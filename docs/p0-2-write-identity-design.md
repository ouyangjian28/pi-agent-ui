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

| 失败 | 行为 | 服务呈现 |
|---|---|---|
| 锁 EEXIST（活/死同拒；stale=诊断） | 该 file 写面不开 | 该会话写请求→4402（not-ready.cause=writer-lock-held）；读面正常 |
| 盘面 bad-tail（撕裂尾/坏行在场——oath 门拒；修复/裁决=1a/1b 既有面，不入装配链 ADR-P02-D4） | 写面不开 | cause=writer-bad-tail |
| 宣誓写失败（fsync 失败等） | 写面不开 | cause=writer-oath-failed |
| 运行中冻结（superseded/foreign-write） | 后续 append 全拒 | audit+statusFor 呈现 writerState（冻结原因+对方 epoch/bootId） |

运维清锁前提（P0-3 设计稿 §3 已冻结）：停服务（含旧/暂停写者）+禁并发拉起+同命名空间+其他清锁者串行化。**stale 锁不自动清**——SIGKILL 后自动重启（systemd）会拒绝开写面直至运维清锁；这是 P0-3 r2 已审定的 fail-closed 语义，本批不改。

### 1.4 关停序（composition dispose 插位）

现有冻结序：摘 onConnection → 停轮询/SIGHUP → gateway.dispose（1000 告别+观察器解绑）→ adapter.dispose → tokens.dispose。
本批插入：composition.dispose 实际序=registry.dispose（排空会话）→ **guardedWriters.dispose（汇合每 writer 生命周期队列含在途 boot/append+关底座+逐文件 `releaseLock()`）** → tokens.dispose——释放前写面静止由队列汇合保证（r2 根修：不再依赖调用方序）。释放失败=audit（锁残留=下次启动 EEXIST 拒，可接受；r1 勘误：unlink 细节通常不可见=「部分失败可能静默残锁」，继承 P0-3 组件行为）。

## §2 r2 帧身份（预告，r1 审定后细化）

- 契约 v1.1：`prompt` 帧扩 `generation`（number；客户端从 session/live 事件取当前进程代次；网关校验=当前活代匹配，旧代→4409）；新增 `resume` 开放帧形 `{t, requestId, file, intentId, generation}`。
- resume 校验序：形校验（4404）→ 开放面（4405）→ intentId∈recovery.resendAuthorized（否则 4409 resume-not-authorized；resumeBlocked=true 时恒空=全拒提示走修复面）→ generation 匹配 → 宿主执行面（rpc-session 重发接线，授权≠执行面已定）。
- writer-authority WS 层接线（双 tab 单写者）：r2 批评估是否同批或后移（Kimi 前端面联动）。

## §3 FF（fitness functions）

- **FF-P02-1 装配硬序**：任一 journal 业务行写入前该文件必有 writer 宣誓行且 guard 就绪；装配失败=零业务行写入（E2E 断言盘面）。
- **FF-P02-2 守卫全覆**：TurnGate/DispatchCoordinator 两写入口产生的全部行经守卫（测试注入探针：绕守卫直接打 FileDurability 的路径不存在——装配层唯一构造点走查+变异）。
- **FF-P02-3 关停有序**：dispose 后无新 append 被受理；锁释放前写面已静止（E2E：dispose 期间注入并发写→全拒或已在途完成，无锁释放后写）。
- **FF-P02-4 重启身份**：同 bootId 不重复宣誓同文件；重启（新 bootId）→新 epoch 严格递增；旧进程存活→新进程锁拒。
- **FF-P02-5（r2）帧身份拒旧**：旧 generation/intentId 冒充→4409，零盘面写入。

## §4 ADR

- **P02-D1 序列化单一来源**：serializeJournalLine 入 protocol；FileDurability 守卫壳共用。防：字节计数与实写格式漂移（noteAppended 记账错=守卫假阳性冻结/假阴性放行）。
- **P02-D2 bootId 全局单次**：一次 server 启动一 UUID，多文件共享。弃逐文件独立 bootId：跨文件写权属同一进程身份，读面 INV-3（同 epoch 两 bootId=脑裂）按文件判即可，共享 bootId 让「同次启动」跨文件可识别。
- **P02-D3 守卫壳不改 sessionFor 同步契约**：懒异步装配，append 入队后 await boot 结果（失败=reject「guarded-writer:…」恒拒，RpcSession 面=durability-failure；非「同步拒」——r1 文档过称勘误）。弃 sessionFor 异步化：侵入 ws-gateway/rpc-write-host 全调用面，收益零（RpcSession.send 本就异步冷启动，首写前装配必已完成或已失败）。
- **P02-D4 恢复链不入装配批**：装配只读 writer 行历史（scanWriterEpoch）；修复/裁决/恢复扫描（resumeBlocked 面）=既有懒路径不动。理由：装配批最小化（GPT r3 五项必验聚焦），恢复链行为已有 1a/1b 全套审链。

## §5 测试计划（W-asm 系；变异纪律=基线先提交+五步单链+杀点点验）

| # | 断言 | 杀点 |
|---|---|---|
| W-asm-1 | 装配硬序：首 append 前 writer 行已在盘（读盘断言）；装配失败 append→reject 恒拒（fail-closed） | 去装配 await→挂 |
| W-asm-2 | 锁失败零写：EEXIST（活/死同拒）→sessionFor 抛/写全拒+零业务行 | 去锁检查→挂 |
| W-asm-3 | 守卫接线：check 冻结后 append 拒（superseded 注入异已宣誓行）| 壳绕过（直接 inner.append）→挂 |
| W-asm-4 | 字节记账：noteAppended=序列化实长（serializeJournalLine 共用断言） | 计数偏移→后续 check 误冻/误放→挂 |
| W-asm-5 | 关停序：dispose 后 append 拒+锁已释放（文件不存在）；释放前写面静止 | 释放提前→挂 |
| W-asm-6 | E2E 真服务（A-1）：composition 起→prompt 写→dispose→实例重建续写（epoch 1→2+新 bootId+锁清）；A-2 双实例活锁拒。**边界（r1 勘称）**：实例重建≠OS 进程 SIGKILL；崩溃残留（stale 锁→运维清锁）与 SIGKILL 链=未在 E2E 验证，stale 行为由单元 W-asm-2 死锁例覆盖 | — |
| W-asm-7 | 双实例拒：同 journal 第二实例锁拒+零写 | — |

## §6 迭代史

- r1：装配面（GPT 审 58 NO-GO：R1 dispose 不汇合在途 boot→锁泄漏/释放后旧宣誓污染后继；R2 check→append→note 未整体串行→同写者自冻粘性；R3 bootP 无 rejection 归一化→取锁 I/O 异常 unhandled rejection 杀进程——三探针实锤 /tmp/gpt-p02-r1-probe/）。
- r2（本批）：根修=每 writer 生命周期队列（boot/append/close 全串行临界区）+dispose 汇合队列（含在途 boot）+boot 检查点①②（装配中 dispose→零宣誓零泄漏中止）+bootP 构造即归一化（异常→failed 恒拒，永不成 unhandled）+mkdir 父目录（对齐 FileDurability）。杀点：R1-交错1/交错2、R2 并发自写、R3 子进程 EACCES exit=0。文档同步收窄（§5 释放序/§3 同步拒称/§6 崩溃链边界）。
