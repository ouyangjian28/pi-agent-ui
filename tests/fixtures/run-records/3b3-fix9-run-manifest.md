# 3b3-fix9 终态运行清单（run manifest；GPT fix8 D9-1 要求）

## 干净终态运行（证据基线）
- 运行前源码哈希（sha256）：
  - packages/protocol/src/subscription-engine.ts = 323f7137e8c3d8a4b2b72ab0c799c408ff025aadbc59b3111394a31fa763dcd4
  - apps/server/src/runtime/history-source.ts = cc084943ef833fd9f317231c97ab8098c79f87f4720ea5f55da1a408eab41e8b
  - apps/server/src/runtime/dual-history-source.ts = 892d3c1c2b696cfd43aadb3a79d6d67efb61237a476722206997521ecf1ae871
  - apps/server/src/ws/ws-gateway.ts = 67de091600bfdabc9752c1a9c873515f83efad26f8bd4c6ec3ebf73dfb4462c0
- 命令与退出码（fix10 补全为可直接复制形式；cwd=仓根）：
  - `npm run typecheck` → exit0；`npm run lint` → exit0
  - `npx vitest run --reporter=json --outputFile=tests/fixtures/run-records/3b3-fix9-vitest.json`（实际先写 /tmp 再拷入，内容逐字节同）→ exit0
- 机器结果：tests/fixtures/run-records/3b3-fix9-vitest.json（sha256=5bb537918abf93f2a790a52a37e8ea49ccd15d4fc969a2f886c37294624bf7f7）
  - numTotalTests=839 / numPassedTests=832 / numPendingTests=7 / numFailedTests=0 / success=true / testResults=44 文件
  - 增量=fix8 826+7 → 832+7（+6：F9 引擎 5 例[BUDGET-CACHED/H1/PAGE-SHRINK/PAGE-EMPTY/NOCLOSE] + 网关 1 例[P-PAGE-NOW-COMMIT]）
- 运行后源码哈希：se 同 323f7137…（无漂移；测试期零写源）。fix10 补记（诚实边界）：运行后仅重取了 SE 哈希；HS/DUAL/GW 三件未在运行后重取，可由 git 提交 94df345 内容与运行前哈希一致性间接验证，不冒充「四件均有运行后读数」。

## 过程事故（不采用，仅存证）
- 事故：重建 fix8 档 m-f8-commit.diff 带头版时，还原步骤误用 fix8 提交态副本（c25d0815…）覆盖 fix9 工作树 → 首次全套在缺 F9-1 四口的状态下运行：numTotalTests=839 / passed=828 / failed=4 / success=false，失败恰为 4 个 F9-1 探针（P-BUDGET-CACHED/H1/PAGE-SHRINK/PAGE-EMPTY，均在 subscription-engine.test.ts）——与「代码被回退」事故解释完全一致，无其他失败。
- 处置：自 /tmp/f9-se-clean2.ts（sha256=323f7137…）恢复 → tsc exit0 → 全套重跑（上方干净终态）。事故态 JSON 已被干净重跑覆盖（/tmp 同名文件），未入仓；本节为如实记录。
