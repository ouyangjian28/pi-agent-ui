// 计算并发闸（切片③ w0 对齐 B12；契约 §5.6：全服务计算并发 2+排队 5s）
// 不变量：
// ①全服务（跨连接共享一个实例）list-sessions/get-recovery 计算并发 ≤limit（默认 2）；
// ②排队超时（默认 5s，从 acquire 起算）→ {ok:false, kind:"timeout"}（调用方转 4409 retryable=true）；
// ③断开取消：未开始（仍在队列）的任务 cancel → {ok:false, kind:"canceled"}；
// ④槽位所有权按任务实例：只有持有者的 release 生效且幂等（旧 finally 不清新任务槽；已执行未结束不假释放）；
// ⑤FIFO 公平推进。
export interface AcquireResult {
  readonly ok: boolean;
  readonly kind?: "timeout" | "canceled";
  release(): void;
}

interface Waiter {
  resolve: (r: AcquireResult) => void;
  timer: unknown;
  canceled: boolean;
  done: boolean;
}

export class ComputeSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly limit = 2,
    private readonly queueTimeoutMs = 5_000,
    private readonly timers: {
      setTimeout?: (cb: () => void, ms: number) => unknown;
      clearTimeout?: (t: unknown) => void;
    } = {},
  ) {}

  private readonly st = (cb: () => void, ms: number): unknown => (this.timers.setTimeout ?? ((c, m) => setTimeout(c, m)))(cb, ms);
  private readonly ct = (t: unknown): void => (this.timers.clearTimeout ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);

  private grant(w: Waiter): void {
    if (w.done) return;
    w.done = true;
    this.ct(w.timer);
    this.active++;
    let released = false;
    w.resolve({
      ok: true,
      release: () => {
        if (released) return; // 幂等（重复 release 不多还槽）
        if (this.active > 0) this.active--;
        released = true;
        this.pump();
      },
    });
  }

  private settle(w: Waiter, kind: "timeout" | "canceled"): void {
    if (w.done) return;
    w.done = true;
    this.ct(w.timer);
    const idx = this.waiters.indexOf(w);
    if (idx >= 0) this.waiters.splice(idx, 1);
    w.resolve({ ok: false, kind, release: () => {} });
  }

  acquire(): { promise: Promise<AcquireResult>; cancel: () => void } {
    const w: Waiter = { resolve: () => {}, timer: null, canceled: false, done: false };
    const promise = new Promise<AcquireResult>((res) => {
      w.resolve = res;
      w.timer = this.st(() => this.settle(w, "timeout"), this.queueTimeoutMs);
    });
    if (this.active < this.limit) {
      this.grant(w);
    } else {
      this.waiters.push(w);
    }
    const cancel = (): void => this.settle(w, "canceled");
    return { promise, cancel };
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w === undefined) break;
      this.grant(w); // grant 内有 done 检查——已超时/取消的残留安全跳过
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }
}
