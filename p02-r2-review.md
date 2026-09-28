# P0-2 r2 独立审读：生命周期队列根修

## 一、结论

**GO，88/100；仅放行本批生命周期根修，不等于帧身份批或崩溃恢复链已验收。**

审对象：主仓 `/home/yyj/ai/repos/pi-agent-ui`，HEAD `16323bf`（实现 `52bba50`，变异/时序补强 `bb29eca`）。审读工作树：`/home/yyj/ai/repos/gpt-p02-r2-review`，原始 HEAD 同为 `16323bf`。未修改主仓实现、测试或文档；所有独立探针及变异副本在新目录 `/tmp/gpt-p02-r2-probe/`。旧 `/tmp/gpt-p02-r1-probe/` 保留不动。

| 核销项 | r1 | r2 判定及证据 |
|---|---|---|
| R1：close/dispose 不汇合 boot，漏锁及旧宣誓污染 | P1，未解决 | **核销**。立即 close+dispose 命中 after-lock；enteredRead 后关停命中 pre-oath；dispose 等待 boot，旧宣誓不落盘，锁清后 B 单独取得 epoch=1 并连续写成功。另证在途 guard-check/append 先完成、随后释放锁，late append 拒绝。 |
| R2：check→append→note 非整体串行，自写误冻 | P1，未解决 | **核销**。独立探针在真实 FileDurability 已写入字节、尚未返回到 note 的窗口挂起；第二 append 不进入底座，放行后两次均成功、第三次仍成功。 |
| R3：构造 boot Promise rejection 无消费者，杀进程 | P1，未解决 | **核销**。原缺父目录形现在可创建并写入；真实 EACCES 子进程及局部 catch 外意外异常均 exit=0、SURVIVED，后续 append 恒拒。 |
| 总分（100 分制） | 58，NO-GO（送审材料口径） | **88，GO**：生产根修成立；扣分集中于测试错误路径清理、杀点表述和文档残留，不再是三项生产 P1。 |

本轮独立复跑：单元 16/16；服务端 tsc exit=0；真服务 E2E 2/2；独立交错探针 7/7；启动异常子进程 exit=0；Mu-b4、Mu-b2 副本定向变异均得到预期的断言失败。按 M-251 **不重跑已绿全仓**；1444 绿仅引用送审基线，不计作本轮独立实测。

证据范围说明：使用现存 r1 探针源码重造 r2 断言。原探针先 await dispose/close 再放 boot 的步骤在正确队列下会互等，故改为先保存关停 Promise、断言尚未完成，再放行并等待；不是把测试超时当作修复证据。未找到旧 r1 报告文件，r1 编号依据送审描述及现存探针对照。当前会话未提供 session_search 工具，未冒称完成历史会话检索；未见【流程门】注入块，已在执行前披露。无子代理/嵌套后台进程，无长 sleep，单条命令上限 280 秒。

## 二、高优发现

**本轮未发现未解决的生产 P1/P2 阻断；三项 r1 P1 均有独立反向证据。** 下述新结构风险已专项检查，结论不扩大到未测范围。

1. **队列及失败推进**：`apps/server/src/runtime/guarded-journal-writer.ts:135,156-159` 只保存尾 Promise，尾结果归一为 undefined；没有另存历史任务数组或反向链。已完成任务未见显式长期保留路径；未完成积压仍是 O(排队数量)，不宣称内存恒定或已有背压，也未做长期堆/GC 压测。`then(op, op)` 只会选择一个回调，前序失败仍推进；底座的失败锁语义未被解除。独立 P5 证实写前异常后队列可继续、close 异常不会卡住 dispose 的锁释放。
2. **关停与 late append**：同文件 boot 为首个入队项，append/close 共用队列；`drainAndClose` 在队列中先置 closed 再关底座（同文件 `163-175`）。close 后调用的 append 排在 close 后并拒绝，关停前已接收的任务可完成。独立 P4 在 guard-check 挂起时启动 dispose，证实锁仍在、dispose 未完成；放行后才释放，late 行没有入盘。这里“排空”指已接收的生命周期 I/O；不声称任意晚入队的拒绝任务都必须先于 dispose Promise settle。
3. **检查点①与循环双释放**：`84-89` 中止分支 return 在 releases.set 之前；因此该锁不进入 dispose 的 Map 循环。检查点②已登记，释放归 dispose。底层 `writer-oath.ts:112-125` 的 release 本身共享一次 Promise，叠加保护重复/并发 dispose；独立 P7 证实旧工厂重复关停不删后继 B 的锁。未发现当场释放与 Map 释放互删新锁的窗口。
4. **mkdir 变化**：`guarded-journal-writer.ts:60-65` 对齐真实底座创建父目录；新增目录成功、父路径为普通文件（ENOTDIR）失败均已独立测。EACCES 明确命中 lock-io-failed，而不是把目录准备失败误算取锁失败。递归 mkdir 不代表新增祖先目录均具有掉电耐久承诺。
5. **检查点②可达性**：官方交错2的 enteredRead 确实把 dispose 放在检查点①之后。独立 P2 观察到 `stage=pre-oath`；Mu-b4 副本只将该检查点改为 `false && disposed`，官方交错2在 `:231` 因 bootA 实际 ready 而非 failed 失败。故该变异记录可核销，不是无关异常偷杀。新实现已把旧 boot 汇合在 B 获锁之前，不再需要制造“B 获锁后恢复旧 boot”的非法次序。

## 三、低优及非阻断整改

### L1（P2，测试清理错误路径；非生产阻断）：A-2 的 finally 没有拿到第二实例

- 位置：`tests/integration/p02-assembly-e2e.test.ts:133,137,152`。
- 外层 `let l4: Live | null = null` 被 try 内 `const l4 = await boot()` 遮蔽。正常路径第 151 行显式 shutdown 会清理；但 boot 完成后、显式 shutdown 前任意断言/等待失败，finally 看到的仍是 null，漏清第二 server/ws。
- 复现方法：在第 137 行后注入 throw，finally 只清 l3；l4 所有权没有交给外层变量。此条为代码路径审证，本轮没有故意遗留真实 server 来复现。
- 最小修正：第 137 行改为赋值 `l4 = await boot()`。同时建议 boot() 内启动 server 后握手失败自行清理；调用方 await boot() 失败时尚拿不到 Live。
- 判定：本轮 E2E 两例真实通过，但“try/finally 收尾已全覆盖”只能**部分核销**。

### L2（P3，杀点表述不准）：官方 R2 是写前延迟，不是已落盘未记账窗口

- 位置：`tests/unit/server/guarded-journal-writer.test.ts:239-265`，尤其 `250-251`；`tests/fixtures/TEST-MAP.md:1072,1077`。
- 40ms 暂停发生在 `origAppend` 之前，不保证第二次 check 发生在第一行已落盘而 note 尚未更新时。
- 本轮 Mu-b2 副本移除 append 外层队列，官方用例确实红，但实际失败是第 263 行顺序断言：得到 `[i-2,i-1]`，不是 foreign-write-detected。因此“变异被杀”成立，“此杀点复现自冻”不应照写。
- 独立 `races.test.ts` P3 已补齐真正的**落盘后、返回前**受控暂停，当前生产实现通过。建议把该形移入仓内回归，并使用 entered/resume 信号而非固定延迟。

### L3（P3，文档收窄未完全同步）：TEST-MAP 预留说明成立，设计稿服务表仍过称

- `tests/fixtures/TEST-MAP.md:1075` 明确把 4402/not-ready.cause/writerState 呈现放到帧身份批，符合当前 gate-failed(enqueue) 行为。
- 但 `docs/p0-2-write-identity-design.md:47,50` 仍把这些写成“服务呈现”，没有就地标注预留，读单份设计稿会误判已交付。应改成当前表现＋未来计划两栏。
- 同文件 `:69` FF-P02-3 写“E2E：dispose 期间注入并发写”，本 E2E 实际没有这种注入。生命周期受控交错来自单元/本轮探针，不是当前组合根 E2E；应改证据层级或补例。
- 同文件 `:85` 仍有“sessionFor 抛/写全拒”，与 `:77` 正确的同步 sessionFor、异步 append reject 不一致；去掉前半句即可。
- 文档章节引用也有漂移：同步契约实际在 §4、释放序在 §1.4、崩溃链边界在 §5，并非送审摘要/迭代史所述 §3/§5/§6。

### L4（P3，注释及释放诊断边界）：已修措辞但还应避免再过称

- 官方交错1的 `tests/unit/server/guarded-journal-writer.test.ts:186,197` 仍写“检查点②”，实际立即 dispose 在 after-lock 的①就中止；TEST-MAP 本批段及本轮 audit 探针正确。
- r1 P3-2 的核心措辞已经落地：设计稿 `:57` 明示“部分失败可能静默残锁”；底层 `writer-oath.ts:122` 的 unlink.catch 会吞错误，壳层 release-error 不可能覆盖所有删除失败。核销的是**文档承认诊断边界**，不是新增了全量 release 诊断或失败注入验证。
- 设计稿 `:57` 开头仍写“释放失败=audit”，壳 `guarded-journal-writer.ts:214` 也如此注释，建议统一成“可观察到的 release rejection 记 audit；底层吞掉的 unlink 错误可能仅留残锁”。

## 四、核销清单与实跑记录

| 项目/探针 | 本轮结果 | 核销范围 |
|---|---|---|
| `npx vitest run tests/unit/server/guarded-journal-writer.test.ts` | exit=0，16/16，795ms | 官方定向基线 |
| `npx tsc --noEmit -p apps/server` | exit=0 | 服务端类型检查；与上一命令用 && 串行执行 |
| `PI_E2E=1 npx vitest run tests/integration/p02-assembly-e2e.test.ts` | exit=0，2/2，18.95s | 真 pi 三轮；实例重建 epoch 精确 1→2、新 bootId、旧轮保留；第二实例活锁拒 |
| 独立 P1 immediate close+dispose | 通过 | after-lock audit；read 未进入；零 oath、无锁、late append 拒 |
| 独立 P2 enteredRead/继任 B | 通过 | dispose 等待；pre-oath audit；B 恰一代且可续写 |
| 独立 P3 durable-before-note | 通过 | 真实已写字节窗口第二调用被串行；三行均成功 |
| 独立 P4 guard-check/dispose | 通过 | 在途先完成，释放前写面静止，晚到行拒 |
| 独立 P5 failed op/close | 通过 | 队列失败后推进；close 抛仍关写面并释放锁 |
| 独立 P6 mkdir/ENOTDIR | 通过 | 缺多级目录可写；目录准备错误 fail-closed |
| 独立 P7 repeated dispose | 通过 | 重复/并发 dispose 后不误删新持有者锁 |
| `boot-reject.mts` | exit=0 | 原 ENOENT 形逆转；EACCES_REJECT SURVIVED；UNEXPECTED_REJECT SURVIVED |
| Mu-b4 副本＋官方交错2 | Vitest exit=1，1 failed/15 skipped（预期红） | `ready` 对 `failed`，证实检查点②杀点有效 |
| Mu-b2 副本＋官方 R2 | Vitest exit=1，1 failed/15 skipped（预期红） | 杀点为写入顺序逆转；不冒称 foreign 自冻 |
| r1 R4：E2E 精确 epoch＋崩溃边界 | 核销主要断言；错误清理部分未核销 | epoch 用 toBe(1)；实例重建≠SIGKILL；见 L1/L3 |
| r1 P3-1：同步契约/释放顺序/迭代边界 | 主要修订落地，残句未尽 | 设计稿 :77/:57/:89 已改，:85 等见 L3 |
| r1 P3-2：release 诊断描述 | 核销核心降界，保留 L4 | 承认静默残锁；不是完整错误观测保证 |

复跑入口（所有测试从主仓执行，PATH 前置 `/home/yyj/.nvm/versions/node/v24.18.0/bin`）：

```sh
npx vitest run --config /tmp/gpt-p02-r2-probe/vitest.config.mjs
node --experimental-transform-types /tmp/gpt-p02-r2-probe/boot-reject.mts
npx vitest run --config /tmp/gpt-p02-r2-probe/mub4.config.mjs -t 'R1-交错2' # 预期 exit=1
npx vitest run --config /tmp/gpt-p02-r2-probe/mub2.config.mjs -t 'R2 同写者' # 预期 exit=1
```

独立原始日志：`/tmp/gpt-p02-r2-probe/{races,boot-reject,mub4,mub2}.log`。变异仅改新目录的 guarded 副本，其他依赖指向主仓，未在主仓注入/还原代码；因此预期红不代表最终实现测试失败。两个后台变异包装命令验证 Vitest exit=1 后自身 exit=0，报告明确区分两层退出码。

官方实跑原始日志（主仓相对路径）：`.pi/tasks/session-3038535-3038535/b4cd24010.output`（定向＋tsc）、`.pi/tasks/session-3038535-3038535/b97cf71c4.output`（E2E）。没有复跑 Mu-b1/Mu-b3，也不把既有变异记录全盘冒称本轮复验。

## 五、给 r3（帧身份批）的输入

1. 保留本批单写者生命周期队列，不把 boot 或任一 check/append/note 拆到队列外；晚到写入拒绝与已接收任务排空是不同义务。
2. 将 r3 明确定名为“帧身份批”，清掉设计稿里同时把 r2 指代生命周期根修和帧身份的歧义。
3. 在写帧入口独立验证 generation、intentId 授权及恢复证据身份，补旧代/无授权/双端竞争的拒绝码与零副作用断言；不能用当前 gate-failed(enqueue) 代替身份拒绝语义。
4. 先修 L1 测试 finally 遮蔽；把本轮 P3 的落盘后受控暂停、P4 的关停中并发写纳入仓内回归。L2 的变异记录应如实改成“顺序杀点”，或补真实自冻窗口证据。
5. 同步 L3/L4 文档边界：当前可观察行为与预留目标分开；运行中 guard 冻结状态与读盘 writerState 不是自动等价的诊断接口。
6. 明确留在未验证清单：OS 进程 SIGKILL→stale 锁→运维串行清锁→重新开写完整链、release 实际 I/O 错误诊断、长时积压/内存背压。不得把本轮 GO 外推成这些项已绿。
