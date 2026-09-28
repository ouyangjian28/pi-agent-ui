# P0-2 写面身份校验设计稿（r1=装配面 / r2=帧身份）

> P0 冻结序④（PROJECT.md s4g 分工：契约 v1.1 写帧扩 resume 意图身份；网关写分支校验「恢复的意图=盘面那条」；旧 revision/过期/旧代次→4404/4405 拒）。
> 前置：P0-3 writerEpoch 组件级 GO（86；audits/gpt-p03-r3-review-2026-10-09.md）。本环 r1=把 P0-3 组件装进生产写路径（GPT r3 审五项必验的兑现批）；r2=写帧身份校验。

## §0 范围与威胁

| 威胁 | 防线 | 批 |
|---|---|---|
| T1 server 双实例写同一 journal（跨进程双写） | P0-3 L1 O_EXCL 锁+L2 宣誓行（组件已 GO，**未接线**） | r1 |
| T2 server 内多写路径绕守卫（ RpcSession→TurnGate/DispatchCoordinator 两入口共用 DurabilityPort） | 守卫壳包在 DurabilityPort 层=两入口统一被守 | r1 |
| T3 server 重启后旧进程复活续写（脑裂） | writer epoch 递增+旧写者读到异已宣誓冻结（组件已 GO，**未接线**） | r1 |
| T4 旧页面/旧意图冒充恢复重发（resume 冒充/双端同答） | 帧身份校验（intentId∈授权面+代次匹配） | r2 |
| T5 写帧身份缺失（prompt 打到换代前进程） | prompt 帧扩 processGeneration（客户端从 live 事件取） | r2 |

边界（2026-10-08 需求对齐拍板③）：多端=单写者+跨端接管（writer-authority 连接级 epoch——WS 层接线属 r2 面）；不做双端同时打字。

## §1 r1 装配面设计

### 1.1 组件图（写路径全链）

```
ws-gateway 写分支 → rpc-write-host → session-registry.sessionFor(file) → RpcSession
  → TurnGate.append / DispatchCoordinator（两写入口）
    → GuardedJournalWriter[新] —— DurabilityPort 实现
        ├─ WriterGuard.checkBeforeAppend → append+datasync → noteAppended（P0-3 组件）
        └─ FileDurability[既有]（串行队列+逐行 fdatasync+失败锁）
装配生命周期（每 journal 文件一次，懒触发=首次 sessionFor）：
  acquireJournalLock → （恢复链既有，不在本批） → scanWriterEpoch
    → appendWriterOath(epoch=N+1, bootId) → guard.initialize(oath) → 开写面（guard ready）
关停（composition dispose 冻结序尾插）：关写面（registry dispose→sessions 排空）→ 逐文件 releaseLock
```

### 1.2 GuardedJournalWriter（守卫壳）

- 实现 `DurabilityPort`（append/close）；组合 `FileDurability`（不继承——壳不加写行为，只加门）。
- **装配异步、append 等待装配完成**（r1 实现修订）：`sessionFor` 同步契约不动。构造即启动异步装配（锁→扫描→宣誓→初始化）；`append` 先 `await boot`：装配中→等待（毫秒级 fsync，RpcSession 写路径全异步，无假失败）；装配失败（锁 held/宣誓 bad-tail/写失败）→ reject `guarded-writer:{原因}`（fail-closed，RpcSession 面收 durability-failure 类错误→gate close，不动进程）。同一 boot Promise 全调用方共享——失败结果一致性。
- **append 三步序**（每行）：①`guard.checkBeforeAppend()`（stat≠基线→尾扫 writer 行→异已宣誓冻结/foreign-write 冻结；拒=reject 本行+audit）②`inner.append(line)`（既有串行队列+fsync；失败=inner failed 锁语义不变）③`noteAppended(serializeJournalLine(line).length)`。
- **序列化单一来源（ADR-P02-D1）**：新 `serializeJournalLine(line): Buffer`（`${JSON.stringify(line)}\n` utf8）入 protocol 包；FileDurability 与守卫壳共用（消字节计数与实写格式漂移）。
- **L2 界限承继（P0-3 已审定）**：check→append 间隙的他写=检测非预防；下一轮 check 发现 size 漂移→冻结。守卫壳不做「append 后重 stat」额外校验（P0-3 设计 §3 已定，不重复防线）。
- **bootId（ADR-P02-D2）**：composition 启动时生成一次 UUID，全 server 生命周期共享；每 journal 文件独立 epoch（该文件 writer 行历史 maxEpoch+1）。同次启动写多文件=同 bootId 不同 epoch。

### 1.3 装配失败面（fail-closed 语义）

| 失败 | 行为 | 当前服务呈现（r1/r2 已交付） | 帧身份批（r3）预留 |
|---|---|---|---|
| 锁 EEXIST（活/死同拒；stale=诊断） | 该 file 写面不开 | write-ack gate-failed{stage:enqueue,cause:writer-lock-held}（audit 同步留痕） | 4402（not-ready.cause=writer-lock-held）；读面正常 |
| 盘面 bad-tail（撕裂尾/坏行在场——oath 门拒；修复/裁决=1a/1b 既有面，不入装配链 ADR-P02-D4） | 写面不开 | 同上 gate-failed 面（cause=writer-bad-tail 入 audit） | cause=writer-bad-tail 结构化呈现 |
| 宣誓写失败（fsync 失败等） | 写面不开 | 同上 gate-failed 面（audit writer-oath-failed） | cause=writer-oath-failed 结构化呈现 |
| 运行中冻结（superseded/foreign-write） | 后续 append 全拒 | audit 留痕（guarded-writer 前缀） | statusFor 呈现 writerState（冻结原因+对方 epoch/bootId） |

运维清锁前提（P0-3 设计稿 §3 已冻结）：停服务（含旧/暂停写者）+禁并发拉起+同命名空间+其他清锁者串行化。**stale 锁不自动清**——SIGKILL 后自动重启（systemd）会拒绝开写面直至运维清锁；这是 P0-3 r2 已审定的 fail-closed 语义，本批不改。

### 1.4 关停序（composition dispose 插位）

现有冻结序：摘 onConnection → 停轮询/SIGHUP → gateway.dispose（1000 告别+观察器解绑）→ adapter.dispose → tokens.dispose。
本批插入：composition.dispose 实际序=registry.dispose（排空会话）→ **guardedWriters.dispose（汇合每 writer 生命周期队列含在途 boot/append+关底座+逐文件 `releaseLock()`）** → tokens.dispose——释放前写面静止由队列汇合保证（r2 根修：不再依赖调用方序）。可观察到的 release rejection 记 audit；底层吞掉的 unlink 错误可能仅留残锁（锁残留=下次启动 EEXIST 拒，可接受；r1 勘误：unlink 细节通常不可见，继承 P0-3 组件行为——r2 审 L4 措辞统一）。

## §2 r3a 帧身份（已实现；审读点=身份门序+零副作用）

**分工**：身份门在宿主面（rpc-write-host）；网关保持传输薄（形校验+转发+ack）。r3b（执行面：真重发 payload 读回+TurnGate）另批。

**契约面**（contracts.ts）：`WRITE_OPEN_FRAME_TYPES+resume`；prompt 可选 `generation?`（安全整数≥0；exactWrite 探测副本剥除后四字段严格形——v1 客户端原形不变）；新 `resume{requestId,file,intentId,generation}` 帧；`WriteIdentityRejectCause = no-recovery-data | resume-blocked | resume-not-authorized | generation-mismatch`；结果帧=**`write-resume-ack`（非 4409；原预告勘正——身份拒非传输层错误）**：resume 拒走 `{kind:"identity-rejected",cause}`，通过走 `{kind:"execution-pending"}`（诚实占位，非 not-ready 挪用）；prompt.generation 拒=write-ack.outcome 加枝 `identity-rejected{generation-mismatch}`。

**身份门序**（rpc-write-host.resume；全部拒绝零副作用——不触 sessionFor/send）：
1. 无权威源（resumeAuthority 缺省）→ no-recovery-data（fail-closed，审计 source=absent）
2. reportFor 抛错→审计+stripped→网关 4402（细节先落宿主审计再截断）
3. report null→no-recovery-data
4. resumeBlocked→resume-blocked（优先于授权；原预告「恒空=全拒」收敛为独立成因）
5. intentId ∉ resendAuthorized→resume-not-authorized
6. live generation ≠ frame.generation→generation-mismatch（无活进程 live=null→放行至执行面，无冒充对象）
7. 全过→execution-pending（r3b 真重发）

prompt.generation（同门序第六步；**K3 审 P2-1 拍板 fail-closed**）：携带代次+无权威源→identity-rejected{no-recovery-data}（身份断言不可验证→拒；v1 缺省不受影响）；有权威源旧代→generation-mismatch；无活进程→放行。

**真源装配**（composition）：makeResumeAuthority 工厂（导出供装配层测试）——reportFor=journal 绝对路径→logicalNameWithinRoots 归一逻辑名→recoveryEvidence→isRecoverySnapshot→recoverFromSnapshot→{resendAuthorized,resumeBlocked}（**键与 get-recovery 同面：seen-store/锚点持久键单一宇宙，K3 审 P1 修复**）；generationFor=绝对路径直查 registry.statusFor(file).process.generation（write 面口径——sendPrompt/stop/sessionFor 链皆绝对路径键；file 未构造/无 registry→null 放行）。**接线运行时验证入 r3b E2E**（execution-pending 真重发链一起测；本批证据=tsc 类型链+W-res/W-ra 替身面+互审点验）。

**资源面（K3 审 P2-3，r3b 设计条目）**：resume reportFor 直调 provider（全量 journal 读+解析），绕开 get-recovery 的计算闸（registerTask+semaphore+连接 abort）；r3b 须定 semaphore/按 evidenceHash 缓存/断连取消口径。

writer-authority WS 层接线（双 tab 单写者）：与 Kimi 前端面联动评估，不在 r3a 范围。

## §2b r3b 执行面（已实现；审读点=执行点读一致面+结果映射+窄窗口明示）

**执行序**（门序四校验通过后）：
1. `executeFor(file, intentId)`（ResumeAuthority 新方法）：**同一快照**同出复核报告+目标载荷——门序→执行间隔内新阻断/授权撤销在此收敛（快照原子面）；残余窗口=读完成→send 提交，彻底闭环属写面原子化（P0-4 后 TECH 债条目，不在本批）。复核拒→identity-rejected（cause 同枚举，审计 source=execute-recheck）。
2. `payload===null`→`execution-failed{cause:"payload-unavailable"}`（授权在但 enqueue 载荷读不回——证据不完整，非身份错；零副作用）。
3. `generationFor` 执行点重查（内存廉价）：拦「门序→执行点间进程重启换代」（send 打到新进程=语义错配）→generation-mismatch。
4. `sessionOf(file).send(rawText)`：TurnGate 交涉天然在 session.send 内；结果=SessionSendResult 映射（launched/busy/gate-rejected/gate-failed/invalidated/no-process/not-ready 同 prompt 面）。

**契约终形**：WriteResumeOutcomeDTO 删 execution-pending（占位被真交付替换）→identity-rejected|execution-failed|（与 prompt 面同构的七枝独立声明，不嵌套复用——identity-rejected 的 cause 空间两帧面不同，嵌套会并集松化类型；同构性由赋值兼容自证，无 as）。launched.intentId=重发新意图；原意图→新意图关联在宿主审计行（write-resume outcome=launched newIntentId=…）；**journal 面不因 resume 加行型**——新 enqueue 即无辜新意图，重放语义不变（幂等保护=matchKey 同文本重发已有语义）。

**composition 接线**：makeResumeAuthority 加 executeFor=同 readOnce 归一链→recoverFromSnapshot→intents 查 payload.rawText（授权在则 intents 必含该 id；缺=防御 null）。

**资源面（K3 审 P2-3 定案）**：per-file in-flight 合并（并发读共享同次 provider 调用；完成即删）——**不缓存**：无失效钩子下缓存 resume #1 快照跨 send 不失效→同 matchKey 双发面，正确性否决；断连取消=r3a 同口径不提供（帧应答前断连=send 已提交不可撤）；预算闸=evidence-source 合计 8MiB 入口门（同源）。

**E2E（A-3）**：真 composition 接线实证（K3 附条件后半）——手造 journal（writer+enqueue）→resume 帧→identity-rejected{resume-not-authorized}：收到 not-authorized（非 no-recovery-data）即证归一键链通+真 provider 读到真盘+恢复算法真跑；零新行断言=零副作用。首捕信任=测试仓显式 trustFirstRecoveryCapture:true（生产=宿主声明，不传则新文件恒 no-evidence-snapshot——B12-1 冷启动权威门）。

- **FF-P02-1 装配硬序**：任一 journal 业务行写入前该文件必有 writer 宣誓行且 guard 就绪；装配失败=零业务行写入（E2E 断言盘面）。
- **FF-P02-2 守卫全覆**：TurnGate/DispatchCoordinator 两写入口产生的全部行经守卫（测试注入探针：绕守卫直接打 FileDurability 的路径不存在——装配层唯一构造点走查+变异）。
- **FF-P02-3 关停有序**：dispose 后无新 append 被受理；锁释放前写面已静止（证据层级=单元受控交错（R1-交错1/2+GPT r2 审探针 P4：guard-check 挂起时 dispose→在途先完成再释放，late 行拒）——组合根 E2E 无 dispose 期并发写注入，不冒称）。
- **FF-P02-4 重启身份**：同 bootId 不重复宣誓同文件；重启（新 bootId）→新 epoch 严格递增；旧进程存活→新进程锁拒。
- **FF-P02-5（r3a）帧身份拒旧**：旧 generation/intentId 冒充→identity-rejected（prompt 面=write-ack 枝；resume 面=write-resume-ack），零会话创建零盘面写入（r2 预告时写作 4409，实装后勘正——身份拒非传输层错误）。

## §4 ADR

- **P02-D1 序列化单一来源**：serializeJournalLine 入 protocol；FileDurability 守卫壳共用。防：字节计数与实写格式漂移（noteAppended 记账错=守卫假阳性冻结/假阴性放行）。
- **P02-D2 bootId 全局单次**：一次 server 启动一 UUID，多文件共享。弃逐文件独立 bootId：跨文件写权属同一进程身份，读面 INV-3（同 epoch 两 bootId=脑裂）按文件判即可，共享 bootId 让「同次启动」跨文件可识别。
- **P02-D3 守卫壳不改 sessionFor 同步契约**：懒异步装配，append 入队后 await boot 结果（失败=reject「guarded-writer:…」恒拒，RpcSession 面=durability-failure；非「同步拒」——r1 文档过称勘误）。弃 sessionFor 异步化：侵入 ws-gateway/rpc-write-host 全调用面，收益零（RpcSession.send 本就异步冷启动，首写前装配必已完成或已失败）。
- **P02-D4 恢复链不入装配批**：装配只读 writer 行历史（scanWriterEpoch）；修复/裁决/恢复扫描（resumeBlocked 面）=既有懒路径不动。理由：装配批最小化（GPT r3 五项必验聚焦），恢复链行为已有 1a/1b 全套审链。

## §5 测试计划（W-asm 系；变异纪律=基线先提交+五步单链+杀点点验）

| # | 断言 | 杀点 |
|---|---|---|
| W-asm-1 | 装配硬序：首 append 前 writer 行已在盘（读盘断言）；装配失败 append→reject 恒拒（fail-closed） | 去装配 await→挂 |
| W-asm-2 | 锁失败零写：EEXIST（活/死同拒）→写全拒（sessionFor 同步契约不变，见 §4 P02-D3）+零业务行 | 去锁检查→挂 |
| W-asm-3 | 守卫接线：check 冻结后 append 拒（superseded 注入异已宣誓行）| 壳绕过（直接 inner.append）→挂 |
| W-asm-4 | 字节记账：noteAppended=序列化实长（serializeJournalLine 共用断言） | 计数偏移→后续 check 误冻/误放→挂 |
| W-asm-5 | 关停序：dispose 后 append 拒+锁已释放（文件不存在）；释放前写面静止 | 释放提前→挂 |
| W-asm-6 | E2E 真服务（A-1）：composition 起→prompt 写→dispose→实例重建续写（epoch 1→2+新 bootId+锁清）；A-2 双实例活锁拒。**边界（r1 勘称）**：实例重建≠OS 进程 SIGKILL；崩溃残留（stale 锁→运维清锁）与 SIGKILL 链=未在 E2E 验证，stale 行为由单元 W-asm-2 死锁例覆盖 | — |
| W-asm-7 | 双实例拒：同 journal 第二实例锁拒+零写 | — |

W-res 系（r3a，tests/unit/server/ws-gateway-write-resume.test.ts，11 例）：

| # | 断言 | 杀点 |
|---|---|---|
| W-res-1 | 形校验：resume 缺/坏字段→4404（4404 累计 3→close 1002 故拆两连接）；多余字段→4404 | exactWrite 集合松→挂 |
| W-res-2 | 只读网关（未接写宿主）→4405+close 1008（v1 冻结面不变） | 开放面越界→挂 |
| W-res-3 | 无权威源（resumeAuthority 缺省）→no-recovery-data（fail-closed） | 缺省放行→挂（Mu-r3a-3） |
| W-res-4 | reportFor→null→no-recovery-data | — |
| W-res-5 | resumeBlocked 优先于授权→resume-blocked | 门序错→挂（Mu-r3a-1） |
| W-res-6 | intentId ∉ resendAuthorized→resume-not-authorized | — |
| W-res-7 | 旧代→generation-mismatch（审计 frame=2 live=3） | — |
| W-res-8 | 全过→execution-pending+write-resume-ack 帧结构+requestId 槽归还 | — |
| W-res-9 | 无活进程（generationFor→null）→放行（无冒充对象） | — |
| W-res-10 | prompt.generation 四态：旧代拒+零副作用（created.n===0）；匹配放行；缺省 v1 兼容；无活进程放行 | 校验跳过→挂（Mu-r3a-4）；零副作用破坏→挂（Mu-r3a-2：sessionOf 前置→created.n=1） |
| W-res-11 | reportFor 抛错→stripped（write-host-internal: resume）→4402+审计 op=resume | — |
| W-res-12 | prompt.generation+无权威源→no-recovery-data（fail-closed；零副作用；v1 缺省照写） | fail-open 复活→挂（Mu-fix-1） |

W-ra 系（r3a 修复批，tests/unit/server/resume-authority.test.ts，5 例）：

| # | 断言 | 杀点 |
|---|---|---|
| W-ra-1 | abs→provider 收逻辑名（单根/子目录形；get-recovery 同键） | 归一破坏→挂（Mu-fix-2） |
| W-ra-2 | 无匹配根→原样透传（fail-open 归一不制造拒因） | — |
| W-ra-3 | provider null/非 snapshot→report null | — |
| W-ra-4 | snapshot→recoverFromSnapshot 真映射 | — |
| W-ra-5 | generationFor=registry 直查（键=原样绝对路径，write 面口径） | — |

变异四杀全过（基线 8d8e255；每条=注入→git diff 非空→定向红点名→checkout 还原→复绿）：Mu-r3a-1 blocked 优先 if(false&&)→W-res-5；Mu-r3a-2 prompt 校验前 await sessionOf→W-res-10；Mu-r3a-3 authority 缺省 if(false)→W-res-3；Mu-r3a-4 generation 校验 if(false&&)→W-res-10。

## §6 迭代史

- r1：装配面（GPT 审 58 NO-GO：R1 dispose 不汇合在途 boot→锁泄漏/释放后旧宣誓污染后继；R2 check→append→note 未整体串行→同写者自冻粘性；R3 bootP 无 rejection 归一化→取锁 I/O 异常 unhandled rejection 杀进程——三探针实锤 /tmp/gpt-p02-r1-probe/）。
- r2（本批）：根修=每 writer 生命周期队列（boot/append/close 全串行临界区）+dispose 汇合队列（含在途 boot）+boot 检查点①②（装配中 dispose→零宣誓零泄漏中止）+bootP 构造即归一化（异常→failed 恒拒，永不成 unhandled）+mkdir 父目录（对齐 FileDurability）。杀点：R1-交错1/交错2、R2 并发自写、R3 子进程 EACCES exit=0。文档同步收窄（§1.4 释放序/§4 P02-D3 同步拒称/§5 W-asm-6 崩溃链边界；r2 审 L3 勘正原引用漂移）。
- r2 尾债（98c8f11 并入 r3a 送审）：L1 E2E A-2 finally 遮蔽；L2 R2b 落盘后未记账窗口入仓；L3 设计稿五处；L4 交错1 注释勘正。
- r3a（本批）：帧身份门（resume 帧+prompt.generation；§2 展开）。审读=Kimi K3（互审制首单，GPT 额度尽后 GLM 写→K3 审）。r3b（下批）：执行面（真重发 payload 读回+TurnGate 交涉）+composition 真源接线 E2E。
- r3a 修复批（K3 审 86 GO 附条件，8eec8a4）：P1 makeResumeAuthority 键归一（abs→逻辑名/provider 单一宇宙；generationFor 保持 write 面 abs 口径）+P2-1 prompt 无权威源 fail-closed（no-recovery-data）+P2-2 intentIdPattern+P2-3 资源面记 r3b+P3 四小项。W-ra 五例+W-res-12；变异三杀。
