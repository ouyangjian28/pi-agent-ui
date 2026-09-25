// 会话列表扫描测试（§6 查看≠接管）：真 tmpdir IO；r8-03 坏 header 不吞行；r8-04 身份=header.id 与文件定位键分离
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions, watchSessions } from "../../../apps/server/src/host/session-list.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pau-sessions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 真实 pi v3 命名格式：${fileTimestamp}_${sessionId}.jsonl（≠会话身份；身份=header.id）
const FILE_A = "2026-09-25T01-00-00-000Z_s-uuid-a.jsonl";
const FILE_B = "2026-09-25T02-00-00-000Z_s-uuid-b.jsonl";

const header = (id: string) =>
  `{"type":"session","version":3,"id":"${id}","timestamp":"2026-09-25T01:00:00.000Z","cwd":"/tmp"}\n`;
const userMsg = (text: string, ts: string) =>
  `{"type":"message","id":"m1","parentId":null,"timestamp":"${ts}","message":{"role":"user","content":[{"type":"text","text":"${text}"}]}}\n`;

describe("会话列表扫描（真 IO）", () => {
  it("身份=header.id（r8-04：文件名≠身份）；file=独立定位键；倒序+首个 user 标题", async () => {
    await writeFile(join(dir, FILE_A), header("s-uuid-a") + userMsg("第一个会话的问题", "2026-09-25T01:00:05.000Z"));
    await writeFile(join(dir, FILE_B), header("s-uuid-b") + userMsg("第二个会话", "2026-09-25T02:00:05.000Z"));
    const list = await listSessions(dir);
    expect(list).toHaveLength(2);
    expect(list[0]!.file).toBe(FILE_B); // 02:00 活动在前
    expect(list[0]!.sessionId).toBe("s-uuid-b"); // 身份来自 header.id，非文件名
    expect(list[0]!.title).toBe("第二个会话");
    expect(list[1]!.sessionId).toBe("s-uuid-a");
    expect(list[1]!.title).toBe("第一个会话的问题");
    expect(list[1]!.entryCount).toBe(1);
  });

  it("r8-03 必修：坏 header 不吞下一条——正常 user/assistant 仍计 entry，标题取首个 user，身份=null 显式呈现", async () => {
    const torn = '{"type":"sess'; // 坏首行（撕裂 header）
    const assistant = `{"type":"message","timestamp":"2026-09-25T01:00:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}\n`;
    await writeFile(join(dir, FILE_A), torn + "\n" + userMsg("坏 header 后的第一条 user", "2026-09-25T01:00:06.000Z") + assistant);
    const list = await listSessions(dir);
    expect(list).toHaveLength(1);
    const s = list[0]!;
    expect(s.sessionId).toBeNull(); // 身份损坏=显式 null（上层降级），不得冒充
    expect(s.title).toBe("坏 header 后的第一条 user"); // 正常 entry 未被吞为 header
    expect(s.entryCount).toBe(2); // user+assistant 都计入
  });

  it("r8-03：首行可解析但非 session header（截断/损坏）→按正文计，不吞", async () => {
    await writeFile(join(dir, FILE_A), userMsg("无 header 文件的首条", "2026-09-25T01:00:06.000Z"));
    const list = await listSessions(dir);
    expect(list[0]!.sessionId).toBeNull();
    expect(list[0]!.title).toBe("无 header 文件的首条");
    expect(list[0]!.entryCount).toBe(1);
  });

  it("纯 header 文件：活动时刻取 header.timestamp，标题=(无标题)", async () => {
    await writeFile(join(dir, FILE_A), header("s-uuid-a"));
    const list = await listSessions(dir);
    expect(list[0]!.entryCount).toBe(0);
    expect(list[0]!.title).toBe("(无标题)");
    expect(list[0]!.lastActiveMs).toBe(Date.parse("2026-09-25T01:00:00.000Z"));
  });

  it("撕裂尾（末行半 JSON）跳过不炸；无 user 时默认标题；titleMax 截断", async () => {
    const long = "很长的标题".repeat(30);
    await writeFile(
      join(dir, FILE_A),
      header("s-uuid-a") + userMsg(long, "2026-09-25T01:00:05.000Z") + '{"type":"message","timestamp":"2026-09-25T01:00:06.000Z"',
    );
    const list = await listSessions(dir, { titleMaxChars: 20 });
    expect(list[0]!.title.length).toBeLessThanOrEqual(21); // 20 字+省略号
    expect(list[0]!.title.endsWith("…")).toBe(true);
    expect(list[0]!.entryCount).toBe(1); // 撕裂尾不计

    await writeFile(join(dir, FILE_B), header("s-uuid-b") + assistantOnly());
    const list2 = await listSessions(dir);
    const b = list2.find((s) => s.file === FILE_B)!;
    expect(b.title).toBe("(无标题)"); // 无 user=默认标题
  });

  it("limit 上限（倒序截尾）", async () => {
    for (let i = 0; i < 3; i++) {
      await writeFile(
        join(dir, `2026-09-25T0${i}-00-00-000Z_s-${i}.jsonl`),
        header(`s-${i}`) + userMsg(`会话${i}`, `2026-09-25T0${i}:00:05.000Z`),
      );
    }
    const list = await listSessions(dir, { limit: 2 });
    expect(list).toHaveLength(2);
    expect(list[0]!.sessionId).toBe("s-2"); // 最新的保留
    expect(list[1]!.sessionId).toBe("s-1");
  });

  it("目录不存在=空列表；非 .jsonl 文件忽略；多 user 取首个", async () => {
    expect(await listSessions(join(dir, "nope"))).toEqual([]);
    await writeFile(join(dir, "note.txt"), "x");
    await writeFile(
      join(dir, FILE_A),
      header("s-uuid-a") + userMsg("第一条 user", "2026-09-25T01:00:05.000Z") + userMsg("第二条 user 不覆盖标题", "2026-09-25T01:00:06.000Z"),
    );
    const list = await listSessions(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("第一条 user"); // 首个 user 定标题，后续不覆盖
    expect(list[0]!.entryCount).toBe(2);
  });

  it("fs.watch 变化门铃：新 .jsonl 文件出现触发回调（rename；可能=新增/删除/替换，调用方重扫确认）", async () => {
    const seen: string[] = [];
    const w = watchSessions(dir, (f) => seen.push(f));
    expect(w).not.toBeNull();
    await writeFile(join(dir, FILE_A), header("s-uuid-a") + userMsg("新会话", "2026-09-25T03:00:05.000Z"));
    await new Promise((r) => setTimeout(r, 120)); // 等 watch 事件（真 fs.watch，非 mock）
    w!.close();
    expect(seen.some((f) => f === FILE_A)).toBe(true);
  }, 5000);
});

function assistantOnly(): string {
  return `{"type":"message","timestamp":"2026-09-25T02:00:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}\n`;
}
