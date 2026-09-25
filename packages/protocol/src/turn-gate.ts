// 轮派发屏障（TECH §3 RPC 命令顺序化③ + §5 层1 三写硬序 + §5.5 三标记制；r8/r8c 风险序 1）
//
// 屏障语义（r2 指令 5 + r8 下一步意见 1）：
// - submit 仅 idle 受理；硬序=①enqueue 行 fsync→②sending 行 fsync→③调用方拿 send 许可后才可写 stdin 首字节
//   （「sending fsync 先于 stdin 首字节」由本序机械保证——§5.5 崩溃矩阵自动补发唯一判据）
// - RPC response 的 success 仅表示 pi 受理（onAccepted 只记录，不释放屏障）
// - agent_settled 事件 + settled 行 fsync 成功才释放屏障（下一 prompt 可受理）；终态耐久失败=closed 保持（fail-closed）
// - 乱序基础：settled 先于 success 可正常收口；晚到 success/晚到 settled=观察 no-op 不开新轮
// - 轮超时（turnTimeoutMs 默认 30min，§5.5）：超窗→closed("turn-timeout")=中断呈现；不自动重发；
//   进程级处置与对账归后续切片，reopen() 由宿主在裁决后调用
//
// 本模块=纯逻辑状态机：耐久=注入 DurabilityPort（真 fsync 由 adapter 宿主接管）；时钟=注入 now()（受控测试）。
// 实例粒度=一会话一轮（§6 单写者：同一会话同时至多一个 in-flight 轮）。

import type { IntentId, IntentMatchKey, SessionId } from "./identity.ts";
import type { EnqueuePayload, JournalLine } from "./journal.ts";

/** 提交意图输入（enqueue 行字段；generation/leafId 由调用方给出）。 */
export interface TurnIntentInput {
  readonly intentId: IntentId;
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly leafId: string;
  readonly matchKey: IntentMatchKey;
  readonly payload: EnqueuePayload;
}

/** 账本耐久端口：append=追加一行并 fsync；失败=reject（屏障 fail-closed）。 */
export interface DurabilityPort {
  append(line: JournalLine): Promise<void>;
}

export type GateCloseReason =
  | "durability-failure" // 账本 fsync 失败：closed 保持，恢复流程裁决后 reopen
  | "turn-timeout" // 轮超时：中断呈现（不自动重发）；进程处置+对账归宿主
  | "manual"; // 宿主显式关闭（进程换代/接管等场景）

export type GateState =
  | { readonly kind: "closed"; readonly reason: GateCloseReason }
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching"; readonly intentId: IntentId } // 硬序 fsync 进行中（此间无 send 许可）
  | {
      readonly kind: "in-flight";
      readonly intentId: IntentId;
      readonly acceptedAt: string | null; // null=尚未见受理回执（success 晚到/未见）
      readonly dispatchedAt: string; // send 许可签发时刻（轮超时窗起点）
    }
  | { readonly kind: "settling"; readonly intentId: IntentId }; // settled 事件已到，终态行 fsync 中

export type SubmitOutcome =
  | { readonly kind: "send" } // 两 fsync 完成：自此刻起调用方可写 stdin 首字节
  | { readonly kind: "rejected"; readonly reason: "busy" | "closed" }
  | {
      /** 硬序中断：意图未发送（sending fsync 完成前调用方拿不到 send，副作用通道从未开栓）。注：fsync reject 不证明盘上无行——write 可能已落完整/部分行后报错；恢复以实际重放出的记录裁决（A1-02）。 */
      readonly kind: "failed";
      readonly stage: "enqueue" | "sending";
      readonly error: unknown;
    }
  | {
      /** 生命周期失效（A1-01）：任一 fsync await 期间屏障被 close/reopen 接管——本意图不得发送（无 send 许可、不得覆盖新状态）；已发 journal 行的写入结果同样未确认，恢复以实际重放裁决。 */
      readonly kind: "invalidated";
      readonly stage: "enqueue" | "sending";
    };

export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000; // §5.5 轮超时默认 30min（含模型+工具全程）

export class TurnGate {
  private state: GateState = { kind: "idle" };
  /** 操作代次（A1-01）：close/reopen 递增，使仍在 await 中的旧 submit/旧 settled 追加失效——旧操作完成后不得返回 send、不得覆盖新状态。 */
  private opEpoch = 0;

  constructor(
    private readonly opts: {
      durability: DurabilityPort;
      now(): string;
      turnTimeoutMs?: number;
    },
  ) {}

  getState(): GateState {
    return this.state;
  }

  /** 受理意图：仅 idle。硬序两 fsync 完成后返回 send 许可；任一 fsync 失败→closed（journal 行写入结果未确认——reject 不证明无行；恢复以实际重放裁决）。 */
  async submit(intent: TurnIntentInput): Promise<SubmitOutcome> {
    if (this.state.kind === "closed") return { kind: "rejected", reason: "closed" };
    if (this.state.kind !== "idle") return { kind: "rejected", reason: "busy" };
    const epoch = this.opEpoch; // A1-01：本次提交绑定的操作身份
    this.state = { kind: "dispatching", intentId: intent.intentId };
    try {
      // 硬序①：意图行 fsync（≡written）
      await this.opts.durability.append({ t: "enqueue", ...intent });
    } catch (error) {
      if (epoch !== this.opEpoch) return { kind: "invalidated", stage: "enqueue" }; // 生命周期已接管：不动状态（close 已设 closed）
      this.state = { kind: "closed", reason: "durability-failure" };
      return { kind: "failed", stage: "enqueue", error };
    }
    if (epoch !== this.opEpoch || this.state.kind !== "dispatching") {
      return { kind: "invalidated", stage: "enqueue" }; // await 期间被 close/reopen 接管：不覆盖新状态、不发放 send
    }
    try {
      // 硬序②：sending 行 fsync——完成前调用方拿不到 send（stdin 首字节不可能早于此 fsync，机械硬序）
      await this.opts.durability.append({ t: "sending", intentId: intent.intentId });
    } catch (error) {
      if (epoch !== this.opEpoch) return { kind: "invalidated", stage: "sending" };
      this.state = { kind: "closed", reason: "durability-failure" };
      return { kind: "failed", stage: "sending", error };
    }
    if (epoch !== this.opEpoch || this.state.kind !== "dispatching") {
      return { kind: "invalidated", stage: "sending" }; // sending 已 fsync 成功但屏障已易主：同样不发 send
    }
    this.state = {
      kind: "in-flight",
      intentId: intent.intentId,
      acceptedAt: null,
      dispatchedAt: this.opts.now(),
    };
    return { kind: "send" };
  }

  /** RPC response success=仅受理回执（非轮终）：只记录，不释放屏障。晚到（已收口/关闭）=观察 no-op。 */
  onAccepted(): void {
    if (this.state.kind === "in-flight" && this.state.acceptedAt === null) {
      this.state = { ...this.state, acceptedAt: this.opts.now() };
    }
    // dispatching=防御丢弃（无 send 许可不应有 response）；其余态=晚到观察 no-op
  }

  /** agent_settled 事件：in-flight→settling+settled 行 fsync→成功才 idle（释放屏障）；失败=closed 保持。
   *  晚到 settled（idle/closed 后，如超时收口后）=观察 no-op——轮已收口，不开新轮；观测层记录归宿主。
   *  A1-04 部分修复：追加 await 期间屏障被 close/reopen 接管后，旧追加的成败均不得改写新状态（含不得把新在飞轮关掉）。 */
  async onTurnSettled(): Promise<void> {
    if (this.state.kind !== "in-flight") return;
    const intentId = this.state.intentId;
    const epoch = this.opEpoch; // A1-01：本次结算绑定的操作身份
    this.state = { kind: "settling", intentId };
    try {
      await this.opts.durability.append({ t: "settled", intentId });
    } catch {
      if (epoch !== this.opEpoch) return; // 生命周期已接管（如已换代+新轮在飞）：旧追加失败不关新轮，恢复以实际重放裁决
      this.state = { kind: "closed", reason: "durability-failure" }; // 终态耐久失败=保持关闭
      return;
    }
    if (epoch === this.opEpoch && this.state.kind === "settling" && this.state.intentId === intentId) {
      this.state = { kind: "idle" };
    }
  }

  /** 轮超时检查（宿主受控时钟周期调用）：in-flight 超窗→closed("turn-timeout")=中断呈现（不自动重发）。 */
  checkTimeout(now?: string): void {
    if (this.state.kind !== "in-flight") return;
    const nowMs = Date.parse(now ?? this.opts.now());
    const startMs = Date.parse(this.state.dispatchedAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(startMs)) return; // 判据坏=不裁决（保守）
    const timeoutMs = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (nowMs - startMs > timeoutMs) {
      this.state = { kind: "closed", reason: "turn-timeout" };
    }
  }

  /** 宿主显式关闭（进程换代/接管等；原因留痕）。使仍在 await 中的旧 submit/旧 settled 追加失效（A1-01）。 */
  close(reason: GateCloseReason = "manual"): void {
    this.opEpoch += 1;
    this.state = { kind: "closed", reason };
  }

  /** 恢复/裁决后由宿主解锁（仅 closed→idle）。reopen 不证明旧轮已收口——解锁依据（已耐久结算/退出确认/换代完成）归宿主裁决（A1-04 边界）；亦使更早的悬置操作失效。 */
  reopen(): boolean {
    this.opEpoch += 1;
    if (this.state.kind === "closed") {
      this.state = { kind: "idle" };
      return true;
    }
    return false;
  }
}
