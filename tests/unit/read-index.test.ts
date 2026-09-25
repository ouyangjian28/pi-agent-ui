// c5 B02：读索引不变量——坐标统一/内容摘要换流/boot 隔离 ID/触顶卸载/LRU 触达刷新。
import { describe, expect, it } from "vitest";
import { ReadIndex, ReadIndexRegistry, scanDigest, type HistoryEvent } from "@pi-agent-ui/protocol";

function ev(seq: number): HistoryEvent { return { kind: "sending", seq, ts: null, generation: null, intentId: null }; }

describe("读索引不变量（c5 B02）", () => {
  it("append 原子赋 seq：输入携带 seq 被覆盖统一（坐标不分裂）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    const r = idx.append("journal", "L1", ev(99)); // 恶意/陈旧输入 seq=99
    expect(r).toBe(1);
    expect(idx.read(1, 1, 1)[0]?.event.seq).toBe(1); // 索引与事件坐标恒一致
    const r2 = idx.append("journal", "L2", ev(2));
    expect(r2).toBe(2);
  });

  it("内容摘要：同位改写（同 locator 不同内容）→isPrefixOf=false（换流）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    idx.append("journal", "L1", ev(1));
    idx.append("journal", "L2", ev(2));
    // 当前盘面重扫：L1 内容被改写（ locator 同、事件不同）
    const scan = [
      { source: "journal" as const, locator: "L1", event: ev(1) },
      { source: "journal" as const, locator: "L2", event: { ...ev(2), intentId: "i-changed" } },
    ];
    expect(idx.isPrefixOf(scan)).toBe(false); // 位置+locator 同但摘要不同→换流
    // 未改写→true
    const scan2 = [
      { source: "journal" as const, locator: "L1", event: ev(1) },
      { source: "journal" as const, locator: "L2", event: ev(2) },
    ];
    expect(idx.isPrefixOf(scan2)).toBe(true);
    // 截短（索引有 3 条、盘面只 2 条）→false
    idx.append("journal", "L3", ev(3));
    expect(idx.isPrefixOf(scan2)).toBe(false);
  });

  it("scanDigest：源+定位+事件投影三要素参与（同事件不同 locator→不同摘要）", () => {
    const a = scanDigest({ source: "journal", locator: "L1", event: ev(1) });
    const b = scanDigest({ source: "session", locator: "L1", event: ev(1) });
    const c = scanDigest({ source: "journal", locator: "L2", event: ev(1) });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(scanDigest({ source: "journal", locator: "L1", event: ev(1) }));
  });

  it("boot 隔离：注册表 ID=注入随机源（两次 boot 不同流 ID，不随注册序重放）", () => {
    const reg = new ReadIndexRegistry(() => "boot1-x");
    const a = reg.get("s.jsonl");
    const reg2 = new ReadIndexRegistry(() => "boot2-y");
    const b = reg2.get("s.jsonl");
    expect(a.streamId).toBe("boot1-x");
    expect(b.streamId).toBe("boot2-y");
    expect(a.streamId).not.toBe(b.streamId); // 跨 boot 不重放 s-1
  });

  it("触顶卸载：get 发现 overBudget→废弃换新流（有限出口）+get 触达即 LRU 刷新", () => {
    const reg = new ReadIndexRegistry(() => `id-${Math.random().toString(16).slice(2, 8)}`, { maxStreams: 2 }, { maxEventsPerStream: 3 });
    const a = reg.get("a.jsonl");
    a.append("journal", "L1", ev(1));
    reg.get("b.jsonl");
    reg.get("c.jsonl"); // maxStreams=2：c 的 get 挤出最久未访问（a 或 b）
    expect(reg.size).toBe(2);
    // 单流超事件数：get 返回新流（旧流废弃；有限出口不循环重扫）
    const d = reg.get("d.jsonl");
    d.append("journal", "L1", ev(1));
    d.append("journal", "L2", ev(2));
    d.append("journal", "L3", ev(3));
    expect(d.overBudget).toBe(false); // =3 未超
    d.append("journal", "L4", ev(4));
    expect(d.overBudget).toBe(true);
    const d2 = reg.get("d.jsonl"); // 触顶→get 废弃换新
    expect(d2.overBudget).toBe(false);
    expect(d2.streamId).not.toBe(d.streamId);
  });

  it("replace：文件替换→换流（新 streamId+空索引）", () => {
    let n = 0;
    const reg = new ReadIndexRegistry(() => `id-${++n}`);
    const a = reg.get("s.jsonl");
    a.append("journal", "L1", ev(1));
    reg.replace("s.jsonl"); // 废弃旧流
    const b = reg.get("s.jsonl");
    expect(b.streamId).not.toBe(a.streamId);
    expect(b.waterMark).toBe(0);
    expect(reg.get("s.jsonl").streamId).toBe(b.streamId); // 稳定复用
  });
});
