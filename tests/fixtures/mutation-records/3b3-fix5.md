# 3b3-fix5 变异记录（GPT fix4 复审 81→修复轮；2026-10-01）

标准（同 3b3-fix2/3b3-fix4.md）：真实 diff + 复现命令 + 退出码 + 还原校验。
GPT fix4 §7 要求：窄变异合法存活应如实接受；回归杀伤用**明确标注的复合变异**承担。

## M-F5-GATE recheck2 门恒假（F5-1 门后重入提交资格）

- 目标：证明 recheck2 门（退旧入队/撤帧重入后的提交资格复核）是 P3（队列溢出同步 closeConn）/P4（撤帧审计重入关连接）两反例的必要防线。
- 变异基线：本轮工作树（F5-1 门+双探针在场），ws-gateway.ts sha256=a2d83cbba60bd01842ed07586a51bb40fd56a51b862aa5d0734366b1f610968e。
- diff（apps/server/src/ws/ws-gateway.ts，一处锚点）：
  ```diff
  -        if (st.closed || this.registry.peek(file) !== index) {
  +        if (false && (st.closed || this.registry.peek(file) !== index)) {
  ```
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "F5/P-RETIRE"`
- 结果：exit 1，KILLED（2 failed：F5/P-RETIRE-OVERFLOW + F5/P-RETIRE-AUDIT-REENTRY——死连接复活绑定/引用双结算暴露）。
- 还原：`cp /tmp/f5-gw.bak apps/server/src/ws/ws-gateway.ts`；还原校验=sha256 同值 a2d83cbba60bd018…968e，复跑 F5/P-RETIRE 2/2 过。

## M-F5-2a 分发循环逐 sink 双门移除（F5-2 同批残余通知）

- 目标：证明逐 sink 生命周期+成员资格复核是 P10（同批分发回调内 dispose/退订→残余行照投）的必要防线。
- 变异基线：本轮工作树，history-source.ts sha256=69d4e3ea2bbc78455fb906b7a710525cf44f429a51b411cf767552f93bd076a4。
- diff（apps/server/src/runtime/history-source.ts，分发内循环首两行删除）：
  ```diff
  -          if (entry.disposed || entry.sinks === null) return; // 代已死：整批停（后续行归重扫/新代）
  -          if (!entry.sinks.has(sk)) continue; // 成员已摘（本批回调内退订）：跳过该 sink，其余照投
  ```
- 命令：`npx vitest run tests/unit/server/history-source.test.ts -t "F5/P-BATCH"`
- 结果：exit 1，KILLED（2 failed：F5/P-BATCH-DISPOSE——B 收残余行+还原前 TypeError 风险；F5/P-BATCH-UNBIND——A 收退订后行）。
- 还原：`cp /tmp/f5-hs.bak apps/server/src/runtime/history-source.ts`；还原校验=sha256 同值 69d4e3ea…076a4。

## M-F5-2b Dual.observe 迟到注册回收移除（F5-2 P11）

- diff（apps/server/src/runtime/dual-history-source.ts，observe 内终态二验块删除）：
  ```diff
  -    if (this.disposed) {
  -      try { unJ(); } catch { /* 子源已关 */ }
  -      try { unS?.(); } catch { /* 子源已关 */ }
  -      this.audit(`observe-aborted-disposed file=${file}`);
  -      return null;
  -    }
  ```
- 命令：`npx vitest run tests/unit/server/dual-history-source.test.ts -t "F5/P-OBSERVE-AUDIT-REENTRY"`
- 结果：exit 1，KILLED（1 failed：终态后 obs 滞留 1 项/审计缺席）。
- 还原：`cp /tmp/f5-dual.bak apps/server/src/runtime/dual-history-source.ts`；还原校验=sha256 同值 30319bbf…4c9e8。

## M-F5-2c attachSessionIfObserved 快照迭代+晚附迟到回收回退（F5-2 晚附窗）

- diff（apps/server/src/runtime/dual-history-source.ts，两处合并变异）：`for (const st of [...regs])` 还原为 `for (const st of regs)`（活注册表边迭代边 splice）+晚附迟到绑定回收块删除。
- 命令：`npx vitest run tests/unit/server/dual-history-source.test.ts -t "F5/P-LATE-ATTACH-REENTRY"`
- 结果：exit 1，KILLED（1 failed：迭代跳项——B 永不补接 session）。**探针自捕真 bug**：快照迭代修复本身就是 P-LATE-ATTACH-REENTRY 开发中发现的活注册表迭代缺陷（splice 当前项→跳过后续注册）。
- 还原：同上 sha256 校验。

## M-F2c 复合变异：去 F4-1 门+恢复 async/await（F5-3 回归杀伤）

- 目标：窄 M-F2（仅恢复 async）在 F4-1 门在场下=合法拒绝（identity 门静默 close），fix5 双出口语义下为**合法 SURVIVED**；原缺陷（退役坐标静默存活）的回归杀伤由本复合变异承担。
- diff（apps/server/src/ws/ws-gateway.ts，三处）：syncIndex 恢复 `private async` 声明+`Promise<>` 返回型；调用点恢复 `await`；F4-1 门块整段删除（recheck2 保留但 P-REPLACE-MICRO 场景不触退旧分支故不设防）。
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "P-REPLACE-MICRO"`
- 结果：exit 1，KILLED（b 在退役后提交旧坐标：快照在/4409 永缺→出口二末断言 `expect(bGot4409()).toBe(true)` 前的 until 超时抛错）。
- 还原：sha256 同值 a2d83cbba…968e，复跑 P-REPLACE-MICRO 过。

## 窄 M-F2 合法存活复跑记录（fix5 勘正 3b3-fix4.md 归因）

- 变异=仅恢复 async+await（F4-1 门在场）。
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "P-REPLACE-MICRO"`
- 结果：exit 0，**SURVIVED（合法）**——b 走出口一（身份门拒绝：审计 why=identity+release 恰 1+零新绑定）。杀伤/存活判定语义见 P-REPLACE-MICRO 用例头注：until 条件容纳拒绝信号（否则超时抛错=错杀合法拒绝，fix4 档旧归因即源于此）。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F5-GATE | F5-1 门后重入复核 | F5/P-RETIRE-OVERFLOW + P-RETIRE-AUDIT-REENTRY | 1 KILLED×2 | 2/2 过（sha256 同值） |
| M-F5-2a | F5-2 同批残余通知双门 | F5/P-BATCH-DISPOSE + P-BATCH-UNBIND | 1 KILLED×2 | 过（sha256 同值） |
| M-F5-2b | F5-2 observe 迟到注册回收 | F5/P-OBSERVE-AUDIT-REENTRY | 1 KILLED | 过（sha256 同值） |
| M-F5-2c | F5-2 晚附快照迭代+回收 | F5/P-LATE-ATTACH-REENTRY | 1 KILLED | 过（sha256 同值） |
| M-F2c | F2 提交窗+身份门复合回归 | F2/P-REPLACE-MICRO | 1 KILLED | 过（sha256 同值） |
| 窄 M-F2 | 合法拒绝路径 | ——（出口一） | 0 SURVIVED（合法） | 基线 |

还原校验：全套 npm test 终态见 TEST-MAP 3b3-fix5 节（44 files 807+7）；`git diff` 仅含本轮计划内改动。
