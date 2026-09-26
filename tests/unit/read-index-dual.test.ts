// 3b-2b②：read-index 按源分流前缀+continueFrom（确定性续编序）。
// 反例集：双源 live 交错编入后，固定源序重扫不得误判换流（分流前缀的动机反例）。
import { describe, expect, it } from "vitest";
import { ReadIndex, scanDigest, type ScanRow } from "../../packages/protocol/src/read-index.ts";
import type { HistoryEvent } from "../../packages/protocol/src/contracts.ts";

function ev(i: number): HistoryEvent {
  return { seq: 0, ts: null, generation: null, intentId: null, kind: "unknown-line" , ...{ n: i } } as unknown as HistoryEvent;
}
function row(source: "journal" | "session", locator: string, n: number): ScanRow {
  return { source, locator, raw: `r-${n}`, event: ev(n) };
}

describe("ReadIndex 3b-2b②——按源分流前缀", () => {
  it("交错编入（journal/session 到达序交错）后固定源序重扫：前缀成立（旧逐位比对会误判换流）", () => {
    const idx = new ReadIndex("f", "s1");
    // live 到达序：j1, s1, j2, s2, j3（交错）
    idx.append("journal", "1", "r-1", ev(1));
    idx.append("session", "10", "r-2", ev(2));
    idx.append("journal", "2", "r-3", ev(3));
    idx.append("session", "20", "r-4", ev(4));
    idx.append("journal", "3", "r-5", ev(5));
    // 全量重扫固定源序：journal 全部在前 session 在后
    const scan = [row("journal", "1", 1), row("journal", "2", 3), row("journal", "3", 5), row("session", "10", 2), row("session", "20", 4)];
    expect(idx.isPrefixOf(scan)).toBe(true);
  });

  it("同源改写（同 locator 原文变）→前缀不成立（换流）；另一源完好不掩盖", () => {
    const idx = new ReadIndex("f", "s1");
    idx.append("journal", "1", "r-1", ev(1));
    idx.append("session", "10", "r-2", ev(2));
    const ok = [row("journal", "1", 1), row("session", "10", 2)];
    expect(idx.isPrefixOf(ok)).toBe(true);
    const rewritten = [{ ...row("journal", "1", 1), raw: "CHANGED" }, row("session", "10", 2)];
    void scanDigest; // digest 语义依赖入口
    expect(idx.isPrefixOf(rewritten)).toBe(false);
    const sRewritten = [row("journal", "1", 1), { ...row("session", "10", 2), raw: "CHANGED" }];
    expect(idx.isPrefixOf(sRewritten)).toBe(false);
  });

  it("单源截断（重扫后该源行数少于已编入）→前缀不成立", () => {
    const idx = new ReadIndex("f", "s1");
    idx.append("journal", "1", "r-1", ev(1));
    idx.append("journal", "2", "r-3", ev(3));
    idx.append("session", "10", "r-2", ev(2));
    // 重扫只剩 journal 1 行 + session 完整（journal 面截断）
    expect(idx.isPrefixOf([row("journal", "1", 1), row("session", "10", 2)])).toBe(false);
  });

  it("continueFrom：按 journal 余量先 session 余量后确定性续编；续编后与全量重扫互为前缀", () => {
    const idx = new ReadIndex("f", "s1");
    idx.append("journal", "1", "r-1", ev(1));
    idx.append("session", "10", "r-2", ev(2));
    const scan = [row("journal", "1", 1), row("journal", "2", 3), row("session", "10", 2), row("session", "20", 4)];
    expect(idx.isPrefixOf(scan)).toBe(true);
    expect(idx.continueFrom(scan)).toBe(2);
    // 续编序=固定源序：journal2 在前（seq 3），session20 在后（seq 4）
    const [j2, s20] = idx.read(1, 10).slice(2);
    expect(j2?.source).toBe("journal");
    expect(j2?.locator).toBe("2");
    expect(s20?.source).toBe("session");
    expect(s20?.locator).toBe("20");
    // 与全量重扫互为前缀：重扫再续编=0（无新行）
    expect(idx.isPrefixOf(scan)).toBe(true);
    expect(idx.continueFrom(scan)).toBe(0);
  });

  it("continueFrom 幂等保护之外：前缀不成立时调用=宿主违约（行为=尾追不前缀），文档化而非防御", () => {
    const idx = new ReadIndex("f", "s1");
    idx.append("journal", "1", "OLD", ev(1));
    const scan = [row("journal", "1", 1)]; // 原文改写
    expect(idx.isPrefixOf(scan)).toBe(false);
    // 宿主义务：不满足前缀走 registry.replace 换流，不得调 continueFrom
    idx.continueFrom(scan); // 违约路径行为不承诺（此调用仅证明不抛错不崩）
    expect(idx.waterMark).toBeGreaterThan(0);
  });
});
