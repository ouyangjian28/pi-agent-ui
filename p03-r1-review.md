# P0-3 writerEpoch 批 r1 独立审读报告

## 一、结论

**61/100，NO-GO。** 本批基础协议与只读呈现可用，但 L1 陈旧锁抢占不具互斥保证，L2 不能可靠兜住该失效；当前不能认可“flock 语义等价”或“T1–T4 已防住”。本轮不修改实现。

审读基准：`252df2ca85a686b8ccfd450a925fa2e7210e9bac`；覆盖 `11bc0df → 1b6a8d4 → 252df2c`。主仓 `/home/yyj/ai/repos/pi-agent-ui` 同一 HEAD，测试前后源码工作区均干净。承认设计 §7 的分批边界：**本批仅协议、工具与报告呈现，未接线本身不作为本批新增 P1**；但“FF 全落地”不能解释为真实服务已经具备这些保证。

### 实测证据

在主仓使用 Node v24.18.0，依次同步运行指定命令，均 exit 0：

```text
npx vitest run tests/unit/server/writer-oath.test.ts
Test Files  1 passed (1)
Tests       12 passed (12)
Duration    302ms

npx vitest run
Test Files  71 passed | 2 skipped (73)
Tests       1422 passed | 15 skipped (1437)
Duration    12.65s
```

原始输出：`/tmp/p03-r1-targeted.log`、`/tmp/p03-r1-full.log`。整仓只跑一次。全部探针与变异均在 `/tmp/p03-r1-probe/`，没有改主仓/审读仓源码；没有派生 agent 或后台任务。开场未收到【流程门】注入块，已披露，按显式规则核查后执行只读审读。

### 七道判断题逐项结论

| 判断题 | 结论 |
|---|---|
| 1. T1/T2/T3/T4 是否防住 | **部分且有硬缺口。** 正常路径、同机同 PID 命名空间、相同规范路径、没有 stale/外部删锁时，O_EXCL 可拒第二写者。T1/T2 遇陈旧锁并发回收可双成功。T3 单纯 SIGSTOP 不使 PID 消失，通常拒接管；锁丢失后仅有条件检测，非可靠拒旧。T4 本机 PID 探活无远端意义，epoch 行不是存储端 fencing（按代次原子拒旧写），不能独立保证共享存储单写。 |
| 2. 锁面 TOCTOU 是否可接受 | **不可接受。** 读死 holder 后，unlink 删除的是当前路径，不一定是读到的旧锁。已复现两个真实 acquire 都成功。release 的读归属再删也非原子，仅减小风险。 |
| 3. WriterGuard 窗口与冻结 | **冻结粘性正确，防线不完整。** 检查和追加之间允许旧写；即使严格 fsync 后 noteSize，传入重新 stat 的全盘大小仍可把外部宣誓吸收进基线，后续继续放行。未初始化还默认放行。 |
| 4. INV-1/2/3 与 legacyHead | **按当前类型定义基本正确，但不能当写权证明。** INV-2 对低于/等于历史最大值报异常，INV-3 同 epoch 不同 boot 报异常；不是仅比较相邻行，也不要求连续 +1。repair/adjudicate 无顶层 intentId，不计业务行符合约定。legacyHead 是历史前缀标记，不阻断；clear 行被定义排除、同 epoch 的“latestBootId”歧义见 F7。 |
| 5. 契约 2→3 连带 | **不完整。** schema ≥1 兼容读正确，固定旧形 v2 的方向正确；但遗漏“v2 且含 fragIntentId”的历史半行。生产 adjudicate 默认仍是 `?? 2`。 |
| 6. 测试与五杀点 | **12 绿和五点杀均真实，但证明范围偏窄。** 五杀不等于设计原列五种变异；没有服务启动/实际追加集成证明，缺少关键竞态与升级残局测试。 |
| 7. 文档与 ADR | **不完全一致，D2 必须重审。** §7 披露未接线值得保留，但“语义等价”“FF 全落地”过强。flock 改为 pathname+PID 锁改变生命周期、抢占与信任假设，不应作为免 ADR 的实现细节。 |

## 二、分项评分

| 维度 | 得分 | 满分 | 扣分依据 |
|---|---:|---:|---|
| 语义正确 | 27 | 40 | 扫描/呈现基本正确；锁抢占、守卫基线与写入校验存在缺口 |
| 攻击面 | 11 | 25 | TOCTOU 可产生双持有者；跨机 PID 与 check→append 不能提供拒旧保证 |
| 测试质量 | 14 | 20 | 全量回归和五个定向变异有效；缺少并发/集成/迁移边界 |
| 文档一致 | 6 | 10 | 未接线有披露；FF、变异映射、L1 等价表述与 ADR 未充分同步 |
| 兼容面 | 3 | 5 | 完整行兼容读良好；v2 含身份字段的半行恢复回退、写面版本残留 |
| **总分** | **61** | **100** | **低于 85：NO-GO** |

## 三、发现明细（证据与 severity）

### F1 — P1 阻断：陈旧锁回收不是原子抢占，可返回两个合法持有者

**代码**：`apps/server/src/runtime/writer-oath.ts:93–117`；release 为 `:104–107`。

可达时序：A、B 都读到旧 dead holder；A 在 unlink 前停顿；B 删除旧锁并创建/写入/fsync 自己的新锁，返回 ok；A 恢复后按路径 unlink，删除 B 的锁，再创建 A 的锁并返回 ok。两方都认为持有 L1，且 B 没有收到失锁通知。第二轮失败路径还可能在循环耗尽前删除后来出现的锁；吞掉 unlink 错误也掩盖诊断。

**确定性探针**：`/tmp/p03-r1-probe/scheduled-lock.mjs`，使用真实 `acquireJournalLock` 与真实文件系统，仅在第一个 unlink 调用前插入调度暂停；放 B 完整 acquire 成功后才恢复 A，未伪造返回值：

```json
{"name":"scheduled-real-acquirers","aOk":true,"bOk":true,"holderBefore":"B","holderAfter":"A"}
```

日志：`scheduled-lock.log`。另一个 `alive` 接缝内替换文件的探针也证实新 live holder 被删除。诚实边界：无调度控制的 30 次并发探针 **0 次**双成功；这不反驳上述确定性可达交错，也不用于声称自然竞态发生频率。

release 校验 bootId 是保守改进，但读后到 unlink 仍有同类窗口。加一次 stat/bootId 比对也仍非原子删除，不能当根治。

**威胁后果**：同机 T1/T2 即可触发，不需要恶意共享存储。两个写者可能并行扫描同一 N，宣誓同一 N+1，随后业务行无自身 bootId，盘面不能可靠追溯实际写者。**不可接受为“同机硬门”。**

### F2 — P1 阻断：写后 noteSize 可吞掉并发宣誓，L2 不只漏一次写

**代码**：`writer-oath.ts:211–240`；设计稿 `:86` 仅约定 fsync 后 noteSize。

复现顺序：A 建立 epoch=1 基线 → A check 返回 ok → B 宣誓 epoch=2 → A 实际 append 旧业务行并 fsync → A 按盘面 stat 值 noteSize → A 再 check。

`/tmp/p03-r1-probe/probe.mts` / `results.log`：

```json
{"name":"guard-post-sync-mask","before":{"ok":true},"after":{"ok":true},"scan":{"maxEpoch":2,"latestBootId":"B","anomalies":[],"legacyHead":false}}
{"name":"guard-uninitialized","verdict":{"ok":true}}
```

这满足“fsync 后 noteSize”却永久把 B 的字节纳入 A 的基线，文件不再变化时 A 可继续写；INV 扫描甚至完全正常。不是仅一个不可避免的最后 in-flight append。

必须区分：用“旧可信大小 + 本次自己确认写入的字节数”更新，可避免此类基线吞并，但仍不能把 check→append 变成原子拒旧。若 L1 已失效，L2 只是异常检测，不是存储端拒写闸。组装层必须串行本进程写入，否则自身并发 append 也可能被当作外部写。

**正面结论**：冻结对象先行返回（`:219`），noteSize 不清 frozen，冻结粘性正确；stat/read 失败保守冻结。未初始化默认 ok 则是接线易错点，应改为必须初始化或显式拒写。

### F3 — P2 应修：契约升级遗漏 v2+fragIntentId 历史半行

**代码**：`apps/server/src/runtime/repair-tail.ts:161–173,368–380`。

固定 `legacyMrow` 的 v2 无 fragIntentId 形态是正确方向，但真实历史不止这一种：`git show 11bc0df^:apps/server/src/runtime/repair-tail.ts` 显示升级前 buildRepairRow 已写 fragIntentId，契约当时为 v2。目前候选只有：

1. 当前 v3、带 fragIntentId；
2. 老 v2、不带 fragIntentId。

升级前 r7+ 的 v2 带身份行，若短写跨过版本数字并进入 fragIntentId 字段，不是以上任一前缀。

**真实恢复链探针**（同 `probe.mts`）：provider 建锚 → 真 repair 写 marker/truncate 后注入 write 崩溃 → 写入历史序列化 v2 半行（截至 `,"fragIntentId":"i`）→ 重试。对照仅把版本改为 3：

```text
repair-partial-v2: kind=aborted, reason=repair-marker-conflict, unchanged=true
repair-partial-v3: kind=repaired, via=marker-complete
```

旧盘面安全留置、没有被破坏，故评级 P2（升级恢复可用性回退），不是数据丢失。`tests/unit/server/repair-tail.test.ts:765–800` 的 helper 常量化把身份半行场景切换到 v3，恰好失去此历史回归覆盖。应增加冻结 v2+身份候选及测试，不可只把旧无身份形枚举改回随常量漂移。

### F4 — P2 应修：adjudicate 当前写面仍默认 contractVersion=2

**证据**：全仓文本搜索与补充 `?? 2` 搜索发现 `apps/server/src/runtime/adjudicate-journal.ts:295`：

```ts
contractVersion: opts.contractVersion ?? 2,
```

这是生产默认写面，不是历史 fixture。`AdjudicateOptions:52` 允许覆盖，但没有默认常量注入。repair 当前写面已用 `JOURNAL_CONTRACT_VERSION`，两者不一致。

其他硬编码分类：`repair-tail.ts:378` 为应保留的历史枚举；`adjudicate.test.ts`、`recover.test.ts`、`recovery-evidence-source.test.ts`、`repair-tail.test.ts` 的 v2 常量多为历史读盘/兼容形，不能机械全替换；`TEST-MAP.md:821` 是历史版本记录。搜索输出：`/tmp/p03-r1-search.txt`、`/tmp/p03-r1-all-v2.txt`，另对 apps/packages 检索 `?? 2` 补足默认值形。

schema 对 repair/adjudicate 的 ≥1 安全整数校验（`journal-schema.ts:103–104,139–143`）能读 v2/v3，没有读面故障。此项是版本事实与迁移完整性问题：默认改常量并测试；若要固定旧版本，须明定“行型版本而非 journal 契约版本”，不能无声保留。

### F5 — P2 应修：宣誓函数能成功写入自身 schema 不接受的 epoch

**代码**：`writer-oath.ts:167–184` 未校验新行；`journal-schema.ts:146–152` 要求正安全整数。

探针传入 `Number.MAX_SAFE_INTEGER + 1`：

```text
appendWriterOath → ok=true, epoch=9007199254740992
parseJournalText → lines=[], bad=[schema 损坏：缺字段/错类型 epoch]
```

虽然接口注明 epoch=N+1 由调用方保证，但从合法 MAX_SAFE_INTEGER 求 N+1 也会越界；目前未定义耗尽拒写。bootId 空串亦有类似写读契约差。应在打开写句柄前校验将写行，并对 maxEpoch 耗尽明确拒写且零改盘。不是要求从不可信用户参数推测越权，而是组件成功返回不能掩盖自造坏行。

### F6 — P2 应修：FF 覆盖与“变异五杀”被过度解释

**代码/文档**：`writer-oath.test.ts:28–207`；设计 `:63–72,83–87`；`tests/fixtures/TEST-MAP.md:1048–1050`。

| 测试组 | 真正证明 | 没有证明 |
|---|---|---|
| W-oath-1 | 同进程顺序两次 acquire 拒第二次；单一 stale 抢占；坏锁拒绝 | 真双进程/并发 stale/release 竞争；不是服务启动零写 E2E |
| W-oath-2 | 手工传入 1、2 可追加并扫描；撕裂尾拒绝 | 自动恢复取 max+1、N 次真实重启、业务开放严格在 oath fsync 之后 |
| W-oath-3 | 先写异己 oath 再 check 能冻结；错误分类和粘性 | 实际 append 被拦、检查后插入宣誓、noteSize 基线吞并 |
| W-oath-4 | schema 样例、扫描异常、报告字段、不抛异常 | 含真实 enqueue 的重放结果保持不变；现有 replay 测试始终为空 Map |
| W-oath-5 | v2 settled 行解析与手动补 oath | 服务恢复后正常业务写链；历史 repair 半行跨版本迁移 |

W-oath-1 第二例在 `a.release()` 后才创建 B，之后只调用 C.acquire，**没有在 B 持锁时再次调用 A.release**；不能声称已测“旧 release 不误删新锁”。

**五点变异独立复现**：`git archive 11bc0df` 导入 `/tmp/p03-r1-probe/mutations`，明确 alias 到副本 protocol，每次唯一精确替换并验证内容变更，定向单文件运行后恢复原文；没有修改原仓。脚本 `mutate.py`，结果 `mutation-results.log`，各断言日志 `Mu1.log`…`Mu5.log`：

| 变异 | exit | 断言失败数 | 说明 |
|---|---:|---:|---|
| 基线 | 0 | 0（12 passed） | 11bc0df 定向基线 |
| Mu1 活 PID 拒绝门关闭 | 1 | 2 | 真杀拒起门 |
| Mu2 删除 bad-tail 门 | 1 | 1 | 真杀盘面预检，不是“宣誓后置” |
| Mu3 superseded 恒 false | 1 | 1 | **错误类别杀**：仍然 foreign-write-detected 冻结，不是删写前检查 |
| Mu4 删除 INV-2 anomaly push | 1 | 1 | 真杀异常呈现，不是 writer 参与聚合 |
| Mu5 legacyHead 取反 | 1 | 3 | W2/W4/W5 均杀；不是 legacy 拒读 |

失败均为 AssertionError，非加载/语法错误。本次采用整个布尔式取反，故 Mu5 3 failed；历史“双杀”记录没有保留精确 patch 可逐字核实，不能直接断言其历史造假。结论是**五个窄杀点有效，§5 原列的五种语义变异并未等价实现**。

新增负例优先级：F1/F2/F3 确定性重现；oath append/sync 抛错与失败后禁开写面；同 epoch 异 boot；真实旧 release；锁 open→写 JSON 中途崩溃；epoch 上限；默认 EPERM。

补充实测：`scheduled-lock.log` 中模拟 process.kill 抛 EPERM，实际默认 defaultAlive 返回 held；空锁文件返回 held+holder:null。保守行为正确，但原 12 例没覆盖这些具体形态。半写锁崩溃将长期 held，PID 重用也会误拒；需要明确运维恢复，不等价于 flock 崩溃自动释放。

### F7 — P3 建议：扫描结果命名与 INV-1 定义的边界要说清

**证据**：`packages/protocol/src/journal.ts:83–109`。

- INV-2 用历史 max 判断：序列 3,2,3 的后两个都异常，合理表达“违反严格增长”，但不是仅局部下降。
- INV-3 记录 epoch 首个 bootId，后续不同者均报异常；异常列表非去重集合，应按事件解释。
- `latestBootId` 只在 epoch 严格刷新 max 时更新，序列 writer(1,A),writer(1,B) 返回 latestBootId=A，同时正确报两个异常。守卫 A 此时冻结为 foreign-write-detected 而非 writer-superseded；**不漏冻，但原因和“最新写者”名称不准确**。
- repair/adjudicate 排除于 INV-1 正确；但 `clear` 也是无 intentId 的实际业务行（`:33,221–226`），`scanWriterEpoch([clear])` 实测 legacyHead=false。按设计“业务行=有 intentId”的字面没有违反，但不能外推到“所有业务操作都受 INV-1 检查”。建议明确工具行白名单/业务行分类。
- legacyHead=true 是遗留前缀事实，不是异常；混合 v2→v3 后仍为 true 正确。仅有 writer/repair/adjudicate 或空文件为 false 也正确。非法行被 parse 排除后的扫描不是原始盘面的完整安全认证。

### F8 — P2 应修：O_EXCL 替 flock 改变 ADR 前提，T4 和 FF 宣称需降界

**证据**：设计 `:22–27,77,83–87`；`writer-oath.ts:5–15,60–67`；外部 ADR `/home/yyj/ai/projects/pi-agent-ui/decisions-2026-09-23.md:75` 仍为 flock 主互斥。

两种锁并不等价：flock 是持有 fd 的内核锁（在既定同机同 inode 前提下）；当前 O_EXCL 是创建后关闭 fd 的持久路径文件，依赖后续 PID 解释与可竞争删除。新增空/半锁残局、PID 重用/命名空间、路径别名、释放 TOCTOU 等条件。T4 下同一 PID 数字跨机无身份意义：本机 ESRCH 不证明远端 owner 已死。

L2 没有原子 epoch 分配，也没有存储端 compare-and-append/reject-old；两机同时读 N 可都宣誓 N+1，事后 anomalies 只是证据，不会撤销已经落盘的业务行。因此 D2 的“多机时 epoch 行升主位”条件不足，须重新选择具备互斥/拒旧写原语的存储协议，或明确不支持共享存储。单凭换成 flock 同样不应对所有 NFS 配置作无条件保证。

§7 已列未接线，但同段“FF 全落地”和 TEST-MAP 的启动硬序易造成完成态误读；应区分组件测试通过与装配验收待做。文档小差异：设计 `:36` 的 at:number 与实现 string 不符；schema 注释称 at 非空但 `return str("at")` 接受空串，ISO8601 只是声明/惯例而非验证。

## 四、必修项

| 优先级 | 必修内容 | 复审验收 |
|---|---|---|
| **P1-1** | 修复 F1：单机采用真正持有期互斥或有证明的串行回收协议；不能用再读一次 holder 掩盖 TOCTOU | 确定性交错下至多一个 acquire 成功；旧 release 不删除新 holder；失败者零业务写 |
| **P1-2** | 修复 F2：固化可信字节基线契约、初始化约束和进程内串行；明确 L2 只检测的界限，防双写必须依赖实际原子互斥/拒旧机制 | check→他者 oath→自身 append→fsync→更新基线后，不得继续无期限返回 ok；冻结后 noteSize 不能解冻 |
| P2-1 | 补 v2+fragIntentId 历史 repair 半行形 | 与 v3 对照均安全收敛，垃圾/无身份旧 marker 仍 fail-closed |
| P2-2 | adjudicate 默认契约常量化，或正式阐明不同版本语义 | 新写默认版本断言+存量 v2 完整行仍可读 |
| P2-3 | 宣誓入盘前校验 epoch/bootId 等字段并定义代次耗尽 | 上限+1、0、非整数、空 bootId 零改盘拒绝；写失败不能开写面 |
| P2-4 | 补 F6 关键负例与真实杀点，修订 FF/变异证据范围 | 用断言区分拒写安全杀与分类/呈现杀；保留 patch 与日志 |
| P2-5 | 修订 ADR-D2、设计 §3/§6/§7 与 TEST-MAP | 不再宣称 O_EXCL 与 flock 等价；跨机非支持或有真实方案；组件/接线验收分开 |

P3 的命名、clear 分类及日期类型对齐可并批处理。缺少生产接线属于已公开的后续批，不强行要求在本纯组件批完成；但后续在所有写入口、启动恢复与关闭生命周期接线并验收之前，不能对外宣称服务防双写已交付。

## 五、下一步建议

1. 优先修 P1-1/P1-2，不应先把现有守卫接到生产就视为完成。单机先把真实单写互斥做成立，L2 明确作为纵深检测。
2. 用本轮 `/tmp/p03-r1-probe/` 的确定性交错和升级残局提炼持久回归测试；不以“高概率压力测试没撞到”替代时序证据。
3. 补契约迁移与 ADR 后进行定向复审；本轮已绿整仓不重复跑。实现发生新改动后再按变更范围补测，最终接线批执行真实重启、旧实例恢复、fsync 失败后禁开写面的集成验收。
4. 本报告没有真实 NFS/双机、SIGSTOP/恢复端到端或生产网关验证；相关结论来自明确代码前提与本机可复现反例，没有把单测冒充这些验证。

复现入口（均仅操作 `/tmp`，主仓源码只读）：

```sh
NODE=/home/yyj/.nvm/versions/node/v24.18.0/bin/node
$NODE --experimental-transform-types /tmp/p03-r1-probe/probe.mts
$NODE --experimental-transform-types /tmp/p03-r1-probe/scheduled-lock.mjs
python3 /tmp/p03-r1-probe/mutate.py
```

探针/原始日志为本机临时证据；本报告已内嵌关键结果以避免清理 `/tmp` 后只剩结论。报告交付后再写 `/tmp/gpt-p03-r1-done` 哨兵。
