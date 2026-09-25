// FileDurability 受控 fsPort 测试（S4-06）：部分写撕裂/close 不解锁/markRepaired 显式授权/close 串行。
import { describe, expect, it } from "vitest";
import { FileDurability, type DurabilityFsPort, type DurabilityFileHandleLike } from "../../../apps/server/src/runtime/file-durability.js";

interface WritePlan {
  /** 本次 write 吸收的字节数（缺省=全量）；小于缓冲长度=部分写。 */
  readonly bytes?: number;
  /** 本次 write 抛错（部分写后失败：bytes 先计入再抛）。 */
  readonly error?: Error;
}

/** 受控 fs：逐事件序+逐写计划+可挂 datasync。chunks 以 Buffer 保存（Y-C3/s4c：跨多字节边界
 *  的字节证据——toString 在撕裂尾会把不完整 UTF-8 序列圆整成替换符，掊盖字节级错位）。 */
class FakeFs implements DurabilityFsPort {
  readonly chunks: Buffer[] = [];
  readonly events: string[] = [];
  readonly dirSyncs: string[] = [];
  writes: WritePlan[] = [];
  datasyncHang = false;
  closeCalls = 0;
  syncDirError: Error | null = null;
  private datasyncWaiters: Array<() => void> = [];

  async open(): Promise<DurabilityFileHandleLike> {
    this.events.push("open");
    let wi = 0;
    const write = async (buf: Buffer, offset?: number): Promise<{ bytesWritten: number }> => {
      this.events.push("write");
      const plan = this.writes[wi++] as WritePlan | undefined;
      const start = offset ?? 0; // Y2（s4b）：尊重 offset——部分写重试须从剩余字节起算，不重写已落字节
      const n = Math.min(plan?.bytes ?? buf.length - start, buf.length - start);
      this.chunks.push(Buffer.from(buf.subarray(start, start + n)));
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

  async syncDir(dirPath: string): Promise<void> {
    this.events.push("dirsync");
    this.dirSyncs.push(dirPath);
    if (this.syncDirError !== null) throw this.syncDirError;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
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
    let a1Done = false;
    void a1.then(() => {
      a1Done = true;
    });
    await new Promise((r) => setTimeout(r, 10)); // 进入 datasync 挂起
    const closeP = dur.close(); // 排队：等 a1 完成（close 先兑现=未串行）
    const a2 = dur.append(line("sending")); // close 同步置位：新任务立即拒（但队列推进须等前序）
    fs.releaseDatasync(); // 先释放：a1→close→a2 依序兑现
    await closeP;
    expect(a1Done).toBe(true); // close 完成前 a1 必已落定（串行证据）
    await a1;
    await expect(a2).rejects.toThrow(/已关闭|失败态/);
    expect(fs.events).toEqual(["open", "write", "datasync", "dirsync", "close"]); // 首写含目录同步（R3）
    expect(fs.closeCalls).toBe(1);
  });

  it("零进展保护（Y3）：write 返回 0 字节→报错不进死循环", async () => {
    const fs = new FakeFs();
    fs.writes = [{ bytes: 0 }];
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await expect(dur.append(line("enqueue"))).rejects.toThrow(/零进展/);
  });

  it("S4-B3a 同段 append→close：已接收 append 照常完成（close 只拦后来调用）", async () => {
    const fs = new FakeFs();
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    const a = dur.append(line("enqueue")); // 已接收（旧代码：run 内查 closed 而 close 同步置位→误拒）
    const c = dur.close(); // 同一同步段紧随
    await a; // 不得 reject「已关闭」
    await c;
    expect(fs.text()).toBe(`${JSON.stringify(line("enqueue"))}\n`);
    expect(fs.events).toEqual(["open", "write", "datasync", "dirsync", "close"]); // 首写含目录同步（R3）
    await expect(dur.append(line("sending"))).rejects.toThrow(/已关闭/); // close 后新调用仍拒
  });

  it("S4-B3b 挂起中 append×2→close：两任务都完成，close 后才关 fd", async () => {
    const fs = new FakeFs();
    fs.datasyncHang = true;
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    const a1 = dur.append(line("enqueue"));
    const a2 = dur.append(line("sending")); // 排队（尚未执行）
    const c = dur.close();
    await new Promise((r) => setTimeout(r, 10)); // 确保都已在队列里
    fs.datasyncHang = false; // 后续 datasync 不再挂（只挂第一次）
    fs.releaseDatasync();
    await a1; // 两任务都完成
    await a2;
    await c;
    expect(fs.text()).toBe(`${JSON.stringify(line("enqueue"))}\n${JSON.stringify(line("sending"))}\n`);
    expect(fs.events).toEqual(["open", "write", "datasync", "dirsync", "write", "datasync", "close"]); // dirsync 仅首写（R3）
    expect(fs.closeCalls).toBe(1);
  });

  it("R3a 目录同步恰一次：首次成功追加后同步父目录，后续追加不再（文件名条目耐久边界）", async () => {
    const fs = new FakeFs();
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await dur.append(line("enqueue"));
    await dur.append(line("sending"));
    await dur.close();
    expect(fs.dirSyncs).toEqual(["/fake"]); // 恰一次+路径=父目录
    expect(fs.events.filter((e) => e === "dirsync")).toHaveLength(1);
  });

  it("R3b 目录同步失败=fail-closed：本次 append 拒绝+失败态置位（不确认未同步的文件名）", async () => {
    const fs = new FakeFs();
    fs.syncDirError = new Error("EIO: 目录同步失败");
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await expect(dur.append(line("enqueue"))).rejects.toThrow(/EIO/);
    await expect(dur.append(line("sending"))).rejects.toThrow(/失败态/); // 未修复不得续写
    expect(fs.dirSyncs).toEqual(["/fake"]);
    dur.markRepaired();
    fs.syncDirError = null;
    await dur.append(line("sending")); // 修复+故障排除后：重试成功且完成目录同步（dirSynced 仅成功置位）
    expect(fs.dirSyncs).toEqual(["/fake", "/fake"]);
    await dur.close();
  });

  it("Y2 部分写重试字节正确性：offset 尊重，盘面逐字节无重写/无丢字节", async () => {
    const fs = new FakeFs();
    fs.writes = [{ bytes: 4 }, { bytes: 2 }]; // 第一次吸收 4 字节，重试再吸收 2 字节，第三次余量
    const dur = new FileDurability("/fake/j.jsonl", { fsPort: fs });
    await dur.append(line("enqueue"));
    expect(fs.text()).toBe(`${JSON.stringify(line("enqueue"))}\n`); // 逐字节与完整行一致（无重复前缀）
    expect(fs.events.filter((e) => e === "write").length).toBe(3);
  });
});
