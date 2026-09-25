// recover.ts 受控单测（切片4c）：撕裂尾/坏行/判据分档——变异面（真 pi E2E 只作接线证据）。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournalFile, buildRecoverReport, recoverFromJournal } from "../../../apps/server/src/runtime/recover.js";
import type { JournalLine } from "@pi-agent-ui/protocol";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeJournal(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recover-"));
  dirs.push(dir);
  const p = join(dir, "journal.jsonl");
  await writeFile(p, lines.join("\n"), "utf8");
  return p;
}

const enq = (id: string): string =>
  JSON.stringify({ t: "enqueue", intentId: id, sessionId: "s1", generation: 1, leafId: `leaf-${id}`, matchKey: { textHash: `h-${id}`, attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: id, attachments: [], sentAt: "t" } });

describe("recover（恢复入口受控面）", () => {
  it("完整两轮（enqueue/sending/settled）：无坏行、两轮已结算、无效果未知", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"}', '{"t":"settled","intentId":"i-1"}', enq("i-2"), '{"t":"sending","intentId":"i-2"}', '{"t":"settled","intentId":"i-2"}', ""]);
    const r = await recoverFromJournal(p, "s1");
    expect(r.bad).toEqual([]);
    expect(r.intents.map((x) => x.intentId)).toEqual(["i-1", "i-2"]);
    expect(r.settledCount).toBe(2);
    expect(r.unknownEffect).toEqual([]);
    expect(r.resumable).toEqual([]);
  });

  it("撕裂尾：末段无换行→partialTail 坏行、好行保留（写入中断=效果未知面）", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"']);
    // writeFile 用 \n join：末段=半行 JSON 无尾换行
    const r = await readJournalFile(p);
    expect(r.lines.map((l) => (l as { t: string }).t)).toEqual(["enqueue"]); // sending 半行不入好行
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0]?.partialTail).toBe(true);
    expect(r.bad[0]?.raw).toContain("sending");
  });

  it("坏行分型：完整行但 JSON 损坏/无 t 字段→partialTail=false；空行跳过不判坏", async () => {
    const p = await writeJournal([enq("i-1"), '{"broken": ', '{"t":123}', "", '{"t":"sending","intentId":"i-1"}', '{"t":"settled","intentId":"i-1"}', ""]);
    const r = await readJournalFile(p);
    expect(r.lines.map((l) => (l as { t: string }).t)).toEqual(["enqueue", "sending", "settled"]);
    expect(r.bad).toHaveLength(2);
    expect(r.bad.map((b) => b.partialTail)).toEqual([false, false]);
    expect(r.bad[0]?.error).toContain("JSON 解析失败");
    expect(r.bad[1]?.error).toContain("无 t 字段");
  });

  it("效果未知三分档：sending 无终态/超时未结算/已判 unknown；非 sending 无终态=可重发", async () => {
    const lines: JournalLine[] = [
      JSON.parse(enq("i-1")) as JournalLine,
      { t: "sending", intentId: "i-1" }, // 写后中断：sending 无终态
      JSON.parse(enq("i-2")) as JournalLine,
      { t: "sending", intentId: "i-2" },
      { t: "response-timeout", intentId: "i-2", generation: 1, commandId: 2 }, // 超时未结算
      JSON.parse(enq("i-3")) as JournalLine,
      { t: "sending", intentId: "i-3" },
      { t: "unknown", intentId: "i-3", reason: "写后中断" }, // 已判 unknown
      JSON.parse(enq("i-4")) as JournalLine, // 受理未发送：resumable
    ];
    const r = buildRecoverReport(lines, "s1");
    expect(r.unknownEffect).toEqual(["i-1", "i-2", "i-3"]);
    expect(r.resumable).toEqual(["i-4"]);
    expect(r.settledCount).toBe(0);
  });

  it("会话过滤：他 session 的 enqueue 行不进重放（跨会话 journal 隔离）", async () => {
    const other = JSON.parse(enq("i-x")) as { sessionId: string } & JournalLine;
    other.sessionId = "other";
    const lines: JournalLine[] = [other as JournalLine, JSON.parse(enq("i-1")) as JournalLine];
    const r = buildRecoverReport(lines, "s1");
    expect(r.intents.map((x) => x.intentId)).toEqual(["i-1"]);
  });

  it("cancelled+delivered 终态：cancelled 不算效果未知也不算可重发（幂等面已终局）", async () => {
    const lines: JournalLine[] = [
      JSON.parse(enq("i-1")) as JournalLine,
      { t: "cancelled", intentId: "i-1" },
      JSON.parse(enq("i-2")) as JournalLine,
      { t: "sending", intentId: "i-2" },
      { t: "delivered", intentId: "i-2" },
    ];
    const r = buildRecoverReport(lines, "s1");
    expect(r.unknownEffect).toEqual([]); // cancelled/delivered 均有终局
    expect(r.resumable).toEqual([]);
  });
});
