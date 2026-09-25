# ②WS/UI 只读面共享契约（草案 v0.9，待 GPT 审定冻结）

> 状态：**草案**——冻结前 GLM(server 面)与 GPT(UI 面)都不得开工实现。
> 冻结五契约类别（s5e 裁定零增删）：①身份与版本 ②状态语义 ③快照+增量 ④恢复只读说明 ⑤传输边界。
> 类别冻结≠schema 已冻结：本文档=类别→具体字段的落地方。冻结后改动须双方审记（版本号+1）。
> 范围红线：②只读订阅/快照/历史/状态/恢复说明。**不开放 prompt、接管、裁决、恢复执行**（③单独验收 P0-1~P0-4）。writerEpoch/revision 等写者身份概念**预留**到③，本契约 DTO 不含。

---

## 组1 身份与版本

### 1.1 服务身份与协议版本

```ts
/** 服务身份（welcome 帧下发；每次服务进程重启必变）。 */
interface ServerIdentity {
  readonly serverBootId: string;   // UUID v4，进程启动生成
  readonly protocolVersion: 1;     // 本契约冻结版本（不匹配=4403 拒）
}
```

### 1.2 双层会话身份

- **宿主会话**（pi 会话文件）：`sessionId`=header.id（身份）；`file`=basename（定位键）。两者分离（r8-04）；`sessionId:null`=header 损坏的显式降级态（列表面呈现「身份损坏」，订阅面拒 4402）。
- **adapter 会话**（RpcSession/journal）：`adapterSessionId`（journal 的 sessionId）。一个宿主会话文件至多一个活跃 RpcSession 绑定（server 内部路由依据；跨订阅稳定）。

```ts
interface SessionRef {
  readonly sessionId: string | null;   // pi header.id；null=身份损坏
  readonly file: string;               // basename 定位键（绝不透出绝对路径）
  readonly adapterSessionId: string | null; // 活跃 RpcSession 绑定；null=该会话当前无 adapter 运行面
}
```

### 1.3 轮次/进程身份（只读呈现，非写者凭据）

```ts
/** 进程代次：null=无进程（supervisor idle）。换代≠游标失效（journal 连续）。 */
type ProcessGeneration = number | null;
/** 当前在飞轮意图 id（gate in-flight 时；否则 null）。 */
type TurnIntentId = string | null;
```

### 1.4 事件游标

```ts
interface EventCursor {
  readonly kind: "journal";   // v1 唯一游标域=journal 行序（统一权威流，见组3）
  readonly seq: number;       // ≥0；0=从头；快照后=nextCursor 续订
}
```

**重启规则**：`serverBootId` 变化→一切游标失效（客户端收到 4409 游标过期，须重新 hello+快照）；journal 文件被截断/回退（seq 回落）→同样 4409。`processGeneration` 变化**不**使游标失效。

---

## 组2 状态语义

五态分立，映射唯一权威=server；UI 只呈现不自推。

```ts
interface SessionStatus {
  readonly session: SessionRef;
  readonly process: {
    readonly phase: "idle" | "running" | "stopping";
    readonly generation: ProcessGeneration;
  };
  readonly turn: {
    readonly state: "idle" | "in-flight" | "settling";
    readonly intentId: TurnIntentId;
  };
  readonly backgroundTasks: { readonly activeCount: number };  // 登记表只读计数
  readonly reap: {
    readonly eligible: boolean;          // 双条件已满足且计时中
    readonly idleSinceMs: number | null; // epoch ms
    readonly idleMs: number;             // 配置期限（呈现用）
  };
  readonly recovery: RecoveryInfo;       // 组4
}
```

**映射表（唯一权威）**：
| server 字段 | 来源 | 语义红线 |
| --- | --- | --- |
| process.phase/generation | supervisor.getState() | **idle=无进程≠agent_settled≠恢复授权** |
| turn.state/intentId | gate.getState()（idle/in-flight/settling 直映射） | settling=已见 settled 待耐久 |
| backgroundTasks.activeCount | registry.activeCount() | 未知登记状态阻断回收（呈现如实） |
| reap.* | reaper 观测面 | eligible≠已回收；idleSinceMs=null=未计时 |

---

## 组3 快照+增量（统一事件流）

**权威流=journal 行投影**：每条 journal append（含 pi 事件入账）=一个 `TimelineEvent`。实时 `onPiEvent` 旁路事件也按入账序获得 seq——**历史重放与实时增量同一坐标系，不冒充**（旁路事件入账前不外发）。

```ts
type TimelineEventKind =
  | "turn-enqueued" | "sending" | "settled" | "response-timeout" | "clear"
  | "pi-event";

interface TimelineEvent {
  readonly seq: number;          // journal 行序，全流唯一、单调
  readonly ts: number;           // epoch ms（server 入账时刻）
  readonly kind: TimelineEventKind;
  readonly intentId: string | null;   // 归因轮（pi-event 按 demux 归因；null=非轮事件）
  readonly payload: EventPayload;     // 白名单投影（见 3.3）
}
```

### 3.3 payload 白名单（敏感过滤）

```ts
type EventPayload =
  | { turn: { rawTextPreview: string; ordinal: number } }            // turn-enqueued：截断 200 字符预览
  | { stdio: { bytes: number } }                                       // sending
  | { settled: { verdict: "settled" | "delivered" } }
  | { timeout: { commandId: number } }
  | { clear: { cleared: string[] } }
  | { pi: { type: string; role?: "assistant" | "user" | "system";
            textPreview?: string;      // assistant/user 正文截断 500 字符
            toolName?: string } };     // agent_* 事件的白名单投影；**不含原始 unknown、路径、凭据**
```

### 3.4 快照与增量

```ts
interface SnapshotFrame {
  readonly file: string;
  readonly snapshotUpTo: number;     // seq（含）
  readonly status: SessionStatus;
  readonly timeline: TimelineEvent[]; // ≤200/页（分页：nextCursor 续拉）
  readonly nextCursor: EventCursor;   // 续订起点=快照后第一条未含事件
}
interface EventsFrame {
  readonly file: string;
  readonly events: TimelineEvent[];   // 按 seq 升序；客户端按 seq 去重
}
```

**衔接规则**：客户端持 cursor 订阅→server 先发快照再增量；`nextCursor.seq==snapshotUpTo+1` 恰衔接；事件 seq>last+1=断档→server 发 `resync-required`（客户端重拉快照，不静默跳）；重复=按 seq 幂等丢弃；游标过期（重启/回退）=4409 全量重同步。

---

## 组4 恢复只读说明

```ts
interface RecoveryInfo {
  readonly resumeBlocked: boolean;     // =diskBlocked || unknownEffect.length>0
  readonly diskBlocked: boolean;       // 坏行/撕裂残片在盘
  readonly unknownEffect: string[];    // intentId 列表（效果未知轮）
  readonly resumable: string[];        // 可重发轮（③才执行；②只呈现）
  readonly intentsCount: number;
  readonly settledCount: number;
  readonly candidateHash: string | null;  // 恢复证据指纹（s4k 绑定；恢复投影版本）
  readonly notes: string[];           // server 生成的人话原因（UI 原样呈现，不推断）
}
```

**UI 红线**：不得从文本/进程态/事件流推导恢复许可；恢复说明卡只消费本 DTO；不出现任何「执行恢复/重发/接管」入口。

---

## 组5 传输边界（WS 帧协议 v1）

JSON 文本帧，UTF-8，单帧 ≤256KB（超限=4404）。`t` 字段判别。

### 客户端→服务端（v1 只读五帧）

```ts
type ClientFrame =
  | { t: "hello"; protocolVersion: 1; token: string }            // 认证（v1=配置静态令牌）
  | { t: "list-sessions" }                                        // →sessions
  | { t: "subscribe"; file: string; cursor?: EventCursor }        // →snapshot+events 流；无 cursor=只增量（从当前）
  | { t: "unsubscribe"; file: string }
  | { t: "ping"; nonce: string };
```

### 服务端→客户端

```ts
type ServerFrame =
  | { t: "welcome"; serverBootId: string; protocolVersion: 1 }
  | { t: "sessions"; sessions: SessionSummaryDTO[] }             // 组5.4
  | { t: "snapshot" } & SnapshotFrame
  | { t: "events" } & EventsFrame
  | { t: "status"; file: string; status: SessionStatus }         // 状态变化门推送
  | { t: "resync-required"; file: string; reason: string }
  | { t: "error"; code: number; message: string; retryable: boolean }
  | { t: "pong"; nonce: string };
```

### 5.4 SessionSummaryDTO（复用 session-list.ts 语义）

```ts
interface SessionSummaryDTO {
  readonly sessionId: string | null;
  readonly file: string;
  readonly title: string;            // ≤80 字符
  readonly lastActiveMs: number | null;
  readonly entryCount: number;
  readonly sizeBytes: number;
  readonly hasRecoveryNotice: boolean; // resumeBlocked=true 时列表角标
}
```

### 5.5 错误码表（封闭枚举）

| 码 | 含义 | retryable |
| --- | --- | --- |
| 4401 | 未认证/令牌无效（未 hello 或失败后发业务帧） | false |
| 4402 | 会话不存在或不可读（含 sessionId 损坏） | true（换会话） |
| 4403 | 协议版本不匹配 | false |
| 4404 | 帧格式非法（含未知 t、超限） | false |
| 4405 | 写类帧（v1 只读协议：任何写意图帧一律拒绝且**零副作用**） | false |
| 4409 | 游标过期（重启/回退/断档不可续） | true（重新快照） |
| 4429 | 订阅数超限（>8/连接） | false |
| 4431 | 慢客户端：事件缓冲超限断开（缓冲 1024 事件） | true（重连重同步） |

`error.message`=白名单短语（上表「含义」列原文），**不透出内部异常文本**。

### 5.6 限额与心跳

- 订阅并发=8/连接；列表=200 会话；快照分页=200 事件/帧；事件缓冲=1024/订阅（溢出=4431 断开）；单帧 256KB。
- 心跳：客户端 ping 间隔建议 30s；服务端 90s 未见任何帧→主动断开（不告警风暴）。
- 慢客户端不阻塞 journal/其他会话（每订阅独立有界缓冲，溢出即断开该连接）。

### 5.7 认证

v1=配置静态令牌（hello.token 比对；常数时间比较）。未认证只允许 hello；认证失败=4401 并断开。已认证连接发写类/未知帧=4405/4404，**无任何副作用**。列表/订阅/心跳/重连**不 spawn、不写 stdin、不重置执行活动期限、不授权旧意图补发**。

---

## 权威 fixtures 与一致性（开工后首批落地物）

- 位置=repo `tests/fixtures/contracts/`：`welcome.json`、`sessions.json`、`snapshot.json`（含 timeline 各 kind）、`events.json`、`status.json`、`recovery-blocked.json`、`resync.json`、`error-codes.json`。
- **生成方式=真代码产出**（server 帧序列化对拍），手写仅作格式示意；fixtures 变更=契约变更（版本+1 双方审记）。
- schema 单一来源=TS 类型（server 包导出）；UI 侧复用同一类型定义（或由 fixtures 生成），不另写一套。

## 验收场景（七组，s5c §8.2~8.4 附件）

正常订阅；闲置回收展示（eligible→reap→idle）；断线续读（cursor 续订无缺口）；游标过期（重启→4409→全量重同步）；跨会话迟到（换代/切会话旧代事件不污染当前视图）；认证过期（4401）；慢客户端（4431 断开+重连恢复）。外加至少一条**真实 server→WS→UI 只读端到端链**。

## 「第二代历史已读入」证据（②内完成，非第六契约）

实际只读历史口（组3 timeline 的 pi-event 历史重放）接好后：在恢复/冷启动场景断言第一代旧消息（含身份 entryId/role）出现在 timeline——归入组3 历史读取与组1 身份验证验收，具体以实际读口为准。

---

## 冻结检查单（GPT 审定项）

1. 五组类别覆盖是否与 s5c §8.1 一致（零增删）。
2. 字段/枚举/错误码/限额的具体值是否可实施、有无遗漏（尤其断线续读衔接与 4431 重同步路径）。
3. 敏感过滤白名单（3.3/5.5）是否充分（路径/凭据/原始异常不外泄）。
4. 「第二代历史已读入」归属组3 的验收口径是否成立。
5. 有无越权面（写帧/恢复执行/接管入口混入）。
