# 3b3-fix4 变异记录（GPT fix3 复审 80→修复轮；2026-09-30）

标准（同 3b3-fix2.md）：真实 diff + 复现命令 + 退出码 + 还原校验。
GPT fix3 §7 要求：窄 M-F2 变异（恢复 async+await 必须被杀）——本档主变异即 M-F2。

## M-F2 syncIndex 恢复 async+调用点 await（F2 同步化回退）

- 目标：证明 F4-3 真嵌套探针依赖「提交窗口已同步化」——恢复 await 让出微任务窗口后，换流竞态必须被杀手暴露（GPT fix3 F3R-TEST 判定：仓内原 afterMicrotasks 为假嵌套，恢复 async 后旧三例 SURVIVED）。
- 变异基线：F4-1 门（提交资格复核）+ F4-3 真嵌套助手（latch+双微任务包装 load）已在场——变异只回退 syncIndex 的同步性，不复原其他修复，验证「同步化本身」是防线而非测试假象。
- diff（apps/server/src/ws/ws-gateway.ts，两处锚点）：
  ```diff
  -  private syncIndex(file: string, rows: readonly ScanRow[]): ReadIndex | typeof WsGateway.INDEX_BUDGET {
  +  private async syncIndex(file: string, rows: readonly ScanRow[]): Promise<ReadIndex | typeof WsGateway.INDEX_BUDGET> {
  ```
  ```diff
  -        index = this.syncIndex(file, rows);
  +        index = await this.syncIndex(file, rows);
  ```
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "P-CLOSE-MICRO|P-REPLACE-MICRO"`
- 结果：exit 1，KILLED。失败用例=`F2/P-REPLACE-MICRO 提交窗双微任务 onInvalidate(replace)→旧流即退（4409），任何时序都不复活退役流坐标`（await 让出窗口内 invalidate 换流→无门则旧坐标照承诺→4409 后帧序断言崩）。
- 合法存活者：`F2/P-CLOSE-MICRO`（closed 路径**双守卫**——load 后置 `st.closed` 检查（B3 前置段）与 F4-1 同步复核门任一拦截均满足断言：release 恰一次+零残留；identity 路径唯一守卫=F4-1 门，故承担杀伤）。存活≠假绿：该探针断言的是「任一门拦截都收口正确」，非「仅同步门存在」。
- 还原：`git checkout -- apps/server/src/ws/ws-gateway.ts` 还原变异（副作用：连带回退了当时未提交的 F4-1 门——当场用同一锚点 edit 重打，重打后该文件 83/83 全绿；本档如实记录，还原校验以重打后绿跑为准）。

## M-F4-RECYCLE syncIndex 换流路回收移除（F4-4 第四出口）

- 目标：证明 F4-4 的 recyclePublishState(非前缀 replace 路) 是账本回收必要件——去掉后旧流发布账本项滞留。
- diff（apps/server/src/ws/ws-gateway.ts，syncIndex 非前缀分支）：
  ```diff
  -    const droppedStream = this.registry.peek(file)?.streamId;
  -    if (droppedStream !== undefined) this.recyclePublishState(file, droppedStream);
       this.registry.replace(file);
  ```
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "F4/P-PS-"`
- 结果：exit 1，KILLED。失败用例=`F4/P-PS-OVERBUDGET-CHURN 超容量失败分支（非前缀+索引超预算）不滞留旧流账本`（该路 overBudget 早退在 claimPublish 前、无引擎/onAppend 后续——同步回收是唯一防线，去之即滞留）。
- 合法存活者：`F4/P-PS-REWRITE-RECYCLE`（其盘面 put 触发 FakeHistory 的 onAppend 通知→旧索引 append 非前缀失败→invalidate 路走 fix3 的 onInvalidate 钩子回收——双防线覆盖，断言性质「旧流不滞留」仍成立；非假绿，如实入档）。
- 还原：`cp /tmp/mut-f4-orig.ts apps/server/src/ws/ws-gateway.ts`；还原校验=还原前后 sha256 同值 dd35317b2112b82316812739db89416b49826b86c6cc868dcb968601dc6316c2，复跑 F4/P-PS- 两例 2/2 过。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F2 | F2 同步化（await 窗口） | F2/P-REPLACE-MICRO | 1 KILLED | 83/83 过 |
| M-F4-RECYCLE | F4-4 换路回收 | F4/P-PS-OVERBUDGET-CHURN | 1 KILLED | F4/P-PS- 2/2 过（sha256 同值校验） |

还原校验：全套 npm test 终态见 TEST-MAP 3b3-fix4 节；`git diff` 仅含本轮计划内改动。
