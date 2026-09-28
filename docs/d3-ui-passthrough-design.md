# D3 扩展问答透传设计（P0-4；ui-request/ui-answer/ui-note，契约 v1.2）

权威：pi 官方协议=pi-coding-agent docs/rpc.md §Extension UI（stdout `extension_ui_request` / stdin `extension_ui_response`）。
本稿=宿主面（pi-agent-ui server）与 web 客户端面契约冻结；实现细节以本稿+TEST-MAP D3 节为准。

## 1. 背景与目标

pi 进程内扩展（安全三层防线：permission-gate / pi-verdict / filter-output）需要向最终用户发问
（典型=权限确认 confirm）。pi `--mode rpc` 下这些提问以 `extension_ui_request` 出现在 stdout，
阻塞扩展直到宿主回 `extension_ui_response`。宿主必须把问题透传到 web UI、收集答案、回写 pi。
（此前 E2E 只能 `--no-extensions` 规避：扩展提问会永远阻塞。）

## 2. pi 协议事实（外部权威，不重复实现）

出站请求（stdout JSONL）：`{type:"extension_ui_request", id, method, ...}`，method 两族：
- **对话族**（等答案）：`select`（options[]）／`confirm`／`input`（placeholder?）／`editor`（prefill?）。
  携带可选 `timeout`（ms）：pi 侧到点自答 undefined（晚到的响应 pi 按过期 id 忽略——宿主不追踪该超时）。
- **即显族**（不等答案）：`notify`（message+notifyType info|warning|error）／`setStatus`／`setWidget`／`setTitle`／`set_editor_text`。

回写响应（stdin JSONL）：`{type:"extension_ui_response", id, value?}`（select/input/editor）
或 `{..., confirmed: boolean}`（confirm）或 `{..., cancelled: true}`（任意对话族=用户放弃）。

## 3. 宿主契约 v1.2（本稿冻结）

### 3.1 对话族=瞬态请求/响应（不进耐久事件流）

服务端→客户端（定向广播，见 §4 路由）：
```
{ t:"ui-request", requestId, file, method:"select|confirm|input|editor",
  title?, options?, message?, placeholder?, prefill?, timeoutMs? }
```
- `requestId` = pi 的 `id` 原样透传（宿主不重编号；绑定与校验键）。
- `timeoutMs` 透传 pi 的 `timeout`（仅 UI 展示提示；宿主不据此作答）。

客户端→服务端：
```
{ t:"ui-answer", requestId, value?: string, confirmed?: boolean, cancelled?: true }
```
- 按方法校验：select→`value∈options` 或 cancelled；confirm→`confirmed:boolean` 或 cancelled；
  input/editor→`value:string` 或 cancelled。畸形→4404（帧形状错码惯例；§5.3 第 2 级同口径）。
- `requestId` 未知/已答/已闭 → 4404（晚答诚实拒绝，幂等：首个合法答案胜出）。

服务端→客户端（请求作废通知，UI 撤对话框）：
```
{ t:"ui-closed", requestId, reason:"process-retired"|"no-subscriber"|"overflow" }
```

### 3.2 即显族

- `notify` → LiveEvent v1.2 新形 `{kind:"ui-note", notifyType:"info"|"warning"|"error", message}`
  （进耐久 live 流：重放/续读天然兼容，重复显示无害）。
- `setStatus`/`setWidget`/`setTitle`/`set_editor_text` → v1 不透传，审计行 `ui-unsupported` 留痕
  （即显族无阻塞风险；web 化归后续批）。

### 3.3 与既有面的关系

- ui-answer **不是**写帧：不触 journal、不经 writerEpoch（它驾驶宿主拥有的 pi 进程 stdin，
  与写面身份链无关；见 §6 边界）。
- ui-request/ui-closed 不进订阅事件流（答案语义瞬态；重放旧问=错误）。
- LiveEvent `ui-note` 按既有 events(origin=live) 帧投递，D2 前端旁路面渲染。

## 4. 路由与生命周期

- **派发**：file F 的 pi 进程发出对话族请求 → 广播给「当前订阅 F 的全部活跃连接」（任意相；
  paging 期订阅者也可答）。零订阅者 → 立即回 pi `cancelled`（无人可答，不悬挂扩展）+审计。
- **答案**：任一活跃订阅连接可答；首个合法答案胜出并回写 pi stdin；此后同 requestId → 4404。
  请求校验=answerer 连接须持 F 的活跃订阅（requestId 反查 file；跨文件猜测 → 4404）。
- **无人可答规则**：连接断开使 F 失去最后一个订阅者且 F 有 pending ui-request → 全部回 pi
  `cancelled` + 向（已断的）连接外无投递（ui-closed 只发仍订阅者，无则仅审计）。
- **进程边界**：pi 进程 retire/意外退出（generation 切换）→ pending 全灭（不向死进程写 stdin），
  对订阅者发 `ui-closed{reason:"process-retired"}`；重启后的新提问走新代次自然派发。
- **上限**：每会话 pending ≤8（防御洪泛）；第 9 个起立即回 `cancelled`+`ui-closed{reason:"overflow"}`。
- **宿主不设超时**：pi 侧 extension timeout 自治；晚答照常转发（pi 忽略过期 id），审计留痕。

## 5. 实现落点（repo）

| 件 | 文件 | 内容 |
|---|---|---|
| 协议 | packages/protocol/src/contracts.ts | ClientFrame +ui-answer；ServerFrame +ui-request/+ui-closed；LiveEvent +ui-note；校验器三入口 |
| 会话 | apps/server/src/runtime/rpc-session.ts | demux 增 `extension_ui_request` 分支（先于 onPiEvent 兜底）；pendingUi 表+onUiRequest/onUiNote/onUiClosed 回调；answerUi(requestId,resp)→boolean；retire 清 pending+逐个 onUiClosed |
| 网关 | apps/server/src/ws/ws-gateway.ts | ui-answer 入站校验/绑定/首答胜出；ui-request 广播（订阅表反查）；断开触发无人可答规则；ui-note 经 engine.onLiveEvent |
| 组装 | apps/server/src/composition.ts | sessionFor(file).onUiRequest→网关广播（零订阅→answerUi cancelled）；onUiNote→onLiveEvent(ui-note)；onUiClosed→广播 |
| 文档 | docs/ws-ui-contracts-v1.md | v1.2 节（三帧+ui-note+规则表） |

## 6. 边界与已知限（v1 明示）

1. 答案权限=活跃订阅者即答（含多读者）。单用户自举口径成立；多信任域部署须升格为写级身份
   （挂 writerEpoch 或独立 answer-authority）——REQ 债条目，不在本批。
2. `set_editor_text`/`setStatus`/`setWidget`/`setTitle` 不透传（§3.2）。
3. ui-request 不做跨连接去重弹窗仲裁（首个到达连接渲染即可；广播面=全订阅者同时弹，
   首答胜出自洽）。
4. 洪泛上限 8 是宿主防御，不是 pi 契约值。

## 7. 测试面（TEST-MAP D3 节）

- rpc-session 单元 W-ui-s*：对话族 demux→onUiRequest；即显 notify→onUiNote；其余即显→审计；
  answerUi 三方法回写形+cancelled；retire 清 pending+onUiClosed 逐个；cap 8 溢出；晚答照转。
- 网关单元 W-ui-g*：合法答案回写+首答胜出+次答 4404；跨文件 4404；畸形 4403；零订阅派发→立即
  cancelled；末订阅者断开→pending 全 cancelled；进程 retired→ui-closed 广播；ui-note 进 live 流。
- E2E（受控 FakeRpcHost）：emit extension_ui_request → 帧→answer→stdin 断言；断开/退役两路。
