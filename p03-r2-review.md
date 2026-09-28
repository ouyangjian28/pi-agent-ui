# P0-3 writerEpoch r2 独立审读报告

## 一、结论

**77/100，NO-GO。** r2 实质修复了 stale 自动抢占、常规追加记账、v2+身份半行兼容和部分写前校验；但仍有两条可复现的安全缺口：**并发 release 可删除后来者锁，初始化 stat 可吞并发宣誓**。此外，新增的 at 非空读约束没有同步到宣誓写入口。

审读基准：`f0ca3792afe8ba4550181846f69066c25c766e11`；实现批 `6aca9f8`，`f0ca379` 仅改 TEST-MAP。审读仓实际分支 `wt/gpt-p03-r2-review`，与主仓共用 Git common-dir；测试时主仓 HEAD 同为 f0ca379，源码工作区干净。本轮不改实现，承认 §7 的纯组件批边界，**未接生产线本身不新增阻断项**；不能把组件测试当服务防双写验收。

### 指定测试实测

Node v24.18.0，主仓 `/home/yyj/ai/repos/pi-agent-ui`，同步执行；整仓仅跑一次：

```text
npx vitest run tests/unit/server/writer-oath.test.ts
Test Files  1 passed (1)
Tests       14 passed (14)
Duration    283ms

npx vitest run
Test Files  1 failed | 70 passed | 2 skipped (73)
Tests       1 failed | 1423 passed | 15 skipped (1439)
Duration    14.97s
FAIL tests/unit/server/history-source.test.ts:631:24
AssertionError: expected null not to be null

# 只对失败文件补核，不重跑整仓
npx vitest run tests/unit/server/history-source.test.ts
Test Files  1 passed (1)
Tests       75 passed (75)
Duration    1.11s
```

日志：`/tmp/p03-r2-targeted.log`、`/tmp/p03-r2-full.log`、`/tmp/p03-r2-history-targeted.log`。**不能改报本次整仓 1424 绿**；单文件复绿提示时序/环境相关，但未证明根因，也未证明由本批引入。失败点在真盘 rename-handoff 后重新 load，见该测试 `:618–631`。

所有探针、变异及其数据在 `/tmp/p03-r2-probe/`。无后台任务、无嵌套 agent，单命令均未超过 5 分钟。开场未收到【流程门】块，已披露；已查项目索引、记忆及 r1 原审报；当前无 session_search 工具，未冒称做过会话搜索。外部 ADR 不作为已验证证据，本报告按用户指定以设计 §6 为准。

### 七道判断题

| # | 判断 | 结论 |
|---|---|---|
| 1 | F1 是否充分 | **部分，不充分。** EEXIST 无删无重试修复了 acquire 抢占竞态；正常单次 release、相同规范路径、无人外部删锁时可成立。两次重叠 release 可让 B、C 都 acquire 成功（R2-F1）。坏/半锁及 EPERM 保守拒；stale 仅诊断，不是清锁授权或原子凭证。 |
| 2 | F2 是否充分 | **部分，不充分。** 自写增量正确，已初始化后的原 r1 反例被堵；但「进程内串行」不能阻止别的进程在 oath→stat 间插写，初始化仍可永久吞 B（R2-F2）。check→append 非预防已披露。串行冻结粘性成立；重叠在途 check 仍可冻结后返回 ok，须限定/机械兑现串行契约。 |
| 3 | 三形枚举 | **通过，带既有前提。** 历史未发现第四种生产序列化结构；null/string 已是带身份形的值变体。三形短前缀可以重合，不必互斥识别；严格字节前缀和起点判据有效。旧 marker 缺身份仍有意拒，跨 build 短行不承诺自动补完。 |
| 4 | F4/F5/F7 收尾 | **F4 代码通过，F5 指定四形通过，整体未闭合。** 未发现新的生产默认版本 2 残留；四种 invalid-oath 在任何 I/O 前返回。F7 读面空 at 被拒，但写面 at 空仍成功落盘（R2-F3）。 |
| 5 | 变异五连 | **窄杀点可复现，不等于完整安全证明。** Mu-2/4/5 为有效拒写/兼容杀；Mu-3 仍拒，只改错误类别；Mu-1 的插 unlink 只证明删锁违规可见，不能等同 r1 的 unlink→重建→双成功完整交错（R2-F4）。 |
| 6 | 文档一致 | **部分。** 非 flock 等价、无抢占、检测非预防、多机需另做 fencing 已补；但「自然消灭 TOCTOU」「安全清理」、初始化前提及 T4/FF 旧强宣称仍与实际不符（R2-F5）。TEST-MAP 测试例数与多数断言吻合。 |
| 7 | r1 P3 | **维持 P3，不阻断。** latestBootId 同代异 boot 命名与 clear 分类未改；未发现由 r2 将其提升为漏冻或新的写面故障。 |

## 二、分项评分

| 维度 | 得分 | 满分 | 依据 |
|---|---:|---:|---|
| 语义正确 | 32 | 40 | 增量追加和兼容修复有效；初始化吸收及空 at 写读不一致仍在 |
| 攻击面 | 17 | 25 | 自动抢占窗消失；重复 release 可双持有，运维清锁仍需外部排他条件 |
| 测试质量 | 16 | 20 | 14 例和 RT37 有真杀点；缺 release/初始化并发，F4/F7 定向变异存活；全量实测有失败 |
| 文档一致 | 7 | 10 | 关键降界已补，但安全前提与旧强宣称未收净 |
| 兼容面 | 5 | 5 | 三种历史结构有 git 证据，v2+身份真切点与精确删除枚举变异均验证 |
| **总分** | **77** | **100** | **低于 85：NO-GO** |

对比 r1 的 61 分，本次认可无抢占、常规增量和兼容面的进展，不重复扣已经闭合的同一问题。

## 三、发现明细（证据与 severity）

### R2-F1 — P1 阻断：同一 release 回调重叠调用仍可删后来者锁

**位置**：`apps/server/src/runtime/writer-oath.ts:110–113`；设计 `docs/p0-3-writer-epoch-design.md:27`；测试 `tests/unit/server/writer-oath.test.ts:28–72`。

release 每次独立执行 `readLockHolder → 比 bootId → unlink(path)`，没有一次性状态或共享在途 Promise。fail-closed 保证其他 acquire 不会删锁，**不保证同一个持有者的多个 release 不会重叠**。可达交错：

1. A 的 release-1 读到 A，在 unlink 前暂停。
2. A 的 release-2 也读到 A，unlink 完成，返回。
3. B acquire，写锁并 fsync，返回 ok。
4. release-1 恢复，按路径删掉 B 的锁。
5. C acquire 返回 ok；B 未 release，仍自认持有。

`/tmp/p03-r2-probe/probe.mjs` 用真实 acquire、真实文件系统，仅暂停第一个 unlink，不伪造读值、返回值，不需要运维/恶意外部删锁：

```json
{"name":"concurrent-release-deletes-B","bOk":true,"holderBefore":"B","cOk":true,"holderAfter":"C"}
```

这是组件回调生命周期缺口，不是「r1 stale 抢占仍在」；正常单次 release 不受此反例否定。API 没声明只能恰好调用一次，常见关闭/错误清理重入足以形成这种用法。r2 的三个锁测试没有调用 release，因而无法覆盖该面。

**修复要求**：release 先同步进入一次性/共享 Promise 状态，再做异步读删；重复/并发调用不能再发第二次删除。还须保证所有持有者写入静止后才 release。不能靠多加一次 bootId 读来声称原子删除。

**其余锁面核证**：

```json
{"name":"stale-eight-acquirers","oks":0,"allStale":true,"unchanged":true}
```

空锁、半 JSON 锁均 `held, holder:null, stale:false`；默认 process.kill 注入 EPERM 为 `held, stale:false`。open 后写/sync 失败会抛并留下锁而非返回成功，偏可用性、非自动双持有。

**运维边界**：stale 只是某一时刻、本 PID 命名空间的探活结果。读取 stale 后到人工 unlink 间，锁可能已被另一运维动作清掉并被新启动者重建。必须先冻结启动入口、停止/隔离全部相关写者及其他清锁者，再处理当前锁；`pid+bootId` 再读一次也不是原子清锁。若外部随时可删换路径，当前协议不提供互斥证明。路径别名、跨 PID 命名空间、多机也不能由这个本地诊断背书。

### R2-F2 — P1 阻断：oath 后 stat 初始化仍可吸收 B，不是只漏一个 in-flight append

**位置**：`writer-oath.ts:206–227,238–246`；设计 `:52`；测试 `writer-oath.test.ts:107–147`。

r2 的 noteAppended 确实修复了「已建立可信基线后」按全盘大小覆盖的问题。但 initialize 的注释仍断言「自己刚写完，进程内串行前提下无人插写」。进程内串行只能约束 A，不能约束已经绕锁/失锁后进入的 B；这正是 L2 宣称要检测的威胁面。

真实文件、实际 oath append+fsync 的时序：A oath(1) 成功 → B oath(2) 成功 → A stat+initialize → A check → A append+fsync+noteAppended → A check。没有依赖同进程 A 并发追加：

```json
{"name":"initialize-absorbs-B","a":{"ok":true,"epoch":1,"byteStart":0,"byteEnd":47},"before":{"ok":true},"after":{"ok":true},"raw":"{\"t\":\"writer\",\"epoch\":1,\"bootId\":\"A\",\"at\":\"T\"}\n{\"t\":\"writer\",\"epoch\":2,\"bootId\":\"B\",\"at\":\"T\"}\n{\"t\":\"settled\",\"intentId\":\"old-A\"}\n"}
{"name":"initialize-own-byteEnd-control","verdict":{"ok":false,"reason":"writer-superseded","detail":"epoch=2 bootId=B"}}
```

盘面随后仅 A 自写，size 与含 B 的基线同步增长，守卫可以无限继续 ok。这不同于已诚实披露的 check→append 一次检测窗口。**L1 正常独占时这个外部插写不可达；本项阻断的是所宣称的跨锁纵深检测闭合，非断言正常 L1 必然失效。**

另一个孔：initialize 在未冻结时可以无限重复调用，仍能充当旧 noteSize：A 初始化 → B 宣誓 → A 再 initialize(stat) → check ok。探针 `second-initialize-masks-B` 已证实。冻结以后调用 initialize/noteAppended 不解冻，则确实正确。

**修复要求**：初始化应消费已验证的自身宣誓结果/可信预写边界加自写字节，而不是追加之后再取全盘 stat；绑定自己的 epoch/boot 并核对初始化证据。现有返回 `byteEnd` 在本探针对照下有效，但其来自预读长度推算，不能误称并发 append 的真实原子偏移。initialize 应一次性，不能借重复初始化重建任意基线；进程内检查、追加、记账须串行。

**冻结补充边界（P3，若维持严格串行契约）**：check 只在入口看 frozen。探针暂停 A 的旧 stat 返回，另一次 check 先观察 B 并冻结，然后恢复旧 check：

```json
{"name":"inflight-check-after-freeze","second":{"ok":false,"reason":"writer-superseded","detail":"epoch=2 bootId=B"},"first":{"ok":true},"next":{"ok":false,"reason":"writer-superseded","detail":"epoch=2 bootId=B"}}
```

它不解冻对象，后续新 check 仍拒，但不能承诺所有已在途检查都拒。要么 API 明定且装配层机械保证串行，要么 await 后返回 ok 前重验冻结状态；这仍不替代 check→append 的存储端原子拒旧。

### R2-F3 — P2 应修：at 空串可成功写出自己 schema 不接受的 writer 行

**位置**：`writer-oath.ts:158–177,185–195`；`packages/protocol/src/journal-schema.ts:146–154`；`writer-oath.test.ts:190–198,221–237`。

写前只校验 epoch、bootId；`opts.at ?? ...` 会保留空字符串。r2 新 schema 明确拒 at 空，却没同步写面：

```json
{"name":"empty-at-success-invalid-row","result":{"ok":true,"epoch":1,"byteStart":0,"byteEnd":46},"parsed":{"lines":[],"bad":[{"raw":"{\"t\":\"writer\",\"epoch\":1,\"bootId\":\"A\",\"at\":\"\"}","error":"schema 损坏：缺字段/错类型 at","partialTail":false}]},"raw":"{\"t\":\"writer\",\"epoch\":1,\"bootId\":\"A\",\"at\":\"\"}\n"}
```

不是要求深验 ISO8601，最小要求是将写行满足当前 schema。建议在读盘/开句柄之前组装并统一校验行，空 at 返回 invalid-oath、零 I/O/零改盘；补缺省 at 正例和空 at 负例。

**F5 已修部分认可**：给 MAX_SAFE_INTEGER+1、0、1.5、空 bootId 注入读/打开计数接缝：四次均 invalid-oath，`io=0`，原本不存在的 journal 仍不存在。代码校验也覆盖 NaN、Infinity、负数等非正安全整数。因此不是否定本批指定四参数的零改盘证明。

### R2-F4 — P2 应修：变异证明范围仍窄，两个本批修复可被撤回而定向测试不红

**位置**：`tests/fixtures/TEST-MAP.md:1048–1050`；`writer-oath.test.ts:28–72,148–165,180–200,221–237`；`repair-tail.test.ts:800–813`。

独立变异在 f0ca379 的 `/tmp` archive 副本实施（与 6aca9f8 的源码相同），protocol alias 显式指向副本，复用主仓 node_modules；每点唯一精确替换，保存 patch/log，finally 还原。定向基线 **59/59**（writer 14+repair 45）。首次副本漏带 tsconfig.base.json，出现 TSCONFIG_ERROR、0 tests；保留 `baseline-infra-error.log`，补齐后才开始变异，**没有将加载失败算杀点**。

| 变异 | 实测 | 真正证明 |
|---|---|---|
| Mu-r2-1，EEXIST 后、读 holder 前插 unlink | 2 failed / 12 passed | 活例 holder 变 undefined，stale 例 stale 变 false；有经过注入点，但先在诊断断言被杀，未走到锁原样断言 |
| Mu-r2-1 窄对照，只在探活死后 unlink、仍返回 held | 1 failed / 13 passed | `writer-oath.test.ts:56` readFile 因锁确实被删而 ENOENT；这是删锁行为被检测，不是加载错误；仍未模拟重建/双持有 |
| Mu-r2-2，epoch/bootId 校验门关闭 | 1 failed / 13 passed | W6 首个非法 epoch 从拒到 ok，真写前校验杀；循环首断言失败，不能声称一次变异独立走完四形 |
| Mu-r2-3，删 uninitialized 门 | 1 failed / 13 passed | 仍拒，但原因 foreign-write-detected ≠ uninitialized；**错误类别杀，不是安全放行杀** |
| Mu-r2-4，size 比较恒真 | 3 failed / 11 passed | superseded/F2 回归/foreign 三例真从拒到放行 |
| Mu-r2-5，删 v2FragMrow 候选 | 1 failed / 44 passed | RT37 `:809` 由 repaired 变 aborted，精确覆盖 F3 的第三候选 |
| 补充：F4 默认常量退回 `?? 2` | **30/30 仍绿** | adjudicate.test.ts 未锁住本批默认写版本；不是说现实现还错 |
| 补充：F7 允许 writer 空 at | **14/14 仍绿** | writer-oath.test.ts 只验 at 缺，不验空；未锁住新增读约束 |

历史 f0ca379 只存文字记录，未附该轮精确 patch 与逐例输出。因此上表是**按描述独立重建的证据**，不能声称逐字复现原执行。尤其 Mu-1 插入位置会改变先命中的断言。插 unlink 等效于违反「不删除」这一安全子性质，**不等效于完整撤销 fail-closed/复现 r1 acquire 双成功**；应分开记账。真正的原 r1 stale 两 acquirer 交错，还需要重建循环和确定性调度，而本轮发现的 release 双成功又是另一个缺口。

测试改进优先：将 R2-F1/F2/F3 反例转持久回归；加默认版本精确断言、schema 空 at 断言；分开诊断杀/拒写杀/互斥交错杀。W3 F2 用例注释说 fsync，但 `:136–142` 实际 append 后 close、未调用 sync；逻辑记账覆盖有效，不应把它记作 fsync 顺序证据。W2 仍是手动两次 oath，不是真 server 重启。

### R2-F5 — P2 应修：文档降界未彻底，清锁和串行前提写得过强

**位置**：设计 `:18,27–33,46,52,65,74,79,85–90`；TEST-MAP `:1043–1050`；测试 `writer-oath.test.ts:52`。

认可 §3/§6 对「O_EXCL 非 flock 等价」「崩溃锁不自动回收」「多机需另做 fencing」的纠正，§7 未接线清单与代码使用点相符。仍需同步：

- `:27`「持有者唯一删除者——自然消灭 TOCTOU」不成立，见重复 release 反例；改成带单次释放、静止写面、排除外部路径替换的条件保证。
- `:28` 和测试 `:52` 的「安全清理」不是 stale 自带的保证；应写明停服务、禁止并发拉起/清锁以及命名空间前提。
- `:52` 的 oath 后 stat 初始化不是可信本进程边界；必须随 R2-F2 修正。
- `:18`「不依赖单机」、`:29` T4「L2 兜底」、`:79`「跨机成立」容易被读成写权防护；只能称异常检测且有上述限制。当前多机共享存储应明确不支持，不能靠一句非 fencing 同时保留强承诺。
- `:33,46,65` 仍使用现行 flock/fd 机制描述；旧设计应明确标作历史，而不是混进当前启动硬序。
- `:85`「FF 全落地」及 12/1422 是历史组件记录，需与 `:90` 未接线、r2 的 14 例分清。§5 原排五类变异与当前五个窄点不是一回事。

TEST-MAP r2 的例数与 W1/W3/W6/RT37 实际结构大体吻合；全仓 1424 绿可以保留为作者当时运行记录，不能覆盖本次失败实测。外部 ADR 已合入一说未在本次跨树核验，不冒称文档全链已一致。

### R2-F6 — P3 建议：遗留命名、clear 分类及历史窗口文字

**位置**：`packages/protocol/src/journal.ts:83–109,221–226`；设计 `:87`。

- latestBootId 只在 epoch 刷新 max 时更新；同 epoch A→B 仍返回 A，同时报 INV-2/3。守卫 A 在增长后仍会 foreign-write-detected 冻结，故维持命名/诊断 P3。
- clear 没有顶层 intentId，不计 INV-1 的业务行。与当前字面定义一致，但不代表所有业务操作都被扫描；仍是分类说明 P3，不借本批升级为阻断。
- 历史 `8ce8d3b`（P0-1b r7）已引入 v2+fragIntentId，r8 `6eb761f` 才把身份加入 marker。文档「v2 无身份到 r7 / v2+身份从 r8」作为生产行型时间线不精确；作为可自动补完且 marker 有证据的窗口有其缘由，建议写清两条时间线。

### 已核销面 — 无新增缺陷：F3 枚举与 F4 默认版本

**F3 证据**：完整路径 git 历史保存于 `repair-history.diff`，关键 11 个版本的 builder 与常量摘录于 `historical-builders.txt`。从 repair 引入 `ef34cce` 起，字段序始终 `t, reason, byteStart, byteEnd, removedSha256, buildId, contractVersion, at`；r7 `8ce8d3b` 只在尾部加 fragIntentId，版本仍 2；`11bc0df` 才升 3。未发现生产 v1 repair、其他字段顺序或第四结构。

`repair-tail.ts:380–385` 三候选覆盖当前 v3+身份、v2无身份、v2+身份；身份值为 null/string 不需要另起结构候选。严格短于候选且逐字节 equals、marker.byteStart 相同才进部分行路径；版本数字前、身份字段前共享前缀是正常现象，目标是证明可补完前缀存在，不是唯一辨认版本。RT37 形二a 的切点已越过版本位并进入 fragIntentId 值，删第三候选确实失败，区别力成立；垃圾/超界拒仍在。

边界：`repair-tail.ts:361–364` 先拒旧 marker 缺身份的非原尾吻合形，是既有安全收窄，三形枚举不撤销它；`:380` 使用当前 buildId 重建，跨 build 的半行可能因前缀不符而保守拒，不可把三形完备外推为任意历史参数都能自动恢复；完整旧行另走实盘事实分支。未来升 v4 时要保留固定 v3 候选，不能只让当前常量漂移。

**F4 证据**：`adjudicate-journal.ts:295`、`repair-tail.ts:169` 均默认 JOURNAL_CONTRACT_VERSION；常量为 `journal.ts:63` 的 3。对 apps/packages/tests/tools/docs/.github 和根配置做 contractVersion、默认 `?? 2` 及裸 2 搜索，保存 `/tmp/p03-r2-contract-search.txt`、`/tmp/p03-r2-all-bare2.txt`。生产相关裸 2 只剩 `repair-tail.ts:382–383` 两个必要历史枚举；测试 fixture 的 v2 与 TEST-MAP 历史版本记录应保留。其它 `?? 200`/`?? 250`/`?? 2_000` 是限制/时长，不是契约版本。未发现新的生产默认残留；不足是定向测试没锁住它，而非当前代码未修。

## 四、必修项

| 优先级 | 内容 | 复审验收 |
|---|---|---|
| **P1-1** | release 一次性/并发幂等，释放前停止写入；删除不能跨到下一任持有者 | 暂停 release-1 → release-2 → B acquire → 恢复 release-1 → C acquire，B 未释放时 C 必拒；顺序重复 release 同样不删 B |
| **P1-2** | 初始化绑定可信自身宣誓边界；拒重复重置，明确并机械兑现进程内串行 | A oath → B oath → A initialize/业务写循环，不得无限 ok；已有 noteAppended 回归继续通过；冻结不解冻 |
| P2-1 | writer 写前校验与 schema 全字段对齐，至少补 at 空串 | 空 at invalid-oath 且无读/开/写 I/O，缺省 at 可写可读；安全整数上限和 bootId 四形保持零改盘 |
| P2-2 | 把上述反例与 F4/F7 断言纳入测试，修正变异杀点分层 | 双 release/初始化/空 at 反例能杀对应错误实现；默认 `?? 2` 及允许空 at 的窄变异各有精确失败断言 |
| P2-3 | 同步设计 §3/§6/§7、TEST-MAP 与运维清锁条件 | 不再宣称无条件消灭 TOCTOU、stale 自动等于安全清理；当前机制统一，组件与装配验收分开 |

另外保留全量回归失败的待核验项：history-source 单文件已复绿，但本次全仓未全绿事实不变。需归因或提供经确认的时序隔离结论；不将它冒归本批 P1，也不靠重复整仓刷绿销案。

## 五、下一步建议

1. 先闭合两个 P1 和空 at 写读不一致，再做定向复审；不要先接生产线后把 L2 当成原子拒旧写机制。
2. 将单次 release、初始化证据和进程内串行变成组件/装配层可检验约束，不仅写注释。服务装配批再验证真实重启、关闭重入、失败后不开写面、旧进程恢复等场景。
3. 现有三形兼容修复可以保留；不用为追求形态数把旧 marker 的缺证据拒绝门放开，也不要误删历史 fixture 的版本 2。
4. 本轮未测试真实双机/NFS、真实 SIGSTOP 或服务启动 E2E；未以单测替代这些证明。所有并发反例均明确其调度与信任前提，未推断自然发生概率。

复现与证据索引（源码只读，数据仅在 /tmp）：

```sh
/home/yyj/.nvm/versions/node/v24.18.0/bin/node --experimental-transform-types /tmp/p03-r2-probe/probe.mjs
python3 /tmp/p03-r2-probe/mutate.py
python3 /tmp/p03-r2-probe/mu1-narrow.py
```

- 真实竞态/参数探针：`probe.mjs`、`results.log`。
- 五连及额外存活变异：`mutate.py`、`mutation-results.log`、各 `Mu-r2-*.patch/.log`、`extra-F4-default-v2.patch/.log`、`extra-F7-empty-at.patch/.log`。
- Mu-1 删锁断言窄对照：`mu1-narrow.py`、`Mu-r2-1-narrow.patch/.log`。
- 历史：`repair-history.diff`、`historical-builders.txt`、`contract-history.diff`；审读差异：`r2.diff`。
- 指定三次测试日志见第一节。关键结果已嵌入本报告，临时目录被清理不会只剩结论。

报告交付后写 `/tmp/gpt-p03-r2-done` 哨兵。审读前已有未跟踪 `p03-r2-brief.md`，不修改、不纳入本轮报告提交；实现与主仓源码保持不变。
