# D4 双源归并读面：全文/思考/工具调用补全设计稿 v5

状态：v5.1 冻结版（v5 复审 86/100 GO——五轮审链 74→74→80→84→86；本版=v5 收尾批：闭合新 P2（rawBytes 口径）+P3-a..h）
日期：2026-10-10（审源五轮见 audits/）
前置：D3 全链已合（d0c87d3）；迁移就绪里程碑 M-D4。
审源：audits/ds-d4-design-review{,-v2,-v3,-v4}-2026-10-10.md。

## 0. v5 变更摘要（对 v4 复审的裁决）

| 审项 | v4 缺陷 | v5 裁决 |
|---|---|---|
| P2-N1 | 「同一 thinkingVisible 门」无单一真值源、无通往扫描面/entry 面的线；hasThinking 产生位未声明 | **单一真值源=服务端 config `thinkingVisible`（默认 false）**；两条落线：①扫描面=`SessionProjectionInput` 增可选 `thinkingVisible?: boolean`（声明为协议包内部契约变更，加字段不改现有消费者）；②entry 面=同一 config 值传入 entry 读路径。**hasThinking 唯一产生位=session-projection（扫描面）**，门值并入输入（§4.5a） |
| P2-N2 | 预算判原始 UTF-8 字节=静态账；JSON 编码膨胀（换行 1B→2B、控制符 1B→6B）→30_720B 分配最坏 ~186KB，≤32_768B 承诺破 | 改**两段式**：粗估快筛（同 subscription-engine.ts:217 先例）+**终判整帧 estimateFrameBytes 实测**（同 :228-250 终判环）+超限末块再切片重测（编码后字节最终递减、下界=信封）；argsPreview 512 按**编码后字节**计入；上界承诺=终判后帧≤singleEventBytes 恒成立（§4.1b） |
| P2-N1'（v5 复审新） | §4.5b 说 truncated 态不显示 rawBytes，但 §4.1b/§4.4 UI 文案仍写「原文 X KB」→两读并存 | **truncated 帧线上不携带 rawBytes 字段**（wire 级缺席非 UI 隐藏）；文案改「已截断·可见 X KB / Y 块」（§4.1b/§4.4） |
| P3-N3..N13 | 客户端并发上限/索引换代误并 oversized/index-evicted 触发源/两收编面/缓存失效/按钮触发式/rawBytes 口径/1MiB 理由/两断言/四行号/清单编号 | 全落（§4.3/§4.4/§4.5/§5/§6） |

## 1. 问题（日用最大缺口）

- 历史面 session 投影只发 `textPreview`（`SESSION_PREVIEW_LIMIT=200` 代码单元，session-projection.ts:31）——正文一旦移交历史区就从直播全文塌缩成 200 字预览（session-detail.tsx HistoryRow 单行渲染 `preview.text…`）。
- thinking 块在历史投影整体丢弃（session-projection.ts:105）；直播面 thinking 缺省不透（live-aggregator.ts:25,129 thinkingVisible 默认 false）——刷新后思考内容永久不可见。
- toolCall 块只投影 `toolCallId`（session-projection.ts:104，无工具名/参数摘要）——历史区无法分辨「调了什么」。
- 直播→历史交接无 entryId 锚（message-final 无身份，contracts.ts:187；live-stream.tsx 靠「历史出现 assistant 行」启发式清缓冲）。

## 2. 目标 / 非目标

目标：
1. 历史区可展开看全文（含 thinking 段（门开时）、toolCall 名称+参数摘要、toolResult 摘要）。
2. 帧大小有界（含 entry 响应帧自身，**终判实测保证**）且截断诚实可消费——任何可读条目预算尽时恒 truncated、永不因预算 oversized。
3. 直播→历史交接可精确锚定（同一 assistant 条目不双显）。
4. 姿态继承：D4 读面不改变 D1 冻结的安全姿态——thinking 全链与 `thinkingVisible` 同开关（协议默认关+部署默认也关=零行为变更）；system 不外泄。

非目标：改 journal 行型；改 pi 会话文件格式（只读投影）；把全文塞进常规事件流（§3 否决案）；权限模型变更。

## 3. 决策空间（v3 版维持）

既有机制事实：装页器已有**整帧预算贪心收缩**——subscription-engine.ts:202-250 逐条装页、粗估快筛（:217，envelopeOverheadBytes=256 起算）+终判环（:228-250：整帧实测，超 pageFrameBudgetBytes=200_000（contracts.ts:18）退末条重测 :246-249；首条必装仍超=显式失败 :241-245）；同型第二先例=快照帧 projection-frames.ts:26/31（粗估+首条必装失败→显式 null）。单帧硬顶 frameMaxBytes=262_144（contracts.ts:14，仅入站校验 ws-gateway.ts:347）。故「事件变大→帧爆炸」不成立：帧有界恒成立，真实代价是**页变小、往返变多**。

| 案 | 做法 | 真实代价/优点 | 结论 |
|---|---|---|---|
| A 抬预览上限（200→8K） | 一行改动 | ①同会话不同页预览长度不一致；②全文条目多页往返却全程背 8K 预览；③journal 面 HISTORY_PREVIEW_LIMIT（history-projection.ts:15）不同步=双源分裂。优点：零新协议面。 | 否决 |
| A′ 抬上限+装页自适应 | 机制已有=等价 A | 同 A。 | 否决（并入 A） |
| **B 按需取全文（推荐）** | 新增 `entry-get` 读路径：点「展开」→`{t:"entry-get",requestId,file,entryId}`→薄索引定位行→offset 读→同一解析器→回投影同形块 | 代价：一次往返+行游标失效处理（§4.3）。优点：读路径基建 90% 已在；权限面沿用订阅校验。 | **采纳** |
| C 全文内联限长（N KB） | 预览抬到 N KB | 两套路径=口径分裂；N 无原理；内联量随分页窗口漂移。 | 否决 |
| E 快照前 N 条全文+其余按需 | 快照期前 N 条内联 | N 无原理；快照预算被独占；快照/续页两口径。 | 否决 |
| F 回 raw 行给前端 | 原样回行 JSON | raw 外泄面+前端第二套解析器。 | 否决 |

## 4. 推荐案细节（B 案）

### 4.1 契约

请求（ClientFrame 变体）：`{t:"entry-get", requestId, file, entryId}`——file=逻辑名（订阅口径；网关归一方向=logical，服务端 sessionFor 反解）。**entry-get 仅接受 session 源条目**（journal 投影今日不产 message 条目——无展开面；journal 文件上的 entry-get=4414 unknown-entry）。

响应（ServerFrame 变体）：`{t:"entry", requestId, entryId, source:"session", digest, state:"ok"|"truncated", blocks, stopReason?, rawBytes?, totalBlockCount?}`——成功帧只余 ok/truncated 两态（oversized 归错误面 4414）。

**4.1a blocks 形状与产出路径**

- 白名单四形：`{kind:"text", text, truncatedAt?}` / `{kind:"thinking", text, truncatedAt?}`（thinkingSignature 永不投；**thinking 块仅在 thinkingVisible 门开时出现**——§4.5a）/ `{kind:"toolCall", toolCallId, toolName, argsPreview, argsTruncated?}` / `{kind:"attachment", attachmentId}`（attachmentIdOfBlock 派生，session-projection.ts:74；不回 pi 原始 image/base64/path/url）。
- **独立全文块投影器 `entryBlocksOf`**（新函数，落 session-projection.ts 同文件）：输入=**parseMessageLine 已校验行的全量 content**（同文件内私有通道直传——parseMessageLine 多返回一个内部产物；全量 content 不入 MessageEntry、不进任何导出面），输出=全文块四形。它**不是**「宽松版解析器」而是**同一解析结果的另一投影面**——行 schema 校验、身份判定、digest 全部只在共享路径发生一次；只做投影+净化（§4.5）。
- **共享面改动口径**：`Block`（**未导出内部类型**，v5 复审勘正——非导出面）与 `blocksOf` 的**调用点（唯一=parseMessageLine:137）与现有消费面不变**；文件内私有改动两处——blocksOf 的 thinking 分支 `continue` 改为 `thinkingCount++` 后 continue（行为等价）+`MessageEntry`（未导出、瞬态）增可选 `stats?: {blockCount, thinkingCount}`。`blockCount`=**可见块数**（text+toolCall+attachment，不含 thinking）；现有消费者不读 stats=零外部 ripple；fixtures 增量补充。
- **事件面字段派生**：历史 message 事件 `hasThinking`（仅门开且 thinkingCount>0 时置 true）+`blockCount`（可见块数）——**唯一产生位=session-projection（扫描面）**，取自 stats；事件面与展开面同源同值。

**4.1b 字节预算与截断（两段式实测版，P2-N2 裁决）**

- **执行点（新建门，如实声明）**：entry 装帧处（网关 entry-get 应答路径内）。`singleEventBytes=32_768`（contracts.ts:19）此前全仓无出站执行点（仅定义+estimateHistoryEventBytes 异常回退常数 :348）；entry 帧预算=**新建执行点**。
- **两段式预算（同装页器先例 :217/:228-250）**：
  1. **粗估快筛**：按块序装入（信封预留=envelopeOverheadBytes 256+entry 专属开销预留 1_792，块内容可用≈30_720 编码前字节）——整块编码前字节放得下→入；放不下且非空→先按剩余量 UTF-8 安全预截；其后块暂不计入。
  2. **终判整帧实测**：装帧后 `estimateFrameBytes`（contracts.ts:342-344，JSON.stringify→byteLength，**编码后字节**）实测——超 singleEventBytes →对末块再切片（**UTF-8 安全预截**，同粗估段纪律）重测，至收敛；其后块省略并计数。**收敛性**：每轮切片编码后字节最终递减且下界=信封（首刀可能被新写入的 truncatedAt 字段净增 ~15-20B 抵消，非严格递减；最小 entry 骨架实测 ≈306B ≪ 32_768，工程上必收敛）；**基例（照抄先例 :241-245/projection-frames.ts:31）：末块切到空仍超=显式失败（改发 4414 reason=oversized，不走装帧出口）**。**上界承诺：终判后帧 ≤ singleEventBytes 恒成立**（JSON 转义膨胀——换行 1B→2B、控制符 1B→6B——由终判+单调收敛吸收）。
- **结果态**：全部块装得下=`state:"ok"`；预算尽=`state:"truncated"`（被截块记 `truncatedAt` 块内码位、其后块省略计数）——**预算尽时恒 truncated、永不因预算 oversized**。`argsPreview` 限 512 **编码后字节**（截断置 argsTruncated:true，计入同一预算）。
- `truncatedAt` 在块级，口径声明：与既有 `SESSION_PREVIEW_LIMIT` 同为 UTF-16 代码单元切位（非 Unicode 码位——两口径一致，代理对不切断由安全预截保证）；顶层 `rawBytes`（原行字节数，口径见 §4.5）+`totalBlockCount`（可见块总口径）——**rawBytes 仅 ok 态携带；truncated 帧线上不携带 rawBytes 字段**（wire 级缺席，P2-N1' 裁决），UI 文案「已截断·可见 X KB / Y 块」不展示原文规模。截断只影响展示不影响身份（digest 仍对全行）。
- **行硬读限=1 MiB（产品取值）**：readLineAt 读窗超此=4414 reason=oversized，不重读。（依据=本机 session 行长预算——与单帧硬顶 262_144B 为 4× 量级关系、与入站 transportMaxPayloadBytes 同数值但互不借用，均为独立产品取值；>1MiB 行多为内嵌 base64 附件，展开本就只回 attachmentId。）**oversized 仅此一因+末块切空仍超一因**（读级/装帧级失败；「索引换代」归 stale/index-evicted——P3-N4 裁决）。
- **单帧量级解耦（表述修正）**：entry 帧终判后 ≤32_768B，单帧量级不构成 ConnectionQueue 压力；但 entry 帧与所有出站帧同经队列（ws-gateway.ts:1426-1432），积压溢出时任何帧类（含 entry）都可能被 4431 关连接裁掉——与帧类无关，属连接级背压。

**4.1c digest 与 ts**

- digest=scanDigest 派生 `fnv1a64:fnv1a64Hex(JSON.stringify([source,locator,raw]))`（read-index.ts:41-43 现算现存索引 :72，零新增摘要算法）。客户端**不比对**；一致性锚=只对已订阅流内 entryId 发起（binding.streamId 锚，subscribe-client.ts:841-854）；服务端独占失效判据（§4.2 三判据+索引换代）。**用途**：仅诊断日志/UI「内容指纹」显示；**禁作渲染缓存键**。
- ts 三件：session 源 entry/事件 ts=行级 timestamp→epoch ms（ISO 解析失败回退 null 不抛）；同一行多事件共享行级 ts；journal 源 ts=null 保持（**不对称写入契约**：历史投影两文件头部声明同步改——session-projection.ts:19/history-projection.ts:6 现声明位）。
- **源可辨**：entry 帧恒 `source:"session"`（§4.1 仅 session 源）；不变量「`kind:"message"` ⟺ session 源」维持网关校验+测试断言。

### 4.2 服务端定位与读取

**薄索引归属 ReadIndex**：`ReadIndex` 内部维护 `entryId → {source, locator, digest, event}` 映射（append 时顺手登记；键=(file,source,entryId)，首见为准——session-projection.ts:176 去重口径；entryId 来源=行 id :137）。天然覆盖三处 append 调用点（ws-gateway.ts:812 首扫/:853 replace/:921 增量追加）+continueFrom 复调（read-index.ts:113）+syncIndex 三路装载+replace 重建（:851 换对象后由 :853 重新 append 填 map）——无需改调用点。索引持有 locator+digest+**事件投影**（非 raw 行）。

**触顶语义（与现码对齐）**：`maxEventsPerStream=20_000`（read-index.ts:49）触顶→overBudget=**既有流废弃**（closeSubscriptionsFor(file,"index-over-budget")，ws-gateway.ts:814/841/855/916/930/1223——订阅已关、快照从未下发，与现状一致）；对仍持旧 entryId 的在飞/迟到 entry-get→4414 reason=index-evicted；不复活流。**触发源（P3-N5 裁决）**：entry 路径命中该 file 的索引且 `index.overBudget===true`（read-index.ts:125 getter；注册表级 overBudgetFiles/FileOverBudgetError :147/:164-169）→index-evicted；索引无此 entryId→unknown-entry（二者可区分，枚举可达）。

**entryId 粒度=整行**：同一行可产多事件（消息本体+每个 toolCall 块，session-projection.ts:274-291 共享同一 entryId 与 locator）——entry-get 按 entryId 命中**整行**，回该行全部块；UI 子行共用同一 entryId 请求+按 entryId 缓存展开态（缓存失效见 §4.4）。`corrupt-*`/`unknown-line` 条目**登记时跳过**（同 system 排除口径）→请求未登记 entryId=4414 reason=unknown-entry。

**offset 读器（新建）**：readBounded 仅顺序读（safe-open.ts:111-115）；句柄本带定位参数（BoundedReadHandle.read(buffer,offset,length,position)，safe-open.ts:107）→新增 `readLineAt(fh, offset, maxBytes, file)` 定点读=加函数不改架构。**raw 契约**：raw=行内容**不含**终止 `\n`（与扫描期按 \n 切分同口径——`offset += Buffer.byteLength(raw,"utf8")+1` 累加 session-projection.ts:243，\n 只计位不入串）；`\n` 仅用于判据②行界。locator=十进制字符串行首字节偏移（:7/:256，Number() 解析即可）。**三条命中判据**（缺一=不命中→4414 reason=stale）：
1. `offset===0` 或前一字节（position:offset-1 读 1 字节）===0x0A（行首判定——否则是重写后中段残片）；
2. 读窗内行以 \n 结束（撕裂尾拒——口径=session-projection.ts:225-229 扫描期 complete 同式；journal 面同口径注释 :195）；
3. 同解码纪律（TextDecoder fatal:true, ignoreBOM:true，history-source.ts:73-90）还原 raw（**不含 \n**）后，scanDigest 派生值===索引值（字节级身份对账）。

读取链：索引命中→readLineAt（≤1 MiB）→parseMessageLine 共享校验→entryBlocksOf 投影+净化（§4.5）→两段式预算装帧（§4.1b）。

### 4.3 错误码与在途路由

- **新码 4414**（entry-get 请求级专用；不复用 4409——既有语义绑定 pending.kind 路由+流通局 resync（subscribe-client.ts:958-975）；不复用 4413——语义为会话身份损坏）。
- **同步面清单（P3-N13 统一编号，共 7 行）**：①contracts.ts:55 ErrorCode 联合；②error 帧**形状加 `reason?:` 字段**（六值枚举 stale/unknown-entry/oversized/index-evicted/not-subscribed/in-flight，contracts.ts:320 形状区）；③docs/ws-ui-contracts-v1.md 错误矩阵（码+reason+retryable 档位）**含 :331 entry 帧行 shape 补行（P3-e 裁决）**；④subscribe-client.ts:164 KNOWN_ERROR_CODES；⑤ws-client.ts:83 闭码表；⑥write-client.ts:148 闭码表；⑦subscribe-client.ts:504-516 errorTextFor 文案映射。**另两处收编面（P3-N6，非码表但漏挂=帧被静默丢）**：⑧contracts.ts:372 validateClientFrame+ClientFrame 联合（entry-get 请求不过此门恒 4404）+**ServerFrame 联合 :313-325 entry 帧变体**；⑨subscribe-client.ts:765/822-824 客户端帧分派 switch（漏挂 case "entry" → entry 帧落 default 安全忽略 → 前端只走 10s 超时不报错）。**漏任一处=parseError/分派静默丢弃 UI 永挂**——§5 断言钉死①-⑦全含 4414、⑧⑨收编 entry/entry-get。
- **retryable 按 reason 分档**：stale/in-flight=true（瞬态可重试）；unknown-entry/not-subscribed/oversized/index-evicted=false。
- **网关新出口 `entryErrFrame`**：enqueue error 帧（code:4414, reason, retryable, requestId）——**不入 errFrame**（后者签名仅 4401|4402|4403|4404|4405 且 4404 无条件计数 3→close 1002，ws-gateway.ts:572-580）；不计数、不绑订阅、不 close。
- **在途门分流**：通用在途门在 dispatch 之前（ws-gateway.ts:392-397）——门内**按 frame.t 分流**：`t==="entry-get"` 的重复 requestId/超限（第 5 个）→entryErrFrame(4414, reason=in-flight)，不走 4404 出口；其余帧类维持既有 4404 出口。未订阅 file 上 entry-get→4414 reason=not-subscribed。entry 族错误**永不过 4404 计数器**。
- **客户端路由**：独立 keyed map `entryRequests: Map<requestId, {entryId, resolve, timer}>`（同 uiRequests 模式 subscribe-client.ts:798-815）——**不落单槽 pending**（:839-840 不匹配即丢帧）；同 entryId 二次点击=复用在途 Promise（合流）；**客户端在飞上限=2**（P3-N3 裁决：与订阅面共享服务端 4 槽，超限排队/按钮复位——防「1 page+4 entry」把订阅面第 5 帧挤成 4404 计数）；**10s 超时兜底**→按钮复位+「内容获取超时，稍后重试」文案；**终局清理**：handleStreamTerminal（subscribe-client.ts:1000-1005，与 pending/binding/retiredSubs 同址）同步清 entryRequests（在途全 resolve 超时态）。4414 到达：requestId∈map→resolve 错误态并清；∉map→静默丢+审计一行。handleError 顶部按 `code===4414` 前置分流（无关联 error 帧落 :989 安全忽略兜底，不误伤订阅）。**任何 entry 帧不触碰订阅状态机**。
- 路径解析：file→abs 走 sessionFor 映射；不中（journal-only/未知）→4414 reason=unknown-entry；文件不可读=4414 reason=stale。

### 4.4 事件面最小增量+渲染（K3 前端批）

- 历史 `message` 事件补 `hasThinking`（仅门开且 thinkingCount>0 时置 true）+`blockCount`（可见块数）（取自 stats，事件推送点 session-projection.ts:274-281/:285-289；快照/续页同源）。
- **展开按钮触发口径（P3-N8 裁决）**：`hasThinking || blockCount>0 || textPreview?.truncated`（三条件其一即显示）——toolCall-only/attachment-only 条目（无 textPreview）也有展开入口。
- HistoryRow 预览行尾「展开」按钮→entry-get→展开态渲染 blocks（thinking 折叠区默认关，门开时才有 thinking 块）；toolCall 行显示 toolName+argsPreview；truncated 态文案=「**已截断·可见 X KB / Y 块**」（P2-N1'：不展示 rawBytes=原文规模——truncated 帧线上根本不携带该字段）+不可再放大；ok 态可展示 rawBytes（行无截断，规模无泄露面）。
- **展开缓存失效（P3-N7 裁决）**：展开态缓存按 `(streamId, entryId)` 键控；handleStreamTerminal/换流（与 entryRequests 清理同址）一并清展开缓存——session 文件改写（换流/重扫）后不残留旧全文。

### 4.5 安全面

**4.5a thinking 门控真值源与落线（P2-N1 裁决）**

- **单一真值源**：服务端 config `thinkingVisible: boolean`（默认 false）。现状：该 opt 仅存在于 live-aggregator.ts（:25 接口/:116 字段/:129 缺省 false/:165/:173 门控点），唯一构造点（:105）不传 opts=直播面今天也吃默认关；D4 把它升格为**服务级 config**，三面同源：
  - **直播面**：composition 构造 LiveAggregator 时传同一 config 值（今日不传=默认 false，行为等价，接线为新增）。
  - **扫描面**：`SessionProjectionInput`（session-projection.ts:40-46）增可选字段 `thinkingVisible?: boolean`（默认 false；**声明为协议包内部输入契约变更**——加字段，现有调用者不传=行为不变）。**连线点（P3-d 点名）：唯一生产调用点=dual-history-source.ts:119 `sessionToScanRows({ sessionText, enqueues, consumed })`——加字段后由该点从调用方 opts/config 传入**。`hasThinking` **唯一产生位=扫描面**（=thinkingVisible && thinkingCount>0，事件推送点 session-projection.ts:274-281（message 本体）/:285-289（toolCall 子事件），P3-f 精锚）；`stats.thinkingCount` 内部计数恒算，外发字段受门控。
  - **entry 面**：网关 entry 读路径把同一 config 值传入 entryBlocksOf 投影（门关=不产 thinking 块）。
- 门关时：entry 帧无 thinking 块、事件不置 hasThinking、blockCount/totalBlockCount 按可见块口径（thinking 不计数）→**零行为变更真成立**（存在性不泄露，见下）。

**4.5b 其余安全面**

- **姿态继承**：D1 冻结「只透 assistant 正文（system 不外泄）；thinking 缺省不透（opts 开关）」（contracts.ts:181-182）。协议默认关+部署默认也关（config opt-in）；REQ 落决策行。system 条目索引登记时跳过（请求已登记 system entryId=4414 unknown-entry）。
- **rawBytes 口径（P3-N9/P2-N1' 裁决）**：rawBytes/digest 均对**全行**（含隐藏 thinking）计算——属弱推断面（可见≪原文可反推隐藏段规模）。**口径钉死：rawBytes 仅 ok 态携带与展示（ok 态行无截断，规模泄露无意义）；truncated 帧线上不携带 rawBytes 字段（wire 级缺席），UI 文案只显示可见块字节与总块数**；digest 已禁渲染缓存键。
- 权限：entry-get 校验=与 subscribe 同面（token+file 订阅权）。
- **净化（两路）**：①argsPreview 在 JSON.stringify(arguments) 前按键走结构化 denylist：键名（含嵌套）匹配 `token|secret|password|passwd|key|authorization|cookie|credential`（不区分大小写）→值替换 `[redacted]`；②toolResult 正文=纯文本无键名→只 sanitizeText+展开区常驻风险提示头部。
- 审计：entry-get 不写 journal、不触 writerEpoch（纯读面）；审计行 `entry-get file=… id=… state=ok|truncated|err:4414/<reason>`。

## 5. 测试计划

- W-d4-s*（单测·读面）：readLineAt 三判据（行首/行尾/raw 不含 \n 各正反例——判据③含 \n 变体必红）；索引登记/首见为准/触顶（index.overBudget→index-evicted 可达性：旧 entryId 迟到请求 vs 未登记→unknown-entry 二态可辨）；system/corrupt/unknown 排除；**thinking 门控两态**（门关⇒entry 帧无 thinking 块+事件不置 hasThinking+blockCount 可见口径；门开⇒帧含 thinking 块）；denylist（嵌套键+大小写+toolResult 纯文本路）；ts 回退 null；stats 计数同源；**两段式预算**（ok/预算尽恒 truncated/中文多块有内容/**终判实测上界：含 50% 换行与控制字符恶意行终判后仍 ≤32_768B**/argsPreview 512 编码后字节/**末块切空仍超→4414 oversized 基例**）；**行硬读限 >1MiB→4414 oversized**；**成功帧无 oversized 态**；**truncated 帧线上无 rawBytes 字段断言**。
- W-d4-g*（网关）：帧形状/权限/not-subscribed/在途分流（entry-get 第 5 个+重复=4414，余帧类 4404 不变）/entry 错误×5 不断连/streamId 锚/源可辨/**①-⑦ 同含 4414 断言+⑧⑨ 收编断言**。
- W-d4-c*（客户端）：keyed map 独立槽（订阅 init 在飞时 entry-get 不覆盖 pending）；同 entryId 合流；**在飞上限 2（超限排队/复位）**；10s 超时+按钮复位；迟到 4414/entry 帧静默丢；终局/resync 瞬间清 entryRequests+**展开缓存**（不残留）；**展开按钮三条件触发**（toolCall-only 条目有入口）。
- E2E（E-d4-1）：FakeRpcHost 落长文+thinking+toolCall 条目→订阅→entry.get→断言两态+blocks 同形；直播-历史交错（同 entryId 不双显）。
- 变异面：索引登记死→unknown-entry；三判据逐条死→红（残片当正文=最险；raw 带 \n→判据③恒不中=全 stale 红）；denylist 死→token 外泄红；门控死（门关仍回 thinking）→红；在途分流死→五次错误断连红；①-⑦ 漏一处→对应客户端 parseError 拒帧红；⑧⑨ 漏挂→entry 帧/请求静默丢红；**终判死（只粗估不实测）→控制字符行上界破=红**。

## 6. 事实核验附录（2026-10-10；正文即真值；v5 勘误=v4 报 P3-N12 四处已回灌）

- message 行=`{id, message:{content, role, sections, timestamp, toolsAdded}, parentId, timestamp, type:"message"}`。toolCall 块=`{type, id, name, arguments:dict}`。thinking 块=`{type, thinking, thinkingSignature}`。行型全集：message/custom/custom_message/model_change/session/thinking_level_change。
- 关键行号索引（v5.1 全部重核；subscription-engine 终判环精锚=228-250：信封测量段 :234-245、退末条 :246-249、首条超=显式失败 :241-245）：contracts.ts:10 envelopeOverheadBytes=256/:14 frameMaxBytes=262_144/:16 transportMaxPayloadBytes=1_048_576/:18 pageFrameBudgetBytes=200_000/:19 singleEventBytes=32_768/:21 connQueueBytes=1_048_576（:22=socketBufferedBytes=4_194_304 非 1MiB 族）/:25 inFlightRequestsPerConn=4/:55 ErrorCode/:181-182 D1 冻结/:187 message-final/:313-325 ServerFrame 联合/:320 error 形状/:342-344 estimateFrameBytes/:348 回退常数/:372 validateClientFrame；session-projection.ts:7/:19 ts 声明位/:31/:40-46 SessionProjectionInput/:74/:95-107 blocksOf/:104/:105/:114/:137/:176/:195 撕裂注释/:225-229 扫描期 complete/:243 offset 累加/:256/:266/:270-276/:274-281 message 事件推送/:285-289 toolCall 子事件；history-projection.ts:6 ts 声明位/:15 journal 预览限；read-index.ts:41-43/:49/:69-73 append/:72/:113/:124 注释/:125 overBudget getter/:147/:164-169；subscription-engine.ts:217 粗筛/:228-250 终判环/:241-245 首条超显式失败/:246-249 退末条；projection-frames.ts:26/:31 快照帧粗估+首条必装失败先例；safe-open.ts:107/:111-115；history-source.ts:73-90；dual-history-source.ts:119 sessionToScanRows 唯一生产调用点/:155-161；live-aggregator.ts:25/:105 构造点/:116/:129/:165/:173；ws-gateway.ts:347/:392-397 在途门/:572-580 errFrame/:812,853,921 append/:814,841,855,916,930,1223 overBudget 关订阅/:851 replace 重建/:1426-1432 enqueue；subscribe-client.ts:164/:361/:504-516/:519-523/:765 分派 switch/:798-815/:822-824 default 安全忽略/:839-840/:841-854/:958-975/:989/:1000-1005；ws-client.ts:83；write-client.ts:148。

## 7. 开放问题（v5 全收敛）

1. ~~entry-get 限流~~ 服务端复用在途 4 槽+门内分流 4414；客户端 keyed map+在飞上限 2+合流+10s 超时+终局清理（§4.3）。
2. ~~toolResult 同路~~ 随本批；纯文本路=sanitizeText+风险提示（§4.5）。
3. ~~digest~~ scanDigest 派生+仅诊断+禁渲染缓存键（§4.1c）。
4. ~~ts~~ 随本批+不对称契约+fixture 清点（§4.1c）。
5. ~~thinking 姿态~~ 与 thinkingVisible 同开关、三面同源单一真值源、双默认关、存在性不泄露（§4.5a）。
6. ~~预算字节口径~~（v5 新收敛）两段式：粗估快筛+终判整帧实测+单调收敛（§4.1b）。
7. ~~rawBytes 展示面~~（v5.1 新收敛）仅 ok 态携带与展示；truncated 帧线上不携带（§4.1b/§4.4/§4.5b）。
8. ~~收敛基例~~（v5.1 新收敛）末块切空仍超=4414 oversized 显式失败（照抄 :241-245/projection-frames.ts:31 先例；§4.1b）。
