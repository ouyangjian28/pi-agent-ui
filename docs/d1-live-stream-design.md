# D1 直播面设计（pi 事件流→订阅连接广播）

> 批次：D1（GLM 后端）→K3 D2 渲染消费。自举路线第一批：目标=订阅连接实时看到 pi 回复全文增量。
> 探针证据：/tmp/pi-events-dump.json（2026-09-28 真事件 129 update）；repo E2E 既有三轮真 pi。

## 0. 现状断链（为什么做）

- `rpc-session.ts:313` 已有 `opts.onPiEvent(ev, generation, disposition)` 钩子，composition **未接线**——pi 增量在宿主面丢弃。
- 契约 `LiveEvent.pi-progress` 只有摘要粒度（ProgressNote），server 侧零产出（前端死代码）。
- 历史面=journal 投影（意图记账），pi 回复全文不落历史读面——直播面是自举「看回复」的唯一活路径（历史归并=D4 后补）。

## 1. pi 事件结构（探针实证）

- RPC：`{id, type:"prompt", message}`→stdout JSONL 事件流。
- 序列：agent_start→turn_start→message_start\*→message_update\*→message_end\*→turn_end→agent_end→agent_settled。
- `message_update.assistantMessageEvent`：
  - `{type:"thinking_start"|"text_start", contentIndex}` 段开
  - `{type:"thinking_delta"|"text_delta", contentIndex, delta}` 纯增量文本
  - `{type:"thinking_end"|"text_end", contentIndex}` 段闭
- `message_end.message = {role, content(全文), sections, ...}`；usage 字段恒在。
- `extension_ui_request`（33/轮）与 `response` **不广播**（非会话内容面）。

## 2. 契约扩展（packages/protocol/src/contracts.ts）

`LiveEvent` 新增三形（既有两形不动）：

```ts
| { readonly kind: "message-delta"; readonly part: "text" | "thinking";
    readonly contentIndex: number; readonly delta: string }          // 聚合后增量（节流窗内合并）
| { readonly kind: "message-part-end"; readonly part: "text" | "thinking";
    readonly contentIndex: number }                                   // 段闭（text_end/thinking_end）
| { readonly kind: "message-final"; readonly role: "assistant" | "user" | "system";
    readonly text: string }                                           // message_end 终局全文（漂移校准/补齐）
```

- `message-final` 取 `message_end.message`：content 为 string 直取；数组取 `type==="text"` 段拼接（与 e2e assistantBodyText 同规）。role=assistant 才广播正文；user/system 不广播（用户已知/system 泄系统提示——**安全面：只透 assistant**，探针见 system 含全工具清单）。
- thinking 透传：默认**不透**（opts.thinkingVisible=false 缺省；D2 前端消费位后开）——thinking 可能含敏感中间态，先保守。`message-delta.part` 联合先立形状，false 时过滤 thinking_\*。

## 3. 接线（三处）

1. **composition.ts**：rpc-session 构造注入 `onPiEvent: (ev, gen, disp) => this.opts.onSessionEvent?.(file, ev, gen, disp)`——per-file 闭包（RpcSession 由 registry per-file 创建，创建点知 file）。
2. **ws-gateway.ts**：新增 `broadcastLive(file: string, ev: LiveEvent)`——线性扫 `this.conns`×`st.subs.get(file)`（连接规模小，起步可接受；后续 file→conns 反查表再优化）；命中即 `enqueueIfOpen(st, {t:"live", subscriptionId, seq:0, event: ev})`。
   - 帧形状：复用既有直播帧包装（查 subscription 帧的 live 载荷既有形——seq=0 表「无历史序」纯直播）。
3. **订阅状态**：SubEntry 加 `liveOpen: boolean`（订阅处于 streaming/resync-needed 才广播；stopped/closed 不发）。

## 4. 资源面（四件，对齐 P0-2 §2b 口径）

| # | 面 | 定案 |
|---|---|---|
| 1 | 节流 | 每文件聚合窗 80ms：窗内同 (part,contentIndex) delta 拼接一帧；窗到或 8KiB 上限即 flush；part-end/final 即时 flush |
| 2 | 背压 | 复用 ConnectionQueue：enqueue 溢出→4431 关该连接（既有语义，不杀进程不断其他订阅） |
| 3 | 预算 | 单 delta 帧 ≤8KiB（超长切分）；单 turn 广播总量软上限 2MiB（超限停 delta 只发 final——防失控输出刷爆） |
| 4 | 生命周期 | 进程换代/取消（turn_end 后 turn_state 已有）不额外发终局；订阅 resync-needed 期间继续发 delta（前端合并责任）——**resync 覆盖历史面，直播帧独立于快照序** |

## 5. 归属与门

- onPiEvent 带 generation：disposition 白名单门 shouldBroadcastLive——只放行 delivered/buffered（buffered 的记账行已在 enqueue 硬序①先落；E2E 实证回复期=buffered，旧「只 delivered」门把回复期全滤掉）；其余（旧代/溢出/未知态）拒。
- file 无活跃订阅→零开销（broadcastLive 早退）。
- 扩展面 `extension_ui_request`/`response` 不进广播（§1）。

## 6. 测试清单

- 单元（composition 接线）：W-d1-1 onPiEvent→broadcastLive 调用（delivered 才发）；W-d1-2 thinking 过滤缺省；W-d1-3 节流窗合并（80ms 内两 delta 一帧）；W-d1-4 8KiB 切分；W-d1-5 2MiB 软上限停 delta；W-d1-6 final 只透 assistant。
- 网关：W-d1-7 broadcastLive 只投活跃订阅连接；W-d1-8 stopped 订阅不投。
- E2E（PI_E2E）：D1-E2E 真 pi 一轮→订阅连接收 message-delta 序列+final=全文（探针脚本改造成测试）。
- 变异：Mu-d1-1 节流窗去掉→W-d1-3 红；Mu-d1-2 thinking 过滤去掉→W-d1-2 红；Mu-d1-3 final 不过滤 role→W-d1-6 红；Mu-d1-4 disp 过滤去掉→W-d1-1 红。
