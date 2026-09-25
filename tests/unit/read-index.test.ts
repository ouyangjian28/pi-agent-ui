// c5 B02：读索引不变量——坐标统一/内容摘要换流/boot 隔离 ID/触顶卸载/LRU 触达刷新。
import { describe, expect, it } from "vitest";
import { ReadIndex, ReadIndexRegistry, scanDigest, type HistoryEvent } from "@pi-agent-ui/protocol";

function ev(seq: number): HistoryEvent { return { kind: "sending", seq, ts: null, generation: null, intentId: null }; }

describe("读索引不变量（c5 B02）", () => {
  it("append 原子赋 seq：输入携带 seq 被覆盖统一（坐标不分裂）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    const r = idx.append("journal", "L1", "L1", ev(99)); // 恶意/陈旧输入 seq=99
    expect(r).toBe(1);
    expect(idx.read(1, 1, 1)[0]?.event.seq).toBe(1); // 索引与事件坐标恒一致
    const r2 = idx.append("journal", "L2", "L2", ev(2));
    expect(r2).toBe(2);
  });

  it("内容摘要：同位改写（同 locator 不同内容）→isPrefixOf=false（换流）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    idx.append("journal", "L1", '{"t":"settled","intentId":"i-1","url":"https://old.example/secret"}', ev(1));
    idx.append("journal", "L2", "L2", ev(2));
    // 当前盘面重扫：L1 内容被改写（ locator 同、事件不同）
    // C5-02 实测反例：原文改写但**投影相同**（脱敏抹平型）——投影摘要会漏检，原始摘要不会
    const scan = [
      { source: "journal" as const, locator: "L1", raw: '{"t":"settled","intentId":"i-1","url":"https://old.example/secret"}', event: ev(1) },
      { source: "journal" as const, locator: "L2", raw: "L2", event: ev(2) },
    ];
    expect(idx.isPrefixOf(scan)).toBe(true); // L1 原文未变（raw 同）→可续读（L2 同）
    // 同 locator 原文改写（脱敏后投影仍相同）→原始摘要不等→换流
    const scanMutated = [
      { source: "journal" as const, locator: "L1", raw: '{"t":"settled","intentId":"i-1","url":"https://new.example/different"}', event: ev(1) },
      { source: "journal" as const, locator: "L2", raw: "L2", event: ev(2) },
    ];
    expect(idx.isPrefixOf(scanMutated)).toBe(false); // 投影同也拦（原始证据）
    // 未改写→true（raw 逐字节相同）
    const scan2 = [
      { source: "journal" as const, locator: "L1", raw: '{"t":"settled","intentId":"i-1","url":"https://old.example/secret"}', event: ev(1) },
      { source: "journal" as const, locator: "L2", raw: "L2", event: ev(2) },
    ];
    expect(idx.isPrefixOf(scan2)).toBe(true);
    // 截短（索引有 3 条、盘面只 2 条）→false
    idx.append("journal", "L3", "L3", ev(3));
    expect(idx.isPrefixOf(scan2)).toBe(false);
  });

  it("scanDigest：源+定位+原始行三要素参与（同投影不同 raw→不同摘要；同 raw 稳定）", () => {
    const a = scanDigest({ source: "journal", locator: "L1", raw: "R1", event: ev(1) });
    const b = scanDigest({ source: "session", locator: "L1", raw: "R1", event: ev(1) });
    const c = scanDigest({ source: "journal", locator: "L2", raw: "R1", event: ev(1) });
    const d = scanDigest({ source: "journal", locator: "L1", raw: "R1-x", event: ev(1) });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d); // 原始行差异参与（投影同也分）
    expect(a).toBe(scanDigest({ source: "journal", locator: "L1", raw: "R1", event: ev(99) })); // 投影不参与
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
    a.append("journal", "L1", "L1", ev(1));
    reg.get("b.jsonl");
    reg.get("c.jsonl"); // maxStreams=2：c 的 get 挤出最久未访问（a 或 b）
    expect(reg.size).toBe(2);
    // 单流超事件数：get 返回新流（旧流废弃；有限出口不循环重扫）
    const d = reg.get("d.jsonl");
    d.append("journal", "L1", "L1", ev(1));
    d.append("journal", "L2", "L2", ev(2));
    d.append("journal", "L3", "L3", ev(3));
    expect(d.overBudget).toBe(false); // =3 未超
    d.append("journal", "L4", "L4", ev(4));
    expect(d.overBudget).toBe(true);
    const d2 = reg.get("d.jsonl"); // 触顶→get 废弃换新（唯一一次宽容）
    expect(d2.overBudget).toBe(false);
    expect(d2.streamId).not.toBe(d.streamId);
    // C5-02 有限重扫：新流再触顶→同文件第二次 get 拒绝（FileOverBudgetError；不再空流掩盖）
    for (let i = 1; i <= 4; i++) d2.append("journal", `L${i}`, `L${i}`, ev(i));
    expect(d2.overBudget).toBe(true);
    expect(() => reg.get("d.jsonl")).toThrowError(/over budget/);
  });

  it("C6-03：首次触顶换流后——空流/预算内 get 恒放行（不因历史触顶记录误拒）；现流再触顶才拒", () => {
    const reg = new ReadIndexRegistry(() => `id-${Math.random().toString(16).slice(2, 8)}`, { maxStreams: 2 }, { maxEventsPerStream: 3 });
    const a = reg.get("a.jsonl");
    for (let i = 1; i <= 4; i++) a.append("journal", `L${i}`, `L${i}`, ev(i));
    const a2 = reg.get("a.jsonl"); // 首次触顶→换流（宽容额度消耗）
    expect(a2.overBudget).toBe(false);
    // 空流反复 get：恒放行（旧实现第二次 get 即 throw——新流从未被允许填充）
    expect(reg.get("a.jsonl")).toBe(a2);
    expect(reg.get("a.jsonl")).toBe(a2);
    // 预算内填充照常
    a2.append("journal", "L1", "L1", ev(1));
    expect(reg.get("a.jsonl").overBudget).toBe(false);
    // 现流再触顶（额度已用）→拒绝（有限出口不变）
    a2.append("journal", "L2", "L2", ev(2));
    a2.append("journal", "L3", "L3", ev(3));
    a2.append("journal", "L4", "L4", ev(4));
    expect(a2.overBudget).toBe(true);
    expect(() => reg.get("a.jsonl")).toThrowError(/over budget/);
  });

  it("boot 默认流 ID：crypto 随机源唯一（两次构造不同 id，非注册序重放）", () => {
    const reg = new ReadIndexRegistry(); // 默认 newId=crypto.getRandomValues
    const a = reg.get("a.jsonl");
    const b = reg.get("b.jsonl");
    expect(a.streamId).toMatch(/^s-[0-9a-f]{32}$/); // 16B hex
    expect(a.streamId).not.toBe(b.streamId); // 唯一性（非 s-1/s-2 计数）
  });

  it("replace：文件替换→换流（新 streamId+空索引）", () => {
    let n = 0;
    const reg = new ReadIndexRegistry(() => `id-${++n}`);
    const a = reg.get("s.jsonl");
    a.append("journal", "L1", "L1", ev(1));
    reg.replace("s.jsonl"); // 废弃旧流
    const b = reg.get("s.jsonl");
    expect(b.streamId).not.toBe(a.streamId);
    expect(b.waterMark).toBe(0);
    expect(reg.get("s.jsonl").streamId).toBe(b.streamId); // 稳定复用
  });
});
