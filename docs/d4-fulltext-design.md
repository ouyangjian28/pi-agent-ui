# D4 双源归并读面：全文/思考/工具调用补全设计稿 v4

状态：v4 草案（吸收 v3 复审 80/100 NO-GO 全部 P1-1+P2-1..5+P3 建议；待复评≥85 冻结契约）
日期：2026-10-10（v1 74→v2 74→v3 80→v4；三轮审源见 audits/）
前置：D3 全链已合（d0c87d3）；迁移就绪里程碑 M-D4。
审源：audits/ds-d4-design-review{,-v2,-v3}-2026-10-10.md。

## 0. v4 变更摘要（对 v3 复审的裁决）

| 审项 | v3 缺陷 | v4 裁决 |
|---|---|---|
| P1-1 | §4.1a 无条件含 thinking 块+§4.4 仅前端折叠 vs §2/§4.5「不改变 D1 姿态/零行为变更」直接矛盾 | **裁 (a) 同开关**：entry 帧 thinking 块与事件面 hasThinking 均挂同一 thinkingVisible 门；门关=帧内无 thinking 块+事件不置 hasThinking（存在性不泄露）→零行为变更真成立，免拍板（§4.1a/§4.5） |
| P2-1 | oversized 双信号（state+4414 并存）；块级 4096 字符×24 块≈295KB≫32_768B→中文多块条目必然全丢 | **全局字节预算按序装块**（装到预算尽：被截块记 truncatedAt、其后块省略并计数→恒落 truncated 可展示）；**oversized 出口唯一化=4414 reason**（成功帧只余 ok/truncated 两态） |
| P2-2 | 4414 无 reason 载体（error 帧形状无 reason 字段） | error 帧加 `reason?:` 六值枚举，入契约形状+docs 矩阵；**同步面=四处码表+形状+errorTextFor 文案（共六处）** |
| P2-3 | 「触顶不关订阅」与现码 overBudget⇒closeSubscriptionsFor 相反 | 触顶=**既有流废弃（订阅已关，与现状一致）**；4414 index-evicted 仅对旧 entryId 的在飞/迟到请求；不复活流 |
| P2-4 | readLineAt raw 含不含 \n 未定→判据③可能 100% 不命中 | 钉死：raw=行内容**不含**终止 \n；\n 仅判据②行界用（与扫描期切分同口径） |
| P2-5 | 「第 5 个→4414」落点未写（通用在途门先发 4404） | 通用在途门内**按 frame.t 分流**：entry-get 重复/超限→entryErrFrame(4414)；余帧类维持 4404 出口不变 |
| P3-1..7 | 行号残留 3 处/终局清 map/retryable 分档/文案映射/仅 session 源/stats 口径/解耦表述 | 全部落（见 §4 各节+§6 行号索引勘误） |

## 1. 问题（日用最大缺口）

- 历史面 session 投影只发 `textPreview`（`SESSION_PREVIEW_LIMIT=200` 代码单元，session-projection.ts:31）——正文一旦移交历史区就从直播全文塌缩成 200 字预览（session-detail.tsx HistoryRow 单行渲染 `preview.text…`）。
- thinking 块在历史投影整体丢弃（session-projection.ts:105）；直播面 thinking 缺省不透（live-aggregator.ts:25,129 thinkingVisible 默认 false）——刷新后思考内容永久不可见。
- toolCall 块只投影 `toolCallId`（session-projection.ts:104，无工具名/参数摘要）——历史区无法分辨「调了什么」。
- 直播→历史交接无 entryId 锚（message-final 无身份，contracts.ts:187；live-stream.tsx 靠「历史出现 assistant 行」启发式清缓冲）。

## 2. 目标 / 非目标

目标：
1. 历史区可展开看全文（含 thinking 段（门开时）、toolCall 名称+参数摘要、toolResult 摘要）。
2. 帧大小有界（含 entry 响应帧自身）且截断诚实可消费——**任何可读条目恒有可见内容**（全局预算分配保证），大会话不拖垮订阅面。
3. 直播→历史交接可精确锚定（同一 assistant 条目不双显）。
4. 姿态继承：D4 读面不改变 D1 冻结的安全姿态——**thinking 与 thinkingVisible 同开关（协议默认关+部署默认也关=零行为变更）**；system 不外泄。

非目标：改 journal 行型；改 pi 会话文件格式（只读投影）；把全文塞进常规事件流（§3 否决案）；权限模型变更。

## 3. 决策空间（v3 版维持）

既有机制事实：装页器已有**整帧预算贪心收缩**——subscription-engine.ts:202-245 逐条装页、每步 `estimateFrameBytes` 实测整帧、超 `pageFrameBudgetBytes=200_000`（contracts.ts:18）退末条换页；单帧硬顶 `frameMaxBytes=262_144`（contracts.ts:14）。故「事件变大→帧爆炸」不成立：帧有界恒成立，真实代价是**页变小、往返变多**。

| 案 | 做法 | 真实代价/优点 | 结论 |
|---|---|---|---|
| A 抬预览上限（200→8K） | 一行改动 | ①同会话不同页预览长度不一致（预算收缩=口径分裂）；②全文 40KB 条目需多页往返却全程背 8K 预览；③journal 面 HISTORY_PREVIEW_LIMIT（history-projection.ts:15）不同步=双源分裂，同步=帧同膨胀。优点：零新协议面。 | 否决 |
| A′ 抬上限+装页自适应 | 机制已有=等价 A | 同 A。 | 否决（并入 A） |
| **B 按需取全文（推荐）** | 新增 `entry-get` 读路径：点「展开」→`{t:"entry-get",requestId,file,entryId}`→薄索引定位行→offset 读→同一解析器→回投影同形块 | 代价：一次往返+行游标失效处理（§4.3）。优点：读路径基建 90% 已在；权限面沿用订阅校验。 | **采纳** |
| C 全文内联限长（N KB） | 预览抬到 N KB | 两套路径=口径分裂；N 无原理；内联量随分页窗口漂移。 | 否决 |
| E 快照前 N 条全文+其余按需 | 快照期前 N 条内联 | N 无原理；快照预算被独占=深会话首屏更瘦；快照/续页两口径。 | 否决 |
| F 回 raw 行给前端 | 原样回行 JSON | raw 外泄面+前端第二套解析器。 | 否决 |

## 4. 推荐案细节（B 案）

### 4.1 契约

请求（ClientFrame 变体）：`{t:"entry-get", requestId, file, entryId}`——file=逻辑名（订阅口径；网关归一方向=logical，服务端 sessionFor 反解，与 D3 修复同族方向对）。**entry-get 仅接受 session 源条目**（journal 投影今日不产 message 条目——无展开面；journal 文件上的 entry-get=4414 unknown-entry）。

响应（ServerFrame 变体）：`{t:"entry", requestId, entryId, source:"session", digest, state:"ok"|"truncated", blocks, stopReason?, rawBytes?, totalBlockCount?}`——成功帧**只余 ok/truncated 两态**（oversized 归错误面，见 §4.3）。

**4.1a blocks 形状与产出路径**

- 白名单四形：`{kind:"text", text, truncatedAt?}` / `{kind:"thinking", text, truncatedAt?}`（thinkingSignature 永不投；**thinking 块仅在 thinkingVisible 门开时出现**——§4.5）/ `{kind:"toolCall", toolCallId, toolName, argsPreview, argsTruncated?}` / `{kind:"attachment", attachmentId}`（attachmentIdOfBlock 派生，session-projection.ts:74；不回 pi 原始 image/base64/path/url）。
- **独立全文块投影器 `entryBlocksOf`**（新函数，落 session-projection.ts 同文件）：输入=**parseMessageLine 已校验行的全量 content**（同文件内私有通道直传——全量 content 不入 MessageEntry、不进任何导出面；行 schema 校验、身份判定（entryId/role/bad-shape）、digest 全部只在共享路径发生一次），输出=全文块四形。它**不是**「宽松版解析器」而是**同一解析结果的另一投影面**——只做投影+净化（§4.5 denylist），不重新校验、不放宽任何域。
- **共享面改动口径（措辞修正）**：`Block` 导出类型与 `blocksOf` 的**调用点（唯一=parseMessageLine:137）与导出面不变**；文件内私有改动两处——blocksOf 的 thinking 分支从 `continue` 改为 `thinkingCount++` 后 continue（行为等价）+`MessageEntry`（未导出、瞬态，全仓外部零引用）增可选 `stats?: {blockCount, thinkingCount}`。`blockCount`=**可见块数**（text+toolCall+attachment，不含 thinking）；现有消费者不读 stats=零外部 ripple；fixtures 增量补充。
- **事件面字段派生（门控+口径钉死）**：历史 message 事件 `hasThinking` **仅门开时置 true**（门关=不置/false——存在性不泄露）；`blockCount`=可见块数（与 totalBlockCount 同口径）；两字段均取自 scan 时 stats，事件面与展开面同源同值。

**4.1b 字节预算与截断（全局预算分配版）**

- **执行点（新建门，如实声明）**：entry 装帧处（网关 entry-get 应答路径内）——`estimateFrameBytes`（contracts.ts:342-344）实测。v3 起如实声明：`singleEventBytes=32_768`（contracts.ts:19）此前全仓无出站执行点（仅定义+estimateHistoryEventBytes 异常回退常数 :348）；entry 帧预算=**新建执行点**，上限=singleEventBytes。
- **全局字节预算按序装块（收敛规则闭环）**：预算=32_768 减帧信封开销（预留 2_048，块内容可用≈30_720B）——按块顺序装入：整块放得下→原样；放不下且非空→截到剩余预算（UTF-8 字节安全切片+`truncatedAt` 记块内字节码位）；其后块**省略并计数**。结果**恒落 truncated**（可读条目必有可见内容）；`argsPreview` 单独限 512 字符（截断置 `argsTruncated:true`，计入同一预算）。**oversized 不再是成功帧态**——仅存在于错误面（4414 reason=oversized：行硬读限/索引换代等读级失败，blocks 不回）。
- `truncatedAt` 在块级；顶层 `rawBytes`（原行字节数）+`totalBlockCount`（**可见块总口径**，与事件 blockCount 同式）——UI 可显示「已截断·原文 X KB·Y 块」。截断只影响展示不影响身份（digest 仍对全行）。
- **行硬读限=1 MiB**（transportMaxPayloadBytes 同值，contracts.ts:16；另 connQueueBytes=1_048_576 同值 contracts.ts:21-22——均为 1MiB 上界族）：readLineAt 读窗超此=4414 reason=oversized，不重读。
- **单帧量级解耦（表述修正）**：entry 帧 ≤32_768B，单帧量级不构成 ConnectionQueue 压力；但 entry 帧与所有出站帧同经队列（ws-gateway.ts:1426-1432），积压溢出时任何帧类（含 entry）都可能被 4431 关连接裁掉——与帧类无关，属连接级背压。

**4.1c digest 与 ts**

- digest=scanDigest 派生 `fnv1a64:fnv1a64Hex(JSON.stringify([source,locator,raw]))`（read-index.ts:41-43 现算现存索引 :72，零新增摘要算法）。客户端**不比对**；一致性锚=只对已订阅流内 entryId 发起（binding.streamId 锚，subscribe-client.ts:841-854）；服务端独占失效判据（§4.2 三判据+索引换代）。**用途**：仅诊断日志/UI「内容指纹」显示；**禁作渲染缓存键**。
- ts 三件：session 源 entry/事件 ts=行级 timestamp→epoch ms（ISO 解析失败回退 null 不抛）；同一行多事件共享行级 ts；journal 源 ts=null 保持（**不对称写入契约**：历史投影两文件头部声明同步改——session-projection.ts:19/history-projection.ts:7 现声明位）。
- **源可辨**：entry 帧恒 `source:"session"`（§4.1 仅 session 源）；不变量「`kind:"message"` ⟺ session 源」维持网关校验+测试断言。

### 4.2 服务端定位与读取

**薄索引归属 ReadIndex**：`ReadIndex` 内部维护 `entryId → {source, locator, digest, event}` 映射（append 时顺手登记；键=(file,source,entryId)，首见为准——session-projection.ts:176 去重口径；entryId 来源=行 id :137）。天然覆盖三处 append 调用点（ws-gateway.ts:812 首扫/:853 replace/:921 增量追加）+continueFrom 复调（read-index.ts:113）+syncIndex 三路装载——无需改调用点。索引持有 locator+digest+**事件投影**（非 raw 行）。

**触顶语义（与现码对齐）**：`maxEventsPerStream=20_000`（read-index.ts:49）触顶→overBudget=**既有流废弃**（closeSubscriptionsFor(file,"index-over-budget")，ws-gateway.ts:814/841/855/916/930/1223——订阅已关、快照从未下发，与现状一致，不新增语义）；对**仍持旧 entryId 的在飞/迟到 entry-get**→4414 reason=index-evicted；不复活流、不续读、不复用。

**entryId 粒度=整行**：同一行可产多事件（消息本体+每个 toolCall 块，session-projection.ts:274-291 共享同一 entryId 与 locator）——entry-get 按 entryId 命中**整行**，回该行全部块；UI 子行共用同一 entryId 请求+按 entryId 缓存展开态。`corrupt-*`/`unknown-line` 条目**登记时跳过**（同 system 排除口径）→请求未登记 entryId=4414 reason=unknown-entry（不回空 blocks）。

**offset 读器（新建）**：readBounded 仅顺序读（safe-open.ts:111-115）；句柄本带定位参数（BoundedReadHandle.read(buffer,offset,length,position)，safe-open.ts:107）→新增 `readLineAt(fh, offset, maxBytes, file)` 定点读=加函数不改架构。**raw 契约**：raw=行内容**不含**终止 `\n`（与扫描期按 \n 切分同口径——`offset += Buffer.byteLength(raw,"utf8")+1` 累加，\n 只计位不入串）；`\n` 仅用于判据②行界。**三条命中判据**（缺一=不命中→4414 reason=stale）：
1. `offset===0` 或前一字节（position:offset-1 读 1 字节）===0x0A（行首判定——否则是重写后中段残片）；
2. 读窗内行以 \n 结束（撕裂尾拒——口径=session-projection.ts:196-199）；
3. 同解码纪律（TextDecoder fatal:true, ignoreBOM:true，history-source.ts:73-90）还原 raw（**不含 \n**）后，scanDigest 派生值===索引值（字节级身份对账）。

读取链：索引命中→readLineAt（≤1 MiB）→parseMessageLine 共享校验→entryBlocksOf 投影+净化（§4.5）→预算装帧（§4.1b）。

### 4.3 错误码与在途路由

- **新码 4414**（entry-get 请求级专用；不复用 4409——既有语义绑定 pending.kind 路由+流通局 resync（subscribe-client.ts:958-975）；不复用 4413——语义为会话身份损坏）。**同步面六处**：①contracts.ts:55 ErrorCode 联合；②error 帧**形状加 `reason?:` 字段**（六值枚举 stale/unknown-entry/oversized/index-evicted/not-subscribed/in-flight，contracts.ts:320 形状区）；③docs/ws-ui-contracts-v1.md 错误矩阵（码+reason+retryable 档位）；④⑤⑥客户端三处闭码表（subscribe-client.ts:164 KNOWN_ERROR_CODES、ws-client.ts:83、write-client.ts:148）+errorTextFor 文案映射（subscribe-client.ts:504-516，第五处同步面——「内容获取失败」族文案）。**漏任一处=parseError 整帧丢弃 UI 永挂**（subscribe-client.ts:361）——测试断言钉死全表同含 4414。
- **retryable 按 reason 分档**：stale/in-flight=true（瞬态可重试）；unknown-entry/not-subscribed/oversized/index-evicted=false（重试无意义）。
- **网关新出口 `entryErrFrame`**：enqueue error 帧（code:4414, reason, retryable, requestId）——**不入 errFrame**（后者签名仅 4401|4402|4403|4404|4405 且 4404 无条件计数 3→close 1002，ws-gateway.ts:572-580）；不计数、不绑订阅、不 close。
- **在途门分流（落点落字）**：通用在途门在 dispatch 之前（ws-gateway.ts:392-397）——门内**按 frame.t 分流**：`t==="entry-get"` 的重复 requestId/超限（第 5 个）→entryErrFrame(4414, reason=in-flight)，**不走 4404 出口**；其余帧类维持既有 4404 出口不变。未订阅 file 上 entry-get→4414 reason=not-subscribed（不走 4404 越界口径）。entry 族错误**永不过 4404 计数器**：连点 5 次+3 次错误=零断连。
- **客户端路由**：独立 keyed map `entryRequests: Map<requestId, {entryId, resolve, timer}>`（同 uiRequests 模式 subscribe-client.ts:798-815）——**不落单槽 pending**（:839 不匹配即丢帧）；同 entryId 二次点击=复用在途 Promise（合流）；**10s 超时兜底**→按钮复位+「内容获取超时，稍后重试」文案（闭 v1 P3-2）；**终局清理**：handleStreamTerminal（subscribe-client.ts:1000-1005，与 pending/binding/retiredSubs 同址）同步清 entryRequests（在途全 resolve 超时态）。4414 到达：requestId∈map→resolve 错误态并清；∉map（迟到/已超时）→静默丢+审计一行。handleError 顶部按 `code===4414` 前置分流（现无关联 requestId 的 error 帧落「安全忽略」兜底 :989，不误伤订阅）。**任何 entry 帧不触碰订阅状态机**。
- 路径解析：file→abs 走 sessionFor 映射；不中（journal-only/未知）→4414 reason=unknown-entry（§4.1 仅 session 源）；文件不可读=4414 reason=stale（读面失败归 entry 族）。

### 4.4 事件面最小增量+渲染（K3 前端批）

- 历史 `message` 事件补 `hasThinking`（**仅门开时置 true**）+`blockCount`（可见块数）（取自 stats，session-projection.ts:268-288 增两字段；快照/续页同源）——前端据此+`textPreview.truncated` 显示「展开」按钮。
- HistoryRow 预览行尾「展开」按钮→entry-get→展开态渲染 blocks（thinking 折叠区默认关，与直播面同款交互——门开时才有 thinking 块）；toolCall 行显示 toolName+argsPreview；truncated 态显示「已截断·原文 X KB·Y 块」+不可再放大（rawBytes/totalBlockCount 可消费）。

### 4.5 安全面

- **姿态继承（P1-1 裁决=同开关）**：D1 冻结「只透 assistant 正文（system 不外泄）；thinking 缺省不透（opts 开关）」（contracts.ts:181-182）。D4 全面对齐：**entry 帧 thinking 块与事件面 hasThinking 均挂同一 thinkingVisible 开关**（live-aggregator.ts:25,129 既有 opts；协议默认关+部署默认也关）——门关时：entry 帧无 thinking 块、事件不置 hasThinking（**存在性不泄露**）、totalBlockCount/blockCount 按可见块口径（thinking 不计数）→**零行为变更真成立**，免拍板；REQ 落决策行。system 条目索引登记时跳过（请求已登记 system entryId=4414 unknown-entry）。
- 权限：entry-get 校验=与 subscribe 同面（token+file 订阅权）。
- **净化（两路）**：sanitizeText 不承诺自然语言秘密识别（sanitizer.ts:3）——①argsPreview 在 JSON.stringify(arguments) **前按键走结构化 denylist**：键名（含嵌套）匹配 `token|secret|password|passwd|key|authorization|cookie|credential`（不区分大小写）→值替换 `[redacted]`；②**toolResult 正文=纯文本无键名**→只 sanitizeText+展开区常驻风险提示头部。
- 审计：entry-get 不写 journal、不触 writerEpoch（纯读面）；审计行 `entry-get file=… id=… state=ok|truncated|err:4414/<reason>`。

## 5. 测试计划

- W-d4-s*（单测·读面）：readLineAt 三判据（行首/行尾/**raw 不含 \n** 各正反例——判据③含 \n 变体必红）；索引登记/首见为准/触顶=index-evicted（旧 entryId 迟到请求）；system/corrupt/unknown 排除；**thinking 门控两态**（门关⇒entry 帧无 thinking 块+事件不置 hasThinking+blockCount 可见口径；门开⇒帧含 thinking 块）；denylist（嵌套键+大小写+toolResult 纯文本路）；ts 回退 null；stats 计数同源；预算装帧（ok/全局分配截断/多块中文条目恒 truncated 有内容/argsPreview 512）。
- W-d4-g*（网关）：帧形状/权限/not-subscribed/在途分流（entry-get 第 5 个+重复=4414，余帧类 4404 不变）/**entry 错误×5 不断连**/streamId 锚/源可辨/**六处同步面同含 4414 断言**。
- W-d4-c*（客户端）：keyed map 独立槽（订阅 init 在飞时 entry-get 不覆盖 pending）；同 entryId 合流；10s 超时+按钮复位；迟到 4414/entry 帧静默丢；**终局/resync 瞬间清 entryRequests（在飞 resolve 超时态，不残留 map）**。
- E2E（E-d4-1）：FakeRpcHost 落长文+thinking+toolCall 条目→订阅→entry.get→断言两态+blocks 同形；**直播-历史交错**（同 entryId 不双显）。
- 变异面：索引登记死→unknown-entry；三判据逐条死→红（残片当正文=最险；raw 带 \n 变体→判据③恒不中=全 stale 红）；denylist 死→token 外泄红；**门控死（门关仍回 thinking）→红**；在途分流死（entry 误走 4404）→五次错误断连红；六处码表漏一处→对应客户端 parseError 拒帧红。

## 6. 事实核验附录（2026-10-10；正文即真值；v4 勘误=v3 报 P3-1 三处已回灌）

- message 行=`{id, message:{content, role, sections, timestamp, toolsAdded}, parentId, timestamp, type:"message"}`——行级 timestamp 存在→ts 升级依据。toolCall 块=`{type, id, name, arguments:dict}`。thinking 块=`{type, thinking, thinkingSignature}`。行型全集：message/custom/custom_message/model_change/session/thinking_level_change。
- 关键行号索引（v4 全部重核）：contracts.ts:14 frameMaxBytes=262_144/:16 transportMaxPayloadBytes=1_048_576/:18 pageFrameBudgetBytes=200_000/:19 singleEventBytes=32_768/:21-22 connQueueBytes=1_048_576/:25 inFlightRequestsPerConn=4/:55 ErrorCode/:181-182 D1 冻结/:320 error 帧形状/:342-344 estimateFrameBytes；session-projection.ts:31 预览限/:74 attachmentIdOfBlock/:95-107 blocksOf/:104/:105/:114-135 parseMessageLine/:137/:176 首见去重/**:19 ts 现声明位**/:196-199 撕裂/:268-288 事件投影/:274-291 同行多事件；history-projection.ts:7 ts 现声明位；read-index.ts:41-43/:49/:72/:113/:123-124；subscription-engine.ts:202-245/:239-245；safe-open.ts:107/:111-115；history-source.ts:73-90；live-aggregator.ts:25,129/:165,173 thinking 门；ws-gateway.ts:347/:392-397 在途门/:572-580 errFrame/**:814,841,855,916,930,1223 overBudget 关订阅**/:812,853,921 append/:1426-1432；subscribe-client.ts:164/:361/:504-516 errorTextFor/:523/:798-815/:839 requestId 不匹配丢帧/:841-854 binding 锚/:958-975/:989 安全忽略兜底/:1000-1005 终局清理；dual-history-source.ts:155-161。

## 7. 开放问题（v4 全收敛）

1. ~~entry-get 限流~~ 服务端复用在途 4 槽+门内分流 4414；客户端 keyed map+合流+10s 超时+终局清理（§4.3）。
2. ~~toolResult 同路~~ 随本批；纯文本路=sanitizeText+风险提示（§4.5）。
3. ~~digest~~ scanDigest 派生+仅诊断+禁渲染缓存键（§4.1c）。
4. ~~ts~~ 随本批+不对称契约+fixture 清点（§4.1c）。
5. ~~thinking 姿态~~（v4 新收敛）与 thinkingVisible 同开关、双默认关、存在性不泄露（§4.1a/§4.5）。
