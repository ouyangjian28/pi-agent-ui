# D4 双源归并读面：全文/思考/工具调用补全设计稿

状态：草案（待 K3 审 D3-E2E 批收口后冻结契约；本文档先行供评审）
日期：2026-10-10
前置：D3 全链已合（d0c87d3）；迁移就绪里程碑 M-D4。

## 1. 问题（日用最大缺口）

- 历史面 session 投影只发 `textPreview`（`SESSION_PREVIEW_LIMIT=200` 代码单元，session-projection.ts:31）——正文一旦移交历史区就从直播全文塌缩成 200 字预览（session-detail.tsx HistoryRow 单行渲染 `preview.text…`）。
- thinking 块在历史投影整体丢弃（session-projection.ts:105 `t === "thinking" continue`）；直播面 thinking 缺省不透（live-aggregator opts 开关）——刷新后思考内容永久不可见。
- toolCall 块只投影 `toolCallId`（无工具名/参数摘要）——历史区无法分辨「调了什么」。
- 直播→历史交接无 entryId 锚（message-final 无身份，contracts.ts:187；live-stream.tsx 靠「历史出现 assistant 行」启发式清缓冲）。

## 2. 目标 / 非目标

目标：
1. 历史区可展开看全文（含 thinking 段、toolCall 名称+参数摘要、toolResult 摘要）。
2. 帧大小有界（快照/续页不因全文膨胀）——大会话不拖垮订阅面。
3. 直播→历史交接可精确锚定（同一 assistant 条目不双显）。

非目标：改 journal 行型；改 pi 会话文件格式（只读投影）；把全文塞进事件流（明确拒绝——见 §3 否决案）。

## 3. 决策空间

| 案 | 做法 | 优点 | 致命伤 | 结论 |
|---|---|---|---|---|
| A 抬预览上限 | SESSION_PREVIEW_LIMIT 200→8K | 一行改动 | 每事件帧膨胀 40 倍量级；分页双上限全乱；千条会话快照爆炸 | 否决 |
| B 按需取全文（推荐） | 新增 `entry.get` 读路径：客户端点「展开」→ `{requestId,file,entryId}` → 服务端定位行→安全读→回全文帧 | 帧有界；服务端已有全部基建（ScanRow.locator=字节偏移+openSafeFile/readBounded+身份校验族）；权限面沿用订阅校验 | 多一次往返；行游标失效需处理 | **采纳** |
| C 全文内联限长 | 预览抬到 N KB，超出走 B | 简单场景零往返 | 两套路径=口径分裂；N 选择无理；历史长文照样膨胀 | 否决（B 的「预览保持 200」即 C 的退化形） |

## 4. 推荐案细节

### 4.1 契约（新增两组帧）
- 请求（ClientFrame 变体）：`{t:"entry-get", requestId, file, entryId}`——file=逻辑名（沿用订阅口径；网关侧归一方向=logical，服务端 sessionFor 反解，与 D3 修复同族方向对）。
- 响应（ServerFrame 变体）：`{t:"entry", requestId, entryId, digest, blocks:[{kind:"text"|"thinking",text}|{kind:"toolCall",toolCallId,toolName,argsPreview}|{kind:"attachment",id}], stopReason, truncated:false}`。
  - digest=条目行原文 SHA-256（前端比对历史事件快照代的稳定性；不符=照 4409 resync 语义走 resync，不静默拼）。
  - 超行上限（readBounded 同族硬限，如 1 MiB/条）→ `{t:"entry", ..., oversized:true}` 显式失败，不截断。

### 4.2 服务端定位（零新扫描）
ReadIndex.append 已持有全部 ScanRow（ws-gateway.ts:802/843/911）——但事件帧不带 locator，故网关维护 `entryId → {source:"session", locator}` 薄索引（append 时顺手登记，换代/重扫失效随索引生命周期）。
读取链：locator=行字节偏移 → openSafeFile（同 fd 身份）→ readBounded(offset, 硬限) → 按行界切 → 复用 parseMessageLine 全文解析（**同一解析器**——不得另写宽松版，GPT 3b2a P1 家族教训）→ blocks 原样回（thinking/toolCall 这层不再丢）。
行游标失效（会话被 pi 重写/压缩 → digest 对不上或 offset 落空）：回 4409 类「entry-stale」错误帧，前端触发既有 resync 路径（4409 族已成熟）。

### 4.3 直播→历史交接锚（增量小改）
- pi rpc 的 message_end 不携带 pi 侧 entryId（docs/rpc.md 事实）——无法服务端硬锚。
- 前端交接仍走现有启发式（历史 assistant 行出现→清直播），D4 不改语义；但历史 `message` 事件已带 entryId，展开锚定按 entryId 精确。留观：若未来 pi rpc 补 id，接入点在 makeLiveOnPiEvent 一处。

### 4.4 渲染（K3 前端批）
- HistoryRow 预览行尾加「展开」按钮（有 textPreview.truncated 或 toolCall/thinking 存在时）→ entry.get → 展开态渲染 blocks（thinking 折叠区默认关，与直播面同款交互）。
- toolCall 行显示 toolName+argsPreview（预览 200 同限）。

### 4.5 安全面
- 权限：entry-get 校验=与 subscribe 同面（token+file 订阅权）；未订阅 file 上 entry-get → 4404 族（同 ui-answer 跨文件门口径）。
- 净化：回传 blocks 全走 sanitizeText（同族限长）；argsPreview 限长；不回 raw 原文（避免把 pi 会话文件任意字段外泄——只回投影白名单块）。
- 审计：entry-get 不写 journal、不触 writerEpoch（纯读面，同 ui-answer 声明口径）。

## 5. 测试计划（草案）
- W-d4-s*（单测·服务端）：定位/读取/解析复用/超限/游标失效→entry-stale/跨文件门/净化/幂等（同 entryId 重复取）。
- W-d4-g*（网关）：帧形状/权限/4409 resync 联动。
- E2E（E-d4-1）：FakeRpcHost 落一条长文+thinking+toolCall 条目 → 订阅 → entry.get 展开 → 断言 blocks 全量。
- 变异面（先记档后实现）：定位索引登记死→红；readBounded 硬限死→oversized 不出；解析器分叉（宽松版）→形状门红。

## 6. 开放问题（评审拍板）
1. entry-get 并发/频率限流要不要（纯读+有界，倾向 v1 不做，观察）。
2. toolResult 条目（role:"toolResult"）要不要同路展开（倾向：v1 一起做——同一 parseMessageLine 已覆盖）。
3. digest 语义：对行原文还是对投影 blocks（倾向：行原文——与 scanDigest 同坐标系）。
