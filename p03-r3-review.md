# P0-3 writerEpoch r3 独立审读报告

## 一、结论

**86/100，GO（仅本批组件修复；不是生产装配或无条件防双写验收）。** 重复 release、按自身宣誓边界初始化、空 at 写前拒的指定修复成立。没有发现符合已声明调用契约的新 P1；但“类型封死 stat”、schema 空 at 变异已锁住、冻结变异导致放行等声明不实，列 P2 应修。GO 不表示这些证据/文档项已核销。

基准：`a378371e7e8c56c1faddec43755978a343be2cf8`，本批 `b6a4568 + 7880a24 + a378371`。审读仓实际为 `wt/gpt-p03-r3-review`，不是 master；主仓 `/home/yyj/ai/repos/pi-agent-ui` 的 HEAD 同为 a378371，测试前后源码工作区干净。原 r2 报核对自 `/home/yyj/ai/projects/pi-agent-ui/audits/gpt-p03-r2-review-2026-10-09.md`。

### 指定实测

主仓，Node v24.18.0，整仓只跑一次：

```text
npx vitest run tests/unit/server/writer-oath.test.ts
Test Files  1 passed (1)
Tests       17 passed (17)
Duration    323ms

npx vitest run
Test Files  71 passed | 2 skipped (73)
Tests       1428 passed | 15 skipped (1443)
Duration    14.94s
```

本次未复现 history-source 失败；**不能据此确定 r2 失败的根因是审读环境时序**，也不能抹掉 r2 的一次失败。日志：本审读仓 `.pi/tasks/session-1491721-1491721/b59e4b1e8.output`。

### 七道判断题

| # | 判断 | 结论 |
|---|---|---|
| 1 | P1-1 共享 release | **通过，带前提。** 同一闭包只发起一次读删；真实 unlink 暂停探针也证实同 Promise、一次删除、B 持有时 C 拒起。崩溃在 unlink 前会留锁，既有 stale fail-closed 覆盖；unlink 后崩溃无锁可留。释放前必须停止受理并排空在途写；本批没有装配验证，设计 §3/§7 已将其列为装配约束。外部删换路径不在证明内。 |
| 2 | P1-2 初始化/冻结 | **按自身 oath 调用通过；类型强制不成立。** `{byteEnd}` 可任意构造，既不证明来源，也不绑定 epoch/bootId。可接受为可信装配调用约定，但不能称 API 已强制。串行生命周期四格覆盖完整；不含并发在途 check 保证。详见 R3-F1。 |
| 3 | P2-1 分层/selfCheck | **实现通过、文字未净。** 显式空 at 拒绝在 I/O 前；selfCheck 在 readRaw 后、open 前。删显式层仍拒但 reads=1，变异已独立复现。selfCheck 是同步本地解析，不新增 await 窗口；既有预读→append 窗仍在，byteEnd 是预读长度加自写长度，不是并发原子偏移。 |
| 4 | P2-2/P2-3 与全绿 | **部分闭合。** 默认版本精确断言有效；schema 空 at 的原 Mu-extra-F7 仍存活。主要降界已补，仍有旧 flock、stat 初始化及零 I/O 误述。1428 绿实测可接受；flake 根因归属不接受。 |
| 5 | 五连/首注未杀 | **五连当前均有真实断言杀，首注未杀可重建。** b6a4568 测试遇 Mu-r3-4 仍 17 绿，补测试后在 initialize 返回值处红；不是冻结后 check 放行杀。Mu-r3-2 也先被返回值断言杀，未走到后续放行断言。 |
| 6 | 时间线 | **通过。** git 实物与 r2 考古一致：8ce8d3b 引入生产 repair 行 fragIntentId，常量仍 2；6eb761f 才将身份写入 marker。设计 :87 / TEST-MAP :1047 两条时间线已分开。 |
| 7 | latestBootId / clear | **维持 P3，不阻断。** 本批未改；同代异 boot 仍会由盘面增长走保守冻结，不构成新放行。clear 不计顶层 intentId 业务行仍是分类边界。 |

执行披露：开场未收到【流程门】块，已披露；查过项目索引、记忆和 r2 原报，无可用 session_search 工具，未冒称已检索历史会话。用户要求全同步，但本环境更高优先级规则要求长时测试走 bg_run，已事先披露；两个顶层测试命令使用该工具，未启动子代理、未嵌套后台任务，单命令设置不超过 300s。源码只读；变异仅在 /tmp archive 副本，不覆盖主仓或审读仓源码。

## 二、分项评分

| 维度 | r2 | r3 | 满分 | 依据 |
|---|---:|---:|---:|---|
| 语义正确 | 32 | 36 | 40 | 正确调用下的初始化、一次性与空 at 修复成立；初始化证据仍依赖调用方 |
| 攻击面 | 17 | 23 | 25 | 原 release 竞态已堵，stale 保守；静止写面/串行/路径信任仍待装配兑现 |
| 测试质量 | 16 | 16 | 20 | 新增交错回归与默认版本杀有效、全量绿；原 schema F7 仍存活，部分变异被夸称为放行杀 |
| 文档一致 | 7 | 6 | 10 | 主要降界及历史时间线改善；新“类型强制”和分层错误、旧注释及 flake 归因仍需修 |
| 兼容面 | 5 | 5 | 5 | r3 未改既有历史枚举，r7/r8 git 证据吻合，全仓回归通过 |
| **总分** | **77** | **86** | **100** | **达到 85：组件批 GO；保留 P2 应修清单** |

## 三、发现明细（证据与 severity）

### R3-F1 — P2：初始化是调用约定，不是类型来源证明；文档及旧注释会诱导错误用法

位置：`writer-oath.ts:244–251`；设计 `:52,89`；TEST-MAP `:1051`。

真实签名为 `initialize(oath: { readonly byteEnd: number }): boolean`，只检查 frozen/initialized，并直接保存 byteEnd。结构类型允许 `{byteEnd: (await stat(path)).size}`，也接受别的写者 oath；没有 success、epoch、bootId 或 journal 身份核对。测试自身亦多处手造对象（如 `writer-oath.test.ts:112,133,168,179`）。`readonly` 不提供来源证明。

真实文件、实际 append+fsync 探针 `/tmp/p03-r3-probe/probe.mjs`：A oath→B oath→A 用 stat 包装对象初始化→check→A 业务写+sync+增量记账→check：

```json
{"name":"structural-stat-initializer","before":{"ok":true},"after":{"ok":true},"own":{"ok":false,"reason":"writer-superseded","detail":"epoch=2 bootId=B"}}
{"name":"no-epoch-boot-binding","verdict":{"ok":true}}
```

第二条还表明拿当前盘大小给不匹配的 epoch/bootId，也不会核对。此为**违背“自身成功 oath”调用约定可重现的误用**，不冒称符合契约的正常调用仍必然漏冻；组件边界内按可信调用者前提接受，不升级 P1。但设计所谓“类型上拿不到宣誓结果就不能建基线”“类型层封死 stat”必须撤回；若要保留强声明，需另做不能随手构造的成功凭证与自身身份核对，单纯换成另一个结构类型仍不够。

还有两处直接不一致：设计 `:52` 写 `initialize(oath.byteEnd)`，实现收对象，应该是 `initialize(oath)`；源码 `:227` 仍写“正确序：initialize(宣誓后 stat)”，恰好教调用者回到原漏洞路径。

**一次性/冻结矩阵**（串行前提）：

| initialized | frozen | 行为/证据 |
|---|---|---|
| false | false | W-r3-2 首次 initialize(oathA)=true |
| true | false | W-r3-2 二次 initialize=false，不吞 B，check superseded |
| true | true | W-r3-2 与 W-oath-3 第一例拒重置；noteAppended 不解冻 |
| false | true | W-oath-3 第三例先 check 得 uninitialized，随后 initialize=false，仍 uninitialized |

在途并发 check 的旧结果返回问题未修，但已归装配串行前提；不是四格状态矩阵能证明的性质。尚无生产使用点：`apps/server/src` 中 WriterGuard/acquireJournalLock 只见定义。

### R3-F2 — P2：原 Mu-extra-F7 仍存活；写入口的零读盘断言不能替代 schema 空串负例

位置：`journal-schema.ts:146–152`；`writer-oath.test.ts:198–208,294–316`；TEST-MAP `:1051`。

在 a378371 的 /tmp 副本，将 writer schema 的 at 非空校验退回只检查 string：

```diff
-if (typeof obj["at"] !== "string" || (obj["at"] as string).length === 0) return "缺字段/错类型 at";
+if (typeof obj["at"] !== "string") return "缺字段/错类型 at";
```

结果：**writer-oath 17/17 仍绿**（`extra-F7.log/.patch`）。原因明确：W-r3-3 的空串被显式写门提前挡住，根本不经过被变异的 schema 行；W-oath-4 只测 at 缺失，没有 at 空串。不能以 Mu-r3-3（删写门）代替 r2 的 Mu-extra-F7（放宽读 schema）。

建议新增直接 `journalLineSchemaError({t:"writer",epoch:1,bootId:"b",at:""})` 拒绝断言，或从原始空 at 行进入 parseJournalText 的坏行断言。当前生产 schema 本身正确，问题是回归锁与“已锁住”声明，不是现有写面再次写坏行。

### R3-F3 — P2：五连实杀可复现，但 Mu-r3-4 的安全效果与文字不一致

基线 /tmp archive 使用副本 protocol alias、复用主仓 node_modules，writer 17 + adjudicate 31 = **48/48**。每个变异唯一精确替换，保存 patch/log，finally 还原；无加载错误被记作杀点。

| 变异 | 实测 | 首个杀点及证明边界 |
|---|---|---|
| Mu-r3-1 `??=`→`=` | 1 failed / 16 passed | writer :257，holderCalls 2≠1；真走第二次读锁，证明共享语义失效；未走完 B/C 段 |
| Mu-r3-2 去 initialized 条件 | 1 failed / 16 passed | writer :283，第二次 initialize true≠false；返回值契约杀，尚未执行后续 check |
| Mu-r3-3 去显式 at 门 | 1 failed / 16 passed | writer :306，reads 1≠0；此前 invalid-oath 断言仍过，selfCheck 确实兜底 |
| Mu-r3-4 去 frozen 条件 | 1 failed / 16 passed | writer :162，未初始化但冻结后的 initialize true≠false；返回值契约杀 |
| Mu-r3-5 默认 `?? 2` | 1 failed / 30 passed | adjudicate :845，2≠3；已成功写行后解析并断言，确经生产默认位置 :295 |

独立重建 b6a4568 测试内容并施同一 Mu-r3-4：**17/17 仍绿**；切回 7880a24 后测试内容，该变异失败。因此“首注未杀→补测试再杀”过程有 git 和重建证据支持，不是假杀。未取得作者当次逐步运行原始日志，不能称逐字复现原操作记录。

但 TEST-MAP `:1052` 称“uninitialized 冻结可被重置绕过”“重置生效的放行路径”不成立：单删 initialize 的 frozen 条件**没有清除 this.frozen**；check 在 `writer-oath.ts:262` 仍直接返回原冻结结论。用当前类体仅删除该条件的独立运行对照（`frozen-control.mjs/.log`）：

```json
{"mutation":"remove-frozen-only","before":{"ok":false,"reason":"uninitialized"},"initialized":true,"after":{"ok":false,"reason":"uninitialized"}}
```

它违反初始化拒绝契约，但不等于解冻/业务放行。盘大小恰好等于新基线也绕不过 frozen 入口。应将杀点记为**拒重置返回值杀**，不能重复夸成安全放行杀。

### R3-F4 — P2：主要文档降界通过，残留与归因仍需同步

逐项对照 r2 R2-F5：

| 面 | r3 实物 | 判断 |
|---|---|---|
| T4 / 跨机 | 设计 :18,29,79 明确异常检测、共享存储不支持 | 通过；不是跨机写权背书 |
| release | :27 明列单次共享、静止写面、排除路径替换 | 通过；组件未证明装配静止 |
| 运维清锁 | :28 增停服务、禁并发拉起、同命名空间 | 基本通过；建议明确同时串行化其他清锁者，停服务包括旧/暂停写者，不能把 stale 当授权 |
| L2 / 硬序 | :33 历史兜底标注，:46 改 O_EXCL | 通过；但 :65 现行 FF 仍写“flock 门”，源码 :15 也仍写 flock(L1) |
| initialize / 串行 | :52 / :89 明示装配串行 | 前提定位通过；类型强制、调用形式和源码旧 stat 序仍错，见 R3-F1 |
| 预排/实测/历史 | :74 指向实际谱，:85 标历史例数，:91 明示未接线 | 改善；“FF 全落地”仍应理解为历史组件覆盖，不能外推真重启或业务写守卫装配 |

另外，`writer-oath.ts:177` 将参数校验和 selfCheck 合称“均在任何 I/O 前”，实际 readRaw 在 :183，selfCheck 在 :195；设计 :89 也把自证写作“零 I/O”。只有显式空 at 门是零 I/O，自证层不是。Mu-r3-3 的 reads=1 就是反证。

selfCheck 不增加新的异步调度点，也不使既有读写窗口消失。预读推算的 byteEnd 必须在明确单写者/可信启动顺序前提下理解，不能改称内核返回的原子 append 终点。

TEST-MAP :1051 的“两轮未复现=审读环境时序”属于过度归因。本次 1428 全绿支持“本轮未复现”，不支持“已定位原因”。应保留 r2 原失败位置 `history-source.test.ts:631` 和尚未归因状态；不要求通过重跑整仓刷绿销案。

### 已核销证据 — P1-1 release 与 stale

`writer-oath.ts:111–125`：首次调用启动 async 序列并保存 Promise；后续调用返回同一个对象，不再读锁。W-r3-1 的 deferred read 回归虽在首次计数断言就能杀变异，正确实现会继续验证 B 获锁、A 重复 release 不再读、C 拒起。

补充真实文件探针只暂停第一个真实 unlink，不伪造 holder，得到：

```json
{"name":"real-unlink-interleave","samePromise":true,"calls":1,"duringOk":false,"bOk":true,"cOk":false}
{"name":"stale-eight","ok":0,"allStale":true,"unchanged":true}
```

在途/失败的 release 不重试可能留下锁，是既有 fail-closed 可用性代价，不是自动抢占双持有；真实进程 kill 未实测，不把上述 stale 夹具当 SIGKILL E2E。共享只约束此回调，不能阻止不可信外部 unlink，也不能替调用者排空在途写。

### R3-F5 — P3：遗留命名/分类不升级；历史时间线已修正

`packages/protocol/src/journal.ts:83–109`：latestBootId 仅在刷新最大 epoch 时更新，同代异 boot 不表示字面上的“最新”；盘面大小变化仍导致 superseded 或 foreign-write-detected 保守冻结。`:106` 按顶层 intentId 计业务，clear 无此字段，虽 `:221–226` 重放会分派业务效果，仍维持分类说明 P3。

git 核验：`git show 8ce8d3b -- apps/server/src/runtime/repair-tail.ts packages/protocol/src/journal.ts` 显示 buildRepairRow 增 fragIntentId，fresh 调用传 structuralIntentId；该提交 journal.ts:48 常量仍为 2。`git show 6eb761f -- apps/server/src/runtime/repair-tail.ts` 显示 RepairMarker、writeMarker 及补完消费才增加该身份。设计 :87 和 TEST-MAP :1047 已与此一致，R2-F6 时间线子项核销。

## 四、必修项

**本批无新增 P1 阻断；以下 P2 仍应修，不可把 GO 写成全部销案。**

| 优先级 | 项目 | 验收 |
|---|---|---|
| P2 | 初始化证据说明及旧 stat 示例 | 将 initialize 调用示例改为对象；删“类型封死”强宣称及源码旧 stat 初始化指导；写明只接受自身成功 oath 的装配约定，或真正实现来源/身份约束 |
| P2 | schema 空 at 回归 | 新增直接读 schema/parse 负例；原 extra-F7 放宽 schema 变异必须红，不以删写门变异替代 |
| P2 | 变异证据勘误 | Mu-r3-2/4 标首杀为返回值契约；删 Mu-r3-4 单点变异可解冻放行的错误解释；保留首注未杀和补测历史 |
| P2 | 文档/注释与 flake 状态 | 清理现行 flock、selfCheck 零 I/O 残留；history-source 改“本轮未复现、根因未定” |

这些项以定向测试/文字核验复核即可，无需再跑已绿整仓。若不接受“可信调用方约定”的组件边界，而坚持把类型来源强制作为本批验收目标，则该子目标尚未完成，不能据本 GO 宣称完成。

## 五、下一步建议

1. 先补上述小范围 P2，尤其不要把错误 stat 示例带进服务装配。无需为纯组件批凭空要求抗任意恶意调用者，但必须区分约定与强制。
2. 装配批必须机械验证：自身 oath 成功对象唯一流入 initialize；启动失败不开写面；check→append→fsync→记账串行；关闭先禁新写并排空在途写，再 release；真实重启/关闭重入/崩溃残留恢复按限定部署验收。
3. 运维清锁同时隔离启动、旧写者及其他清锁者；多机共享存储继续明确不支持。未测试 NFS、真实 SIGSTOP/SIGKILL 或生产启动 E2E。
4. 本轮报告之外不修改实现、REQ/TECH 或 r3 原文，遗留 P2 作为审读产物交回实现方，不代其宣布完成。

证据索引（临时文件关键结果已内嵌，避免清理后只剩结论）：

- `/tmp/p03-r3-probe/probe.mjs`、`results.log`：真实释放交错、stale 并发及结构对象初始化误用。
- `/tmp/p03-r3-probe/mutate.py`、`mutation-results.log`、`baseline.log`、`Mu-r3-1..5.patch/.log`、`Mu-r3-4-before-test-fix.log`、`extra-F7.patch/.log`：副本定向变异及历史杀点重建。
- `/tmp/p03-r3-probe/frozen-control.mjs`、`frozen-control.log`：单删 frozen 条件后的仍冻结对照。
- `/tmp/p03-r3-probe/r3.diff`：本批 writer-oath 源码差异。

交付：本报告写入指定审读 worktree；原有未跟踪 `p03-r3-brief.md` 保持不动、不纳入报告提交。提交/推送仅限审读分支，不改或合并主仓 master。完成哨兵在报告落盘及核验后写 `/tmp/gpt-p03-r3-done`。
