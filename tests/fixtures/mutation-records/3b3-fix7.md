# 3b3-fix7 变异验证档（GPT fix6 复审 84/100 NO-GO 修复轮；2026-10-01）

基线（fix7 终态）：apps/server/src/runtime/history-source.ts sha256=cc084943ef833fd9f317231c97ab8098c79f87f4720ea5f55da1a408eab41e8b；packages/protocol/src/subscription-engine.ts sha256=5410331c57f5636927802da1a36d43123dd8f20d537f915bafa8b1aca0a67aa5（含 H+1 guard 的 `as string` cast 版）；apps/server/src/runtime/dual-history-source.ts sha256=892d3c1c2b696cfd43aadb3a79d6d67efb61237a476722206997521ecf1ae871。全套 44 files 818 passed + 7 skipped；根 tsc exit0；lint exit0。

## M-F7-1 deliverTerminal finally 收尾回退为旧尾清（F7-1 / GPT fix6 P6）

- diff（apps/server/src/runtime/history-source.ts）：`try { for(...) {...} } finally { entry.sinks = null; }` → 旧版循环后置空（提前 return 不清）。
- 命令：`npx vitest run tests/unit/server/history-source.test.ts -t "F7/P-TERM-RETAIN"` → exit 1。
- 失败断言：`expect(entry.sinks).toBeNull()` ——源级提前 return 出口不清注册面（dispose 后槽已摘、无人再清；宿主长持 entry 视角 Set 滞留 {b,a,c}）。
- 还原：python 反向替换，sha256 回 cc084943…（同值）。

## M-F7-PAGE 两处冻结后 closed 复核删除（F7-3 / GPT fix6 P9/P10）

- diff（packages/protocol/src/subscription-engine.ts）：servePageFrom 的 `if (this.phase === "closed") return err4404(requestId);` → `void 0;`；H+1 分支的 `if ((this.phase as string) === "closed") return [err4404(req.requestId)];` → 删除。enterLive 门保留（本变异只针对两复核）。
- 命令①：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "F7/P-PAGE-REENTRY"` → exit 1（快照帧数 2≠1——旧坐标第 2 页排在 4409 之后漏出）。
- 命令②：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "F7/P-H1-FREEZE"` → exit 1（H+1 空页快照漏出）。
- 注：首轮验证在 cast 前文本上跑过一次；cast 落地后在**终态代码**上原样复跑（同 diff 语义），双杀确认。
- 还原：python 反向替换，sha256 回 5410331c…（同值）。

## M-F7-WRAP wrapSinks ok() 资格门移除（窄）（F7-2 / GPT fix6 P7——fix6 档 M-F6-WRAP「全域无独占面」归因的反证）

- diff（apps/server/src/runtime/dual-history-source.ts）：五方法转发 `if (ok()) host.onX(...)` → 无条件 `host.onX(...)`（ok 定义保留未用）。
- 命令：`npx vitest run tests/unit/server/dual-history-source.test.ts -t "F7/P-LATE-WATCH-FAIL"` → exit 1。
- 失败断言：`expect(a.log.unavailables).toHaveLength(0)` got ['watch-failed']——晚附 observe 未返回窗内收口的 A 漏收终止回调（该窗口 HS 成员门全过，唯一拦截者=wrap ok()）。
- 还原：cp .bak，sha256 回 892d3c1c…（同值）。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F7-1 | F7-1 终止分发全出口清面 | F7/P-TERM-RETAIN | 1 KILLED | 过（sha256 同值） |
| M-F7-PAGE | F7-3 两处冻结后复核 | F7/P-PAGE-REENTRY + F7/P-H1-FREEZE | 1+1 KILLED | 过（sha256 同值） |
| M-F7-WRAP | F7-2 wrap 转发门（窄） | F7/P-LATE-WATCH-FAIL | 1 KILLED | 过（sha256 同值） |

窄变异纪律：三变异均只移除本修复轮新增的门/收尾，不夹带其它行为；杀手=对应新探针（无「借旧探针充杀」）。还原校验全部 sha256 同值；基线测试全绿后落档。

## fix8 重演勘正（GPT fix7 F8-2 要求；2026-10-02）

本档原 diff 记录为自然语言摘要（当时 /tmp 日志已无，不重建当时原始记录）。fix8 轮已在 fix8 基线（SE sha c25d0815…，HS/DUAL 同本档基线）上重新复跑三变异并留存真实 unified diff+失败断言+还原哈希，见 **tests/fixtures/mutation-records/3b3-fix8.md「跨轮重演」节**。要点变化：
- M-F7-1 / M-F7-WRAP：重演 KILLED，断言与本档记录一致。
- **M-F7-PAGE：fix8 基线上窄变异合法 SURVIVED**（F8-1 提交尾/H+1 终检在同窗纵深拦截，可观测行为等价）——本档「双杀」结论仅属 fix7 基线；独立杀伤归因已移交 M-F8-COMMIT/M-F8-H1（复合变异四口同删在双探针上 KILLED，见 fix8 档；**fix9 二次勘正**：该杀的首败断言=快照计数 `expected 2 to be 1`，非 4404 计数；且四口复合在 fix9 基线已不杀，需六口——见 fix9 档）。
- 另一全称勘正（GPT fix8 复审 P17）：本档「本修复轮新增的门」说法对 M-F7-WRAP 不成立——wrap ok() 门为 **fix6 已有门**（fix7 只是补了晚附独占杀伤窗探针），fix7 新增的是 F7-1 finally 与 F7-3 冻结复核两处。
