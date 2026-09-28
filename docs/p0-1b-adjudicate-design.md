# P0-1b 裁决持久化设计（v1；GLM 面，2026-10-06）

> **版本提示（r2/r3 批）：§1-§6 为 v1 历史语义，身份/解锁/门序权威=§7（r2 重构）与 §8（r3 作用域化）；
> 与 §7/§8 冲突处以 §7/§8 为准，§1-§6 保留作决策留痕，不复制旧结论。**

依据：PROJECT.md P0 冻结序②；GPT r6 排序建议（裁决=可重启耐久事实，绑定文件/会话+证据身份；失败次序；崩溃矩阵先行）；P0-1a 收口低项同批吸收。

## 0. 现状缺口（勘察 2026-10-06，repo 3619b53 基线）

- attributedFragments=调用方内存参数（buildRecoverReport opts），快照捕获恒空数组（recover.ts:481）→重启丢裁决、每次重问。
- repairShadow 三链（repairLog>0 || pendingRepair || repairUndecided，:409）恒阻断，无解锁面——「待 adjudicate 显式裁决」的承诺未兑现。
- withRepair 只清 pending 置 undecided（:526），语义正确但无出口。

## 1. 决策：adjudicate 行落 journal（选项 A）

裁决=宿主侧受信动作（人工归因），与 repair 行同机制：
- **adjudicate 行型**（journal 行，t:"adjudicate"）：`{t, at, buildId, contractV, subject:{kind:"fragment"|"repair", ref}, verdict:{outcome:"resend"|"abandon", attributedTo?}, operator}`。
  - subject.ref=fragment：目标残片身份=`sha256(残片原文)+byteRange`（与快照 bad 集合身份同构）。
  - subject.ref=repair：目标修复事务身份=`{removedSha256, byteStart, byteEnd, at}`（与 repairLog 条目/repair 行原文身份同构）。
- 走 repair-tail 同款安全追加（openSafeReadWrite+write+datasync；行小，撕裂=坏行→下轮修复，fail-closed 可接受——裁决丢失只多阻断不漏授权）。
- 读面：provider 捕获已读全量 lines→快照 lines 含 adjudicate 行；canonical hash 自然覆盖（身份自增）。
- **派生**：recoverFromSnapshot 从 lines 派生 attributedFragments+repair 裁决配对（不再信任调用方内存参数——attributedFragments 保留为 opts 但生产路径恒走派生；测试可注入）。

## 2. 解锁语义（配对制）

- fragments：bad 中每个未归因残片阻断；lines 中 adjudicate(ref=fragment 身份) 且该身份仍存在于当前 bad 集合→计入归因（unattributed 减）。
- repairShadow 三链改判：
  - repairLog 中**每条** repair 事务须有对应 adjudicate(ref=repair 身份匹配 removedSha256+byteStart+byteEnd) 才解锁；任一无配对→阻断。
  - pendingRepair 仍恒阻断（事务未完，裁决不可先于事实）。
  - repairUndecided：withRepair 置位后，若快照 lines 中该 undecided 事实对应的 repair 事务已有 adjudicate 配对→不再阻断（undecided 解除=裁决在场证明）；否则维持粘滞。
- **旧裁决不作用于新证据**：adjudicate ref 身份与当前 bad/repairLog 逐字段匹配才生效；不匹配（盘面已变/新事务）→裁决在场但不计解锁（不报错，审计行提示 stale-adjudication）。

## 3. 失败次序（宿主工具 adjudicateJournal）

1. 构造 adjudicate 行→校验 subject 身份在当前快照事实中存在（防对空裁决）。
2. 安全追加落盘+datasync 成功→才回成功（宿主确认=落盘后）。
3. 断在落盘中=撕裂→下轮修复，无裁决（幂等重试安全：重试=同 ref 再落一行，配对去重按 ref 身份）。
4. 断在落盘后确认前=裁决已在盘（重读快照可见）——宿主重试同 ref 行=幂等（重复裁决行去重）。

## 4. 崩溃/重启矩阵（验收先行，R 系测试）

R1 裁决写失败（openHandle 注入崩溃）→无裁决+盘面可修复+重试幂等收敛。
R2 已落盘未确认→重读快照裁决在场+配对解锁生效。
R3 重复裁决（同 ref 两行）→去重配对，单次解锁。
R4 证据已变化（adjudicate ref 指向旧残片/旧 repair 事务，盘面已新）→裁决不计解锁+stale 审计。
R5 裁决文件损坏（journal 撕裂含 adjudicate 行）→坏行阻断+修复工具处理（复用 repair-tail）。
R6 repairUndecided 跨重启保留（无 adjudicate）→恒阻断；adjudicate(ref=repair) 后→解除。
R7 合法裁决后只解锁对应意图正对照：fragment 归因 resume 意图精确匹配（matchKey），他意图不受影响。
R8 pendingRepair 期间 adjudicate(ref=repair 指向进行中事务)→仍阻断（事务优先）。
R9 verdict=abandon→resumable 不含该意图（放弃=不重发）。
R10 派生面回归：attributedFragments 不再依赖调用方内存（生产路径）。

## 5. 同批吸收（P0-1a 收口低项）

- L1-r6：TEST-MAP r3/r4 勘误章节错位修正（r4 节 865 行 tsc exit0 原句勘误落位）。
- L2-r6：RT43 ENOENT 专断言（code==='ENOENT'）+目录快照措辞按断言精度收敛（toString utf8→文件名+length+内容哈希）。

## 6. 非目标

- 多操作者/审计链签名（单机单宿主信任域，operator 记名即可）。
- 裁决 UI（前端面等 Kimi 线恢复后另批）。
- extension_ui_request 透传（P0-4）。


## 7. r2 身份模型重构（GPT r1 审 66 NO-GO 修复批；2026-10-07）

r1 实现的裁决身份（fragment=raw 内容匹配/repair=四元组+词法落根）被审出五高——本节为**权威语义**，覆盖第 3 节相应部分：

1. **统一事务身份**：两种 subject 均=修复事务四元组 `(removedSha256, byteStart, byteEnd, at)`；fragment 另携归因目标 `intentId`。raw 全文不入裁决行（同内容新事务误解锁 P3/换目标假幂等 P2/撕裂字节 SHA 失配 P7/行膨胀 L2 全消）。
2. **追加前置盘面门**：marker 在场→`repair-pending` 拒；bad 行（含撕裂尾）非空→`bad-tail` 拒。均零改盘。裁决只能在「盘面已愈+无在途事务」形态下追加。
3. **幂等/冲突终局**：同 kind 同四元组已裁决——同 verdict 且同归因目标=幂等（返回原 at）；反 verdict（不可翻转）或换归因目标（不可静默更换）=`conflicting-verdict`。
4. **锚转移失败不阻断**：provider 验锚只查旧前缀不变→纯扩展允许→下轮捕获自动收敛（无死锁，P1 证明）。write-failed=提交结果不确定（append 已落+sync 抛形裁决已在盘），幂等重试收敛。
5. **读面**：有效裁决=四元组在场当前 repairLog（stale 淘汰）；同四元组多目标=冲突组整组无效（阴影保留）；journal 派生裁决效果走 abandonedIds/resendIds 通道，不进 G2 raw 匹配；呈现面=新报告字段 derivedAdjudications。

崩溃矩阵同步扩为 R1a/R1b/R2/R3/R4/R5/R6/R7/R8/R9/R10/R11（TEST-MAP r2 节权威）。

## 8. r3 授权作用域化+四门补强（GPT r2 审 77 NO-GO 修复批；2026-10-07）

r2 被审出四必修（授权串扰/marker 误放/冲突组可解锁/schema 未拒 raw）。本节为**权威补丁**，覆盖 §7 第 3/5 条的相应语义：

1. **授权作用域（B1）**：resend/abandon 裁决携带授权来源（其四元组），不再折成裸 intentId 集。覆盖判定（resendCovers/abandonExcludes）：intentId 的每一条 unknown 来源残片（sha），其内容可能归属的**全部同 sha 事务**都须有该 intentId 的同向 fragment 裁决才生效——同 sha 双事务只裁其一→旧授权不越事务覆盖新残片 unknown（R12 主负例）；无残片源（终裁 unknown 行/G2 消耗）resend 不可覆盖（裁决只能授权其证据链内残片）；abandon 无源时=终局放弃（R9 杀点对照）。G2 快照人工归因维持 raw 全等匹配（新 raw 同 intentId 不消耗，阻断保留）。
2. **marker 读错误保守拒（B2）**：仅 ENOENT 视为缺失；其他读错误（EACCES/EISDIR/EIO…）=`marker-unreadable` 零改盘拒——在场性无证据时不得追加（与 recovery-evidence-source 同界）。
3. **冲突组整组失效（B3）**：冲突事务的 repair 裁决同样不可消阴影；conflictKeys 非空本身入修复阴影（两顺序混合 kind 同拒）；derivedAdjudications 只呈现有效集。写面收集同四元组全部既有裁决做矛盾集检测（多 verdict/多目标/kind 混合均 conflicting-verdict，不信任首行）。
4. **raw 运行时禁入（B4）**：schema 显式拒 subject.raw 与顶层 raw（手写盘面带 raw 不成为合法行）；写面 minimalSubject 白名单拷贝，不透传 opts.subject 额外属性（双道防线）。
5. **低项**：句柄全程 try/finally 确定性 close（L1）；锚损坏/不可读=anchor-corrupt 写前拒（证据链已坏需人工），前缀漂移不拒但跳过转移不承诺自动收敛（L4，provider 对漂移锚保守拒 concurrent-modification）；R1b 改真「append 落+sync 抛」形/R9 补无残片源正反对照/R11 改目录链 symlink（O_NOFOLLOW 不挡目录链，realpath 门独立杀点）（L2）；注释/文档收敛到 v2+r3 语义，设计稿 §1-§6 标历史（L3）。

崩溃矩阵扩为 R1a/R1b/R2-R16（TEST-MAP r3 节权威）。
## 9. r4 双证模型（GPT r3 审 74 NO-GO 修复批；2026-10-08）

r3 被审出四阻断。核心是 B-r3-2 的**双证模型**重构——本节为权威补丁，覆盖 §8 第 1/3 条的相应语义：

1. **双证模型（B-r3-2）**：repair 裁决=物理修复**对账**（证明修复事实被确认）；fragment 裁决=效果**归因**（携 intentId+verdict，是唯一的效果授权面）。冷热统一：每个修复事务须有同四元组有效 fragment 裁决归因，否则其移除尾段的效果去向不明→范围级阻断（unattributedRepairs 入修复阴影）。修补的缝：真实修复后冷捕获（新快照残片丢失）曾凭 repair-only 配对解锁 enqueue 重发资格——重启反而比热路径更宽，违背裁决持久化初衷。授权链自证：无残片源（热路径修复后残片已移除）时 resend 覆盖由授权链自身成立（fragment 裁决四元组+归因即完整证据链），不依赖残片在场——否则热路径裁决恒无效=裁决持久化失义。在途 sending 意图默认不可重发，但同向 resend 授权链成立时可重发（裁决的本来目的）。
2. **无映射保守排除（B-r3-1）**：scopeCovers 中残片 sha 无对应事务（撕裂字节失配等）→`return false`（来源无法证明被授权→保留排除），不再空循环直达放行。
3. **锚严格 schema（B-r3-3）**：loadAnchor 对齐 repair-tail parseAnchor 逐项校验（version===1+绑定当前 file+len 非负安全整数+sha 64 位小写 hex），非法=corrupt 写前拒——旧实现只验两字段类型，非法身份锚（`{version:99,file:"wrong-file",len:0,sha:H(empty)}`）可被新锚洗白。
4. **组一致性二维（B-r3-4）**：conflictKeys=按四元组分组的全部有效裁决（fragment+repair 混算），**效果语义**任一维不一致→整组失效：多 verdict（含跨 kind 矛盾）/多归因目标。kind 维不判矛盾——同 verdict 的 repair+fragment 双行=双证合法共存形态（对账+归因），写面幂等/冲突判定按 kind 分域（跨 kind 同 verdict 合法追加，同 kind 内同 verdict 同目标=幂等、反 verdict/换目标=conflicting-verdict）。写面拒的组合读面手写盘面防御同拒。
5. **低项**：openHandle 成功后 readFile 失败路径也确定性 close（L1）；R6 改写真字段（repairUndecided 进快照对象，旧第二参数被单参函数忽略=假杀点）（L2）；R12 主负例重构=tx2 落 i2 归因裁决（归因面全满足，scopeCovers 独立杀点，不再被归因门遮蔽）（L3）；R16 五路径全接计数句柄+逐次增量断言（写失败面不再豁免计数）（L4）。

崩溃矩阵扩为 R1a/R1b/R2-R20（TEST-MAP r4 节权威）。
## 10. r5 冷热一致+授权执行分层（GPT r4 审 71 NO-GO 修复批；2026-10-08）

r4 被审出三红二黄。核心是 P1-r4-1 的**冷热一致性**与 P1-r4-3 的**授权/执行分层**——本节为权威补丁，覆盖 §9 第 1 条的相应语义：

1. **无源分支保守化（P1-r4-1）**：scopeCovers 无残片源（need 空：热路径修复后残片已移除/冷捕获丢 fragments/G2 消耗）不再「有任意授权即覆盖」——改为**归因全覆盖**：repairLog 全部事务均有本意图同向 fragment 裁决（同四元组+kind+intentId）才放行。修补的缝：同 sha 双事务各归因一意图时，冷捕获（丢 fragments）反而比热路径宽——两态统一收窄。G2 消耗时残片内容 sha 补入 unknownShas 源追踪（第二缝）：G2 归因的新残片 sha 无事务映射→覆盖判定失败→旧事务 fragment 授权不越新来源。
2. **写面组一致性前移（P1-r4-2）**：候选加入后统一二维判定（candVerdicts=priors 全部 verdict+本次>1 拒；candTargets=fragment 目标集+本次>1 拒，**不限定请求 kind**）先于 kind 内幂等——修补的缝：repair abandon 在场+fragment resend 请求曾被落行→读面整组剔除→写工具自造矛盾组锁死恢复。
3. **授权/执行分层（P1-r4-3）**：resumable 回退排除在途 sending（删 r4 的授权链放宽——旧 resend 授权不自动覆盖之后的完整 sending，无代次/尝试界限时执行静止未证）；RecoverReport 新增 **resendAuthorized**（授权证明面=通过作用域覆盖判定的 resend 授权意图，含在途 sending）——宿主（P0-3 接线）据此呈现/操作，不自动重发。授权≠执行资格。
4. **安全整数（P2-r4-1）**：len 校验 Number.isInteger→**isSafeInteger** 六处（repair-tail 117/138/139、adjudicate-journal 95、evidence-migration 112、recovery-evidence-source 209/342）——2^53 被 isInteger 接收但精度失真。
5. **测试真杀点（P2-r4-2）**：R6 加 undecided 干净盘面成对断言（旧阻力来自未裁事务非本门）；R12-G2 对账先行（adjRepair+adjFrag 齐）独立断言归因门（旧形被 repairShadow 遮蔽）；R16 写失败/读失败真形（真事务过身份门后 append 抛/readFile 抛——旧形 at=1999 在盘面门就拒，写失败从未到达）；新增 R21（冷热差分成对）/R22（G2 补源）/R23（写面交叉矩阵四形）/R24（锚安全整数边界）。

崩溃矩阵扩为 R1a/R1b/R2-R24（TEST-MAP r5 节权威）。

## 11. r6 执行面影响域+abandon 方向分离（GPT r5 审 76 NO-GO 修复批；2026-10-08）

r5 被审出两 P1。核心是**安全方向的显式分离**与**执行面影响域**——本节为权威补丁，修订 §10 第 1/3 条的相应语义：

1. **执行面影响域（P1-r5-1）**：resumable 执行资格判定加事务归因影响域（txImpacted=fragment resend 裁决归因意图集）：意图在 unknown 集**或**影响域中，均须 resendCovers 授权才可重发。修补的缝：冷捕获丢残片后 enqueue-only 盘面 unknown 为空，短路跳过覆盖判定→冷比热宽。语义锚点：事务的 fragment 裁决归因到某意图=该事务移除的尾段效果与该意图关联——enqueue-only 的「证据缺失」不等于「效果安全」（尾段可能含其 sending）。事务无关的 enqueue（无任何归因）不受影响。
2. **abandon 方向分离（P1-r5-2）**：scopeCovers 按 kind 分向——resend（正向授权）：无法证明来源=保守拒（无源须全事务归因覆盖，§10 语义保持）；abandon（负向排除）：终局证据，have 在场即排除，不做无源全覆盖。方向论证：排除谓词变 false 的后果=意图可重发=激进；「无法证明授权」=保守拒与「撤销已证排除」=激进不是同一件事，不能共享布尔谓词。无关事务加入不得复活已放弃意图（增量不变式）。
3. **杀点归位（P2-r5-1）**：R17 无映射门的独立杀点移到 resendAuthorized 面（!r.sending 执行门使 resumable 断言阻力漂移）；R12-G2 补错 raw 归因负例（G2 消耗的 raw 全等门独立可杀）。
4. **注释对齐（P2-r5-2）**：写面头注与 r4 双证语义同步；isSafeInteger 七落点计数勘误。

崩溃矩阵扩为 R1a/R1b/R2-R26（TEST-MAP r6 节权威）。

## 12. r7 结构归因留痕（GPT r6 审 83 NO-GO 修复批；2026-10-08）

r6 被审出 P1-r6-1：**热态结构归因到持久裁决目标集之外的意图，冷捕获后绕过覆盖判定**。受信宿主提交与残片顶层身份不一致的归因（结构 i1/裁决 i2）时，冷态丢 raw→i1 不在 unknown/txImpacted/abandonKeys 任何集→enqueue-only 放行=冷比热宽。§11 第 1 条「事务无关的 enqueue（无任何归因）不受影响」的边界勘误：**「无持久归因」不等于「事务无关」**——结构归因证据（残片顶层身份）在冷态失忆后，持久面必须有等价信息，否则影响域不完备。本节为权威补丁：

1. **结构归因留痕（生成面）**：repair 行新增可选字段 `fragIntentId`（字段序最尾——旧形态行=新形态行的严格前缀，崩溃部分行残局的前缀判定跨版本兼容）。repair-tail 修复时对移除尾段做受限结构扫描（scanTopLevelIntentId）：顶层唯一身份可证→记该 id；none/conflict→显式 null；marker 补完路径（尾段已物理消失）诚实 null。schema：缺省（存量行）/null/非空 string 合法，其余拒。
2. **写面结构一致门（P1-r6-1 主闭合）**：fragment 裁决请求的归因目标与 repair 行 fragIntentId 强一致——不一致→`inconsistent-attribution` 拒落盘（零追加）。矛盾裁决（结构 i1/归因 i2）自 r7 起不可能持久化。fragIntentId 缺省（存量）/null（不可归因/补完）无结构证据→不强一致，人工归因自由（读面未归因事务阻断门兜底：事务无任何 fragment 裁决→repairShadow 阻断，§9 双证语义）。
3. **读面影响域并入（存量防御）**：txImpacted 并入 repair 行 fragIntentId（有效值）——一致门生效前已落库的 S5 形（结构留痕 i1+裁决目标 i2）在冷态不再失忆：i1 并入影响域→须 resendCovers→归因不含 i1→排除。存量行（无字段）不并入：其归因裁决缺失时由未归因事务阻断门兜底；归因在场时（r1-r6 全部测试形态）行为不变。
4. **不变式保持**：无关 enqueue 正对照不受影响（R28 的 i3）——影响域并入不是无差别封禁；热态行为零变化（残片在场时结构归因经 unknown 已入覆盖判定）；一致归因+全覆盖→授权成立且可重发（缝的修复=让覆盖判定拿到全部证据，不是阻断重发）。

崩溃矩阵扩为 R1a/R1b/R2-R28+RT-r7-1/2/3（TEST-MAP r7 节权威）。注释债清理：测试头注 R1-R10→R1-R28 全谱、describe 标题、R20/R12 杀点注释与现行断言对齐（P2-r6-1）。
