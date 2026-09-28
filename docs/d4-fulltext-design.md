# D4 双源归并读面：全文/思考/工具调用补全设计稿 v3

状态：v3 草案（吸收 v2 复审 74/100 NO-GO 全部 N-1..N-9+P3 建议；待复评≥85 冻结契约）
日期：2026-10-10（v1 74 NO-GO→v2 重写→v2 复审 74 NO-GO（失败面已换：v1 的 7 P1 闭合 5 项，v2 新接缝 3 P1）→v3）
前置：D3 全链已合（d0c87d3）；迁移就绪里程碑 M-D4。
审源：audits/ds-d4-design-review-2026-10-10.md（v1 审）+ audits/ds-d4-design-review-v2-2026-10-10.md（v2 复审）。

## 0. v3 变更摘要（对 v2 复审的裁决）

| 审项 | v2 缺陷 | v3 裁决 |
|---|---|---|
| N-1 | blocks 四形三字段（thinking 正文/toolName/argsPreview）现有投影产不出，而「另写」被禁 | **独立全文块投影器 entryBlocksOf**：同一 parseMessageLine 产出的另一投影面，非第二解析器（§4.1a）；共享 Block/blocksOf 零改动+stats 计数增字段（ripple 清单落 §4.1a） |
| N-2 | 4409 族复用撞既有 resync/流通局语义；新码不在三处闭码表=静默丢帧 UI 永挂 | **新码 4414**（请求级）+三码表同步+网关新出口 entryErrFrame（不计数/不绑订阅/不 close）+客户端独立 keyed map（§4.3） |
| N-3 | singleEventBytes 全仓零执行点；「截断后仍超」无收敛；行硬读限无数值 | 预算执行点=entry 装帧处（**新建门，如实声明非既有级**）+块级限长后再实测+仍超降级 oversized+行硬读限=1MiB 定值（§4.1b） |
| N-4 | 顶层单 truncatedAt 表达不了多块各截各的 | truncatedAt 落块级+顶层 rawBytes/totalBlockCount（§4.1b） |
| N-5 | §6 勘误未回灌正文+新增两处错引 | 勘误表撤销，正文即真值（本版全文行号已回灌） |
| N-6 | 同行多事件共享 entryId 与「首见为准+整行回」口径未定；corrupt-*/unknown-line 无口径 | 粒度=**整行**（一行一次 entry-get 回全部块，UI 子行共用）；corrupt-*/unknown-line 登记时跳过（同 system 排除）（§4.2） |
| N-7 | 「entry 错误不过 4404 计数」与「未订阅→4404/在途超限→4404」互斥 | entry 族错误**一律 4414 出口**（含未订阅/在途超限），永不过 4404 计数器（§4.3） |
| N-8 | 客户端单槽 pending 不可承载 entry-get；无超时兜底 | 独立 keyed map entryRequests（同 uiRequests 模式）+10s 超时兜底→按钮复位+文案（闭 v1 P3-2）（§4.4） |
| N-9 | 「本仓部署默认开 thinking」=策略放开未拍板 | **撤回**：协议默认关+部署默认也关（零行为变更=免拍板；配置留 opt-in；REQ 落决策行）（§4.5） |
| N-10..12 | digest 用途/两测试断言/触顶语义 | 一句钉死 digest 仅诊断；§5 补两断言；触顶=该流废弃全回 4414（§4.2/§5） |

## 1. 问题（日用最大缺口）

- 历史面 session 投影只发 `textPreview`（`SESSION_PREVIEW_LIMIT=200` 代码单元，session-projection.ts:31）——正文一旦移交历史区就从直播全文塌缩成 200 字预览（session-detail.tsx HistoryRow 单行渲染 `preview.text…`）。
- thinking 块在历史投影整体丢弃（session-projection.ts:105 `t === "thinking" continue`）；直播面 thinking 缺省不透（live-aggregator.ts:25,129 thinkingVisible 默认 false）——刷新后思考内容永久不可见。
- toolCall 块只投影 `toolCallId`（session-projection.ts:104，无工具名/参数摘要）——历史区无法分辨「调了什么」。
- 直播→历史交接无 entryId 锚（message-final 无身份，contracts.ts:187；live-stream.tsx 靠「历史出现 assistant 行」启发式清缓冲）。

## 2. 目标 / 非目标

目标：
1. 历史区可展开看全文（含 thinking 段、toolCall 名称+参数摘要、toolResult 摘要）。
2. 帧大小有界（含 entry 响应帧自身）且**截断诚实可消费**——大会话不拖垮订阅面。
3. 直播→历史交接可精确锚定（同一 assistant 条目不双显）。
4. 姿态继承：D4 读面不改变 D1 冻结的安全姿态（thinking 默认关、system 不外泄）——**协议默认与部署默认同关**。

非目标：改 journal 行型；改 pi 会话文件格式（只读投影）；把全文塞进常规事件流（§3 否决案）；权限模型变更。

## 3. 决策空间（v2 版+勘误回灌）

既有机制事实：装页器已有**整帧预算贪心收缩**——subscription-engine.ts:202-245 逐条装页、每步 `estimateFrameBytes` 实测整帧、超 `pageFrameBudgetBytes=200_000`（contracts.ts:18）退末条换页；单帧硬顶 `frameMaxBytes=262_144`（contracts.ts:14）。故「事件变大→帧爆炸」不成立：帧有界恒成立，真实代价是**页变小、往返变多**。

| 案 | 做法 | 真实代价/优点 | 结论 |
|---|---|---|---|
| A 抬预览上限（200→8K） | 一行改动 | 代价：①同会话不同页预览长度不一致（预算收缩=口径分裂）；②全文 40KB 条目需 O(40KB/200KB)=多页往返，与 B 等往返量却全程背着 8K 预览传输；③journal 面 HISTORY_PREVIEW_LIMIT（history-projection.ts:15）若不同步抬=双源口径分裂，同步抬=journal 帧同膨胀。优点：零新协议面。 | 否决 |
| A′ 抬上限+装页自适应 | A 的机制已有=等价 A | 同 A，无额外收益。 | 否决（并入 A 行） |
| **B 按需取全文（推荐）** | 新增 `entry-get` 读路径：客户端点「展开」→`{t:"entry-get",requestId,file,entryId}`→服务端薄索引定位行→offset 读→同一解析器→回投影同形块 | 代价：一次往返+行游标失效处理（§4.3）。优点：读路径基建 90% 已在（ScanRow.locator/openSafeFile/parseMessageLine/身份校验族）；权限面沿用订阅校验。 | **采纳** |
| C 全文内联限长（N KB，超出走 B） | 预览抬到 N KB | 两套路径=口径分裂；N 无原理；与 A 同族论据复用：前 N 条随分页窗口漂移（装页收缩使「内联量」不稳定）。 | 否决 |
| E 快照前 N 条全文+其余按需 | 快照期前 N 条内联全文 | 同 C 族：N 无原理；快照预算被前 N 条独占=深会话首屏反而更瘦；快照/续页两口径。 | 否决 |
| F 回 raw 行给前端 | 服务端原样回行 JSON | raw 外泄面（pi 会话文件任意字段+本地路径 id/url+base64 图片=带宽炸弹）；前端被迫长出第二套解析器。 | 否决 |

## 4. 推荐案细节（B 案）

### 4.1 契约

请求（ClientFrame 变体）：`{t:"entry-get", requestId, file, entryId}`——file=逻辑名（订阅口径；网关归一方向=logical，服务端 sessionFor 反解，与 D3 修复同族方向对）。

响应（ServerFrame 变体）：`{t:"entry", requestId, entryId, source, digest, state:"ok"|"truncated"|"oversized", blocks?, stopReason?, rawBytes?, totalBlockCount?}`：

**4.1a blocks 形状与产出路径（N-1 裁决）**

- 白名单四形：`{kind:"text", text, truncatedAt?}` / `{kind:"thinking", text, truncatedAt?}`（thinkingSignature 不投）/ `{kind:"toolCall", toolCallId, toolName, argsPreview, argsTruncated?}` / `{kind:"attachment", attachmentId}`（attachmentIdOfBlock 哈希派生，session-projection.ts:60-79 同源；**不回 pi 原始 image/base64/path/url**）。
- **独立全文块投影器 `entryBlocksOf(msg)`**（新函数，落 session-projection.ts 同文件）：输入=**parseMessageLine 已校验的同一 msg 对象**（session-projection.ts:114-135 产出），输出=全文块四形。它**不是**「宽松版解析器」而是**同一解析结果的另一投影面**——行 schema 校验、身份判定（entryId/role/bad-shape）、digest 全部只在共享路径（parseMessageLine）发生一次；entryBlocksOf 只做投影+净化（§4.5 denylist），不重新校验、不放宽任何域。
  - 依据（v3 已核验）：parseMessageLine 的 JSON.parse 保留全量（thinking 正文/toolCall name+arguments 均在 msg.content 内，session-projection.ts:125-135）——丢字段的是共享投影 blocksOf（:105 thinking 直接 continue；:104 toolCall 只留 id），不是解析器。
- **共享面零改动+最小计数增量**：共享 `Block` 类型与 `blocksOf` **不动**；live 路径、textBlocksOf（:152-153）、matchUserIntents（:165-172）零变化。唯一增量=`MessageEntry` 增可选字段 `stats?: {blockCount: number, thinkingCount: number}`——由 blocksOf 同一循环顺手计数（thinking 分支从 `continue` 改为 `thinkingCount++` 后 continue，行为等价），现有消费者不读此字段=零 ripple；fixtures 增量补充。
- **hasThinking/blockCount 事件字段派生路径**（闭 v1 P1-7+v2 N-1 连带）：历史 message 事件的 `hasThinking`/`blockCount` 取自 `entry.stats`（scan 时已计），不从 entryBlocksOf 重算——事件面与展开面同源同值。

**4.1b 字节预算与截断（N-3/N-4 裁决）**

- **执行点（新建门，如实声明）**：entry 装帧处（网关 entry-get 应答路径内）——`estimateFrameBytes`（contracts.ts:342-344）实测序列化整帧。v2 称「纳入既有三级纪律」**失实**：`singleEventBytes=32_768`（contracts.ts:19）此前全仓无出站执行点（仅定义+estimateHistoryEventBytes 异常回退常数 :348）；`frameMaxBytes` 只用于入站校验（ws-gateway.ts:347）；出站既有纪律=装页预算（subscription-engine.ts:224-245）+enqueue 队列字节上限（溢出=close 4431，ws-gateway.ts:1426-1432）。entry 帧预算=**新建执行点**，引用常量 singleEventBytes=32_768 但语义自明为「entry 帧上限」。
- 三态流：装帧→实测 ≤32_768 → `state:"ok"`（blocks 全量）→超限→**块级限长**（每 text/thinking 块截 4_096 字符+`truncatedAt` 记块内截断字节码位；argsPreview 截 512 字符+`argsTruncated:true`；总块数上限 24，超出省略尾部块）→再实测→≤32_768 → `state:"truncated"`；**仍超→降级 `state:"oversized"`**（blocks 省略，4414 reason=oversized，不回内容）——收敛规则闭环（v2 缺）。
- `truncatedAt` 在**块级**（N-4）；顶层补 `rawBytes`（原行字节数）+`totalBlockCount`（限长前总块数）——UI 可显示「已截断·原文 X KB·Y 块」。截断只影响展示不影响身份（digest 仍对全行）。
- **行硬读限=1 MiB**（=transportMaxPayloadBytes，contracts.ts:16，仓内唯一上界参照）：readLineAt 读窗超此=直接 oversized，不重读。
- enqueue 溢出不可能由 entry 帧触发（构造上 ≤32_768 ≪ 队列上限）；4431 仍只留给队列压力——entry 路径与连接终局解耦。

**4.1c digest 与 ts（v2 收敛维持+用途钉死）**

- digest=scanDigest 派生 `fnv1a64:fnv1a64Hex(JSON.stringify([source,locator,raw]))`（read-index.ts:41-43 现算现存索引 :72，零新增摘要算法）。客户端**不比对**；一致性锚=只对已订阅流内 entryId 发起（binding.streamId 锚，subscribe-client.ts:841-854）；服务端独占失效判据（§4.2 三判据+索引换代）。**用途（N-10）**：仅诊断日志/UI「内容指纹」显示；**禁作渲染缓存键**（客户端不得以 digest 判等跳过渲染）。
- ts 三件：session 源 entry/事件 ts=行级 timestamp→epoch ms（ISO 解析失败回退 null 不抛）；同一行多事件共享行级 ts；journal 源 ts=null 保持（**不对称写入契约**：历史投影两文件头部声明「session=epoch ms|null，journal=null」——history-projection.ts:6/session-projection.ts:12 现声明同步改）。

**4.1d 源可辨**：帧带 `source:"session"|"journal"`；不变量「`kind:"message"` ⟺ `source:"session"`」网关校验+测试断言钉死。

### 4.2 服务端定位与读取

**薄索引归属 ReadIndex**：`ReadIndex` 内部维护 `entryId → {source, locator, digest, event}` 映射（append 时顺手登记；键=(file,source,entryId)，首见为准——session-projection.ts:176 去重口径；entryId 来源=行 id :137）。天然覆盖三处 append 调用点（ws-gateway.ts:812 首扫装页/:853 replace 路径/:921 增量追加，皆调 index.append）+continueFrom 复调（read-index.ts:113）+syncIndex 三路装载（:1188 注释）——无需改任何调用点。索引持有 locator+digest+**事件投影**（非 raw 行）；触顶=`maxEventsPerStream=20_000`（read-index.ts:49）→ overBudget=**该流废弃**（:123-124）→ 该流后续 entry-get 一律 4414 reason=index-evicted（不关订阅、不续读、不复用——N-12 对齐）。

**entryId 粒度=整行（N-6）**：同一行可产多事件（消息本体+每个 toolCall 块，session-projection.ts:274-291 共享同一 entryId 与 locator）——entry-get 按 entryId 命中**整行**，回该行全部块（含 toolCall 块）；UI 子行（本体行/toolCall 行）共用同一 entryId 请求+按 entryId 缓存展开态。`corrupt-*`/`unknown-line` 条目**登记时跳过**（同 system 排除口径）→ 请求未登记 entryId=4414 reason=unknown-entry（不得回空 blocks 造成「展开了但什么都没有」）。

**offset 读器（新建）**：readBounded 仅 (fh,maxBytes,file) 顺序读（safe-open.ts:111-115）；句柄本带定位参数（BoundedReadHandle.read(buffer,offset,length,position)，safe-open.ts:107）→ 新增 `readLineAt(fh, offset, maxBytes, file)` 定点读=加函数不改架构。**三条命中判据**（缺一=不命中→4414 reason=stale）：
1. `offset===0` 或前一字节（position:offset-1 读 1 字节）===0x0A（行首判定——否则是重写后中段残片）；
2. 读窗内行以 \n 结束（撕裂尾拒——口径=session-projection.ts:196-199 撕裂行不投影）；
3. 同解码纪律（TextDecoder fatal:true, ignoreBOM:true，history-source.ts:73-90）还原 raw 后，scanDigest 派生值===索引值（字节级身份对账）。

读取链：索引命中→readLineAt（≤1 MiB）→parseMessageLine 共享校验→entryBlocksOf 投影+净化（§4.5）→预算三态装帧（§4.1b）。

### 4.3 错误码与在途路由（N-2/N-7 裁决）

- **新码 4414**（entry-get 请求级专用；不复用 4409——其既有语义绑定 pending.kind∈{page,resync} 且落空即 failSubscription/流通局 resync（subscribe-client.ts:967-975,958-964），与「entry 错误不得升级流通局」直接冲突；不复用 4413——语义为会话身份损坏，混用泥语义）。**同步面四处**：contracts.ts:55 ErrorCode 联合+docs/ws-ui-contracts-v1.md 错误矩阵+客户端三处闭码表（subscribe-client.ts:164 KNOWN_ERROR_CODES、ws-client.ts:83、write-client.ts:148）。**漏一处=parseError 整帧丢弃 UI 永挂**（subscribe-client.ts:361 保守拒绝口径）——测试断言钉死四表同含 4414。
- **网关新出口 `entryErrFrame`**：enqueue error 帧（code:4414, retryable:true, requestId）——**不入 errFrame**（后者签名仅 4401|4402|4403|4404|4405 且 4404 无条件计数 3→close 1002，ws-gateway.ts:572-580）；不计数、不绑订阅、不 close。reason 枚举：stale/unknown-entry/oversized/index-evicted/not-subscribed/in-flight。
- **在途槽（N-7 自洽）**：entry-get 复用连接在途门 4 槽（inFlightRequestsPerConn=4，contracts.ts:25）——**第 5 个→4414 reason=in-flight**（不走 4404 出口 ws-gateway.ts:396）；未订阅 file 上 entry-get→**4414 reason=not-subscribed**（不走 4404 越界出口——修正 v2「未订阅→4404 族」表述）。entry 族错误**永不过 4404 计数器**：连点 5 次+3 次错误=零断连，计数隔离承诺自洽成立。
- **客户端路由（N-8）**：独立 keyed map `entryRequests: Map<requestId, {entryId, resolve, timer}>`（同 uiRequests 模式 subscribe-client.ts:798-815）——**不落单槽 pending**（被 init/page/resync 整体占用且 requestId 不匹配即丢帧 :843-844）；同 entryId 二次点击=复用在途 Promise（天然合流）；**10s 超时兜底**→resolve 超时态+按钮复位+「内容获取超时，稍后重试」文案（闭 v1 P3-2：服务端旧版不支持时按钮不会永挂）。4414 到达：requestId∈map→resolve 错误态并清；requestId∉map（迟到/已超时）→静默丢+审计一行。**任何 entry 帧不触碰订阅状态机**（不置 resync、不 failSubscription）。
- 路径解析：file→abs 走 sessionFor 映射（写面同族）；映射不中→journal-only 降级查询（dual-history-source.ts:155-161）；文件不可读=4414 reason=stale（读面失败归 entry 族，不占用 4402 容量语义）。

### 4.4 事件面最小增量+渲染（K3 前端批）

- 历史 `message` 事件补 `hasThinking:boolean, blockCount:number`（取自 entry.stats，§4.1a；session-projection.ts:268-288 增两字段；快照/续页同源）——前端据此+`textPreview.truncated` 显示「展开」按钮。
- HistoryRow 预览行尾「展开」按钮→entry-get→展开态渲染 blocks（thinking 折叠区默认关，与直播面同款交互）；toolCall 行显示 toolName+argsPreview；truncated 态显示「已截断·原文 X KB」+不可再放大（诚实截断，rawBytes/totalBlockCount 可消费）。

### 4.5 安全面

- **姿态继承（含 N-9 撤回）**：D1 冻结「只透 assistant 正文（system 含系统提示不外泄）；thinking 缺省不透（opts 开关）」（contracts.ts:181-182）。D4 对齐：**协议默认关+部署默认也关**（本仓配置留 opt-in 开关；零行为变更=免用户拍板；REQ 落一行决策记录）；system 条目索引登记时跳过（请求已登记 system entryId=4414 reason=unknown-entry）。
- 权限：entry-get 校验=与 subscribe 同面（token+file 订阅权）。
- **净化（P2-6 两路）**：sanitizeText 不承诺自然语言秘密识别（sanitizer.ts:3 自声明）——①argsPreview 在 JSON.stringify(arguments) **前按键走结构化 denylist**：键名（含嵌套）匹配 `token|secret|password|passwd|key|authorization|cookie|credential`（不区分大小写）→值替换 `[redacted]`；②**toolResult 正文=纯文本无键名**→denylist 零作用，只 sanitizeText+展开区常驻显式风险提示头部（「工具输出可能含敏感内容」）。
- 审计：entry-get 不写 journal、不触 writerEpoch（纯读面，同 ui-answer 声明口径）；审计行 `entry-get file=… id=… state=ok|truncated|oversized|4414:<reason>`。

## 5. 测试计划

- W-d4-s*（单测·读面）：readLineAt 三判据（行首/行尾/身份对账各正反例）；索引登记/首见为准/触顶=index-evicted；system/corrupt/unknown 排除；thinking 开关两态；denylist 净化（嵌套键+大小写+toolResult 纯文本路）；ts 解析回退 null；stats 计数（thinkingCount/blockCount vs entryBlocksOf 同源）；预算三态（ok/truncated 块级截断码位/oversized 收敛：块限长后仍超→降级）。
- W-d4-g*（网关）：帧形状/权限/not-subscribed/在途 4 槽第 5 个=in-flight/**entry 错误×5 不断连（4404 计数隔离）**/streamId 锚校验/源可辨断言/**四码表同含 4414 断言**。
- W-d4-c*（客户端）：keyed map 独立槽（订阅 init 在飞时 entry-get 不覆盖 pending）；同 entryId 合流；10s 超时兜底+按钮复位；迟到 4414/entry 帧静默丢+审计；**订阅终局/resync 瞬间在飞 entry-get→迟到 entry 帧丢弃不置错不残留 map（N-11）**。
- E2E（E-d4-1）：FakeRpcHost 落长文+thinking+toolCall 条目→订阅→entry.get→断言三态+blocks 同形；**直播-历史交错断言**（v1 P3-4：直播缓冲与历史事件同 entryId 不双显）。
- 变异面：索引登记死→unknown-entry；三判据逐条死→红（残片被当正文=最险）；denylist 死→token 值外泄断言红；4404 计数隔离死（entry 错误误入 errFrame）→五次错误后断连=红；entryErrFrame 误用 errFrame 签名=编译红。

## 6. 事实核验附录（2026-10-10；本版=正文即真值，v2 §6 勘误表撤销）

- message 行=`{id, message:{content, role, sections, timestamp, toolsAdded}, parentId, timestamp, type:"message"}`——行级 timestamp 存在（ISO 串；message.timestamp 另有毫秒 epoch）→ session 面 ts 升级依据。
- toolCall 块=`{type, id, name, arguments:dict}`——name+全量参数可用→argsPreview（denylist 后限长）。
- thinking 块=`{type, thinking:string, thinkingSignature}`——正文可用（signature 不外投）。
- 行型全集：message/custom/custom_message/model_change/session/thinking_level_change（session-projection.ts unknown-line 口径一致）。
- 关键行号索引（v3 逐条 sed 核验）：contracts.ts:14 frameMaxBytes=262_144/:18 pageFrameBudgetBytes=200_000/:19 singleEventBytes=32_768/:16 transportMaxPayloadBytes=1_048_576/:25 inFlightRequestsPerConn=4/:55 ErrorCode 闭联合/:181-182 D1 冻结姿态/:342-344 estimateFrameBytes；session-projection.ts:31 预览限/:95-107 blocksOf/:104 toolCall 只留 id/:105 thinking continue/:114-135 parseMessageLine/:137 entryId=行 id/:152-153 textBlocksOf/:165-172 matchUserIntents/:176 首见去重/:196-199 撕裂口径/:268-288 事件投影/:274-291 同行多事件共享 entryId；read-index.ts:41-43 scanDigest/:49 maxEventsPerStream=20_000/:72 索引存 {seq,source,locator,digest,event}/:113 continueFrom/:123-124 overBudget=流废弃；subscription-engine.ts:202-245 装页收缩/:239-245 首条超预算 4431；safe-open.ts:107 BoundedReadHandle.read 带位置参数/:111-115 readBounded 无 offset；history-source.ts:73-90 解码纪律（fatal:true+ignoreBOM:true+撕裂尾拒）；live-aggregator.ts:25,129 thinkingVisible 默认 false；ws-gateway.ts:347 入站 frameMaxBytes/:396 在途门 4404 出口/:572-580 errFrame 闭签名+4404 计数/:812,853,921 三处 index.append/:1426-1432 enqueue 溢出 4431；subscribe-client.ts:164 KNOWN_ERROR_CODES/:361 parseError 闭码表拒绝/:523 pending kind 闭联合/:798-815 uiRequests keyed map 模式/:841-854 binding.streamId 锚/:843-844 requestId 不匹配丢帧/:958-975 4409 语义路由；dual-history-source.ts:155-161 journal-only 降级。

## 7. 开放问题（v3 全收敛）

1. ~~entry-get 限流~~ 裁决：服务端复用在途 4 槽+4414 独立出口；客户端 keyed map+合流+10s 超时（§4.3）。
2. ~~toolResult 同路~~ 裁决：随本批做；纯文本路=sanitizeText+风险提示（§4.5）。
3. ~~digest 语义/用途~~ 裁决：scanDigest 派生+仅诊断+禁渲染缓存键（§4.1c）。
4. ~~ts 升级时序~~ 裁决：随本批+不对称写契约+fixture 清点（§4.1c）。
