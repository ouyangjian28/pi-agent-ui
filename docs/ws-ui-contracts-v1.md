# ②WS/UI 只读面共享契约 v1.2（c3 修订稿；对 C3-R01~R09 逐项闭合）

> 状态：**修订稿+真代码准备包**——c3 审定 78/100（9 红项；三项架构取舍已认可：append-only 内存索引/live 无正文 delta/get-recovery 帧）。本版为文档语义修订；随本版同步交付真代码准备包：`packages/protocol/src/contracts.ts`（DTO+strict 校验+帧预算）+`sanitizer.ts`（真实现）+人工 golden 向量+订阅状态机纯逻辑与 13 时序可执行断言（c3 冻结门第 4 步）。
> 范围红线不变：只读。红项对照表 §8；c4 审定请求 §9。

---

## 组1 身份与版本

### 1.1 服务身份

```ts
interface ServerIdentity { readonly serverBootId: string; readonly protocolVersion: 1; }
```

### 1.2 双层会话身份与命名域

- `sessionId`=pi header.id；`file`=basename 定位键：`/^[\w.-]{1,114}\.jsonl$/`（**整串 ≤120 字符**，含 6 字符后缀；与 §5.7 逐字段表一致——C3-R09）；拒绝绝对路径/`..`/分隔符；打开时 O_NOFOLLOW 等价校验（符号链接拒绝）。v1 单根 `sessionRoot`+`journalRoot`；journal 路径=确定函数 `file→journalRoot/<file>`。
- `adapterSessionId:null`≠磁盘历史不存在。

```ts
interface SessionRef { readonly sessionId: string | null; readonly file: string; readonly adapterSessionId: string | null; }
```

### 1.3 流身份、读索引与换流（C3-R01 修订：整文件指纹+超限出口+时序口径）

```ts
type StreamId = string;   // base64url(16B)
interface EventCursor { readonly streamId: StreamId; readonly seq: number; }  // next-to-read；首=1；安全整数
```

**读侧 append-only 编排（冻结；c3 已认可）**：事件表 append-only（seq 编入后永不变；后来者只追加流尾）；内存常驻+LRU；**索引不持久化**（跨 boot 换流，客户端全量重拉）。

**修订条款**：
- **源文件指纹=整文件 SHA-256**（读/增量观察时计算；文件变更时重算重扫）。投影前缀校验=重扫结果与索引已编入定位（源+行定位）逐一比对；前缀不符（截短/替换/重写/header.id 变化）→换流。**指纹覆盖完整字节，非首行**（C3-R01）。
- **索引预算（冻结）**：LRU ≤32 流×每流 ≤20_000 事件×约 48B/事件 ≈32MB 常驻；任一维度超限=最久未订阅流/最大流**强制卸载→换流**（4409 出口；Y03）。
- **编排保证（时序③口径修正）**：任何事件只在其编入时刻获得 seq>H（快照发起后编入的必然>H）——「分页间新增落 H 前」**不可能发生**；两源新增一律在快照结束后按编入序投递（history 域续读）。时序表 §3.7 已修正。
- 换流全集：服务重启；journal/session 截短/替换/重写；绑定重建；索引卸载。游标拒绝：streamId≠当前→4409；超前/跨会话→4409；非法 seq→4404。

### 1.4 订阅实例与状态版本

```ts
type SubscriptionId = string;   // 连接内唯一
type StatusVersion = number;    // 域=(serverBootId, file)；单调递增
```

- statusVersion 比较规则：UI 丢迟到低版本；同版本幂等接受；重订阅初始化不受限；bootId 变=重置。心跳/列表/get-recovery 不推进 version。**LRU 卸载流索引不重置 statusVersion**（版本域=boot+file，与流索引无关；Y01）。
- 历史事件保留 `generation`（可空）。

---

## 组2 状态语义

### 2.1 轮状态（判别联合）

```ts
type TurnState =
  | { state: "idle" }
  | { state: "dispatching"; intentId: string }
  | { state: "in-flight"; intentId: string }
  | { state: "settling"; intentId: string }
  | { state: "closed"; reason: "durability-failure"|"turn-timeout"|"buffer-overflow"|"manual"|"generation-retired" };
```

### 2.2 进程与启停结果（映射表冻结）

| 实现分支 | StartResult | | 停止分支 | lastStopResult |
| --- | --- | --- | --- | --- |
| ready | `{kind:"ready"; generation}` | | confirmed | 更新 `{kind:"confirmed", atMs}` |
| superseded | `{kind:"superseded"; generation}` | | deadline-exceeded | 更新；迟到确认再更新 |
| readiness-timeout | 同名+generation | | no-process/stopping | 不更新 |
| spawn-failed | `{kind:"spawn-failed"; generation:null}` | | | |
| rejected（not-idle） | 不更新 lastStartResult | | | |
| spawn-exited | `{kind:"spawn-exited"; generation}` | | | |

```ts
interface ProcessState {
  readonly phase: "idle" | "running" | "stopping";
  readonly generation: number | null;
  readonly lastStartResult: StartResult | null;
  readonly lastStopResult: StopResult | null;
  readonly ready: boolean;   // =phase==="running" && lastStartResult.kind==="ready" && lastStartResult.generation===generation
}
```

### 2.3 后台任务与回收（时钟域冻结）

```ts
interface BackgroundTasksState { readonly availability: "known" | "unknown"; readonly activeCount: number | null; }
interface ReapState {
  readonly eligible: boolean;
  readonly idleElapsedMs: number | null;     // 服务端单调时钟差，Math.floor
  readonly idleRemainingMs: number | null;
  readonly idleMs: number;
}
```

- elapsed/remaining 不暴露绝对时基；serverTimeMs（epoch 墙钟）仅展示校正，禁与单调差值混算；回收裁决只在服务端。availability==="unknown"→reap.eligible 恒 false。

### 2.4 顶层状态

```ts
interface SessionStatus {
  readonly session: SessionRef; readonly process: ProcessState; readonly turn: TurnState;
  readonly backgroundTasks: BackgroundTasksState; readonly reap: ReapState;
  readonly recovery: RecoverySummary; readonly statusVersion: StatusVersion; readonly serverTimeMs: number;
}
```

---

## 组3 只读事件流（history 域与 live 域分立）

### 3.1 两域模型（c3 认可+修订）

- **history 域（持久坐标、可续读）**：`HistoryEvent` 统一编排（§1.3）。订阅持续期新编入事件（快照后落盘的两源事件）经 events 帧 origin:"history" 投递——**不是只发 live**（C3-R03）。
- **live 域（订阅实例内、不可重放）**：`LiveEvent` 只投进度与状态旁路；**v1 无正文 delta**（脱敏无法安全处理流式增量；终局正文预览以 history `message` 呈现）。live 缺口不承诺恢复。
- 两域 DTO 分立（§3.3/§3.4）；origin 字面量统一 `"history" | "live"`。

### 3.2 journal 全行投影（与 JournalLine 一一闭合）

| t | kind | payload |
| --- | --- | --- |
| enqueue | `turn-enqueued` | `{ preview: SanitizedText; ordinal: number }` |
| sending/engaged/consumed/cancelled/delivered/settled/unknown | 对应 `sending`/`turn-engaged`/`turn-consumed`/`turn-cancelled`/`verdict-delivered`/`verdict-settled`/`verdict-unknown` | `{}` |
| clear | `clear` | `{ clearedCount: number }`（intentId=null） |
| response-timeout | `response-timeout` | `{ commandId: number }` |

- `ts: number|null`+`timeSource:"server-read"`；不投宿主 sentAt。未知 t/坏行→`unknown-line`/`journal-corrupt` 独立位置投影（恢复仍阻断，不洗白）。

### 3.3 HistoryEvent

```ts
interface HistoryEventBase {
  readonly seq: number; readonly ts: number | null; readonly generation: number | null; readonly intentId: string | null;
}
// kind 联合=§3.2 + §3.5 消息/异常事件；payload 判别绑定 kind
```

### 3.4 LiveEvent（C3-R03 修订：受控枚举+statusVersion）

```ts
type LiveEvent =
  | { kind: "pi-progress"; piType: PiEventType; note: ProgressNote }   // 无自由文本（模板枚举）
  | { kind: "turn-state"; statusVersion: StatusVersion; turn: TurnState }  // 携带版本防旧覆盖新
  | { kind: "process-note"; phase: "running" | "stopping" };

type PiEventType = "agent_start"|"turn_start"|"message_start"|"message_update"|"message_end"|"turn_end"|"agent_end"|"agent_settled";
type ProgressNote = "thinking" | "tool-start" | "tool-end" | "compacting" | "message-start" | "message-end";  // 受控模板；禁正文透传
```

- `liveSeq`：订阅实例内每 LiveEvent 递增（首=1）；status 帧不占；**非恢复游标**；重同步重置。

### 3.5 宿主历史读取器（C3-R04 修订：归因三元组+块键+final 映射）

`apps/server/src/host/session-reader.ts`（新组件；职责冻结）：
- 只读解析 session JSONL（完整行边界=末 `\n`；半行不判坏不发布）；消息正文投影（role/content 块）；**工具调用=宿主消息内内容块**，块键=`entryId:blockIndex`（多 toolCall 共用 entryId 时块索引分立——C3-R04）；异常行占位 `corrupt-entry`（entryId=`corrupt-<byteOffset>`）；零副作用。
- **归因规则（冻结）**：
  - **用户条目**：hash+attachmentIdentity+ordinal 三元组匹配 journal enqueue（`matchKeyOf` 同构）→携带 intentId+generation。
  - **assistant/toolResult 条目**：按代次边界邻接——consumed 行之后、下一 enqueue 之前编入的该 generation 条目归该 intentId；无可靠锚（无 journal/无 consumed/外部写者/同文重复匹配多轮）→`intentId:null` 照常输出，不猜。
  - **分支口径（声明）**：v1 投影=当前文件全量；分支切换=文件替换→换流（§1.3）。
- **final 逐项映射（冻结）**：stop→`final:true`；length→`final:true`（截断终局，previewTruncated 标注）；aborted→`final:true`（终局非成功）；toolUse→`final:false`（等待工具结果）；无 stopReason 的 user/toolCall→按角色（user 终局 true；toolCall false）。
- 消息 DTO：

```ts
| { kind: "message"; entryId: string; blockIndex?: number; role: "user"|"assistant"|"toolCall"|"toolResult"|"system";
    textPreview?: SanitizedText; stopReason?: "stop"|"length"|"aborted"|"toolUse"; toolCallId?: string; final: boolean }
| { kind: "corrupt-entry"; entryId: string }
| { kind: "unknown-line" } | { kind: "journal-corrupt" }
```

- 追加观察：指纹变→重扫；新完整行→追加流尾；前缀不符→换流。

### 3.6 快照协议（C3-R02 修订：完整 SnapshotFrame+幂等状态机）

```ts
type SubscribeFrame =
  | { t: "subscribe"; requestId: string; file: string }                                                    // 初始化
  | { t: "subscribe"; requestId: string; file: string; cursor: EventCursor }                                // 重同步
  | { t: "subscribe"; requestId: string; file: string; snapshotId: string; historyNext: EventCursor };      // 续页
interface SnapshotFrame {
  readonly requestId: string;
  readonly subscriptionId: SubscriptionId;
  readonly streamId: StreamId;
  readonly snapshotId: string;            // 本次快照实例（UUID）
  readonly barrier: number;              // H（发起时刻读索引水位；空流=0）
  readonly status: SessionStatus;
  readonly page: HistoryEvent[];          // ≤200 条且整帧 ≤200_000B（§5.6 装页）
  readonly historyNext: EventCursor | null;  // null=历史读完（本页已至 H）
  readonly liveFrom: EventCursor | null;     // 历史读完后的续读起点（=H 的 next）；未读完=null
  readonly hasMore: boolean;
}
```

**订阅状态机（冻结）**：`init → paging → live → closed`（任一态可→closed）。
- **初始化**：登记监听→截 H→缓冲 H 后事件→首页→（续页）→历史读完→自动接持续投递（history 帧续流+live 帧）。
- **续页幂等（修订，消解「必须=期待下页」vs「重复页幂等」）**：快照上下文保存**最近 2 页**（页游标+已序列化页内容缓存）；续页请求 `historyNext` ∈{期待下页, 最近已服务页}→受理（后者=幂等重发缓存内容）；其余→4404。**末页宽限**：历史读完（末页已发）后快照资源保留 60s 供网络重试幂等；之后释放→重试收 `error 4409`（streamId 仍有效；客户端按末页 cursor 直接续读即可，无需重建快照）。requestId 在途重复→4404。快照完成/退订/连接关闭→资源释放（60s 宽限起算=末页发出）。
- **重同步**：校验 cursor 域→原子终止旧订阅→新 subscriptionId→补齐→接续。域失效→4409（关联 requestId）。
- **双源屏障声明**：H=读索引水位（两源已并入）；两源各自完整行边界发布；**观察一致非跨文件事务一致**；status 独立 statusVersion。
- 快照期缓冲：H 后事件 ≤1024 帧/1MB；超→快照加速流化或 4431。
- 出帧串行化：每订阅独立有序队列+单 drain（§5.6）；请求级帧（snapshot/error）也走连接级队列（C3-R08）。

### 3.7 时序表（十三条；③⑩修正）

1. 初始化：subscribe(f)→snapshot(H=450,page[1..200],historyNext=201,hasMore)→续页×2→末页(liveFrom=451)→events(history,451..)。
2. 空流（无 journal 无 session 消息）：snapshot(H=0,historyNext=null,liveFrom=1)→events。
3. **分页间新增（修正口径）**：两源新增只可能在 H 后编入（编排保证）→历史页止于 H→接续首帧从 H+1 起（含缓冲回放）；无丢失无重复（seq 幂等）。
4. 断线续读：hello→subscribe(f,cursor{streamId,455})→补 455..H'→接续。
5. 4409（重启/截断/卸载）：旧 cursor 失配→error 4409→重新初始化。
6. 4431：缓冲超限→error+close 4431（尽力）→destroy→退避重连→cursor 补齐→追赶节流。
7. 同连接主动 resync：A 订阅中 subscribe(f,cursor)→旧订阅终止（新 id）→补齐→续。
8. A→B→A 晚到页：A 的 snapshotId 在 A 终止后失效→4404。
9. 已退订续页：4404。
10. **同页重复请求（修正）**：网络重试同页（historyNext=最近已服务页）→幂等重发缓存内容；期待下页以外的其他值→4404。
11. 历史读完与 live 交错：缓冲回放按编入序有序投递（history 帧与 live 帧可交错，各自域内有序）。
12. live 进度未落盘断线：不承诺恢复（终局以 history 补）。
13. 高生产率追赶失败：4431 有界出口（支持条件=可追赶负载）。

---

## 组4 恢复只读投影（C3-R05/R06 修订）

```ts
type RecoveryInfo =
  | { availability: "available"; report: AvailableRecovery }
  | { availability: "unavailable"; reason: "read-failed" | "concurrent-modification" | "oversized" };

interface RecoverySummary {
  readonly availability: "available" | "unavailable";
  readonly resumeBlocked: boolean | null; readonly diskBlocked: boolean | null;
  readonly unknownEffectCount: number | null; readonly unattributableFragments: number | null;
  readonly intentsCount: number | null; readonly settledCount: number | null;
  readonly evidenceHash: string | null;
}
interface AvailableRecovery {
  readonly evidenceHash: string;
  readonly resumeBlocked: boolean;          // = diskBlocked || unattributableFragments>0（权威公式原样）
  readonly diskBlocked: boolean;
  readonly blockedReasons: readonly RecoveryBlockReason[];
  readonly unknownEffect: PageOf<string>;   // ≤500/页
  readonly resumable: PageOf<string>;       // blocked 时恒空（原样）
  readonly perIntent: PageOf<IntentVerdict>;
  readonly perIntentNext: { offset: number } | null;
}
interface PageOf<T> { items: readonly T[]; total: number; returned: number; truncated: boolean; next: { offset: number } | null; }
type RecoveryBlockReason =
  | { kind: "bad-line"; count: number } | { kind: "torn-tail" }
  | { kind: "short-fragment"; count: number } | { kind: "unattributable-fragment"; count: number };
interface IntentVerdict { readonly intentId: string; readonly verdict: "settled"|"delivered"|"unknown"|"cancelled"|"not-evaluated"; readonly provisional: boolean; }
```

**perIntent 穷尽映射表（冻结；C3-R05）**：

| IntentRecord 状态 | verdict | provisional |
| --- | --- | --- |
| lastVerdict=settled/delivered/unknown | 对应值 | true 若 id∈unknownEffect（残片证据动摇终裁）；否则 false |
| 无 lastVerdict 且 sending 或 responseTimeoutRecorded===true | unknown | true |
| 无 lastVerdict 且 cancelled | cancelled | false |
| enqueue 后无 sending（未发起） | not-evaluated | false |
| id∈unknownEffect 但无 sending 无 verdict | unknown | true |

- short-fragment 无源端分类：blockedReasons 保持计数分类（归因分类归写链，读侧不造）。
- **修复后残片（修订）**：宿主修复盘面后残片证据在 journal 侧被消耗——②投影**不落新裁决**；若读索引曾编入 journal-corrupt/unknown-line 证据事件而盘面重读已无对应坏行（指纹变化+前缀投影不符该证据）→`availability:"unavailable"; reason:"concurrent-modification"`（不输出 resumable 假安全；须宿主走写链确认后重置读索引=换流）。
- **evidenceHash 输入域（冻结）**：SHA-256 over `journalFileSha256 ‖ sessionFingerprint ‖ normalizedJSON(RecoverReport 含 attributedFragments 修订集)`——**完整权威输入**（非字节偏移）；跨页固定（get-recovery 首次调用冻结，页缓存同版本）。
- **恢复分页版本（修订）**：get-recovery 首次响应冻结证据版本（evidenceHash+内容页缓存）；续页带 `evidenceHash` 参数→不符→`error 4409 retryable`（证据已变更，客户端重拉）；不带→按当前版本新快照。恢复投影读取有界（§5.6）。

---

## 组5 传输边界

### 5.1 帧协议（六客户端帧）

```ts
type ClientFrame =
  | { t: "hello"; protocolVersion: 1; token: string }
  | { t: "list-sessions"; requestId: string; offset?: number; limit?: number }
  | { t: "subscribe"; /* §3.6 三分支互斥 */ }
  | { t: "unsubscribe"; requestId: string; subscriptionId: SubscriptionId }
  | { t: "get-recovery"; requestId: string; file: string; offset?: number; evidenceHash?: string }
  | { t: "ping"; nonce: string };
```

JSON 文本帧（UTF-8）；拒二进制；禁 permessage-deflate；单帧 ≤262_144B→4404。

### 5.2 服务端帧（C3-R03：events 判别联合）

```ts
type ServerFrame =
  | { t: "welcome"; serverBootId: string; protocolVersion: 1 }
  | { t: "sessions"; requestId: string; sessions: SessionSummaryDTO[]; total: number; offset: number; hasMore: boolean; listVersion: number }
  | { t: "snapshot"; } & SnapshotFrame
  | { t: "events"; subscriptionId: SubscriptionId; origin: "history";
      refSeq: number; events: HistoryEvent[] }                                     // history 续页+快照后落盘续流
  | { t: "events"; subscriptionId: SubscriptionId; origin: "live";
      liveSeq: number; refSeq: null; events: LiveEvent[] }                         // live 旁路（无 refSeq）
  | { t: "status"; subscriptionId: SubscriptionId; status: SessionStatus }
  | { t: "recovery"; requestId: string; file: string } & AvailableRecovery         // unavailable→recovery 帧带 availability（C3-R06）
  | { t: "resync-required"; subscriptionId: SubscriptionId; reason: "server-side-gap" | "stream-replaced" }
  | { t: "error"; code: ErrorCode; message: string; retryable: boolean; requestId?: string; subscriptionId?: SubscriptionId }
  | { t: "pong"; nonce: string };
```

- recovery 帧 unavailable 分支：`{t:"recovery"; requestId; file; availability:"unavailable"; reason}`（**不退化 4402**；4402 仅 file 不存在/不可读）。

### 5.3 错误码与判别优先级（C3-R09 修订）

| 码 | 含义 | 作用域 | retryable |
| --- | --- | --- | --- |
| 4401 | 未认证或令牌无效 | 连接 close 1008 | false |
| 4402 | 会话不存在或不可读 | 请求级 | true |
| 4403 | 协议版本不匹配 | 连接 close 1003 | false |
| 4404 | 帧格式非法 | 请求级；同连接累计 3 次→close 1002 | false |
| 4405 | 只读协议拒绝写类帧 | 连接 close 1008 | false |
| 4409 | 游标过期/流已替换/证据已变更 | 请求级 | true |
| 4413 | 会话身份损坏 | 请求级 | false |
| 4429 | 订阅数超限 | 请求级 | false |
| 4431 | 慢客户端缓冲超限 | 连接 close（尽力 4431 后 destroy） | true |
| 4432 | 心跳超时 | 连接 close **1000**（正常关闭；4432 只在 error 帧标识原因） | true |

**判别优先级（冻结，逐级短路）**：
1. 未认证且 t≠"hello"→4401（hello 自身格式错→4404，不误伤合法入口）。
2. 帧格式层：**先做有界包络识别**（帧总字节≤262_144→解析 t 字符串；t 缺失/非字符串/未知→4404；字段类型/互斥违反/额外属性/超长→4404；requestId 缺失或超长→4404，**error 帧不回显恶意值**——无 requestId 即不带）。
3. **版本层**：t==="hello" 且 protocolVersion 为合法整数但 ≠1→4403（合法但不支持；不落 4404）。
4. **写类层**：t∈冻结集合 `{prompt,send,stop,resume,takeover,write,execute,spawn,kill}`→4405（**不论其余字段是否合法**——t 识别即可判，有界包络内先于字段校验；`{t:"prompt",text}`→4405 非臭 4404）。
5. 业务层：file 不存在/不可读→4402；header 损坏→4413；游标域/快照参数失效→4409/4404；配额→4429。
- 未知 t（第 2 级）与写类已知 t（第 4 级）顺序唯一；4404 累计 3 次→close 1002。

### 5.4 值级脱敏（C3-R07 修订：实测对齐+结构化+撞键消除）

**SanitizedText（结构化）**：`{ text: string; truncated: boolean }`——所有预览/标题/注记统一结构体（title/note 同样带 truncated；消除「要求置位却无字段」不一致）。

**Sanitizer 规范（冻结；顺序=NFC→剥控制→形态替换→不安全集合→截断→置位）**：
1. **剥控制**：Unicode 类别 Cc/Cf/Co/Cs+U+2028/2029，除 `\n`（折叠空格）与 `\t`（保留）。
2. **形态替换（全局多次；保证范围据实）**：
   - POSIX 绝对路径 `/(?:\/[\w@+=,.:/-]+){2,}\/?/g`→`[path]`；**单段路径（如 `/secret`、`/资料/密码` 单段形态）= 命名性内容，声明为允许透出**（向量标注「允许透出」——不宣称遮蔽所有路径样内容）。
   - Windows `C:\...`/UNC 同前版→`[path]`。
   - env 赋值/Bearer/AKIA/`ssh-rsa AAAA…`→`[env]`/`[token]`/`[secret]`。
   - **PEM 整块**：`/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g`→`[secret]`；**截断 PEM**（有 BEGIN 无 END）→`/-----BEGIN [A-Z ]+-----[\s\S]*$/g`→`[truncated-secret]`（遮到末尾，正文不泄漏）。
   - URL userinfo→`[userinfo-removed]`。
3. **不安全字符集（精确 Unicode 集合）**：RTL/双向（U+061C,U+200E-200F,U+202A-202E,U+2066-2069）与零宽（U+200B-200D,U+2060,U+FEFF）存在→整段 `[unsafe-content]`。
4. **截断**：preview 200/500、title 80、note 120（代码单元）；置 truncated。
5. **机器 ID（修订：先凭据形态、后白名单、撞键结构性消除）**：字符串 ID 字段（intentId/entryId/toolCallId/streamId 外的传输 ID）：**先跑第 2 条凭据形态替换**（AKIA… 已被替换，不会过白名单——C3-R07 实测泄漏消除）；再白名单 `/^[\w:.-]{1,128}$/`→原样；否则映射 `~id-<FNV-1a64 hex16>`（非密码学哈希；稳定关联所需）——**前缀 `~` 不在白名单字符集**，故映射输出**永不等于任何合法 ID**（撞键结构性消除）。`number` 字段（commandId/generation/ordinal）=数字安全，不映射（澄清）。
6. **受控字段诚实声明**：piType=枚举闭合（§3.4）；toolName 仅字符校验 `/^[\w:.-]{1,64}$/`（非枚举闭合，声明）；自然语言秘密不保证识别。
7. **对拍向量（人工 golden）**：`tests/fixtures/contracts/sanitizer-vectors.json` ≥36 例，含 c3 点名：`/secret`（允许透出）、中文路径（多段遮/单段允许）、UNC、Bearer、AKIA、**PEM 多行整块+截断 PEM**、URL userinfo、RTL、零宽、控制字符、**凭据形态恰为合法 ID 形状**（先替换后白名单）、**映射撞键尝试**（非法输入映射值以 `~` 开头≠任何合法 ID）、多片段混合、Unicode 截断边界、帧字节极值（262_143/262_145）。**向量期望值=人工撰写**（GLM 手写+送审 GPT 逐条审定；测试=真实现对拍人工期望，非自证）。
- UI 渲染：纯文本/受限 Markdown 白名单；无 HTML/脚本/危险 scheme。

### 5.5 认证与授权

- 静态令牌+热轮换（mtime/SIGHUP；**重载失败=保守沿用旧基准**+审计）；不匹配既有连接立即 4401 close。**初始无 token 文件=拒绝启动（fail-closed，Y04）**。24h 有效期；hello 前窗口 10s/3 帧。
- 授权域=双根目录；file 命名域+O_NOFOLLOW 等价校验；Origin 白名单（配置）；缺失 Origin=拒绝（非浏览器客户端显式配置放行列表）；非 loopback 必须 TLS；连接 16/服务、握手 10/min；token 不入日志/URL/前端持久化。

### 5.6 背压与资源预算（C3-R08/R10 修订：连接级统一+计算并发）

- **连接级统一发送队列（修订）**：每连接一个出帧队列——订阅帧（events/status/snapshot）**与请求级帧（sessions/recovery/error）都过它**；单 drain 循环（§5.6 工作预算）；出帧前序列化+字节计。队列上限：1024 帧/1MB/连接→4431（同前）。
- **在途请求上限**：每连接并发请求级操作（list/get-recovery/subscribe 初始化）≤4（超→4404）。
- **计算并发上限（修订）**：get-recovery 恢复投影与 list 目录扫描共享全局信号量 ≤2 并发；排队超 5s→`error 4409 retryable`（计算繁忙）。
- **有界读取**：恢复投影单次读取 ≤8MB（journal+session 合计）→超=`availability:"unavailable"; reason:"oversized"`；list 目录枚举 ≤1000 文件→超出 total=1000+`listReliability:"partial"`。
- **字节装页规则（修订）**：snapshot/recovery/sessions 帧组装时逐条序列化，逼近 200_000B 预算即截页（page/next 指示续拉；**不甩 4404**）；单条事件序列化 >32KB→文本字段再截断；仍超→`{kind:"unknown-line"}` 占位（计数不丢）。
- socket bufferedAmount≥4MB→destroy；drain 每轮 ≤16 帧或 ≤8ms→setImmediate；断开释放全部资源；4431 恢复=退避 1s×2 上限 60s ±20% 抖动，稳定 120s 重置；追赶 ≥50ms/页；支持条件=可追赶负载。
- 心跳：30s ping 建议；90s 无帧→close 1000+error 4432 帧尽力先发。

### 5.7 限额汇总（逐字段表=contracts.ts 冻结源）

订阅 8/连接；列表页 ≤200（默认 50；目录枚举 ≤1000）；事件页 ≤200 条且整帧 ≤200_000B；连接队列 1024 帧/1MB；bufferedAmount 4MB；帧 262_144B；连接 16；在途请求 4；计算并发 2（超时 5s）；恢复读取 8MB；恢复数组 ≤500/页；字符串上限：file ≤120（`/^[\w.-]{1,114}\.jsonl$/`）、requestId `/^[\w-]{1,64}$/`、nonce ≤64、streamId/subscriptionId/snapshotId ≤64、title 80、preview 200|500、note 120；心跳 30s/90s；连接 24h；流 LRU 32 流×20k 事件≈32MB。

### 5.8 列表分页（弱一致+C3 黄项）

- 排序=lastActiveMs 倒序，**次键=file 字典序**（稳定）；offset/limit（默认 0/50，≤200）；total/hasMore/listVersion。
- **弱一致声明**：分页间目录变化可能漏/重；listVersion 变化→UI 丢弃旧页重拉首屏（收敛）；不承诺跨页强一致。
- SessionSummaryDTO：sessionId/file/title(SanitizedText)/lastActiveMs/entryCount/sizeBytes/hasRecoveryNotice+`listReliability:"full"|"partial"`（**页级与条目级分立**：页级=目录枚举截断；条目级=单文件读取失败→该条目 listReliability:"partial" 其余正常）。

---

## §6 真代码准备包（c3 冻结门第 4 步；随本版交付）

1. `packages/protocol/src/contracts.ts`：全部 DTO+strict 运行时校验器（判别联合穷尽 `never` 断言+运行时双向校验）+`estimateFrameBytes`+逐字段限额常量（零 node 依赖）。
2. `packages/protocol/src/sanitizer.ts`：§5.4 真实现。
3. `tests/fixtures/contracts/sanitizer-vectors.json`：≥36 人工 golden 向量（期望值手写；送审逐条审定）。
4. 订阅状态机纯逻辑（subscribe/snapshot/续页幂等/重同步/生命周期）+13 时序可执行断言+非法组合拒绝测试。
5. fixtures 由真投影/序列化代码生成；schema 语义变更=版本+1 双方审记。

## §7 验收（不变+补强）

原七组+真实 E2E+零副作用断言+慢连接隔离+4431 有界出口+sanitize 全向量对拍+「第二代历史已读入」链（c1 口径）。

## §8 红项对照表

| 红项 | 闭合条款 |
| --- | --- |
| C3-R01 指纹 | §1.3 整文件 SHA-256+前缀投影比对+LRU 32×20k≈32MB 超限换流+时序③口径修正（编排保证后编入必>H） |
| C3-R02 快照幂等 | §3.6 完整 SnapshotFrame+状态机+最近 2 页缓存幂等+末页 60s 宽限+4409 出口 |
| C3-R03 线协议 | §5.2 events 判别联合（history 无 liveSeq/live 无 refSeq）+origin 统一字面量+note 受控枚举+turn-state 带 statusVersion+快照后落盘走 history 帧 |
| C3-R04 归因/块 | §3.5 三元组匹配（用户）+代次边界邻接（assistant）+blockIndex 块键+分支口径声明+final 逐项映射 |
| C3-R05 残片证据 | §4 concurrent-modification 不可用出口+evidenceHash 完整输入域+perIntent 穷尽表（含 cancelled/not-evaluated/unknownEffect-only 行）+不落新裁决 |
| C3-R06 恢复分页 | §4 evidenceHash 参数续页+4409 证据变更+PageOf 四字段+§5.6 字节装页（不甩 4404）+recovery 帧保 unavailable |
| C3-R07 脱敏 | §5.4 单段路径允许透出声明+PEM 整块/截断遮蔽+先凭据后白名单+`~` 前缀撞键消除+number 澄清+精确 Unicode 集+SanitizedText 结构化+人工 golden |
| C3-R08 请求预算 | §5.6 连接级统一队列+在途 4+计算并发 2+5s 排队超时+有界读取 8MB/1000 文件 |
| C3-R09 错误矩阵 | §5.3 版本层 4403（合法整数≠1）+有界包络先识别 t+写类不论字段 4405+4432 close 1000+requestId 缺失不回显+file 正则统一 |

## §9 c4 审定请求

1. C3-R01~R09 对照表是否实质闭合（尤其 R02 幂等状态机/R04 归因表/R05 残片出口/R07 实测形态）。
2. 真代码准备包（contracts.ts+sanitizer+人工向量+状态机测试）是否符合冻结门第 4 步要求。
3. sanitize 向量集（36+ 例人工期望）逐条审定。
4. 13 时序可执行断言覆盖是否充分。
5. 其余黄项（次键/listReliability 双级/32MB 预算/终局预览措辞/Y01/Y04）是否残留。
