// 派发协调层（TECH §169④ 事件归属屏障的运行时实现；adapter 切片2）
// 职责：受理响应（success）回绑、事件/settled 归因与有界缓冲、响应超时协议（先耐久记录再移出在途）、
// 换代失效。屏障解除证据=TurnGate.onTurnSettled() === "settled"（不以 idle 推测）。
//
// S2 修复（gpt-adapter-s2-review）：
// - S2-01/S2-02 协调器操作身份（opEpoch）：retire/abandonHeld 递增；一切 await 返回后复核，
//   失效操作不得覆盖新登记、不得关新 Gate、不得结算新轮、不得交付旧缓冲。
//   等待期间同轮新增的事件/settled 用「合并式更新」保留（不用旧快照整对象覆盖）。
// - S2-03 结算失败缓冲保留：bufferedEvents 挂在登记上，结算成功才交付；失败保留呈现；
//   弃置走 abandonHeld（丢弃计数审计，不静默丢）。
// - S2-04（部分）held 恢复手续=gate.reopen → coordinator.abandonHeld(reason) → 方可 submit。
// - S2-05 归因前提：无 id settled 的「唯一在途」归因依赖上游按代次顺序+轮边界投递（接线时验证）。

import type { IntentId } from "./identity.ts";
import type { TurnIntentInput, TurnGate, TurnSettleResult } from "./turn-gate.ts";

/** 协调层登记键：intentId（轮身份）+commandId（RPC 命令身份）+generation（进程代次）。 */
export interface TurnKey {
  readonly intentId: IntentId;
  readonly commandId: number;
  readonly generation: number;
}

/** 在途命令相态。 */
export type TrackedPhase =
  | "awaiting-response" // send 已许可、success 未回绑（事件/settled 按代次缓冲）
  | "run-open" // success 已回绑（缓冲事件已交付或随登记保留）
  | "response-timed-out"; // 超时未结算记录已耐久+已移出在途（晚到 success 不回绑不开 run）

export interface TrackedCommand {
  readonly key: TurnKey;
  readonly phase: TrackedPhase;
  readonly sentAt: string;
  readonly acceptedAt: string | null;
  readonly bufferedSettled: boolean; // settled 先于 success 到达：保留缓冲禁丢弃（§169④ 同一状态唯一读法）
  readonly bufferedEvents: readonly unknown[]; // 有界（maxBufferedEvents）；结算成功才交付
}

export interface CoordinatorDeps {
  readonly gate: TurnGate;
  /** 时钟（宿主注入；测试受控）。 */
  now(): string;
  /** 耐久端口（response-timeout 记录行；追加前置契约同 DurabilityPort——reject 后不得裸续写）。 */
  readonly durability: {
    append(line: { t: "response-timeout"; intentId: IntentId; generation: number; commandId: number }): Promise<void>;
  };
  readonly responseTimeoutMs?: number;
  readonly maxBufferedEvents?: number;
  /** 同步审计钩子（C1-02：只收同步函数；async 拒绝不在隔离范围，宿主自消费）。 */
  audit?(line: string): void;
  /** 缓冲交付面（run 开启时事件转发；结算成功时缓冲 drain）。 */
  onBufferDrain?(events: readonly unknown[]): void;
}

export const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BUFFERED_EVENTS = 256;

export type LaunchOutcome =
  | { kind: "launched"; key: TurnKey }
  | { kind: "busy" } // 协调层在飞（旧登记未收口：宿主走恢复手续）
  | { kind: "gate-rejected"; reason: "busy" | "closed" }
  | { kind: "gate-failed"; stage: "enqueue" | "sending"; error: unknown }
  | { kind: "invalidated"; stage: "enqueue" | "sending" }; // 许可过程中生命周期失效（close/换代），未登记未发送

export type ResponseOutcome =
  | { kind: "accepted"; key: TurnKey } // success 回绑：run 开启，缓冲已交付
  | { kind: "accepted-and-settled"; key: TurnKey } // settled 已缓冲：回绑即结算（不再等第二个）
  | { kind: "accepted-settle-failed"; key: TurnKey } // 结算耐久失败：held（缓冲保留在登记上）
  | { kind: "invalidated"; key: TurnKey } // 结算等待期生命周期失效：不改新状态（S2-02）
  | { kind: "response-failure"; key: TurnKey } // 受理失败（ok=false）：屏障不动，处置归宿主
  | { kind: "ignored-late"; key: TurnKey } // 超时后晚到：不回绑不开 run（§169④）
  | { kind: "ignored-unknown" }; // 未登记命令：不猜归属

export type SettledOutcome =
  | { kind: "buffered"; key: TurnKey } // settled 先于 success：保留缓冲（禁丢弃）
  | { kind: "settled"; key: TurnKey } // 结算成功：屏障释放+缓冲 drain
  | { kind: "settle-durability-failed"; key: TurnKey } // 结算耐久失败：held（缓冲保留）
  | { kind: "invalidated"; key: TurnKey } // 结算等待期生命周期失效（S2-02）
  | { kind: "discarded-duplicate"; key: TurnKey }
  | { kind: "discarded-retired-command"; key: TurnKey }
  | { kind: "discarded-stale-generation" }
  | { kind: "discarded-idle"; reason: string }; // 四联空丢弃（§169④：无 run+无在途+无记录+缓冲空）

export type ResponseTimeoutOutcome =
  | { kind: "none" } // 无在途/未超窗/相态不符
  | { kind: "pending"; key: TurnKey } // 记录追加在途：不重复追加（S2-01 重入）
  | { kind: "recorded"; key: TurnKey } // 记录已耐久+移出在途（§169④ 硬序）
  | { kind: "recorded-and-settled"; key: TurnKey } // settled 已缓冲：记录后即结算
  | { kind: "recorded-settle-failed"; key: TurnKey } // 结算耐久失败：held（缓冲保留）
  | { kind: "superseded"; key: TurnKey } // 等待期 success 已回绑：超时未生效（记录行成观测行）
  | { kind: "invalidated"; key: TurnKey } // 等待期生命周期失效：记录行已在盘（恢复按行在+无 settled=效果未知），不改新状态
  | { kind: "durability-failure"; key: TurnKey }; // 记录行耐久失败：close+未移出（追加 reject 不证明无行）

export interface CoordinatorStateView {
  readonly command: TrackedCommand | null;
  readonly responseTimeoutMs: number;
  readonly maxBufferedEvents: number;
}

export class DispatchCoordinator {
  private command: TrackedCommand | null = null;
  private opEpoch = 0; // 协调器操作身份（S2-01/S2-02）：retire/abandonHeld 递增；await 返回后复核
  private timeoutPending = false; // response-timeout 记录追加在途（防重入）

  constructor(private readonly opts: CoordinatorDeps) {}

  /** 提交一轮（send 许可后才登记——关联先于 stdin 首字节）。非 send 结果镜像 Gate，不登记。 */
  async submitTurn(intent: TurnIntentInput, commandId: number): Promise<LaunchOutcome> {
    if (this.command !== null) return { kind: "busy" };
    const verdict = await this.opts.gate.submit(intent);
    if (verdict.kind === "send") {
      this.command = {
        key: { intentId: intent.intentId, commandId, generation: intent.generation },
        phase: "awaiting-response",
        sentAt: this.opts.now(),
        acceptedAt: null,
        bufferedSettled: false,
        bufferedEvents: [],
      };
      return { kind: "launched", key: this.command.key };
    }
    switch (verdict.kind) {
      case "rejected":
        return { kind: "gate-rejected", reason: verdict.reason };
      case "failed":
        return { kind: "gate-failed", stage: verdict.stage, error: verdict.error };
      case "invalidated":
        return { kind: "invalidated", stage: verdict.stage };
    }
  }

  /** 受理响应。awaiting-response+ok：回绑开启 run；bufferedSettled 则回绑即结算（缓冲成功才交付，S2-03）。 */
  async onRpcResponse(commandId: number, generation: number, ok: boolean): Promise<ResponseOutcome> {
    const cur = this.command;
    if (cur === null) return { kind: "ignored-unknown" };
    if (cur.key.commandId !== commandId || cur.key.generation !== generation) {
      this.audit(`response-unknown commandId=${commandId} generation=${generation}`);
      return { kind: "ignored-unknown" };
    }
    if (cur.phase !== "awaiting-response") {
      this.audit(`response-late commandId=${commandId} phase=${cur.phase}`); // §169④：超时后晚到 success 不回绑不开 run
      return { kind: "ignored-late", key: cur.key };
    }
    if (!ok) {
      this.audit(`response-failure commandId=${commandId}`);
      return { kind: "response-failure", key: cur.key };
    }
    this.opts.gate.onAccepted();
    if (cur.bufferedSettled) {
      // S2-03：缓冲保留在登记上（不清空）——结算成功才交付；失败保留呈现
      this.command = { ...cur, phase: "run-open", acceptedAt: this.opts.now() };
      const myEpoch = this.opEpoch;
      const result = await this.opts.gate.onTurnSettled();
      if (this.opEpoch !== myEpoch) {
        this.audit(`settle-invalidated commandId=${cur.key.commandId} droppedEvents=${cur.bufferedEvents.length}`);
        return { kind: "invalidated", key: cur.key }; // 旧操作不改新状态（缓冲随登记退役由 retire/abandon 计数呈现）
      }
      return this.finishSettle(result, cur.key, cur.bufferedEvents) === "released"
        ? { kind: "accepted-and-settled", key: cur.key }
        : { kind: "accepted-settle-failed", key: cur.key };
    }
    const buffered = cur.bufferedEvents;
    this.command = { ...cur, phase: "run-open", acceptedAt: this.opts.now(), bufferedEvents: [] };
    this.drain(buffered); // run 开启：等待期事件交付
    return { kind: "accepted", key: cur.key };
  }

  /**
   * settled 事件归因。带 commandId=精确；无 id=唯一在途归因（S2-05 前提：上游按代次顺序+轮边界投递）。
   * awaiting-response → 缓冲保留（禁丢弃）；run-open/response-timed-out → 结算。
   */
  async onSettledEvent(ev: { generation: number; commandId?: number }): Promise<SettledOutcome> {
    const cur = this.command;
    if (cur === null) {
      const parts = [`settled-idle generation=${ev.generation}`];
      if (ev.commandId !== undefined) parts.push(`commandId=${ev.commandId}`);
      this.audit(parts.join(" ")); // 四联空丢弃（§169④）
      return { kind: "discarded-idle", reason: "no-run-no-inflight-no-record-no-buffer" };
    }
    if (ev.commandId !== undefined && ev.commandId !== cur.key.commandId) {
      this.audit(`settled-retired-command commandId=${ev.commandId} current=${cur.key.commandId}`);
      return { kind: "discarded-retired-command", key: cur.key };
    }
    if (ev.generation !== cur.key.generation) {
      this.audit(`settled-stale-generation generation=${ev.generation} current=${cur.key.generation}`);
      return { kind: "discarded-stale-generation" };
    }
    if (ev.commandId === undefined) {
      this.audit(`settled-attribution-by-single-flight commandId=${cur.key.commandId}`); // 无 id：唯一在途归因（S2-05 前提：上游代次顺序+轮边界）
    }
    if (cur.phase === "awaiting-response") {
      if (cur.bufferedSettled) {
        this.audit(`settled-duplicate commandId=${cur.key.commandId}`);
        return { kind: "discarded-duplicate", key: cur.key };
      }
      this.command = { ...cur, bufferedSettled: true }; // 同轮合并：保留 bufferedEvents（S2-01）
      return { kind: "buffered", key: cur.key };
    }
    if (cur.phase === "run-open" && cur.bufferedSettled) {
      this.audit(`settled-duplicate commandId=${cur.key.commandId}`);
      return { kind: "discarded-duplicate", key: cur.key };
    }
    // run-open / response-timed-out：结算（§169④：晚到 settled 由 settled 行结算超时记录）
    const myEpoch = this.opEpoch;
    const result = await this.opts.gate.onTurnSettled();
    if (this.opEpoch !== myEpoch) {
      this.audit(`settle-invalidated commandId=${cur.key.commandId} droppedEvents=${cur.bufferedEvents.length}`);
      return { kind: "invalidated", key: cur.key };
    }
    return this.finishSettle(result, cur.key, cur.bufferedEvents) === "released"
      ? { kind: "settled", key: cur.key }
      : { kind: "settle-durability-failed", key: cur.key };
  }

  /** 普通事件：run-open=交付；awaiting/timed-out=有界缓冲（溢出=close 不静默丢）。 */
  onPiEvent(ev: unknown, generation: number): { kind: "delivered" | "buffered" | "dropped-stale-generation" | "overflow-closed" } {
    const cur = this.command;
    if (cur === null || cur.key.generation !== generation) {
      return { kind: "dropped-stale-generation" };
    }
    if (cur.phase === "run-open") return { kind: "delivered" }; // 呈现面直交（宿主转发）
    const limit = this.opts.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (cur.bufferedEvents.length >= limit) {
      this.opts.gate.close("buffer-overflow"); // §169④：溢出关闭（已缓冲保留呈现，不静默丢）
      this.audit(`buffer-overflow commandId=${cur.key.commandId} buffered=${cur.bufferedEvents.length} limit=${limit}`);
      return { kind: "overflow-closed" };
    }
    this.command = { ...cur, bufferedEvents: [...cur.bufferedEvents, ev] };
    return { kind: "buffered" };
  }

  /**
   * 响应超时分派（§169④ 超时分派表；宿主受控时钟周期调用）。
   * 硬序：response-timeout 记录行耐久成功之前不得移出在途。等待期世界可能已变（S2-01/S2-02）：
   * 按当前状态合并裁决，不用旧快照覆盖；失效操作不改新状态、不关新 Gate。
   */
  async checkResponseTimeout(now?: string): Promise<ResponseTimeoutOutcome> {
    const cur = this.command;
    if (cur === null || cur.phase !== "awaiting-response") return { kind: "none" };
    const nowMs = Date.parse(now ?? this.opts.now());
    const sentMs = Date.parse(cur.sentAt);
    const limit = this.opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (!Number.isFinite(nowMs) || !Number.isFinite(sentMs)) return { kind: "none" }; // 判据坏=不裁决（保守）
    if (nowMs - sentMs <= limit) return { kind: "none" };
    if (this.timeoutPending) return { kind: "pending", key: cur.key }; // 追加在途：不重复追加
    const myEpoch = this.opEpoch;
    this.timeoutPending = true;
    try {
      await this.opts.durability.append({
        t: "response-timeout",
        intentId: cur.key.intentId,
        generation: cur.key.generation,
        commandId: cur.key.commandId,
      });
    } catch (error) {
      if (this.opEpoch !== myEpoch) {
        this.audit(`response-timeout-record-invalidated commandId=${cur.key.commandId}`); // S2-02：旧操作失败不得关新轮
        return { kind: "invalidated", key: cur.key };
      }
      this.opts.gate.close("durability-failure"); // append reject 不证明无行（写入结果不确定）：未移出，恢复以实际重放裁决
      this.audit(`response-timeout-record-failed commandId=${cur.key.commandId}`);
      void error;
      return { kind: "durability-failure", key: cur.key };
    } finally {
      this.timeoutPending = false;
    }
    if (this.opEpoch !== myEpoch) {
      // 记录行已在盘：恢复按「行在+无 settled=效果未知」（journal.responseTimeoutRecorded）
      this.audit(`response-timeout-invalidated commandId=${cur.key.commandId} appended=true`);
      return { kind: "invalidated", key: cur.key };
    }
    const latest = this.command;
    if (
      latest === null ||
      latest.key.intentId !== cur.key.intentId ||
      latest.key.commandId !== cur.key.commandId ||
      latest.key.generation !== cur.key.generation
    ) {
      this.audit(`response-timeout-invalidated commandId=${cur.key.commandId} key-mismatch`); // 防御：新登记不受旧操作影响
      return { kind: "invalidated", key: cur.key };
    }
    if (latest.phase === "run-open") {
      // 等待期 success 已回绑：超时未生效；记录行成为观测行（终态由 settled 行承载）
      this.audit(`response-timeout-superseded-by-success commandId=${cur.key.commandId}`);
      return { kind: "superseded", key: cur.key };
    }
    if (latest.phase !== "awaiting-response") return { kind: "none" }; // 已并发处理（防御）
    const merged: TrackedCommand = { ...latest, phase: "response-timed-out" }; // 合并：保留等待期新增事件/settled（S2-01）
    this.command = merged;
    if (merged.bufferedSettled) {
      const myEpoch2 = this.opEpoch;
      const result = await this.opts.gate.onTurnSettled();
      if (this.opEpoch !== myEpoch2) {
        this.audit(`settle-invalidated commandId=${merged.key.commandId} droppedEvents=${merged.bufferedEvents.length}`);
        return { kind: "invalidated", key: merged.key };
      }
      return this.finishSettle(result, merged.key, merged.bufferedEvents) === "released"
        ? { kind: "recorded-and-settled", key: merged.key }
        : { kind: "recorded-settle-failed", key: merged.key };
    }
    return { kind: "recorded", key: merged.key };
  }

  /** 整轮超时委托 Gate（两类超时分立：响应超时=受理面，整轮超时=run 面）。 */
  checkTurnTimeout(now?: string): void {
    this.opts.gate.checkTimeout(now);
  }

  /** 换代退役：旧代次登记/缓冲全部失效（计数审计不静默）；pending 协调操作由 opEpoch 失效。屏障处置归宿主（退出确认/换代手续）。 */
  onGenerationRetired(generation: number): { clearedCommands: number; clearedEvents: number } {
    this.opEpoch += 1; // S2-02：等待中的超时记录/结算不得再改任何状态
    const cur = this.command;
    if (cur === null) return { clearedCommands: 0, clearedEvents: 0 };
    let clearedEvents = 0;
    if (cur.key.generation === generation) {
      clearedEvents = cur.bufferedEvents.length;
      this.command = null;
    }
    this.audit(
      `generation-retired generation=${generation} clearedCommands=${cur.key.generation === generation ? 1 : 0} clearedEvents=${clearedEvents} droppedSettled=${cur.bufferedSettled}`,
    );
    return { clearedCommands: cur.key.generation === generation ? 1 : 0, clearedEvents };
  }

  /**
   * 弃置 held 登记（S2-04 恢复手续）：gate closed（终态耐久失败/溢出/手动）→reopen（→idle）→abandonHeld→方可 submit。
   * 仅 closed/idle 可弃（gate 在飞/结算中=活轮，拒绝弃置）；丢弃计数审计同步落，不静默。
   */
  abandonHeld(reason: string): { droppedEvents: number; droppedSettled: boolean } | null {
    const cur = this.command;
    if (cur === null) return null;
    const gs = this.opts.gate.getState().kind;
    if (gs !== "closed" && gs !== "idle") return null;
    this.opEpoch += 1; // 本登记上一切 pending 协调操作失效
    this.command = null;
    this.audit(
      `abandon-held reason=${reason} commandId=${cur.key.commandId} droppedEvents=${cur.bufferedEvents.length} droppedSettled=${cur.bufferedSettled}`,
    );
    return { droppedEvents: cur.bufferedEvents.length, droppedSettled: cur.bufferedSettled };
  }

  /** 快照（观测面）。 */
  getState(): CoordinatorStateView {
    return {
      command: this.command,
      responseTimeoutMs: this.opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      maxBufferedEvents: this.opts.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
    };
  }

  /** 结算收尾（S2-04）：仅 settled 释放；缓冲成功才交付。 */
  private finishSettle(result: TurnSettleResult, key: TurnKey, buffered: readonly unknown[]): "released" | "held" {
    if (result === "settled") {
      const cur = this.command;
      if (cur !== null && cur.key.intentId === key.intentId && cur.key.commandId === key.commandId && cur.key.generation === key.generation) {
        this.command = null; // 解除登记（解锁有证据：settled 结果即本轮）
      }
      this.drain(buffered);
      return "released";
    }
    return "held"; // not-in-flight/invalidated/durability-failure：登记保留（缓冲保留呈现）
  }

  private drain(events: readonly unknown[]): void {
    if (events.length > 0) this.opts.onBufferDrain?.(events);
  }

  private audit(line: string): void {
    try {
      this.opts.audit?.(line);
    } catch {
      // B1-02：同步审计抛错隔离（不中断协调）
    }
  }
}
