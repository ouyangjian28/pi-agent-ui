# 3b3-fix9 变异验证档（GPT fix8 复审 84/100 NO-GO 修复轮；2026-10-03）

基线（fix9 终态）：packages/protocol/src/subscription-engine.ts sha256=323f7137e8c3d8a4b2b72ab0c799c408ff025aadbc59b3111394a31fa763dcd4（=fix8 基线 c25d0815… + F9-1 四口先验）；history-source.ts cc084943…（同 fix7/fix8）；dual-history-source.ts 892d3c1c…（同 fix7/fix8）；ws-gateway.ts 67de0916…（fix9 未改生产网关代码，仅测试）。全套机器结果=tests/fixtures/run-records/3b3-fix9-vitest.json；运行清单（前后哈希+命令+退出码）=tests/fixtures/run-records/3b3-fix9-run-manifest.md。

本轮纪律（GPT fix8 D9-1）：全部变异给**入仓 unified diff**（tests/fixtures/mutation-records/patches/fix9/）、失败断言原文（含测试名+断言位置）、退出码、还原哈希；跨轮重演标注基线归属；归因只写实际观测，不凭一行输出推断。

## M-F9-BUDGET 四处预算口先验删除（F9-1 / GPT fix8 B9-1 P8/P9/P10）

- diff=patches/fix9/m-f9-budget.diff（cached / H+1 / servePageFrom 终判循环 / 退空判定 四口：`if closed → err4404` 先验全部删除，恢复 fix8 旧序）。
- 命令与失败断言（独立跑）：
  - `-t "F9/P-BUDGET-CACHED"` → exit 1，AssertionError: `expected { t: 'error', code: 4431, …(3) } to match object { t: 'error', code: 4404, …(1) }`（缓存重发：估帧回调关引擎+返回超限→旧序 4431 抢盖）。
  - `-t "F9/P-BUDGET-H1"` → exit 1，同型断言（H+1 空页同窗）。
  - `-t "F9/P-BUDGET-PAGE-SHRINK"` → exit 1，同型断言（终判持续超限退空口）。
  - `-t "F9/P-BUDGET-PAGE-EMPTY"` → exit 1，同型断言（首轮关+次轮通过的退空判定口）。
  - 对照（未关闭真超限→4431 语义保留）：`-t "F9/P-BUDGET-NOCLOSE"` → **exit 0**（4431+retryable=false 照发，不因 F9-1 一律 4404）；另有既有用例⑲（首条即超 4431）同属对照面。
- 还原：`cp` 基线副本 → sha256 回 323f7137…（同值）。

## M-F8-COMMIT 重演（fix9 基线；F8-1 提交尾门 vs 新真提交点网关例）

- diff=patches/fix9/m-f8-commit-replay.diff（`pageAt = now()` 后终检删除）。
- 命令与失败断言：
  - `-t "F8/P-PAGE-NOW-ENGINE"`（引擎序列）→ exit 1，同 fix8 记录（退役页照发）。
  - `-t "F9/P-PAGE-NOW-COMMIT"`（**fix9 新增真提交点网关整合例**：freeze 内 arm、pageAt=now() 触发 invalidate）→ exit 1，AssertionError: `expected [ { t: 'snapshot', …(10) }, …(1) } ] to have a length of 1 but got 2`——删门后旧引擎把退役第 2 页快照排在 4409 之后发出（GPT fix8 P14 预测的观测面；探针用双条件等待，首败落在快照计数断言而非 until 超时）。
- 还原：sha256 回 323f7137…（同值）。

## 复合六口（M-F7-PAGE×2 + M-F8-H1×2 + M-F9 终判口 + M-F8-COMMIT）

- diff=patches/fix9/m-compound6.diff。
- **四口复合（fix8 档原复合）在 fix9 基线上 SURVIVED**（exit 0）：P-PAGE-REENTRY 被 F9-1 终判口先验拦截、P-H1-FREEZE 被 F9-1 H+1 先验拦截——F9-1 预算口先验与 F7-3 冻结复核同窗纵深叠加，删掉旧四口仍有新层兜住。**如实记录：防御层叠加使旧复合失效，需六口同删才重现漏页。**
- 六口同删：`P-PAGE-REENTRY` → exit 1，AssertionError: `expected 2 to be 1`，首败断言=ws-gateway.test.ts:2880 `expect(c.frames().filter((f) => f.t === "snapshot").length).toBe(1)`（**快照计数**）；`P-H1-FREEZE` → exit 1，同型，首败=ws-gateway.test.ts:2920（同快照计数断言）。
- 该重验=fix8 档 P16 归因勘正的实证：复合杀伤的可观测面=退役快照计数翻倍，不存在「两份 4404」路径（引擎拒门已删时退役链产 4409 非 4404）。
- 还原：sha256 回 323f7137…（同值）。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F9-BUDGET | 四预算口先验 | P-BUDGET-CACHED/H1/PAGE-SHRINK/PAGE-EMPTY | 1×4 KILLED | 过（323f7137 同值） |
| （对照）M-F9-BUDGET 下 NOCLOSE | 4431 语义保留 | F9/P-BUDGET-NOCLOSE | 0（4431 照发） | — |
| M-F8-COMMIT 重演 | F8-1 提交尾门 | F8/P-PAGE-NOW-ENGINE + **F9/P-PAGE-NOW-COMMIT（新）** | 1×2 KILLED | 过 |
| 复合四口（fix8 原复合） | 旧四门 | — | 0 SURVIVED（F9-1 纵深） | 过 |
| 复合六口 | 全链纵深 | F7/P-PAGE-REENTRY + F7/P-H1-FREEZE（快照计数首败） | 1+1 KILLED | 过 |

过程事故如实记：重建 fix8 档 m-f8-commit.diff（带文件头版）时，还原步骤误用 fix8 提交态副本（c25d0815）覆盖了 fix9 工作树（丢 F9-1 四口）→ 首次全套在该态下运行，恰好 4 个 F9-1 探针失败、其余全绿（失败清单=tests/fixtures/run-records/3b3-fix9-run-manifest.md 事故节，含该次 JSON 与干净重跑的区分）→ 发现后自 /tmp/f9-se-clean2.ts（323f7137）恢复、tsc 过、全套重跑全绿并以重跑为准。未采用事故态任何产物。
