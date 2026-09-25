// FileDurability 受控 fsPort 测试（S4-06）：部分写撕裂/close 不解锁/markRepaired 显式授权/close 串行。
import { describe, expect, it } from "vitest";
import { FileDurability, type DurabilityFsPort, type DurabilityFileHandleLike } from "../../../apps/server/src/runtime/file-durability.js";

interface WritePlan {
  /** 本次 write 吸收的字节数（缺省=全量）；小于缓冲长度=部分写。 */
  readonly bytes?: number;
  /** 本次 write 抛错（部分写后失败：bytes 先计入再抛）。 */
  readonly error?: Error;
}

/** 受控 fs：逐事件序+逐写计划+可挂 datasync。 */
class FakeFs implements DurabilityFsPort {
  readonly chunks: string[] = [];
  readonly events: string[] = [];
  writes: WritePlan[] = [];
  datasyncHang = false;
  closeCalls = 0;
  private datasyncWaiters: Array<() => void> = [];

  async open(): Promise<DurabilityFileHandleLike> {
    this.events.push("open");
    let wi = 0;
    const write = async (buf: Buffer): Promise<{ bytesWritten: number }> => {
      this.events.push("write");
      const plan = this.writes[wi++] as WritePlan | undefined;
      const n = plan?.bytes ?? buf.length;
      this.chunks.push(buf.subarray(0, n).toString("utf8"));
      if (plan?.error) throw plan.error;
      return { bytesWritten: n };
    };
    const datasync = async (): Promise<void> => {
      this.events.push("datasync");
      if (this.datasyncHang) await new Promise<void>((r) => this.datasyncWaiters.push(r));
    };
    const close = async (): Promise<void> => {
      this.closeCalls += 1;
      this.events.push("close");
    };
    return { write, datasync, close };
  }

  releaseDatasync(): void {
    this.datasyncWaiters.splice(0).forEach((r) => r());
  }

  text(): string {
    return this.chunks.join("");
  }
}

const line = (t: string): never => ({ t }) as never;

describe("FileDurability（受控 fsPort）", () => {
  it("S4-06a 部分写失败→撕裂尾；close 不解锁：续写拒绝，盘面不再推进（GPT P9）", async () => {
    const fs = new FakeFs();
    fs.writes = [{ bytes: 3, error: Object.assign(new Error("ENOSPC: 磁盘满"), { code: "ENOSPC" }) }];
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await expect(dur.append(line("enqueue"))).rejects.toThrow(/ENOSPC/);
    expect(fs.text()).toBe('{"t'); // 撕裂尾（部分行已在盘）
    await dur.close(); // 关闭≠修复授权
    await expect(dur.append(line("sending"))).rejects.toThrow(/已关闭|失败态/);
    expect(fs.text()).toBe('{"t'); // 无新写入：P9 的成功续写不再发生
    expect(fs.closeCalls).toBe(1);
  });

  it("S4-06b markRepaired 显式授权：解锁后续写可用（授权证据归宿主）", async () => {
    const fs = new FakeFs();
    fs.writes = [{ bytes: 3, error: Object.assign(new Error("ENOSPC: 磁盘满"), { code: "ENOSPC" }) }];
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await expect(dur.append(line("enqueue"))).rejects.toThrow(/ENOSPC/);
    dur.markRepaired(); // 宿主完成尾部修复/换段裁决后的显式解锁
    await dur.append(line("sending")); // 成功（fake 已无故障计划）
    expect(fs.text()).toContain('"t":"sending"');
    await dur.close();
  });

  it("S4-06c close 串行：挂起的 append 先完成，close 后才关 fd；close 后新 append 拒绝", async () => {
    const fs = new FakeFs();
    fs.datasyncHang = true; // 第一次 append 挂在 datasync
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    const a1 = dur.append(line("enqueue"));
    await new Promise((r) => setTimeout(r, 10)); // 进入 datasync 挂起
    const closeP = dur.close(); // 排队：等 a1 完成
    const a2 = dur.append(line("sending")); // close 同步置位：新任务立即拒（但队列推进须等前序）
    fs.releaseDatasync(); // 先释放：a1→close→a2 依序兑现
    await a1;
    await expect(a2).rejects.toThrow(/已关闭|失败态/);
    await closeP;
    expect(fs.events).toEqual(["open", "write", "datasync", "close"]); // close 在已接收 append 之后
    expect(fs.closeCalls).toBe(1);
  });

  it("零进展保护（Y3）：write 返回 0 字节→报错不进死循环", async () => {
    const fs = new FakeFs();
    fs.writes = [{ bytes: 0 }];
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await expect(dur.append(line("enqueue"))).rejects.toThrow(/零进展/);
  });
});
