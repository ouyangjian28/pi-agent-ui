// 连接级统一发送队列（切片③ w0 对齐 B7-B10；契约 §5.6）
// 不变量：
// ①所有应用层出帧（welcome/error/sessions/recovery/snapshot/events/status/resync）唯一经此队列——业务禁止直发 socket；
//   传输级 ping/pong/close 不在此列（ws 协议控制帧，另行说明）。
// ②序列化一次、UTF-8 实字节（Buffer.byteLength 同义手算）、同一字符串发送——不允许先量后拼两份。
// ③双门：待发帧 ≤1024 且待发字节 ≤1_048_576（边界=允许，+1 拒）；计量所有权=入队计+发送回调成功释放（含排队与在途）。
// ④单 drain、不重入；每轮 ≤16 帧或 8ms 让步（setImmediate）。
// ⑤溢出=终止流程：恰一次 4431（retryable=true，连接级口径）**直接尽力发送**（不占队列预算——不递归溢出），
//   随即 close(4431)；closeWaitMs 内未确认 → terminate。终止态丢弃后续业务帧。
// ⑥bufferedAmount ≥4_194_304（缓冲堆积门）：立即终止（同溢出流程，尽力 4431）。
// ⑦send 同步抛错/回调错误/迟到回调：进入终止流程；迟到成功回调不复活。
export interface SendPort {
  readonly readyState: number; // 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED（ws 常量同义）
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface ConnectionQueueOpts {
  readonly port: SendPort;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
  readonly bufferedAmountLimit?: number;
  readonly drainBatch?: number;
  readonly drainSliceMs?: number;
  readonly closeWaitMs?: number;
  readonly now?: () => number;
  readonly setImmediate?: (cb: () => void) => void;
  readonly setTimeout?: (cb: () => void, ms: number) => void;
  readonly clearTimeout?: (t: unknown) => void;
  readonly audit?: (line: string) => void;
}

export const QUEUE_LIMITS = {
  maxFrames: 1024,
  maxBytes: 1_048_576,
  bufferedAmountLimit: 4_194_304,
  drainBatch: 16,
  drainSliceMs: 8,
  closeWaitMs: 5_000,
} as const;

// UTF-8 字节（与 Buffer.byteLength 等价；无 Buffer 依赖也可手算——此处服务端环境直接手算避免歧义）
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

interface Queued {
  readonly text: string;
  readonly bytes: number;
  readonly inflight: boolean; // true=已交 socket 等回调（计量仍持有，回调成功才释放）
}

export type EnqueueResult = "queued" | "rejected-overflow" | "rejected-closed";

export class ConnectionQueue {
  private readonly q: Queued[] = [];
  private queuedBytes = 0;
  private draining = false;
  private state: "open" | "terminating" | "closed" = "open";
  private notified4431 = false;
  private termTimer: unknown = null;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly bufferedAmountLimit: number;
  private readonly drainBatch: number;
  private readonly drainSliceMs: number;
  private readonly closeWaitMs: number;
  private readonly now: () => number;
  private readonly imm: (cb: () => void) => void;
  private readonly tmr: (cb: () => void, ms: number) => unknown;
  private readonly clr: (t: unknown) => void;
  private readonly port: SendPort;
  private readonly auditFn: (line: string) => void;

  constructor(opts: ConnectionQueueOpts) {
    this.port = opts.port;
    this.maxFrames = opts.maxFrames ?? QUEUE_LIMITS.maxFrames;
    this.maxBytes = opts.maxBytes ?? QUEUE_LIMITS.maxBytes;
    this.bufferedAmountLimit = opts.bufferedAmountLimit ?? QUEUE_LIMITS.bufferedAmountLimit;
    this.drainBatch = opts.drainBatch ?? QUEUE_LIMITS.drainBatch;
    this.drainSliceMs = opts.drainSliceMs ?? QUEUE_LIMITS.drainSliceMs;
    this.closeWaitMs = opts.closeWaitMs ?? QUEUE_LIMITS.closeWaitMs;
    this.now = opts.now ?? (() => Date.now()); // 计量切片用时（非鉴权时钟；单调性由调用方注入保证）
    this.imm = opts.setImmediate ?? ((cb) => setImmediate(cb));
    this.tmr = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clr = opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.auditFn = opts.audit ?? (() => {});
  }

  /** 入队（序列化一次）。终止/关闭态拒收；双门超限→终止流程并拒收本帧。 */
  enqueue(frame: unknown): EnqueueResult {
    if (this.state !== "open") {
      if (this.state === "closed") return "rejected-closed";
      return "rejected-overflow"; // 终止中：不再接收业务帧
    }
    const text = JSON.stringify(frame);
    const bytes = utf8Bytes(text);
    if (this.q.length + 1 > this.maxFrames || this.queuedBytes + bytes > this.maxBytes) {
      this.audit(`conn-queue-overflow frames=${this.q.length + 1} bytes=${this.queuedBytes + bytes}`);
      this.beginTerminate("queue-overflow");
      return "rejected-overflow";
    }
    this.q.push({ text, bytes, inflight: false });
    this.queuedBytes += bytes;
    this.scheduleDrain();
    return "queued";
  }

  /** bufferedAmount 堆积门（gateway 在发送侧与心跳处调用）。 */
  checkBacklog(): boolean {
    if (this.state === "open" && this.port.bufferedAmount >= this.bufferedAmountLimit) {
      this.audit(`conn-queue-backlog bufferedAmount=${this.port.bufferedAmount}`);
      this.beginTerminate("backlog");
      return false;
    }
    return this.state === "open";
  }

  get depth(): number {
    return this.q.length;
  }

  get bytes(): number {
    return this.queuedBytes;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /** 主动关闭（正常路径）：停止接收、尽力排空后 close。 */
  close(code = 1000, reason = ""): void {
    if (this.state !== "open") return;
    this.state = "closed";
    // 排空余量尽力而为：已在途/已排队的帧继续 drain 一次（不重入），随后 close
    this.drainOnce(true);
    if (this.state === "closed" && this.port.readyState <= 1) this.port.close(code, reason);
    this.q.length = 0; // 未发出部分丢弃（正常关闭尽力语义）
    this.queuedBytes = 0;
  }

  /** 终止（异常路径）：恰一次 4431 尽力直发→close(4431)→限时 terminate。 */
  private beginTerminate(reason: string): void {
    if (this.state !== "open") return;
    this.state = "terminating";
    this.q.length = 0; // 丢弃待发（发不完；在途回调不再复活）
    this.queuedBytes = 0;
    const port = this.port;
    if (!this.notified4431 && port.readyState === 1) {
      this.notified4431 = true;
      try {
        port.send(
          JSON.stringify({ t: "error", code: 4431, message: `连接发送队列超限（${reason}）；请重连后按游标续读`, retryable: true, requestId: "" }),
          () => {},
        );
      } catch {
        this.audit("conn-queue-4431-send-failed");
      }
    }
    try {
      port.close(4431, "connection-queue-overflow");
    } catch {
      /* close 抛错→直接 terminate */
    }
    this.termTimer = this.tmr(() => {
      if (port.readyState <= 2) {
        this.audit("conn-queue-terminate reason=" + reason);
        try {
          port.terminate();
        } catch {
          /* 已死 */
        }
      }
      this.state = "closed";
    }, this.closeWaitMs);
  }

  /** gateway 收到传输 close 事件时同步状态（防 terminate 兜底误打）。 */
  onTransportClosed(): void {
    if (this.termTimer !== null) this.clr(this.termTimer);
    this.state = "closed";
    this.q.length = 0;
    this.queuedBytes = 0;
  }

  private scheduleDrain(): void {
    if (this.draining || this.state === "terminating") return;
    this.draining = true;
    this.imm(() => {
      this.draining = false;
      this.drainOnce(false);
    });
  }

  private drainOnce(final: boolean): void {
    if (this.state === "terminating") return;
    const start = this.now();
    let n = 0;
    while (this.q.length > 0 && n < this.drainBatch) {
      if (!final && this.now() - start >= this.drainSliceMs) {
        this.scheduleDrain(); // 8ms 让步
        return;
      }
      const item = this.q.shift();
      if (item === undefined) break;
      const port = this.port;
      if (port.readyState !== 1) {
        // 传输不在 OPEN：迟到关闭——终止态收敛（不重复通知）
        this.state = "terminating";
        this.q.length = 0;
        this.queuedBytes = 0;
        this.tmr(() => {
          this.state = "closed";
        }, 0);
        return;
      }
      if (port.bufferedAmount >= this.bufferedAmountLimit) {
        this.beginTerminate("backlog");
        return;
      }
      n++;
      let settled = false;
      try {
        port.send(item.text, (err?: Error | null) => {
          if (settled) {
            this.audit("conn-queue-send-callback-late err=" + (err ? "yes" : "no")); // 迟到回调：不复活不复账
            return;
          }
          settled = true;
          if (err) {
            this.audit("conn-queue-send-callback-error");
            this.beginTerminate("send-callback-error");
            return;
          }
          this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes); // 回调成功才释放
          if (this.q.length > 0) this.scheduleDrain();
        });
      } catch {
        this.audit("conn-queue-send-throw");
        this.beginTerminate("send-throw");
        return;
      }
    }
    if (this.q.length > 0 && !final) this.scheduleDrain();
  }

  private audit(line: string): void {
    try {
      this.auditFn(line);
    } catch {
      /* 审计失败不改变队列裁决 */
    }
  }

  dispose(): void {
    if (this.termTimer !== null) this.clr(this.termTimer);
    this.termTimer = null;
    this.state = "closed";
    this.q.length = 0;
    this.queuedBytes = 0;
  }
}
