# D4 双源归并读面：全文/思考/工具调用补全设计稿 v2

状态：v2 草案（吸收 DS 设计审 74/100 NO-GO 全部 7 P1+8 P2+6 P3；待复评≥85 冻结契约）
日期：2026-10-10（v1 同日被审退回）
前置：D3 全链已合（d0c87d3）；迁移就绪里程碑 M-D4。
审源：audits/ds-d4-design-review-2026-10-10.md（74/100，7 P1/8 P2/6 P3）。

## 0. v2 变更摘要（对 v1 的修正）

| 审项 | v1 错 | v2 裁决 |
|---|---|---|
| P1-1 | A 案「帧膨胀」否决理由失实（装页预算收缩已存在） | A 否决理由重写为真实代价（§3） |
| P1-2 | 决策表缺 A′/E/F | 三案补入决策表（§3） |
| P1-3 | digest=SHA-256(行原文) 双口径矛盾且客户端无对标物 | 复用 scanDigest 派生+客户端不比对改 streamId 锚（§4.1） |
| P1-4 | entry 帧无字节预算 | 三态 ok/truncated/oversized+estimateFrameBytes 实测（§4.1） |
| P1-5 | 定位读基建不存在（readBounded 无 offset） | 新 offset 读器+三条命中判据（§4.2） |
| P1-6 | 默认回 thinking 全文+system 条目=违背 D1 冻结姿态 | thinking=同源开关（默认关）；system 白名单排除（§4.5） |
| P1-7 | 展开入口信号缺失 | message 事件补最小块摘要 hasThinking/blockCount（§4.4） |
| P2-1..8 | 索引归属/触顶/4404 计数/路径解析/源可辨/净化 denylist/ts 三件/投影同形块 | 全部落 §4（逐项标注 P2-N） |

## 1. 问题（日用最大缺口）

- 历史面 session 投影只发 `textPreview`（`SESSION_PREVIEW_LIMIT=200` 代码单元，session-projection.ts:31）——正文一旦移交历史区就从直播全文塌缩成 200 字预览（session-detail.tsx HistoryRow 单行渲染 `preview.text…`）。
- thinking 块在历史投影整体丢弃（session-projection.ts:105 `t === "thinking" continue`）；直播面 thinking 缺省不透（live-aggregator.ts:25,129 thinkingVisible 默认 false）——刷新后思考内容永久不可见。
- toolCall 块只投影 `toolCallId`（session-projection.ts:104，无工具名/参数摘要）——历史区无法分辨「调了什么」。
- 直播→历史交接无 entryId 锚（message-final 无身份，contracts.ts:187；live-stream.tsx 靠「历史出现 assistant 行」启发式清缓冲）。

## 2. 目标 / 非目标

目标：
1. 历史区可展开看全文（含 thinking 段、toolCall 名称+参数摘要、toolResult 摘要）。
2. 帧大小有界（**含 entry 响应帧自身**——v1 缺）——大会话不拖垮订阅面。
3. 直播→历史交接可精确锚定（同一 assistant 条目不双显）。
4. **姿态继承**：D4 读面不改变 D1 冻结的安全姿态（thinking 默认关、system 不外泄）——v1 违背，本版对齐。

非目标：改 journal 行型；改 pi 会话文件格式（只读投影）；把全文塞进常规事件流（§3 否决案）；权限模型变更。

## 3. 决策空间（P1-1/P1-2 修正版）

既有机制事实（v1 未核）：装页器已有**整帧预算贪心收缩**——subscription-engine.ts:202-245 逐条装页、每步 `estimateFrameBytes` 实测整帧、超 `pageFrameBudgetBytes=200_000`（contracts.ts:14）退末条换页；单帧硬顶 `frameMaxBytes=262_144`（contracts.ts:18）。故「事件变大→帧爆炸」不成立：帧有界恒成立，真实代价是**页变小、往返变多**。

| 案 | 做法 | 真实代价/优点 | 结论 |
|---|---|---|---|
| A 抬预览上限（200→8K） | 一行改动 | 代价：①同会话不同页预览长度不一致（预算收缩=口径分裂）；②全文 40KB 条目需 O(40KB/200KB)=多页往返，与 B 等往返量却全程背着 8K 预览传输；③journal 面 HISTORY_PREVIEW_LIMIT（history-projection.ts:15）若不同步抬=双源口径分裂，同步抬=journal 帧同膨胀。优点：零新协议面。 | 否决（理由修正） |
| **A′ 抬上限+装页自适应** | A 的机制已有=等价 A | 同 A，无额外收益。 | 否决（并入 A 行） |
| **B 按需取全文（推荐）** | 新增 `entry.get` 读路径：客户端点「展开」→`{t:"entry-get",requestId,file,entryId}`→服务端薄索引定位行→offset 读→复用解析器→回投影同形块 | 代价：一次往返+行游标失效处理（§4.3）。优点：帧界纪律复用三级预算；读路径基建 90% 已在（ScanRow.locator/openSafeFile/parseMessageLine/身份校验族）；权限面沿用订阅校验。 | **采纳** |
| C 全文内联限长（N KB，超出走 B） | 预览抬到 N KB | 两套路径=口径分裂；N 无原理；**与 A 同族论据直接复用：前 N 条随分页窗口漂移（装页收缩使「内联量」不稳定）**。 | 否决 |
| **E 快照前 N 条全文+其余按需** | 快照期前 N 条内联全文 | 同 C 族：N 无原理；快照预算被前 N 条独占=深会话首屏反而更瘦；快照/续页两口径。 | 否决（补入表） |
| **F 回 raw 行给前端** | 服务端原样回行 JSON | raw 外泄面（pi 会话文件任意字段+本地路径 id/url+base64 图片=带宽炸弹）；前端被迫长出第二套解析器（与「复用同一解析器」纪律冲突）。 | 否决（补入表） |

## 4. 推荐案细节（B 案）

### 4.1 契约（新增两组帧；P1-3/P1-4/P2-7/P2-8 修正）

请求（ClientFrame 变体）：`{t:"entry-get", requestId, file, entryId}`——file=逻辑名（订阅口径；网关归一方向=logical，服务端 sessionFor 反解，与 D3 修复同族方向对）。

响应（ServerFrame 变体）：`{t:"entry", requestId, entryId, source, digest, state:"ok"|"truncated"|"oversized", blocks, stopReason?, truncatedAt?}`：
- **digest 口径（P1-3）**：复用 scanDigest 派生=`fnv1a64:fnv1a64Hex(JSON.stringify([source,locator,raw]))`（read-index.ts:41-43 现算现存索引 ：72，**不新增第二套摘要算法**）。客户端**不比对 digest**（历史事件帧无 digest 字段、无对标物）——一致性锚改 `streamId`：客户端只对**已订阅流**内 entryId 发起 entry-get（binding.streamId 锚已存在 subscribe-client.ts:830-838）；服务端独占失效判据（§4.2 三判据+索引换代）。
- **字节预算三态（P1-4）**：entry 帧纳入既有三级纪律——`estimateFrameBytes` 实测；预算=`singleEventBytes=32_768`（contracts.ts:19）为常规态上限：
  - `state:"ok"`：整帧 ≤ 预算，blocks 全量。
  - `state:"truncated"`：超预算→按块限长（每 text/thinking 块截到块上限+`truncatedAt` 记截断码位；argsPreview 同限），整帧仍 ≤ 预算。**截断只影响展示，不影响身份**（digest 仍对全行）。
  - `state:"oversized"`：超 `frameMaxBytes` 或硬读限（§4.2）→ blocks 省略，显式失败不静默。
  - 先例对齐：首条超整帧预算=4431 关订阅（subscription-engine.ts:239-245）——entry 帧是**应答帧不走关订阅**，但同用 estimateFrameBytes 实测口径。
- **blocks 只回投影同形块（P2-8）**：白名单四形——`{kind:"text",text}`/`{kind:"thinking",text}`（thinkingSignature 不投）/`{kind:"toolCall",toolCallId,toolName,argsPreview}`/`{kind:"attachment",attachmentId}`（attachmentIdOfBlock 哈希派生，session-projection.ts:60-79 同源；**不回 pi 原始 image/base64/path/url**）。
- **ts 三件（P2-7）**：session 源 entry/事件 ts=行级 timestamp→epoch ms（ISO 解析失败回退 null 不抛）；同一行多事件共享行级 ts；journal 源 ts=null 保持（**不对称写入契约**：历史投影两文件头部声明「session=epoch ms|null，journal=null」）。
- **源可辨（P2-5）**：帧带 `source:"session"|"journal"`；不变量「`kind:"message"` ⟺ `source:"session"`」在网关校验+测试断言钉死。

### 4.2 服务端定位与读取（P1-5/P2-1/P2-2 修正）

**薄索引归属 ReadIndex**（P2-1）：v1 放网关=三处 append 调用点（ws-gateway.ts:802/843/911）+continueFrom 复调（read-index.ts:113-120）必漏一处。改为 `ReadIndex` 内部维护 `entryId → {source, locator, digest, event}` 映射（append 时顺手登记；键=(file,source,entryId)，首见为准，与 session-projection.ts:160 entryId 赋值一致）。**表述修正（P2-2）**：索引持有 locator+digest+**事件投影**（非 raw 行）；触顶=maxEventsPerStream 20_000（read-index.ts:45）=索引满→该流 entry-get 回 oversized 族错误（不关订阅），挤出条目 UX 同「超深会话」既有语义。

**offset 读器（新建，readBounded 不够用）**：readBounded 仅 (fh,maxBytes,file) 顺序读（safe-open.ts:111-115）。新增 `readLineAt(fh, offset, maxBytes, file)`：`position:offset` 定点读。**三条命中判据**（缺一=不命中→走 §4.3 失效路径）：
1. `offset===0` **或** 前一字节（offset-1 处读 1 字节）===0x0A（行首判定——否则是重写后中段残片）；
2. 读窗内行以 \n 结束（撕裂尾拒——口径=session-projection.ts:196-199 撕裂行不投影）；
3. 同解码纪律（TextDecoder fatal:true, ignoreBOM:true，history-source.ts:73-90）还原 raw 后，scanDigest 派生值===索引值（字节级身份对账）。

读取链：索引命中→readLineAt→parseMessageLine 全文解析（**同一解析器，不得另写宽松版**——3b2a P1 家族教训）→投影同形块+净化（§4.5）→预算三态装帧。

### 4.3 失效与错误语义（P2-3/P2-4）

- 三判据任一不满足/索引无此 entryId/索引已换代 → `entry-stale` 错误帧（4409 族 resync 语义——前端走既有 resync 路径，不静默拼）。
- **4404 计数隔离（P2-3）**：entry 类错误帧**不得计入** 4404 累计 3→close 1002 门（ws-gateway.ts:576-579）——否则版本偏斜客户端点三次展开=断连。entry-stale/oversized 用独立错误码（4409 族新号），不过 4404 计数器。
- **路径解析（P2-4）**：file→abs 走 sessionFor 映射（写面同族）；映射不中→journal-only 降级查询（dual-history-source.ts:155-161）；分类：索引 stale=entry-stale；文件不可读=4402 族；root 越界=4404 越界口径（复用 ui-answer 跨文件门）。

### 4.4 事件面最小增量（P1-7）+渲染（K3 前端批）

- 历史 `message` 事件补**最小块摘要**：`hasThinking:boolean, blockCount:number`（session-projection.ts:268-288 增两字段；快照/续页同源）——前端据此+`textPreview.truncated` 显示「展开」按钮。**不做** per-kind 计数矩阵（v1 冗余）。
- HistoryRow 预览行尾「展开」按钮 → entry-get → 展开态渲染 blocks（thinking 折叠区默认关，与直播面同款交互）；toolCall 行显示 toolName+argsPreview；truncated 态显示「已截断」+不可再放大（诚实截断）。

### 4.5 安全面（P1-6 裁决+P2-6）

- **姿态继承（P1-6）**：D1 冻结「只透 assistant 正文（system 含系统提示不外泄）；thinking 缺省不透（opts 开关）」（contracts.ts:181-182）。D4 对齐：
  - thinking：entry 读路径**复用同一 opts 开关**（默认关=thinking 块不出现在 entry 帧；部署配置开——本仓个人部署默认开，协议默认关）。刷新后不可见的日用缺口由部署配置解决，不动协议默认。
  - system：entry.get 白名单**排除 role:"system" 条目**（索引登记时跳过；请求已登记 system entryId=entry-stale）。
- 权限：entry-get 校验=与 subscribe 同面（token+file 订阅权）；未订阅 file 上 entry-get→4404 族（跨文件门口径）。
- **净化 denylist（P2-6）**：sanitizeText 不承诺自然语言秘密识别（sanitizer.ts:3 自声明）——argsPreview 在 JSON.stringify(arguments) **前按键走结构化 denylist**：键名（含嵌套）匹配 `token|secret|password|passwd|key|authorization|cookie|credential`（不区分大小写）→值替换 `[redacted]`；toolResult 同路；argsPreview 带 truncated 标志。
- 审计：entry-get 不写 journal、不触 writerEpoch（纯读面，同 ui-answer 声明口径）；审计行 `entry-get file=… id=… state=ok|truncated|oversized|stale`。

## 5. 测试计划

- W-d4-s*（单测·读面）：readLineAt 三判据（行首/行尾/身份对账各正反例）；索引登记/首见为准/触顶；system 排除；thinking 开关两态；denylist 净化（嵌套键+大小写）；ts 解析回退 null；预算三态（ok/truncated 截断码位/oversized）。
- W-d4-g*（网关）：帧形状/权限/跨文件门/4404 计数隔离（entry 错误×3 不断连）/streamId 锚校验/源可辨断言。
- E2E（E-d4-1）：FakeRpcHost 落长文+thinking+toolCall 条目→订阅→entry.get→断言三态+blocks 同形。
- 变异面：索引登记死→entry-stale；三判据逐条死→红（残片被当正文=最险）；denylist 死→token 值外泄断言红；4404 计数隔离死→三次 entry 错误后断连=红。

## 6. 事实核验附录（2026-10-10，真实 pi 会话文件抽样；v2 增审源核验）

- message 行=`{id, message:{content, role, sections, timestamp, toolsAdded}, parentId, timestamp, type:"message"}`——行级 timestamp 存在（ISO 串；message.timestamp 另有毫秒 epoch）→ session 面 ts 升级依据（§4.1 ts 三件）。
- toolCall 块=`{type, id, name, arguments:dict}`——name+全量参数可用→argsPreview（denylist 后限长 200）。
- thinking 块=`{type, thinking:string, thinkingSignature}`——正文可用（signature 不外投）。
- 行型全集：message/custom/custom_message/model_change/session/thinking_level_change（session-projection.ts unknown-line 口径一致）。
- 审源核验（DS 审报告引用行号，本轮逐条抽验属实；三处勘误：read-index/subscription-engine 实位于 packages/protocol/src；ws-gateway append 三点=812/853/921；subscribe-client binding.streamId 锚=843-854）：subscription-engine.ts:202-245 装页收缩/contracts.ts:14,18,19 三级预算/read-index.ts:41-43,45,72 scanDigest+触顶+索引存值（含 event 投影）/safe-open.ts:111-115 readBounded 无 offset/session-projection.ts:196-199 撕裂口径/history-source.ts:73-90 解码纪律（fatal UTF-8+撕裂尾拒）/contracts.ts:181-182 D1 冻结姿态/live-aggregator.ts:25,129 thinkingVisible 默认 false/ws-gateway.ts:576-579 4404 计数门/subscribe-client.ts:843-854 binding.streamId 锚/dual-history-source.ts:155-161 journal-only 降级。

## 7. 开放问题（v2 收敛后剩两项）

1. entry-get 并发/频率限流：v1 倾向不做→**v2 裁决：纳入既有在途槽位与错误计数口径（同 ui-answer 槽族），不单开限流器**。
2. toolResult 同路展开：**v2 裁决：随本批做**（parseMessageLine 已覆盖+denylist 净化到位；单开小批反而重复读面）。
3. ~~digest 语义~~ 已收敛（§4.1：scanDigest 派生+服务端独占判据）。
4. ~~ts 升级时序~~ 已收敛（§4.1：随本批+清点 ts:null 断言+不对称写契约）。
