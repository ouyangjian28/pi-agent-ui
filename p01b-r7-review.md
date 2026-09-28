# P0-1b r7 独立审读报告（第三次收尾派）

## ① 总分与判定

**82/100，NO-GO。疑点 A 为 P1 必修：r7 补上了“repair 行已保存结构身份”的保护，但截断后、行写入前的崩溃窗口仍丢失该身份，重启后仍可发生 r6 同族的冷态越权放行。B 的旧完整行误拒指控不成立；部分行确有 L 级恢复性退化。C 已闭合。**

- 审读基线：`3718d56`；实现 `8ce8d3b`，文档 `1c39440`。工作树 `wt/gpt-p01b-r7-review`。本轮不改实现、不委派、不启动后台任务。
- 对照先例：`/home/yyj/ai/projects/pi-agent-ui/audits/gpt-p01b-r6-review-2026-10-08.md`，83 分、P1-r6-1。结论沿用其信任前提与冷热不放宽标准，不因崩溃窗口概率较低而降级。
- 下文简称：RT=`apps/server/src/runtime/repair-tail.ts`；R=`apps/server/src/runtime/recover.ts`；A=`apps/server/src/runtime/adjudicate-journal.ts`；T=`tests/unit/server/adjudicate.test.ts`；D=`docs/p0-1b-adjudicate-design.md`。行号对应本轮基线。
- 既有证据目录 E1=`/tmp/p01b-r7-audit-KJvDcb`；E2=`/tmp/p01b-r7-audit-xJl2kX`。采信前两轮验证，不重跑已绿检查。E1 的 RT/R/A 与当前工作树逐字节一致。
- **计数澄清：** E1 `audit-final.json` 为 73/73、reporter 统计 11 个 suite；实际三份测试文件：adjudicate 29、repair-tail 38、审人探针 6。即正式用例 67+探针 6，不是 73 条正式安全回归，更不是全仓复验。探针中有“确认缺陷存在”的断言，绿不代表缺陷闭合。tsc exit 0、r7-review 七文件 ESLint 干净按派单既有证据采信。
- 变异三连 Mu-r7-1/2/3 均基线绿→注入红→复原绿；N-consistent/N-null/N-legacy 同样真杀。**N-abandon-official 实际存活**（status 0），N-abandon-probe 才杀死同一变异；不将“证据链完整”误报为“全部正式用例真杀”。依据 E1 `audit-mutations-summary.json`。
- 本轮唯一新增执行：一个同步 B 定界测试，14 个形态组合，1/1 通过；`audit-final-B.json`、`audit-final-B-run.json/log`、`tests/unit/server/r7-final-B.test.ts` 均在 E1。它只验证分支行为，不代替原矩阵或端到端自动发送验证。
- 环境披露：未见【流程门】注入块，已披露；已查项目索引、记忆及指定前审报告。当前无 session_search 工具，不冒称检索过历史会话。原有未跟踪 `p01b-r7-review-brief.md` 保留不动。

## ② P1 发现

### P1-r7-1／疑点 A：持久 marker 不含结构身份，截断后行未写的补完把 i1 丢成 null

**代码证据：RT:88–89、132–143、403–410、450–476；A:239–249；R:449–460、482–485、523–526、543–549。**

1. 正常生成面会扫描原始尾段，把顶层唯一身份写成 `fragIntentId:"i1"`。但 RT:403 的 marker 只写 version/file/byteStart/byteEnd/removedSha256/startedAt，类型与加载器也不保留结构身份。
2. marker 持久化后，RT:407–409 依次 truncate、datasync、writeFull。若在首次 write 前退出，尾段已删除，预先构造的 repair 行仍只在内存。
3. 重启识别 `raw.length === marker.byteStart` 的截断形，旧锚前缀可验即进入补完；RT:469 无条件构造 `fragIntentId:null`。原始哈希不能逆推出 i1。
4. A:246–249 只对非 null 身份执行一致门。因此宿主可把该事务 fragment 裁给已入队的 i2；无须伪造 marker、锚、repair 四元组，也无须关闭安全检查。
5. 任一有效 fragment 归因使该事务不再进入 `unattributedRepairs`；单事务的有效 fragment 裁决同时足以满足修复对账。所谓“未归因事务门兜底”只在尚未归因时成立，**i2 归因落盘后不再兜底 i1**。
6. 冷态没有 raw，i1 不在 unknown；null 不加入 txImpacted，i2 的裁决亦不把 i1 加入。R:546 对 i1 不调用覆盖门，enqueue-only 的 i1 直接进入 resumable。

### 第一轮探针确实命中了该窗口，而非手造非法残局

来源：E1 `tests/unit/server/r7-review-probe.test.ts:15–24,35–44`、`audit-probes.json/log`、`audit-crash-S5-resend.json` 与 abandon 同名文件。

- **marker 已写：** `setup` 先写三条 enqueue、首次捕获建前缀锚，随后才 append 撕裂尾（:17–20）。`writeCrash(p,0)` 只替换 journal handle 的 write；marker 走原生 sidecar tmp+rename，不被拦截。真实生产控制流先完成 marker 写入，才会到达被拦截的 write。
- **tail 已删：** Proxy 绑定并放行真实 truncate/datasync；首次 write 抛错发生于这两步之后。锚只覆盖保留前缀，允许重启验证。
- **repair 行未写：** cut=0，不调用底层 write，立即抛 `REVIEW_CRASH`。原文件此前没有 repair 行。重试断言明确要求 `kind:repaired, via:marker-complete`，并实际读回 `fragIntentId:null`。
- marker 字段由生产函数生成，没有探针手工拼接。原 JSON 报告只保存裁决和冷热结果，**没有单独保存崩溃瞬间 marker/盘面快照**；三前提由探针源码、真实 IO 顺序及已通过的 marker-complete/null 断言联合证明，不冒称 JSON 本身含这些字段。
- 冷态来自新 provider、`trustFirstCapture:false`；热态是在同一耐久 lines 上携回原 raw 的对照快照，不是另起一个真实常驻热进程。失效注入是同步异常模拟进程丢失内存，并非 SIGKILL 或掉电试验；两者均不影响已验证的“marker 在、尾已删、行未写”文件状态结论。

`audit-crash-S5-resend.json:2–32` 观测解读：

| 裁决 | 证据态 | blocked | unknown | resumable | authorized |
| --- | --- | --- | --- | --- | --- |
| fragment i2 resend | 热 | false | `[i1]` | `[i2,i3]` | `[i2]` |
| fragment i2 resend | 冷 | false | `[]` | **`[i1,i2,i3]`** | `[i2]` |
| fragment i2 abandon | 热 | false | `[i1]` | `[i3]` | `[]` |
| fragment i2 abandon | 冷 | false | `[]` | **`[i1,i3]`** | `[]` |

i3 是无关 enqueue 正对照。**“authorized 不含 i1”并不代表安全：漏洞正是 i1 被错误当成普通无关 enqueue，绕过证明要求取得执行资格。** 此处证明的是恢复报告的执行资格越权，不声称实际外部副作用已经重复发生。

### 第二轮 A 红的原因

E2 探针 `:15–20` 先把 prefix+raw 全写入，再首次 provider 捕获。provider 在 `recovery-evidence-source.ts:416–435` 对全 raw 建锚，因此 `anchor.len > marker.byteStart`。截断后：

- n=0 的无尾补完在 RT:463–467 拒绝，原因 `anchor-stale / marker-prefix-irreproducible`；
- 若有部分行，通常先在 RT:337–341 的锚复验处 `anchor-mismatch`，或后续锚界门拒绝。

E2 日志的 A 正是在首个 n=0 重试期待 repaired 时失败；同样前设影响 N2。它们证明该锚形态保守失败，不证明全部崩溃形态安全。E1 使用合法、可复验的前缀锚，不能用 E2 不同前设否定 E1。

### 定级与修复方向

**定 P1，不降为 P2/L。** 与 r6 相同，仍需受信宿主提交与原结构证据不一致的 i2 归因；不是远端权限提升，也不声称正确一致归因会触发。新增前提仅是工具自己承诺可恢复的崩溃窗口。窗口小不改变后果；冷热不放宽被确定性击穿，锚门仅保护部分前设，未归因门在错目标归因后失效，P0-3 尚未接线也不是读面正确性的替代兜底。第一轮测试名称中的 “P2 observed” 是探针临时名称，不是最终定级。

实现方提出的“truncate 前扫描并存入 marker，补完读 marker 恢复”**方向可行，但尚未验收，不构成方案承诺**：

- 扫描须对应已经校验的同一尾段，身份与 bounds/hash 一同在破坏前持久化；加载器须保留并校验该字段，不能只扩类型不扩序列化/解析。
- fresh、marker-before-truncate、truncated、partial-row 的重建应使用同一耐久身份，不能从新 repair 行的残片重新猜原尾身份。
- 明确区分“真实不可归因 null”与“旧 marker 没保存而未知”；旧 marker/旧行不能无证据推断安全。缺证据时应留置/显式处理，不得把 i2 普通裁决隐式当 i1 的解除事实。
- 正式回归须覆盖本例 resend/abandon、截断与短写窗口、旧 marker、合法 i1 一致归因、无关 i3、完整 sending 禁执行。不得用无差别封禁 enqueue 掩盖模型缺口。

## ③ P2/L 发现（B 定界与 C）

### L-r7-1／疑点 B：完整旧行兼容成立；部分行前缀兼容声明过宽

**证据：RT:151–167、300–305、337–383、450–481；D:126；E1 `audit-new-prefix.json`、`audit-legacy-prefix.json`，本轮 `audit-final-B.json`。**

先纠正证据：E2 `audit-probes.log` 的 B 首个失败为探针 **:83 的 expected repaired、actual aborted**，循环首项 `early` 就退出，并没有执行到 :84 的 old-complete 断言。因此不能把该日志转述成“实测 old-complete 被拒”。

本轮唯一同步小探针以生产 write 接缝生成真实 marker/计划 repair 行，再设置残局字节；对比前缀锚和覆盖旧尾的全文锚。14 个组合全部符合下表：

| 残局形态 | 可复验前缀锚 | 实际分支／解释 |
| --- | --- | --- |
| 旧完整 repair 行，含 `}\n` | `reconciled / marker-reconcile` | 无撕裂尾，走 rowAtBounds；按 schema、行首/末、bounds/hash 认旧行，**不要求旧行是新行前缀** |
| 新完整 repair 行，含 i1 与换行 | `reconciled / marker-reconcile` | 同上，保留原行字节，不重构为 null |
| early 公共前缀 | `repaired / marker-complete` | 有尾，isPartialRow 严格逐字节比较通过，然后截回再补行；当前补成 null |
| 新行到 `"fragIntentId":`、尚未写值 | `repaired / marker-complete` | 与重建 null 行仍共享前缀；后续证据丢失归 A，不重复定 P1 |
| 新行已进入 `"i1"` 值，或完整 JSON 但未写换行 | `aborted / repair-marker-conflict` | 对 repair 残片扫描不产生原顶层 intentId，重建为 null；`"` 与 `n` 不匹配 |
| 旧行已有 `}`、只缺末换行 | `aborted / repair-marker-conflict` | 有撕裂尾，仍走 isPartialRow；旧 `}` 对应新字段前的 `,`，不匹配，不能走 rowAtBounds |
| 上述旧/新完整行，但锚覆盖被删原尾 | `aborted / anchor-stale` | rowAtBounds 已成立，随后 prefixOk 失败；不是 bounds 不匹配，也不是跨版本字节比对误拒 |
| 上述部分行，但锚覆盖原尾 | `aborted / anchor-mismatch`（本探针） | 更早的锚检查拒绝，未进入有意义的前缀兼容判定 |

边界补充：旧行尚未写到 `}` 的公共前缀可通过（同 buildId/时间/序列化条件下）；真正记录 null 的新行，其 null 部分前缀也可匹配。跨 build 前缀不符、行 schema 非法、bounds/hash/行末不匹配，本来就应拒；完整行另有新锚已转移时的 marker-cleanup 路径（RT:455–458）。有尾且与原 marker bounds+原尾哈希一致则是“尚未截断”路径，不走上述部分 repair 行判据。

**定级：旧完整行误拒不成立；新 i1 部分行与旧 `}` 无换行残局的拒绝为 L 级恢复性退化，不是越权。** marker 保留、拒绝时盘面不变，无执行资格扩大。真正的问题是“本工具自己写到一半的行/旧版最后一个换行前窗口”不能按兼容承诺续完；需补测试、修正前缀策略及文档，不能因此放宽任意不匹配字节。

### P2-r7-1：文档闭合过称与正式回归缺口仍未收尽

- r6 的测试头/describe、R12/R17/R20 等具体注释有实质更新，认可已修部分；但 R:463–467 仍概括 resend/abandon 同向全覆盖，紧随 abandon 提前返回才给例外，头注仍应限定正向授权。
- D:126–128、TEST-MAP:1004–1007 的“旧行为新行严格前缀”“矛盾裁决自此不可持久化”“未归因门兜底”均须加本报告 A/B 边界。目前无法据此宣布整个 P1-r6-1 闭合。
- R27/R28/RT-r7-1/2/3 真正保护了新增三面，但 R28 是**预先有 fragIntentId=i1 的行**，并未证明丢行窗口安全。正式用例缺 A 的安全负例及 B 的字节边界。
- N-abandon-official 只对正式 R27 定向运行时存活，不能外推为全仓所有测试都存活；但审人真 IO 探针能杀死同一窄变异，说明应将 abandon+repair-first 的一致门反例纳入正式回归，而非只留临时探针。

### 疑点 C：✅ 已闭合

`3718d56` 已清理未使用 helper。采信前轮七文件定向 ESLint 干净及 tsc exit 0；本轮不重跑、不额外扣分。

遗留边界沿用 r6：孤儿 ID、投影集合及发送前生命周期复核留 P0-3；漂移锚解困 S-r3-1 仍非本轮解决面。本报告不放行端到端自动重发。

## ④ 必修闭合判定表

| 项目 | 判定 | 说明 |
| --- | --- | --- |
| P1-r6-1 结构归因在冷态失忆 | ❌ 部分闭合 | 正常 repair 行留痕、写一致门、读面并入有效；崩溃丢行→null 仍重现同族越权，现编号 P1-r7-1 |
| P2-r6-1 文档／注释债 | ❌ 部分闭合 | 测试标题及多处注释已修；整体闭合、前缀兼容过称及 scopeCovers 泛化残留，见 P2-r7-1 |
| A 截断后行未写窗口 | **P1 必修** | 第一轮真实 IO 反例有效；第二轮锚前设不同而被保守拒绝，不构成反证 |
| B old-complete 误拒 | 不成立 | 合法前缀锚下实际走 rowAtBounds 并 reconcile；覆盖原尾的锚被正当拒绝 |
| B 部分行兼容 | **L，未闭合** | 新身份值部分写入、旧 `}` 无换行均可保守拒绝；不扩大执行资格 |
| C helper／静态检查 | ✅ | `3718d56` 与既有 tsc/lint 证据 |

r6 再送审条件逐条验收：

| 条件 | 结果 | 依据 |
| --- | --- | --- |
| 闭合 P1-r6-1 全路径 | ❌ | A 仍成立，不能仅凭 R27/R28 通过盖章 |
| 无关 enqueue 正对照保持 | ✅ | R28、第一轮 crash 反例均保留 i3 可执行；不是全局阻断假杀 |
| abandon 终局与完整 sending 禁执行保持 | ✅ 指定范围 | 原矩阵既有结果与 R:470、546、548 保持；A 泄漏对象是未被 abandon 的 i1，不是否认 i2 已终局排除 |
| 新反例转正式回归 | ❌ 部分 | R27/R28/RT-r7 已落；A/B 与 abandon 窄变异杀点仍只在审人临时探针 |
| 文档与残留注释同步 | ❌ 部分 | §12/TEST-MAP 已增，边界仍过称；项目入口尚无本轮最终裁定 |
| 原矩阵＋新例验证 | ✅ 所交证据范围 | 正式 67+探针 6=73/73；不重跑，不冒称全仓或真实发送 E2E |
| 定向变异证据 | ✅ 有边界 | 指定三连真杀复原；三项正对照窄变异真杀；abandon 官方定向存活、审人探针真杀已明确区分 |
| P0-1b 全面收口 | ❌ | P1 必修尚未闭合 |

再送审最低要求：结构证据跨 marker/截断/短写恢复持久化或等效保守处理；本报告 A 两 verdict 转正式安全回归并保留 i3 正对照；补 B 兼容边界；同步文档，再提交矩阵与定向变异证据。不得把“丢证据就放行”改成期望值换绿。

## ⑤ 评分明细

| 维度 | 满分 | r6 | r7 | 依据 |
| --- | ---: | ---: | ---: | --- |
| 覆盖与闭合 | 30 | 24 | 24 | 三面修复有效，但耐久事务窗口仍有同族 P1，不能认总体闭合 |
| 代码质量 | 15 | 12 | 12 | schema／一致门／影响域设计清晰；marker 未携身份、部分行重建取错证据来源 |
| 测试矩阵真实性 | 25 | 22 | 21 | 三连真杀及正例有效；缺崩溃丢行和跨版本末字节正式回归，abandon 定向变异仍存活 |
| 变异证据 | 15 | 15 | 15 | 既有完整链可核；存活与真杀如实区分，本轮未伪称重跑 |
| 文档对齐 | 10 | 8 | 8 | 历史注释修复有进展，§12 的整体安全／前缀兼容结论仍超证据 |
| 回归面 | 5 | 2 | 2 | 正对照保持；冷态残留 P1、部分行恢复退化及 P0-3 接线边界仍在 |
| **总分** | **100** | **83** | **82** | **NO-GO；P1-r7-1 必修阻断，不能以 ≥85 的分数形式绕过** |

交付仅本报告；实现与现有测试未修改。临时 E1/E2 不是永久档案，关键构造、观测、分支与评分已在报告中固化。先落本报告，再建立 `/tmp/gpt-p01b-r7-done` 哨兵。
