# GPT 审读指令档：P0-2 r1 装配批（writer 守卫壳装进生产 DurabilityPort）

## 一、背景与分工
你是独立审读人（GLM 实现/GPT 审/Kimi 前端不在场）。审对象=主仓 master HEAD（137dffa；实现批 7d48f09）。
项目=pi-agent-ui（pi 的 web 前端+server）。本批=P0 冻结序④「写面身份校验」前半（装配面）：把 P0-3 组件（acquireJournalLock/appendWriterOath/WriterGuard，writer-oath.ts，已收口 86 GO）装进生产 DurabilityPort 写路径——RpcSession（apps/server/src/runtime/rpc-session.ts:497 两写入口 TurnGate/DispatchCoordinator）经 session-registry.ts:113 durabilityFor 接缝注 DurabilityPort，本批以守卫壳接管该接缝（composition.ts:166→guardedWriters.writerFor）。
设计稿=docs/p0-2-write-identity-design.md（r1 装配/r2 帧身份两批+ADR-P02-D1..D4+FF-P02-1..5+W-asm 测试表）。测试图=tests/fixtures/TEST-MAP.md「P0-2 r1 装配批」节。
r2（下一批）=契约 v1.1 写帧身份（resume 意图身份+网关校验），本批不含帧面语义——凡「write-ack 呈现/4409 语义」类问题请标注「r2 面预留」而非 NO-GO 依据。

## 二、改动面（主仓 /home/yyj/ai/repos/pi-agent-ui 实跑；本 worktree 只读审+探针）
- 新 apps/server/src/runtime/guarded-journal-writer.ts（核心）：createGuardedJournalWriterFactory——每 journal 懒装配（锁→readJournal(ENOENT=空)→scanWriterEpoch→epoch=maxEpoch+1→appendWriterOath→guard.initialize({byteEnd:oath.byteEnd})）；append=disposed 双判→await bootP→checkBeforeAppend→inner.append→noteAppended(serializeJournalLine 实长)；dispose=置位+全写者关写面+逐文件 releaseLock。
- apps/server/src/composition.ts：writerBootId=randomUUID()（P02-D2）+durabilityFor 接线+dispose 序尾 await guardedWriters.dispose()（registry.dispose 之后）。
- 测试：tests/unit/server/guarded-journal-writer.test.ts（12 例 W-asm-1..5+7+杂项）；tests/integration/p02-assembly-e2e.test.ts（PI_E2E=1 门控；A-1 真重启 epoch1→2+锁清；A-2 双实例活锁拒 gate-failed+零新行）。
- docs/p0-2-write-identity-design.md（新设计稿）+TEST-MAP P0-2 r1 节。
- packages/protocol/src/journal.ts 加 serializeJournalLine(line):Buffer（P02-D1 单一来源；file-durability.ts append 已改用之）。

## 三、审读重点（按威胁模型优先级）
1. **装配序竞态**：同文件并发 writerFor（TurnGate/Coordinator 同轮两帧）→bootFile 重入？Map 缓存是否真防双装配；dispose 与 boot 在途交错→锁泄漏/写面复活？
2. **fail-closed 完整性**：三类装配失败（lock-held 活/stale、bad-tail、oath-failed）→写面永不开放+零业务行；append await 窗口 dispose 竞态；writerFor 在 dispose 后抛。
3. **记账同源**（P02-D1）：noteAppended(serializeJournalLine.length) vs inner.append 实写——FileDurability 实写路径是否恒等（Buffer.from(JSON+\n) 同构）？漂移=守卫误报 foreign 或漏报他写。
4. **composition dispose 序**：registry.dispose（会话排空）→guardedWriters.dispose（释放锁）序是否保证「写面静止才释放」；释放失败只 audit 的可接受性。
5. **E2E 证据强度**：A-1/A-2 是否真证重启续写/双实例拒（断言漏洞=过称）；audit 断言是否可伪造。
6. **文档与实现一致**：设计稿 §3/§5 承诺 vs 代码真实行为；「r2 预留」标注是否诚实。

## 四、探针与复跑（本 worktree 无 node_modules——测试一律在主仓跑）
主仓路径=/home/yyj/ai/repos/pi-agent-ui（PATH 前置 /home/yyj/.nvm/versions/node/v24.18.0/bin）。
- 单测：cd 主仓 && npx vitest run tests/unit/server/guarded-journal-writer.test.ts
- 全仓：npx vitest run（1440 绿基线）；tsc=npx tsc --noEmit -p apps/server（exit 0）
- E2E（真 pi 三轮，成本约 2min）：PI_E2E=1 npx vitest run tests/integration/p02-assembly-e2e.test.ts
- 交接探针（自备 /tmp/gpt-p02-r1-probe/）：并发 writerFor 双 boot、dispose/boot 交错、记账漂移注入复现。
- P0-3 组件契约参考=apps/server/src/runtime/writer-oath.ts+tests/unit/server/writer-oath.test.ts（W-oath 14 例）。

## 五、输出（写文件+哨兵）
报告写 /home/yyj/ai/repos/gpt-p02-r1-review/p02-r1-review.md（本 worktree 根）：五段=结论（GO/NO-GO+分数/100）/高优发现（P1=必须修 P2=应修 P3=建议，各附文件:行+复现或推理链）/低优/核销清单（你实际验证过什么——探针名+结果）/给 r2 的输入。
完成哨兵：touch /tmp/gpt-p02-r1-done。
零节执行纪律（M-251）：全程禁嵌套后台进程/禁长 sleep；已绿不重跑全仓（引用本 brief 数字+抽查即可）；报告先落盘再收尾；任何命令单条 ≤5min。
