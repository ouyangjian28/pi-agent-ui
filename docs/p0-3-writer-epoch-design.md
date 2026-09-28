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
- **T4 共享存储双挂**（NFS/双机同卷）：flock 语义弱或不可用。当前部署=单机 systemd（非现实面），但判据不依赖单机假设（纵深防御）。

## 3. 方案：两道防线

### L1 OS 级互斥（flock，同机硬门）

启动时对 journal 文件 `flock(LOCK_EX | LOCK_NB)`：
- 拿到 → 持锁直到进程退出（fd 生命周期=锁生命周期；崩溃自动释放）。
- 拿不到 → **存在活实例**：拒绝启动（响亮报错，不写任何字节）——服务单例由 OS 保证。
- 挡 T1/T2（同机）。锁文件路径=journal 文件本身（锁 inode 而非路径——同内容换 inode 由既有指纹/前缀判据域管，与本门正交）。

### L2 持久代次宣誓（writer 行，跨锁防线）

**flock 失效场景的兜底**（T3 复活写者锁已丢？——T3 旧进程 fd 还开着锁没丢……真正场景：flock 在 NFS 上弱语义/锁被系统释放/绕过锁路径的写）。核心机制：

**新行型 `writer`（宣誓行）**：

```ts
{ readonly t: "writer"; readonly epoch: number; readonly bootId: string; readonly at: number }
```

- `epoch`：journal 写权代次，单调 +1；`bootId`：server 启动身份（UUID，复用读面 bootId 概念：一次启动一个身份，读写面统一）；`at`：墙钟（展示用，不参与判据）。
- 无 intentId —— 同 RepairLine/AdjudicateLine 模式：重放聚合不参与，报告侧呈现（journal 读面新增「当前写者」呈现）。

**启动恢复硬序（宣誓前不开写面）**：

1. flock（L1，失败即拒起）；
2. 走既有恢复链（repair/adjudicate/对账——recover.ts，不改）；
3. 全扫 journal：取最高 writer 行 epoch=N（无数=null）；
4. 自 epoch=N+1，bootId=新 UUID，追加 writer 宣誓行（fsync）；
5. 开放写面（写通道受理）。

**旧写者写前检查（停写面）**：写者维护「上次 append 后的文件 size」。每次业务 append 前 stat：size ≠ 记忆值 → 有他者写过（锁外写入）→ 从尾回扫 writer 行：发现 `epoch ≥ 自身` 的异已宣誓（bootId ≠ 自己）→ **冻结写面**（后续 append 一律拒+告警，进入 writer-superseded 状态）+保留诊断；扫不到异已宣誓（他者写的是业务行？不可能——合法写者必先宣誓；=异常盘面）→ 同样冻结+告警（保守：盘面已不是自己独占）。

**不变式**：
- INV-1（先宣誓后业务）：journal 中任何业务行（有 intentId 的行）之前必有 writer 行；行归属=最近前置 writer 行的 epoch。
- INV-2（代次单调）：writer 行 epoch 严格递增（重放可机检）。
- INV-3（独占宣誓）：同 epoch 不出现两个 bootId（出现=脑裂已发生，读面报告呈现，写面保守冻结）。

### 契约版本

`JOURNAL_CONTRACT_VERSION` 2→3（行型联合扩展，先例：P0-1a RepairLine 入联合时 1→2）。**legacy v2 journal（无 writer 行）兼容读**；恢复时先补宣誓（步骤 3 N=null → 自 epoch=1）——首个 writer 行落盘后 v3 域生效。repair/adjudicate 行绑定版本=2 的存量不受影响（行内版本字段=写入时绑定，读面按行判）。

## 4. FF（fitness functions，收尾必跑）

- **FF-P03-1 单例互斥**：双实例同 journal，第二实例拒起且零字节写入（flock 门）。
- **FF-P03-2 宣誓硬序**：恢复流程产出的 journal，首个业务行之前必有 writer 行；重启 N 次得 N 条递增 writer 行。
- **FF-P03-3 旧写者停写**：注入异已 writer 行后，旧写者 append 一律拒（writer-superseded 冻结，含锁内场景）。
- **FF-P03-4 重放兼容**：writer 行进重放聚合不炸（忽略+报告呈现）；INV-2/INV-3 违反盘面=报告呈现不崩溃。
- **FF-P03-5 legacy 兼容**：v2 journal（无 writer 行）恢复读写正常（补宣誓后转 v3 域）。

## 5. 测试面预排（实现批展开）

- W-oath-1/2/3/4/5 对应 FF-1..5 正例；负例与变异：
  - Mu：flock 门删→FF-1 杀；宣誓后置（业务行先写）→FF-2 杀；写前检查删→FF-3 杀；writer 行参与聚合（漏忽略）→FF-4 杀；legacy 拒读→FF-5 杀。

## 6. ADR（落 projects/pi-agent-ui/decisions）

- **D1 宣誓入 journal（append 行）而非 sidecar 文件**：单一事实源；恢复链/读面复用；无第二原子域（sidecar 与 journal 跨域=新撕裂面）。翻案条件：journal 行体积/解析成本成为瓶颈且宣誓频率高（>1/min）。
- **D2 flock 主互斥+epoch 行兜底**：flock 同机硬、快、零成本；epoch 行慢但跨锁/跨机成立。双防线纵深，不互替。翻案条件：部署形态改为多机共享存储（flock 全废，epoch 行升主位）。
- **D3 bootId 复用读面概念**：一次启动一个身份，读写面统一。翻案条件：无（命名统一项）。
- **D4 契约版本 2→3，legacy 兼容读+写前补宣誓**：行型联合扩展必 bump；存量 v2 journal 无 writer 行≠错误。翻案条件：无。
