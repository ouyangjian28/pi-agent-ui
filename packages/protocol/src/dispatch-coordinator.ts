// 派发协调层（TECH §169④ 事件归属屏障——切片 2 语义权威；s1c 启动条件 1-3）
//
// 在 TurnGate（轮派发屏障）之上补三件事：
// 1. 关联先于回调：命令三元组（intentId+commandId+进程代次）在 send 许可后、stdin 首字节前登记
//    （submitTurn 包装：非 send 许可不登记——close 插入两 fsync 窗口的旧提交不会产生登记）。
// 2. 事件归属：success 回绑前到达的事件按代次缓冲（有界；溢出=关闭屏障+审计，不静默丢）；
//    settled 先到=保留缓冲待回绑消费（「prompt 在途+settled 先到=保留缓冲」——同一状态唯一读法，禁丢弃）；
//    无 commandId 的 settled 按该代次唯一在途命令归因（单写者串行语义；审计留痕 attribution-by-single-flight）。
// 3. 两类超时分立（§169④ 超时分派表）：
//    - 响应超时（受理回执等待窗，responseTimeoutMs）≠整轮超时（30min，gate.checkTimeout 委托）。
//    - 响应超时：先耐久 response-timeout 行（硬序：记录落盘成功之前不得移出在途），再移出在途集合；
//      有记录+settled（含已缓冲）=耐久结算后清记录/缓冲+解屏障；有记录无 settled=保持屏障等 settled 或退出确认/换代；
//      超时后晚到 success 不回绑、不得开启 run；晚到 settled→结算该记录。
//    - 迟到 settled 丢弃四联条件：无开启 run+无在途命令+无未结算记录+缓冲空→丢弃+审计。
// 4. 换代：onGenerationRetired 清旧代次登记/缓冲（计数审计）；屏障解除依据（退出确认/换代手续）归宿主，不自动 reopen。
//
// 纯逻辑：耐久=注入 DurabilityPort（与 TurnGate 同端口共享）；时钟=注入 now()；审计=同步钩子
// （C1-02 契约：只收同步钩子；async 拒绝不在隔离范围，宿主自消费）。实例粒度=一会话一协调器（单写者）。

import type { IntentId } from "./identity.ts";
import type { JournalLine } from "./journal.ts";
import { TurnGate, type SubmitOutcome, type TurnIntentInput } from "./turn-gate.ts";

/** 命令三元组（发送前登记；commandId=RPC 请求 id，宿主生成）。 */
export interface TurnKey {
  readonly intentId: IntentId;
  readonly commandId: number;
  readonly generation: number;
}

/** 在途命令相态：awaiting-response（等受理回执）→run-open（success 回绑，run 已开启）；
 *  response-timed-out=超时未结算记录已耐久+已移出在途（晚到 success 不回绑；晚到 settled 结算此记录）。 */
export type TrackedPhase = "awaiting-response" | "run-open" | "response-timed-out";

/** 协调器跟踪的命令视图（观测面）。 */
export interface TrackedCommand {
  readonly key: TurnKey;
  readonly phase: TrackedPhase;
  readonly sentAt: string;
  readonly acceptedAt: string | null; // null=尚未见受理回执
  readonly bufferedSettled: boolean; // settled 先到保留缓冲（success 回绑时消费，不再等第二个）
  readonly bufferedEvents: readonly unknown[]; // 回绑前到达的普通事件（有界）
}

export type LaunchOutcome =
  | { readonly kind: "launched"; readonly key: TurnKey } // 登记完成：自此刻起调用方可写 stdin 首字节
  | { readonly kind: "rejected"; readonly reason: "busy" | "closed" }
  | { readonly kind: "failed"; readonly stage: "enqueue" | "sending"; readonly error: unknown }
  | { readonly kind: "invalidated"; readonly stage: "enqueue" | "sending" };

export type ResponseOutcome =
  | { readonly kind: "accepted"; readonly key: TurnKey } // success 回绑：run 开启（缓冲事件交付）
  | { readonly kind: "accepted-and-settled"; readonly key: TurnKey } // 回绑+已缓冲 settled 立即结算（不再等第二个）
  | { readonly kind: "accepted-settle-failed"; readonly key: TurnKey } // 回绑+缓冲 settled 结算耐久失败（gate 保持 closed）
  | { readonly kind: "ignored-late"; readonly key: TurnKey } // 超时后/重复晚到 success：不回绑不开 run（审计）
  | { readonly kind: "ignored-unknown"; readonly commandId: number; readonly generation: number } // 未登记/旧代次（审计）
  | { readonly kind: "response-failure"; readonly key: TurnKey }; // ok=false：v1=审计+屏障不动（处置面宿主接管）

export type SettledOutcome =
  | { readonly kind: "buffered"; readonly key: TurnKey } // settled 先到：保留缓冲待回绑（禁丢弃）
  | { readonly kind: "settled"; readonly key: TurnKey } // 结算完成（终态行耐久+屏障释放）
  | { readonly kind: "settle-durability-failed"; readonly key: TurnKey } // 终态行 fsync 失败：gate 保持 closed
  | {
      readonly kind: "discarded";
      readonly reason: "fourfold-empty" | "retired-command" | "stale-generation" | "duplicate";
    };

export type EventOutcome =
  | { readonly kind: "buffered" } // success 前到达：按代次缓冲
  | { readonly kind: "deliver" } // run-open：直接交付（不经缓冲）
  | {
      readonly kind: "discarded";
      readonly reason: "stale-generation" | "no-in-flight" | "overflow-closed";
    };

export type ResponseTimeoutOutcome =
  | { readonly kind: "none" } // 无在途/未超窗/判据坏（保守不裁决）
  | { readonly kind: "recorded"; readonly key: TurnKey } // 记录已耐久+已移出在途；保持屏障等 settled/换代
  | { readonly kind: "recorded-and-settled"; readonly key: TurnKey } // 记录耐久+缓冲 settled 消费：结算+解屏障
  | { readonly kind: "recorded-settle-failed"; readonly key: TurnKey } // 缓冲 settled 结算耐久失败（gate 保持 closed）
  | { readonly kind: "durability-failure"; readonly key: TurnKey }; // 记录行 fsync 失败：gate fail-closed，不移出在途

export const DEFAULT_RESPONSE_TIMEOUT_MS = 60 * 1000; // 受理回执等待窗默认 60s（整轮 30min 归 TurnGate）
export const DEFAULT_MAX_BUFFERED_EVENTS = 256; // 回绑前事件缓冲上界（溢出=关闭+审计，不静默丢）

/** 结算后置：gate 终态=「已释放（idle）」清登记+交付缓冲；否则保留命令呈现（closed=终态行耐久失败/换代接管）。 */
export type SettleAftermath = "released" | "held";

export interface CoordinatorDeps {
  readonly gate: TurnGate;
  readonly durability: { append(line: JournalLine): Promise<void> }; // 与 gate 共享同一账本端口
  now(): string;
  readonly responseTimeoutMs?: number;
  readonly maxBufferedEvents?: number;
  /** 同步审计钩子（C1-02：只收同步；async 拒绝宿主自消费；钩子自身异常不波及协调）。 */
  audit?(line: string): void;
  /** 缓冲交付回调：run 开启回绑时/无回绑收口（超时+缓冲 settled）时交付已缓冲事件。 */
  onBufferDrain?(events: readonly unknown[]): void;
}

export class DispatchCoordinator {
  private command: TrackedCommand | null = null;

  constructor(private readonly opts: CoordinatorDeps) {}

  private audit(line: string): void {
    try {
      this.opts.audit?.(line);
    } catch {
      // 审计钩子自身异常不波及协调（B1-02 同步隔离）
    }
  }

  private drain(events: readonly unknown[]): void {
    if (events.length > 0) this.opts.onBufferDrain?.([...events]);
  }

  getState(): { readonly command: TrackedCommand | null } {
    return this.command === null
      ? { command: null }
      : {
          command: {
            ...this.command,
            key: { ...this.command.key },
            bufferedEvents: [...this.command.bufferedEvents],
          },
        };
  }

  /** 结算收尾：gate 到 idle=清登记+交付缓冲；非 idle=保留命令呈现（终态耐久失败/换代接管）。 */
  private settleAftermath(buffered: readonly unknown[]): SettleAftermath {
    if (this.opts.gate.getState().kind === "idle") {
      this.command = null;
      this.drain(buffered);
      return "released";
    }
    return "held";
  }

  /** 提交并登记：send 许可才登记（关联先于 stdin 首字节）；非 send 许可镜像 gate 结果，不产生登记。 */
  async submitTurn(intent: TurnIntentInput, commandId: number): Promise<LaunchOutcome> {
    if (this.command !== null) {
      // 单写者不变量下不可达（gate busy 先拦）；防御呈现
      this.audit(`coordinator-busy intent=${intent.intentId}`);
      return { kind: "rejected", reason: "busy" };
    }
    const outcome: SubmitOutcome = await this.opts.gate.submit(intent);
    if (outcome.kind !== "send") {
      return outcome; // rejected/failed/invalidated：无登记、无 stdin 许可
    }
    const key: TurnKey = { intentId: intent.intentId, commandId, generation: intent.generation };
    this.command = {
      key,
      phase: "awaiting-response",
      sentAt: this.opts.now(),
      acceptedAt: null,
      bufferedSettled: false,
      bufferedEvents: [],
    };
    return { kind: "launched", key };
  }

  /** RPC 受理响应（success=回绑开 run；超时后晚到=不回绑不开 run）。 */
  async onRpcResponse(commandId: number, generation: number, ok: boolean): Promise<ResponseOutcome> {
    const cur = this.command;
    if (cur === null || cur.key.commandId !== commandId || cur.key.generation !== generation) {
      this.audit(`response-unknown commandId=${commandId} generation=${generation}`);
      return { kind: "ignored-unknown", commandId, generation };
    }
    if (cur.phase === "awaiting-response" && ok) {
      this.opts.gate.onAccepted(); // 仅受理记录，不释放屏障
      const buffered = cur.bufferedEvents;
      this.command = { ...cur, phase: "run-open", acceptedAt: this.opts.now(), bufferedEvents: [] };
      if (cur.bufferedSettled) {
        // 已缓冲 settled：回绑即消费——不再等第二个 settled（§169④）
        await this.opts.gate.onTurnSettled();
        return this.settleAftermath(buffered) === "released"
          ? { kind: "accepted-and-settled", key: cur.key }
          : { kind: "accepted-settle-failed", key: cur.key };
      }
      this.drain(buffered);
      return { kind: "accepted", key: cur.key };
    }
    if (cur.phase === "awaiting-response" && !ok) {
      this.audit(`response-failure commandId=${commandId} generation=${generation}`);
      return { kind: "response-failure", key: cur.key }; // 屏障不动：处置面（重试/中止）宿主接管
    }
    // run-open 重复回执 / 超时后晚到 success：不回绑、不开 run（§169④）
    this.audit(`response-late commandId=${commandId} phase=${cur.phase}`);
    return { kind: "ignored-late", key: cur.key };
  }

  /** agent_settled 事件（归属判据=commandId 精确命中，或该代次唯一在途命令；其余按四联条件/代次裁决）。 */
  async onSettledEvent(ev: { generation: number; commandId?: number }): Promise<SettledOutcome> {
    const cur = this.command;
    if (ev.commandId !== undefined) {
      if (cur === null || cur.key.commandId !== ev.commandId) {
        this.audit(`settled-retired-command commandId=${ev.commandId}`);
        return { kind: "discarded", reason: "retired-command" }; // 已收口命令的晚到 settled：不得结算当前轮
      }
      if (cur.key.generation !== ev.generation) {
        this.audit(`settled-stale-generation commandId=${ev.commandId} generation=${ev.generation}`);
        return { kind: "discarded", reason: "stale-generation" };
      }
    } else {
      if (cur === null) {
        this.audit("settled-late-fourfold-empty");
        return { kind: "discarded", reason: "fourfold-empty" }; // 无 run+无在途+无记录+缓冲空→丢弃+审计
      }
      if (cur.key.generation !== ev.generation) {
        this.audit(`settled-stale-generation generation=${ev.generation}`);
        return { kind: "discarded", reason: "stale-generation" };
      }
      this.audit("settled-attribution-by-single-flight"); // 无 id：唯一在途归因留痕（接线时优先带 id 精确归因）
    }
    // cur 已归因
    if (cur.phase === "awaiting-response") {
      if (cur.bufferedSettled) {
        this.audit(`settled-duplicate commandId=${cur.key.commandId}`);
        return { kind: "discarded", reason: "duplicate" };
      }
      this.command = { ...cur, bufferedSettled: true };
      return { kind: "buffered", key: cur.key }; // prompt 在途+settled 先到=保留缓冲回绑（唯一读法）
    }
    // run-open：正常结算；response-timed-out：晚到 settled→结算该记录（§169④）
    await this.opts.gate.onTurnSettled();
    return this.settleAftermath(cur.bufferedEvents) === "released"
      ? { kind: "settled", key: cur.key }
      : { kind: "settle-durability-failed", key: cur.key };
  }

  /** 普通事件（success 前缓冲/run-open 直接交付/旧代次丢弃）。溢出=关闭+审计（不静默丢）。 */
  onPiEvent(ev: unknown, generation: number): EventOutcome {
    const cur = this.command;
    if (cur === null) {
      this.audit("event-no-in-flight"); // 轮外事件不经协调器（宿主自行路由非轮事件）
      return { kind: "discarded", reason: "no-in-flight" };
    }
    if (cur.key.generation !== generation) {
      this.audit(`event-stale-generation generation=${generation}`);
      return { kind: "discarded", reason: "stale-generation" };
    }
    if (cur.phase === "run-open") return { kind: "deliver" };
    const cap = this.opts.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (cur.bufferedEvents.length >= cap) {
      this.opts.gate.close("buffer-overflow"); // 溢出关闭（保留已缓冲呈现，不静默丢）
      this.audit(`event-buffer-overflow cap=${cap}`);
      return { kind: "discarded", reason: "overflow-closed" };
    }
    this.command = { ...cur, bufferedEvents: [...cur.bufferedEvents, ev] };
    return { kind: "buffered" };
  }

  /** 响应超时分派（§169④）：先耐久 response-timeout 行，再移出在途；缓冲 settled 则立即结算。 */
  async checkResponseTimeout(now?: string): Promise<ResponseTimeoutOutcome> {
    const cur = this.command;
    if (cur === null || cur.phase !== "awaiting-response") return { kind: "none" };
    const nowMs = Date.parse(now ?? this.opts.now());
    const sentMs = Date.parse(cur.sentAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(sentMs)) return { kind: "none" }; // 判据坏=不裁决（保守）
    const timeoutMs = this.opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (nowMs - sentMs <= timeoutMs) return { kind: "none" };
    try {
      // 硬序：记录行落盘成功之前不得移出在途（append reject 不证明无行——写入结果不确定，恢复以实际重放裁决）
      await this.opts.durability.append({
        t: "response-timeout",
        intentId: cur.key.intentId,
        generation: cur.key.generation,
        commandId: cur.key.commandId,
      });
    } catch (error) {
      this.opts.gate.close("durability-failure");
      this.audit(`response-timeout-record-failed commandId=${cur.key.commandId}`);
      void error;
      return { kind: "durability-failure", key: cur.key }; // 未移出：保持 awaiting-response
    }
    this.command = { ...cur, phase: "response-timed-out" }; // 移出在途（晚到 success 不再回绑）
    if (cur.bufferedSettled) {
      // 有记录+已缓冲 settled：耐久结算后清记录/缓冲+解屏障
      await this.opts.gate.onTurnSettled();
      return this.settleAftermath(cur.bufferedEvents) === "released"
        ? { kind: "recorded-and-settled", key: cur.key }
        : { kind: "recorded-settle-failed", key: cur.key };
    }
    // 有记录无 settled：保持屏障等 settled 或退出确认/换代（§169④）
    return { kind: "recorded", key: cur.key };
  }

  /** 整轮超时（30min 含模型+工具全程）：委托 gate（closed("turn-timeout")=中断呈现不自动重发）。 */
  checkTurnTimeout(now?: string): void {
    this.opts.gate.checkTimeout(now);
  }

  /** 进程换代：清旧代次登记/缓冲（计数审计）；屏障解除依据（退出确认/换代手续）归宿主——不自动 reopen。 */
  onGenerationRetired(generation: number): { readonly clearedCommands: number; readonly clearedEvents: number } {
    const cur = this.command;
    if (cur === null || cur.key.generation !== generation) return { clearedCommands: 0, clearedEvents: 0 };
    this.command = null;
    this.audit(`generation-retired generation=${generation} bufferedEvents=${cur.bufferedEvents.length}`);
    return { clearedCommands: 1, clearedEvents: cur.bufferedEvents.length };
  }
}
