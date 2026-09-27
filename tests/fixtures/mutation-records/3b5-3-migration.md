# 3b5-3 变异记录（迁移执行面：bless 窗口/纯追加前缀验删/幂等判据）

基线=commit 93bf49a（evidence-migration.ts=73ef1cbf…、recovery-evidence-source.ts=7b36f23d…
两文件三变异各自还原后 sha256 复核均与提交版一致）。定向命令裸跑，退出码直录于各 log 末行；
首败归属一律取首个 FAIL 块（FAIL 块序=执行序），未跨块摘句。变异二为 provider 临时未提交
patch（还原=git checkout+sha256 复核），不违反「禁改 provider」——仅变异期存在，未入任何提交。

## M-3B5-BLESSWIN（bless 窗口失效：trustFirstCapture 恒 false）

- diff=patches/3b5-3/M-3B5-BLESSWIN.diff；完整输出=run-records/3b5-3-blesswin-mutation-full.log。
- 裸跑 4 failed | 7 passed。**首败 MG1** `expected { total: 1, migrated: +0, …(2) } to deeply equal
  { total: 1, migrated: 1, …(2) }`（fresh 文件被恒拒授权→no-evidence-snapshot 拒）；连杀 MG3/MG7/MG10。
- 佐证语义：**MG2 仍绿**——legacy-anchor 补登记路径不询及 bless（B15④：旧锚不依赖 bless 窗口，
  provider 既有分支结构在工具层亦被此变异间接例证）。

## M-3B5-PUREAPPEND（纯追加前缀验删：provider:388 判定恒 true）

- diff=patches/3b5-3/M-3B5-PUREAPPEND.diff；变异态 tsc 通过（TSC_MUT_EXIT=0，
  =run-records/3b5-3-pureappend-mutation-tsc.log）；完整输出=run-records/3b5-3-pureappend-mutation-full.log。
- 双测试面同跑（本工具测试+provider 测试）：7 failed | 45 passed。**本工具首败 MG4**
  `expected { total: 1, migrated: 1, …(2) } to deeply equal { total: 1, migrated: +0, …(2) }`
  ——截断文件被放行且补登记（migrated=1，正是 fail-open 实态）；连杀 MG5/MG7；provider 侧
  R11/R12/R25/R38 同杀。**结论：纯追加前缀验证的杀面由 provider 与工具两侧测试共同覆盖
  （工具测试证明接缝真实委托、无工具层旁路）。**

## M-3B5-IDEMPOT（幂等判据删：seen.json rename 归位观测移除）

- diff=patches/3b5-3/M-3B5-IDEMPOT.diff；完整输出=run-records/3b5-3-idempot-mutation-full.log。
- 裸跑 5 failed | 6 passed。**首败 MG1** `expected { total: 1, migrated: +0, …(2) } to deeply equal
  { total: 1, migrated: 1, …(2) }`——迁移成功被误报 noop（验收记录虚报「无事发生」）；
  连杀 MG2/MG3/MG7/MG10。MG3 亦杀：其首跑即断言 migrated=1——判据删后并非「全 noop 恰好过」，
  migrated/noop 双向均被锁定。

## 汇总

| 变异 | 首败 | 杀灭集合 | 还原复核 |
|---|---|---|---|
| M-3B5-BLESSWIN | MG1 | MG1/MG3/MG7/MG10 | sha 73ef1cbf…=提交版 |
| M-3B5-PUREAPPEND | MG4（工具面） | 工具 MG4/MG5/MG7+provider R11/R12/R25/R38 | sha 7b36f23d…=提交版 |
| M-3B5-IDEMPOT | MG1 | MG1/MG2/MG3/MG7/MG10 | sha 73ef1cbf…=提交版 |
