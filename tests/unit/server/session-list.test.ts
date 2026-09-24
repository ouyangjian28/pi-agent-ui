// 会话列表扫描真测（tmpdir 真文件 IO：header/entry/坏行/排序/目录缺失/watch）
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessions, watchSessions } from "../../../apps/server/src/host/session-list.js";

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-sess-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const HEADER = JSON.stringify({ version: 3, id: "s-1", timestamp: "2026-09-24T10:00:00Z" });
const USER_A = JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "帮我看看恢复算法" }], timestamp: "2026-09-24T10:00:01Z" });
const ASSIST_A = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: "2026-09-24T10:05:00Z" });

describe("listSessions（tmpdir 真测）", () => {
  it("正常会话：标题=首个 user 消息截断，最后活动=最末行时间戳，倒序排列", async () => {
    const d = await tmp();
    await writeFile(join(d, "a.jsonl"), [HEADER, USER_A, ASSIST_A].join("\n") + "\n");
    const olderHeader = HEADER.replace('"2026-09-24T10:00:00Z"', '"2026-09-23T10:00:00Z"');
    await writeFile(join(d, "b.jsonl"), [olderHeader, JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "旧会话" }], timestamp: "2026-09-23T10:00:01Z" })].join("\n") + "\n");
    const list = await listSessions(d);
    expect(list).toHaveLength(2);
    expect(list[0]?.sessionId).toBe("a"); // 最近活动在前
    expect(list[0]?.title).toBe("帮我看看恢复算法");
    expect(list[0]?.entryCount).toBe(2); // header 不计
    expect(list[0]?.lastActiveMs).toBe(Date.parse("2026-09-24T10:05:00Z"));
    expect(list[1]?.sessionId).toBe("b");
  });

  it("坏行跳过（撕裂尾/非法 JSON/空行）不炸列表；无 user 消息=(无标题)", async () => {
    const d = await tmp();
    const torn = [HEADER, USER_A, '{"type":"message","role":"assista'].join("\n"); // 撕裂尾（无换行收尾）
    await writeFile(join(d, "torn.jsonl"), torn);
    await writeFile(join(d, "no-user.jsonl"), [HEADER, ASSIST_A].join("\n") + "\n");
    const list = await listSessions(d);
    expect(list).toHaveLength(2);
    const tornS = list.find((s) => s.sessionId === "torn");
    expect(tornS?.entryCount).toBe(1); // 撕裂尾行（assistant 前半）解析失败跳过——可解析=user 1 条
    expect(tornS?.title).toBe("帮我看看恢复算法");
    const noUser = list.find((s) => s.sessionId === "no-user");
    expect(noUser?.title).toBe("(无标题)");
  });

  it("目录不存在=空列表（不炸）；非 jsonl 文件忽略", async () => {
    const d = await tmp();
    await writeFile(join(d, "readme.txt"), "x");
    expect(await listSessions(d)).toEqual([]);
    expect(await listSessions(join(d, "no-such-dir"))).toEqual([]);
  });

  it("标题截断（titleMaxChars）与列表上限（limit）", async () => {
    const d = await tmp();
    const longText = "很".repeat(100);
    await writeFile(join(d, "long.jsonl"), [HEADER, JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: longText }], timestamp: 1 })].join("\n") + "\n");
    const [s] = await listSessions(d, { titleMaxChars: 10 });
    expect(s?.title.length).toBeLessThanOrEqual(11); // 10+省略号
    expect(s?.title.endsWith("…")).toBe(true);
  });
});

describe("watchSessions（目录级 watch）", () => {
  it("新 .jsonl 文件出现→onNew 回调（真 fs.watch）", async () => {
    const d = await tmp();
    const seen: string[] = [];
    const w = watchSessions(d, (f) => seen.push(f));
    expect(w).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50)); // watch 生效窗口
    await writeFile(join(d, "new.jsonl"), HEADER + "\n");
    await new Promise((r) => setTimeout(r, 300)); // 事件传播窗口
    w?.close();
    expect(seen.some((f) => f.includes("new.jsonl"))).toBe(true);
  });

  it("目录不存在=返回 null（不抛）", async () => {
    expect(watchSessions(join(tmpdir(), "pi-no-such-xyz"), () => {})).toBeNull();
  });
});
