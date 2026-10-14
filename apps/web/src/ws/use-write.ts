// A1c 写 hook（归属整改重写：本文件由 Kimi 亲手重写，语义对照 K5 修复批逐项保真——重写非返工）。
// 职责：useSyncExternalStore 订阅 WriteClient 快照→写视图态机（idle/sending/stopping/error）+写动作。
// 纯派生（writeViewOf）与 hook 分立（同 use-session-detail/sessionDetailViewOf 惯例）。
//
// 保真清单（重写锚点）：
// ①在途态按（file×kind）从快照 inflight 派生：prompt→sending、stop→stopping；两者并行时以 stop 为
//   后发动作呈现「停止中」；lastResult 以 file 身份门透出（换文件不泄漏旧文件结果——B3 同精神）；
// ②错误双源：连接级（快照 connState=error，受控文案来自 write-client）为硬错误（发送入口随 ready
//   关闭）；本地/请求级（send 被拒）为瞬态错误（横幅展示，下一次发送尝试自动清除，不锁死发送入口）；
// ③B3 瞬态错误身份门：瞬态错误不是全局字符串，而是绑定发起时 client×file+动作序号的记录——
//   派生期（渲染时）只透出属当前 client×file 身份的错误（旧会话失败不污染当前会话；file=null 全隐）；
//   迟到失败回调若非最新动作则不落账（旧请求在 effect 之后才失败也不得覆盖新动作/当前身份状态）；
//   回到曾失败的会话时错误重新可见（与 lastResult 的 file 身份门同语义）；
// ④卸载不清服务端状态：无 cleanup 动作（不自动 stop——停止只由用户显式触发；在途请求由连接面继续结算）；
// ⑤send/stop 恒不 reject（失败 resolve false+错误进视图），组件侧无需防御未处理拒绝。

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type {
  WriteClientSurface,
  WriteLastResult,
  WriteResumeResult,
  WriteSnapshot,
} from "./write-client";
import { WriteSendError } from "./write-client";
import { classifySend, classifySendError, type SendResult } from "./conversation-state";

/** 写视图态机：idle=可发送；sending=prompt 在途；stopping=stop 在途（可叠加 sending）；
 * resuming=resume 在途（独立账）；error=硬/瞬态错误。 */
export type WritePhase = "idle" | "sending" | "stopping" | "resuming" | "error";

/** 写面视图（纯派生产物；errorMessage 恒为受控文案）。 */
export interface WriteView {
  readonly phase: WritePhase;
  readonly file: string | null;
  /** 写连接已握手（ready）——发送/停止入口的连接前置。 */
  readonly ready: boolean;
  readonly sending: boolean;
  readonly stopping: boolean;
  /** resume 在途（v1.1 恢复重发面；file 身份门：他 file 在途不透出）。 */
  readonly resuming: boolean;
  /** 本文件最近一次已终结请求（锚点① file 身份门：他文件结果不透出）。 */
  readonly lastResult: WriteLastResult | null;
  /** 本文件最近一次已终结恢复重发（同 file 身份门；4409 排队超时等受控失败也在此呈现）。 */
  readonly lastResumeResult: WriteResumeResult | null;
  /** 受控错误文案（连接级硬错误或最近一次发送失败）。 */
  readonly errorMessage: string | null;
  /** M-OPS（v1.4）not-ready 面：最近一次发送收到 not-ready ack（启动失败；cause+detail=stderr 尾行）。
   * 与 errorMessage 分立：这不是发送失败——ack 已到，是进程启动失败需响亮呈现+重试/换模型动作。
   * 同锚点③身份门（他文件启动失败不透出）。 */
  readonly notReady: NotReadyInfo | null;
}

/** M-OPS（v1.4）：not-ready 受控信息（服务端 detail 已 ≤500+strip；前端 React 默认转义渲染）。 */
export interface NotReadyInfo {
  readonly cause: string | null;
  readonly detail: string | null;
}

/** 快照→写视图派生（纯函数；锚点①②）。localError=hook 捕获的最近一次 send 拒绝文案（瞬态，重试即清）；
 * notReady=同源瞬态 not-ready 记录（M-OPS v1.4；已过身份过滤后传入）。 */
export function writeViewOf(
  snap: WriteSnapshot,
  file: string | null,
  localError: string | null,
  notReady: NotReadyInfo | null = null,
): WriteView {
  const hasPrompt = file !== null && snap.inflight.some((e) => e.file === file && e.kind === "prompt");
  const hasStop = file !== null && snap.inflight.some((e) => e.file === file && e.kind === "stop");
  const hasResume = file !== null && snap.resumeState.phase === "resuming" && snap.resumeState.files.includes(file);
  const connError = snap.connState === "error" ? snap.errorMessage : null;
  const lastResult = snap.lastResult !== null && snap.lastResult.file === file ? snap.lastResult : null;
  const lastResumeResult = snap.lastResumeResult !== null && snap.lastResumeResult.file === file ? snap.lastResumeResult : null;
  let phase: WritePhase;
  if (connError !== null) phase = "error"; // 连接级硬错误优先（在途已被连接面统一结算清空）
  else if (hasStop) phase = "stopping"; // 后发动作优先呈现
  else if (hasPrompt) phase = "sending";
  else if (hasResume) phase = "resuming";
  else if (localError !== null) phase = "error";
  else phase = "idle";
  return {
    phase,
    file,
    ready: snap.connState === "ready",
    sending: hasPrompt,
    stopping: hasStop,
    resuming: hasResume,
    lastResult,
    lastResumeResult,
    errorMessage: connError ?? localError,
    notReady,
  };
}

/** 瞬态错误记录（锚点③身份门）：绑定动作发起时的 client×file 身份与动作序号。
 * 派生期按当前身份过滤（非当前 client/file 不透出）；seq 供迟到回调门（非最新动作不落账）。 */
interface TransientFailure {
  readonly client: WriteClientSurface;
  readonly file: string;
  readonly seq: number;
  readonly message: string;
}

/** send 拒绝值→受控文案（WriteSendError.message 本就是受控映射产物；未知异常兜底固定文案）。 */
function failureText(error: unknown): string {
  if (error instanceof WriteSendError) return error.message;
  return "发送失败：未知错误";
}

/** M-OPS（v1.4）：瞬态 not-ready 记录（同 TransientFailure 锚点③身份门：client×file+动作序号）。 */
interface TransientNotReady {
  readonly client: WriteClientSurface;
  readonly file: string;
  readonly seq: number;
  readonly cause: string | null;
  readonly detail: string | null;
}

/** prompt 返回五域结构化事实；stop/resume 保留独立旧接口，不作为清稿判据。 */
export interface UseWrite {
  readonly view: WriteView;
  /** M-OPS（v1.4）：可选 model——新建态/换模型路径携带；正常会话传 undefined（不改会话模型）。
   * v1.5（批A）：可选 cwd——仅新建会话首 prompt 携带（会话寿命内 cwd 固定）；正常会话传 undefined。 */
  readonly send: (text: string, model?: string, cwd?: string) => Promise<SendResult>;
  readonly stop: () => Promise<boolean>;
  /** 恢复重发（v1.1）：intentId+generation 由调用方提供（演示位手输；默认 generation=1）。 */
  readonly resume: (intentId: string, generation: number) => Promise<boolean>;
}

/** 挂接写面：file=null 时视图照常派生（idle/连接级态），send/stop 直接 false（组合层保证不触达）。 */
export function useWrite(client: WriteClientSurface, file: string | null): UseWrite {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [failure, setFailure] = useState<TransientFailure | null>(null);
  const [notReady, setNotReady] = useState<TransientNotReady | null>(null);
  /** 动作序号（每次 send/stop 尝试递增）：迟到失败回调只认最新动作（锚点③）。 */
  const attemptSeq = useRef(0);

  /** 新动作开始：序号递增+清瞬态错误（无论旧错误属何身份，新尝试即全部作废）。 */
  const beginAttempt = (): number => {
    attemptSeq.current += 1;
    setFailure(null); // 瞬态错误随新尝试清除
    setNotReady(null); // M-OPS：not-ready 面同瞬态语义（新尝试作废旧呈现）
    return attemptSeq.current;
  };

  /** 动作失败落账（锚点③迟到门）：非最新动作的失败不落账——旧请求迟到失败不得覆盖新动作/
   * 当前身份状态。记录携带发起时 client×file 身份；透出与否由渲染期身份过滤决定。 */
  const recordFailure = (seq: number, actionFile: string, error: unknown): false => {
    if (seq !== attemptSeq.current) return false;
    setFailure({ client, file: actionFile, seq, message: failureText(error) });
    return false;
  };

  const send = useCallback(
    (text: string, model?: string, cwd?: string): Promise<SendResult> => {
      if (file === null) return Promise.resolve({ status: "local", kind: "local-invalid", message: "尚未选择会话，未发送。" });
      const wasReady = client.getSnapshot().connState === "ready";
      const seq = beginAttempt();
      return client.sendPrompt(file, text, model, cwd).then(
        (outcome) => {
          // M-OPS（v1.4）：not-ready=ack 已到但进程启动失败——受控信息落账（非错误路径）；
          // 迟到门：非最新动作不覆盖新动作/当前身份状态。
          if (outcome.kind === "not-ready" && seq === attemptSeq.current) {
            setNotReady({ client, file, seq, cause: outcome.cause ?? null, detail: outcome.detail ?? null });
          }
          return classifySend(outcome);
        },
        (error: unknown) => {
          recordFailure(seq, file, error);
          return classifySendError(error, wasReady);
        },
      );
    },
    [client, file],
  );

  const stop = useCallback(
    (): Promise<boolean> => {
      if (file === null) return Promise.resolve(false);
      const seq = beginAttempt();
      return client.sendStop(file).then(
        () => true,
        (error: unknown) => recordFailure(seq, file, error),
      );
    },
    [client, file],
  );

  const resume = useCallback(
    (intentId: string, generation: number): Promise<boolean> => {
      if (file === null) return Promise.resolve(false);
      const seq = beginAttempt();
      return client.resume(file, intentId, generation).then(
        () => true,
        (error: unknown) => recordFailure(seq, file, error),
      );
    },
    [client, file],
  );

  // 派生期身份门（锚点③）：瞬态错误仅当属当前 client×file 身份时透出；file=null 全隐。
  const visibleFailure =
    failure !== null && failure.client === client && failure.file === file ? failure.message : null;
  // M-OPS（v1.4）：not-ready 同身份门（他文件启动失败不透出；file=null 全隐）。
  const visibleNotReady: NotReadyInfo | null =
    notReady !== null && notReady.client === client && notReady.file === file
      ? { cause: notReady.cause, detail: notReady.detail }
      : null;
  return { view: writeViewOf(snap, file, visibleFailure, visibleNotReady), send, stop, resume };
}
