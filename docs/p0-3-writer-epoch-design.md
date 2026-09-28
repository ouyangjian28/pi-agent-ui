# P0-3 设计稿：journal 写权代次（writer oath）——全服务重启身份恢复与拒旧续写

> P0 冻结序③（PROJECT.md s4g 分工）。边界（2026-10-08 需求对齐拍板）：只管**同一 session journal 文件跨 server 进程代次双写拒**；不管多端并发提交（网关串行化+writer-authority 连接级 epoch 管）、不管多会话并存（多文件互不共享，tmux 多实例的 UI 对应物）。帧面身份（session/revision/writerEpoch/processGeneration/commandId 进写帧）=P0-2（④位），本片只做 server 进程维度。

## 1. 三层身份模型（现有两层+本片新增第三层）

| 层 | 概念 | 存储 | 管什么 | 状态 |
|---|---|---|---|---|
| 连接级 | writer-authority `epoch`（writer-authority.ts） | 内存 | 页面/连接写权单席（接管/让位/僵死交接）；stale-epoch 拒旧页面提交 | ✅ 已有 |
| 会话进程级 | `generation`（契约帧面 ready/superseded/enqueue 行） | 帧+journal enqueue 行 | pi 会话进程 spawn 代次（一次 spawn 一代） | ✅ 已有 |
| **server 进程级** | **writer oath `epoch`+`bootId`（本片）** | **journal writer 行（append）** | **journal 文件写权归属代次：谁是合法续写者、旧写者如何被拒** | 🔨 本片 |

## 2. 威胁模型

- **T1 部署双实例**：同机双 systemd 单元/手动+服务并存 → 同 journal 文件双写者，行交错撕裂。
- **T2 重启竞态**：旧 server 收尾写 vs 新 server 恢复写（关闭超时/强杀后 systemd 立即拉新）。
- **T3 旧写者复活**：SIGSTOP 解除/长停顿（VM 暂停恢复/swap 颠簸）后旧 server 继续写——新 server 已接管。
- **T4 共享存储双挂**（NFS/双机同卷）：flock 语义弱或不可用。当前部署=单机 systemd（非现实面）。防御定位=纵深异常检测，不构成跨机写权防护；多机共享存储=不支持形态（§6 D2）。

## 3. 方案：两道防线

### L1 OS 级互斥（同机硬门；落地=O_EXCL 锁文件，r2 起 fail-closed）

> **r2 勘误（GPT r1 F1/F8，2026-10-09）**：设计时设想 flock，落地时改 O_EXCL 锁文件+pid 探活——两者不等价（flock 由 OS 回收崩溃锁，锁文件不会）。r1 实现的「探活死→unlink→重建抢占」有 TOCTOU 窗（两竞争者交错 unlink 可互删对方新锁→双持有者，确定性探针复现）。**r2 拍板：fail-closed 无抢占**——stale 锁同样拒起+stale 诊断；崩溃残留恢复=宿主/运维显式清锁（宁拒起不可双写）。ADR-D2 同步勘误。

启动时创建锁文件 `${journalPath}.writer.lock`（O_EXCL 原子创建，写 {pid,bootId,at}+fsync）：
- 创建成功 → 持有；release 读回校验 bootId 后删（只删自己的）。**条件保证（r3/GPT r2 R2-F1）**：release=单次共享（重叠/重复调用共享同一在途 Promise，至多一次「读回→unlink」序列；无共享时重叠调用可删到下一任持有者的锁→双持有）+调用方保证释放前写面静止（装配层约束：先关写面再释放锁）+信任域排除外部路径替换——「持有者唯一删除者、无 TOCTOU」是这三项前提下的结论，非无条件性质。
- EEXIST → 探活（process.kill(pid,0)：ESRCH=死，EPERM=活保守）：活=held 拒；死=held 拒+stale:true 诊断（供运维清理：前提=停服务（含旧/暂停写者）+禁并发拉起+同命名空间+其他清锁者串行化——stale 本身不自动等于清理安全，见 GPT r3 R3-F4）；锁不可读=held+holder:null 保守拒。**任何分支都不 unlink 不重试**。
- 挡 T1/T2（同机）。T4 共享存储（NFS）上 O_EXCL 弱语义→L2 为**异常检测**（非写权防护、非存储端 fencing；多机共享存储=不支持形态，需另做存储端 fencing，见 §6 ADR-D2）。

### L2 持久代次宣誓（writer 行，跨锁防线）

**锁防线外的第二道检测（历史稿称「flock 失效场景的兜底」——L1 落地已非 flock，见 §3 r2 勘误；真正场景：锁被误删/绕锁路径写/T3 复活写者）**。核心机制：

**新行型 `writer`（宣誓行）**：

```ts
{ readonly t: "writer"; readonly epoch: number; readonly bootId: string; readonly at: string } // at=ISO8601 字符串（与实现一致；r2/F8 勘误：设计初稿误记 number）
```

- `epoch`：journal 写权代次，单调 +1；`bootId`：server 启动身份（UUID，复用读面 bootId 概念：一次启动一个身份，读写面统一）；`at`：墙钟（展示用，不参与判据）。
- 无 intentId —— 同 RepairLine/AdjudicateLine 模式：重放聚合不参与，报告侧呈现（journal 读面新增「当前写者」呈现）。

**启动恢复硬序（宣誓前不开写面）**：

1. O_EXCL 锁文件 acquire（L1，失败即拒起）；
2. 走既有恢复链（repair/adjudicate/对账——recover.ts，不改）；
3. 全扫 journal：取最高 writer 行 epoch=N（无数=null）；
4. 自 epoch=N+1，bootId=新 UUID，追加 writer 宣誓行（fsync）；
5. 开放写面（写通道受理）。

**旧写者写前检查（停写面；r2 起增量基线，r3 起绑定宣誓边界）**：写者以 `initialize(oath)` 建基线（入参=appendWriterOath 成功结果对象，其 byteEnd=自身宣誓字节终点；r3/GPT r3 R3-F1 勘误：这是**装配调用约定非类型强制**——结构类型 {byteEnd} 不证明来源（手造 stat 包装对象可骗过签名），装配层保证唯一流入自身成功 oath（服务装配批机械验证）；全盘 stat 会吞并发他者宣誓字节进基线守卫永续放行；一次性，重复调用无效返回 false 拒重置），此后每次 append+fsync 成功 `noteAppended(自写字节数)` 增量记账。未 initialize 即 check=uninitialized 拒（r1 缺陷形：未初始化默认放行）。每次业务 append 前 stat：size ≠ 基线 → 从尾回扫 writer 行：发现 `epoch ≥ 自身` 的异已宣誓（bootId ≠ 自己）→ **冻结写面**（后续 append 一律拒+告警，进入 writer-superseded 状态；冻结粘性，initialize/noteAppended 不解冻）+保留诊断；扫不到异已宣誓（合法写者必先宣誓，无宣誓他写=异常盘面）→ 同样冻结（foreign-write-detected，保守）。check→append 窗口内的他写=检测非预防（L2 界限，文件头注；在途 check 的 await 返回 ok 后新 check 已冻结的交错=装配层串行承诺，见 §7 r3）。

**不变式**：
- INV-1（先宣誓后业务）：journal 中任何业务行（有 intentId 的行）之前必有 writer 行；行归属=最近前置 writer 行的 epoch。
- INV-2（代次单调）：writer 行 epoch 严格递增（重放可机检）。
- INV-3（独占宣誓）：同 epoch 不出现两个 bootId（出现=脑裂已发生，读面报告呈现，写面保守冻结）。

### 契约版本

`JOURNAL_CONTRACT_VERSION` 2→3（行型联合扩展，先例：P0-1a RepairLine 入联合时 1→2）。**legacy v2 journal（无 writer 行）兼容读**；恢复时先补宣誓（步骤 3 N=null → 自 epoch=1）——首个 writer 行落盘后 v3 域生效。repair/adjudicate 行绑定版本=2 的存量不受影响（行内版本字段=写入时绑定，读面按行判）。

## 4. FF（fitness functions，收尾必跑）

- **FF-P03-1 单例互斥**：双实例同 journal，第二实例拒起且零字节写入（O_EXCL 锁文件门）。
- **FF-P03-2 宣誓硬序**：恢复流程产出的 journal，首个业务行之前必有 writer 行；重启 N 次得 N 条递增 writer 行。
- **FF-P03-3 旧写者停写**：注入异已 writer 行后，旧写者 append 一律拒（writer-superseded 冻结，含锁内场景）。
- **FF-P03-4 重放兼容**：writer 行进重放聚合不炸（忽略+报告呈现）；INV-2/INV-3 违反盘面=报告呈现不崩溃。
- **FF-P03-5 legacy 兼容**：v2 journal（无 writer 行）恢复读写正常（补宣誓后转 v3 域）。

## 5. 测试面预排（实现批展开）

- W-oath-1/2/3/4/5 对应 FF-1..5 正例；负例与变异：
  - Mu：flock 门删→FF-1 杀；宣誓后置（业务行先写）→FF-2 杀；写前检查删→FF-3 杀；writer 行参与聚合（漏忽略）→FF-4 杀；legacy 拒读→FF-5 杀。（预排；实际变异谱与分批记录=TEST-MAP P0-3 节权威）

## 6. ADR（落 projects/pi-agent-ui/decisions）

- **D1 宣誓入 journal（append 行）而非 sidecar 文件**：单一事实源；恢复链/读面复用；无第二原子域（sidecar 与 journal 跨域=新撕裂面）。翻案条件：journal 行体积/解析成本成为瓶颈且宣誓频率高（>1/min）。
- **D2 flock 主互斥+epoch 行兜底（r2 勘误：落地为 O_EXCL 锁文件，非 flock 等价）**：O_EXCL 同机硬、快、零成本；但**崩溃锁不自动回收**（flock 会）——r1 抢占式回收有 TOCTOU，r2 改 fail-closed（stale 同拒+诊断，显式清锁恢复）。epoch 行慢但跨锁成立（锁被绕过/误删后仍能检测）；**跨机共享存储不成立**（写前检查是检测非预防，无存储端原子拒旧写）——单机部署下双防线够用，多机共享存储=不支持形态（需另做存储端 fencing，超本片范围）。翻案条件：部署形态改为多机共享存储。
- **D3 bootId 复用读面概念**：一次启动一个身份，读写面统一。翻案条件：无（命名统一项）。
- **D4 契约版本 2→3，legacy 兼容读+写前补宣誓**：行型联合扩展必 bump；存量 v2 journal 无 writer 行≠错误。翻案条件：无。

## 7. 实现批对照（2026-10-08 落库 11bc0df+1b6a8d4；TEST-MAP P0-3 节权威）

- FF-1..5 ↔ W-oath-1..5 全落地（实现批时点 12 例全绿；全仓 1422 绿——历史记录；r2 后=14 例、r3 后=17 例，见下）。变异五点全杀：Mu-1 活锁拒起门/Mu-2 bad-tail 盘面门/Mu-3 superseded 判定/Mu-4 INV-2 anomaly/Mu-5 legacyHead 反写（双杀）。教训：sed 注入后 `git diff --stat` 空=未命中（Mu-5 首跑行号差一），必须验 diff 非空再判杀。
- **L1 落地差异**：Node 无 flock 绑定→O_EXCL 锁文件+pid 探活（**非语义等价**，见 §3 r2 勘误：flock 由 OS 回收崩溃锁、锁文件不会——r2 起 fail-closed，stale 同拒+诊断，无 unlink 抢占；release 读回校验 bootId，持有者=唯一删除者）。锁文件=`${journalPath}.writer.lock`。
- **契约 2→3 连带决策（D4 展开）**：repair 行写面 contractVersion=JOURNAL_CONTRACT_VERSION 常量注入；**repair-tail 旧行形枚举三形**（r2/F3；r3/GPT r2 R2-F6 时间线勘误——生产行型与 marker 是两条时间线）：①新形（随常量）②v2 无身份（fix11..8ce8d3b^ 即 P0-1b r7 前，固定 v2）③**v2+身份过渡形**（8ce8d3b..11bc0df^ 即 P0-1b r7..r10：r7 起生产行型已带 fragIntentId 而契约仍 v2；marker 携身份另自 r8 6eb761f 起，11bc0df^ 历史实证；缺此枚举过渡窗残局被误判 conflict 拒）。buildRepairRow 加 contractVersion 入参——枚举=历史兼容面不随常量漂移，未来版本升级只追加枚举不改旧形。schema contractVersion≥1 安全整数=v2/v3 兼容读。测试 helper 拆 mrowOf（当前契约形态）/mrowLegacyOf（固定 v2 历史形）/mrowV2FragOf（过渡形）。
- **r2 修复批（GPT r1 审后，2026-10-09）**：①F1 锁 fail-closed（§3 勘误）②F2 WriterGuard 增量基线（initialize/noteAppended 替 noteSize；uninitialized 拒；冻结粘性）③F3 枚举三形（上条）④F4 adjudicate-journal 生产默认 `?? JOURNAL_CONTRACT_VERSION`（残留字面量 2 会写错版本）⑤F5 appendWriterOath 写前参数校验（epoch 耗尽/非正安全整数/bootId 空→invalid-oath 零改盘）⑥F7 schema writer 行 at 非空。测试 W-oath-1/3 重写+W-oath-6 新增；RT37 形二a 过渡形。
- **r3 修复批（GPT r2 审 77 NO-GO 后，2026-10-09）**：①R2-F1 release 单次共享（重叠/重复调用共享在途 Promise；W-r3-1）②R2-F2 initialize 绑定宣誓边界（入参改 oath 结果对象，调用约定层堵 stat 吞字节——类型层不封死，见 R3-F1 勘误；一次性拒重置；W-r3-2）③R2-F3 at 空串写前拒+组装行 parseJournalText 自证（显式层零 I/O，自证层在读盘后非零 I/O；W-r3-3）④R2-F4 变异锁面补强（adjudicate 默认版本精确断言 Mu-extra-F4；W3 注释失实勘误）⑤R2-F5 文档降界五处（本节上下改动）。组件级约束（单次 release/初始化证据/进程内串行）在服务装配批验证真实重启/关闭重入。
- **r3 尾债批（GPT r3 审 86 GO 后，2026-10-09；审报 audits/gpt-p03-r3-review-*.md）**：P2 四项定向修①R3-F1 初始化证据降称（「类型封死」→装配约定；设计稿/源码旧「initialize(宣誓后 stat)」序删除）②R3-F2 schema 空 at 直接负例（journalLineSchemaError 空 at 拒——锁 Mu-extra-F7 放宽 schema 变异）③R3-F3 变异证据勘误（Mu-r3-2/4 首杀=initialize 返回值契约杀非放行杀；单删 frozen 条件不清 frozen，check 仍返原冻结结论——「解冻放行」解释删除）④R3-F4 文档残留清（源码头注/FF flock→O_EXCL；selfCheck「均在任何 I/O 前」→分层表述；history-source「=审读环境时序」→「本轮未复现根因未定」）。GO 边界=组件批，不外推真重启/业务写守卫装配（装配批另验）。
- **实现切面**：scanWriterEpoch 放 protocol 层（writer-oath.ts 与 recover.ts 共用，破 recover↔writer-oath 循环依赖）；WriterGuard 写前检查=stat size 快路径+变化时重读慢路径；writerState 并入 RecoverReport（异常呈现不阻断恢复）。
- **未接线面（后续批）**：ws-gateway 服务启动序（acquire→恢复→宣誓→开写面）与业务行写面 WriterGuard 接线=写面装配批（P0-2 前）；本批=纯增量（协议+工具+读面呈现），不改既有写路径行为。
