# GPT 审读指令档：P0-2 r2 根修批（生命周期队列）

## 一、背景与分工
你是独立审读人（GLM 实现/GPT 审/Kimi 前端不在场）。审对象=主仓 master HEAD（16323bf；实现 52bba50+变异轮 bb29eca）。
你 r1 审（58 NO-GO，报告 worktrees/gpt-p02-r1-review）提的三 P1 本批全修：R1 close/dispose 不汇合在途 boot（锁泄漏/释放后旧宣誓污染）/R2 check→append→note 未整体串行（同写者自冻粘性）/R3 bootP 无 rejection 归一化（取锁 I/O 异常 unhandled rejection 杀进程，你 boot-reject.mts exit=1 实锤）。R4（测试过称）与 P3 文档三处同批收窄。
设计稿=docs/p0-2-write-identity-design.md（§3/§5/§6 已按你 R4/P3 修）+§6 迭代史 r2 段。测试图=tests/fixtures/TEST-MAP.md「P0-2 r2 根修批」节。

## 二、改动面（主仓 /home/yyj/ai/repos/pi-agent-ui 实跑；本 worktree 只读审+探针）
- apps/server/src/runtime/guarded-journal-writer.ts 重写：
  ①每 writer 生命周期队列（queueTail 链；boot/append/drainAndClose 全串行，enqueue 前序失败不卡队列）。
  ②dispose=同步置位 disposed→drainAndClose 汇合（含在途 boot）→逐文件释放锁（releases Map 归口）。
  ③bootFile 加目录准备（mkdir recursive，对齐 FileDurability）+取锁 try/catch 归一 lock-io-failed+检查点①(after-lock：disposed→当场 release+failed)+检查点②(pre-oath：disposed→failed 零宣誓，锁归 dispose 释放)。
  ④bootP=enqueue(bootFile).then(ok,异常兜底→failed)——从构造即消费所有 rejection。
- 测试：新增 4 例（R1-交错1 走检查点①/R1-交错2 走检查点②（enteredRead 信号锚定+旧 boot 不污染新持有者 B）/R2 真底座延迟层并发不自冻/R3 子进程 EACCES exit=0 SURVIVED）；E2E epoch1 toBe(1)+勘称实例重建+try/finally。
- 文档：设计稿 §3 P02-D3「同步拒」→「await boot 结果 reject」、§5 释放序 registry→guardedWriters→tokens、§6 r1 迭代史勘称+r2 段+崩溃链边界（stale 锁/清锁=E2E 未验证，单元覆盖）。

## 三、审读重点
1. **r1 三 P1 是否真死**：用你原探针（/tmp/gpt-p02-r1-probe/ 若在，或重造）对 r2 实现复跑——races P1（close/dispose 在途 boot 后 oath 落盘+锁遗留）/P2（旧 boot 恢复污染新持有者）/P3（并发自冻）/boot-reject.mts（exit=1）应全部反转。
2. **新结构自引入风险**：队列链的内存（queueTail 尾引用）；enqueue(op,op) 前序失败续跑语义；drainAndClose 后 late append；检查点①当场 release 与 dispose 循环释放的双释放窗口；mkdir 语义变化（原来不建目录现在建——单测覆盖面）。
3. **交错2 测试有效性**：enteredRead 锚定后是否真走检查点②（可注入探针验证 stage=pre-oath 审计行）；Mu-b4 变异记录声称杀——可复验。
4. **R4 收窄是否诚实**：设计稿/TEST-MAP 的「r2 面预留」标注与实现是否一致；E2E 断言强度。
5. **核销你 r1 的低优**：P3-1 文档三处/P3-2 release 诊断描述（勘称后措辞）是否落地。

## 四、探针与复跑（本 worktree 无 node_modules——测试一律在主仓跑）
主仓路径=/home/yyj/ai/repos/pi-agent-ui（PATH 前置 /home/yyj/.nvm/versions/node/v24.18.0/bin）。
- 定向：npx vitest run tests/unit/server/guarded-journal-writer.test.ts（16 例）
- 全仓：npx vitest run（1444 绿基线）；tsc=npx tsc --noEmit -p apps/server（exit 0）
- E2E（真 pi 三轮约 30s×2）：PI_E2E=1 npx vitest run tests/integration/p02-assembly-e2e.test.ts
- 交接探针自备 /tmp/gpt-p02-r2-probe/（新目录，勿覆写 r1 探针）。

## 五、输出（写文件+哨兵）
报告写 /home/yyj/ai/repos/gpt-p02-r2-review/p02-r2-review.md（本 worktree 根）：五段=结论（GO/NO-GO+分数/100；r1 三 P1 逐项核销判定）/高优发现（P1/P2/P3 附文件:行+复现）/低优/核销清单（探针名+结果）/给 r3（帧身份批）的输入。
完成哨兵：touch /tmp/gpt-p02-r2-done。
零节执行纪律（M-251）：全程禁嵌套后台进程/禁长 sleep；已绿不重跑全仓；报告先落盘再收尾；单条命令 ≤5min。
