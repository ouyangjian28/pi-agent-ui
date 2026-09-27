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
  WriteSnapshot,
} from "./write-client";
import { WriteSendError } from "./write-client";

/** 写视图态机：idle=可发送；sending=prompt 在途；stopping=stop 在途（可叠加 sending）；error=硬/瞬态错误。 */
export type WritePhase = "idle" | "sending" | "stopping" | "error";

/** 写面视图（纯派生产物；errorMessage 恒为受控文案）。 */
export interface WriteView {
  readonly phase: WritePhase;
  readonly file: string | null;
  /** 写连接已握手（ready）——发送/停止入口的连接前置。 */
  readonly ready: boolean;
  readonly sending: boolean;
  readonly stopping: boolean;
  /** 本文件最近一次已终结请求（锚点① file 身份门：他文件结果不透出）。 */
  readonly lastResult: WriteLastResult | null;
  /** 受控错误文案（连接级硬错误或最近一次发送失败）。 */
  readonly errorMessage: string | null;
}

/** 快照→写视图派生（纯函数；锚点①②）。localError=hook 捕获的最近一次 send 拒绝文案（瞬态，重试即清）。 */
export function writeViewOf(snap: WriteSnapshot, file: string | null, localError: string | null): WriteView {
  const hasPrompt = file !== null && snap.inflight.some((e) => e.file === file && e.kind === "prompt");
  const hasStop = file !== null && snap.inflight.some((e) => e.file === file && e.kind === "stop");
  const connError = snap.connState === "error" ? snap.errorMessage : null;
  const lastResult = snap.lastResult !== null && snap.lastResult.file === file ? snap.lastResult : null;
  let phase: WritePhase;
  if (connError !== null) phase = "error"; // 连接级硬错误优先（在途已被连接面统一结算清空）
  else if (hasStop) phase = "stopping"; // 后发动作优先呈现
  else if (hasPrompt) phase = "sending";
  else if (localError !== null) phase = "error";
  else phase = "idle";
  return {
    phase,
    file,
    ready: snap.connState === "ready",
    sending: hasPrompt,
    stopping: hasStop,
    lastResult,
    errorMessage: connError ?? localError,
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

/** 写动作返回契约（锚点⑤）：true=收到合法 ack；false=被拒（受控文案已进 errorMessage 视图）。 */
export interface UseWrite {
  readonly view: WriteView;
  readonly send: (text: string) => Promise<boolean>;
  readonly stop: () => Promise<boolean>;
}

/** 挂接写面：file=null 时视图照常派生（idle/连接级态），send/stop 直接 false（组合层保证不触达）。 */
export function useWrite(client: WriteClientSurface, file: string | null): UseWrite {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [failure, setFailure] = useState<TransientFailure | null>(null);
  /** 动作序号（每次 send/stop 尝试递增）：迟到失败回调只认最新动作（锚点③）。 */
  const attemptSeq = useRef(0);

  /** 新动作开始：序号递增+清瞬态错误（无论旧错误属何身份，新尝试即全部作废）。 */
  const beginAttempt = (): number => {
    attemptSeq.current += 1;
    setFailure(null); // 瞬态错误随新尝试清除
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
    (text: string): Promise<boolean> => {
      if (file === null) return Promise.resolve(false);
      const seq = beginAttempt();
      return client.sendPrompt(file, text).then(
        () => true,
        (error: unknown) => recordFailure(seq, file, error),
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

  // 派生期身份门（锚点③）：瞬态错误仅当属当前 client×file 身份时透出；file=null 全隐。
  const visibleFailure =
    failure !== null && failure.client === client && failure.file === file ? failure.message : null;
  return { view: writeViewOf(snap, file, visibleFailure), send, stop };
}
