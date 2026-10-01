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

- `sessionId`=pi header.id；`file`=basename 定位键：`/^[\w.-]{1,114}\.jsonl$/`（**精确规则**：basename 单段、字符集 [A-Za-z0-9_.-]、主名 1..114、后缀 `.jsonl`、整串 ≤120；与 §5.7 逐字段表一致——C3-R09）。**字符集语义**：字面 `..` 作为主名字符串合法（`a..b.jsonl` 通过——正则按字符集匹配，非路径语义）；拒绝的是**路径形态**：分隔符 `/`、`\`、绝对路径前缀（正则字符集不含分隔符即天然拒绝）；打开时 O_NOFOLLOW 等价校验（符号链接拒绝）；打开时 O_NOFOLLOW 等价校验（符号链接拒绝）。v1 单根 `sessionRoot`+`journalRoot`；journal 路径=确定函数 `file→journalRoot/<file>`。
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
- **索引预算（c5 B02+c7 C6-03 诚实口径）**：LRU ≤32 流×每流 ≤20_000 事件。**常驻=理论估算（非实测）**：仅坐标≈48B/事件，含事件投影（预览文本/身份字段）≈数百 B~2KB/事件（500 中文字预览≈1.5KB）→理论最坏 ≈1.2GB；按预览配额典型 ≈100~300MB。**触顶状态机（c7 修正）**：现流触顶→废弃换流一次（宽容额度按文件记）；**新流在预算内 `get` 恒放行**（不因历史触顶记录误拒空流）；**现流再次触顶且额度已用**→`FileOverBudgetError`（宿主转 4402；有限出口，不循环重扫）；LRU 淘汰后重建视为新流（重建流再触顶时因额度记录仍会被拒）。`append` **不设硬门**——写侧容量由宿主经 `get`/`overBudget` 检查+换流维持（接线验收项，非本层保证）；`get` 触达即 LRU 刷新；**boot 隔离**：流 ID=注入随机源 base16(16B)，不随注册序重放（跨 boot 同 s-1 假命中不可能）。
- **索引不变量（c5 B02+c8 口径对齐）**：①`append` 原子赋 seq（输入携带 seq 一律被覆盖统一——引擎/索引坐标恒一致）；②每已编入行保存**内容摘要=fnv1a64Hex(JSON.stringify([源, 定位, raw 原文]))**（c6 C5-02 实装：对 **raw 原始行**而非事件投影——投影抹平型改写也换流；read-index.ts:71），前缀比对=位置+定位+摘要三重——**同位内容改写=换流**（不只比位置）；③触顶=换流非标记。
- **编排保证（时序③口径修正）**：任何事件只在其编入时刻获得 seq>H（快照发起后编入的必然>H）——「分页间新增落 H 前」**不可能发生**；两源新增一律在快照结束后按编入序投递（history 域续读）。时序表 §3.7 已修正。
- 换流全集：服务重启；journal/session 截短/替换/重写（**内容判据=前缀比对，非 inode**：同字节换 inode（重命名/原子替换同内容）≠换流——短路同流；纯追加且换 inode=同流交接（inode-handoff-append，重挂后核对读补窗）——见 §1.3 指纹/前缀判据）；绑定重建；索引卸载。游标拒绝（c8 单模型）：streamId≠当前→4404（B01 完整游标域——错流不命中缓存）；**合法域内非期待游标（未缓存且≠expectNext）→4409**（按游标续读；引擎实现口径）；seq<1、非安全整数、非法类型→4404（格式域，勿并入业务进度域）；合法正整数>H+1（超前）→4409（§3.6 同口径）。

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
- **live 域（订阅实例内、不可重放）**：`LiveEvent` 只投进度与状态旁路；~~**v1 无正文 delta**（脱敏无法安全处理流式增量；终局正文预览以 history `message` 呈现）~~ **v1.1 修订（D1）**：新增 message-delta/message-part-end/message-final 三形——只透 assistant 正文+thinking 缺省滤（详见 §3.4 D1 语义面）。终局正文预览以 history `message` 呈现。live 缺口不承诺恢复。
- 两域 DTO 分立（§3.3/§3.4）；origin 字面量统一 `"history" | "live"`。

### 3.2 journal 全行投影（与 JournalLine 一一闭合）

| t | kind | payload |
| --- | --- | --- |
| enqueue | `turn-enqueued` | `{ preview: SanitizedText; ordinal: number }` |
| sending/engaged/consumed/cancelled/delivered/settled/unknown | 对应 `sending`/`turn-engaged`/`turn-consumed`/`turn-cancelled`/`verdict-delivered`/`verdict-settled`/`verdict-unknown` | `{}` |
| clear | `clear` | `{ clearedCount: number }`（intentId=null） |
| response-timeout | `response-timeout` | `{ commandId: number }` |
| repair | `journal-repair` | `{ repairReason: "torn-tail"; repairByteStart: number; repairByteEnd: number }`（P0-1a：宿主撕裂尾修复留痕行；replay 聚合忽略；意图 id=null） |

- `ts: number|null`（服务器读取时刻；不投宿主 sentAt；无独立 timeSource 字段——判别由读取器出口统一保证=c6 C5-07 单模型清理）。未知 t/坏行→`unknown-line`/`journal-corrupt` 独立位置投影（恢复仍阻断，不洗白）。repair 行的 byteStart/byteEnd 为被移除撕裂尾的字节区间，removedSha256/buildId/contractVersion/at 见 journal-schema（读面 repairLog 派生权威=recover.ts）。

### 3.3 HistoryEvent

```ts
interface HistoryEventBase {
  readonly seq: number; readonly ts: number | null; readonly generation: number | null; readonly intentId: string | null;
}
// kind 联合=§3.2 + §3.5 消息/异常事件；payload 判别绑定 kind
```

### 3.4 LiveEvent（C3-R03 修订：受控枚举+statusVersion；D1 扩三形）

```ts
type LiveEvent =
  | { kind: "pi-progress"; piType: PiEventType; note: ProgressNote }   // 无自由文本（模板枚举）
  | { kind: "turn-state"; statusVersion: StatusVersion; turn: TurnState }  // 携带版本防旧覆盖新
  | { kind: "process-note"; phase: "running" | "stopping" }
  // D1 直播面（docs/d1-live-stream-design.md）：pi 回复增量透传（v1.1 新增）
  | { kind: "message-delta"; part: "text" | "thinking"; contentIndex: number; delta: string }   // 节流窗内同段合并（80ms/8KiB）
  | { kind: "message-part-end"; part: "text" | "thinking"; contentIndex: number }               // 段闭锚（text_end/thinking_end）
  | { kind: "message-final"; role: "assistant"; text: string };                                  // message_end 终局全文（只 assistant）

type PiEventType = "agent_start"|"turn_start"|"message_start"|"message_update"|"message_end"|"turn_end"|"agent_end"|"agent_settled";
type ProgressNote = "thinking" | "tool-start" | "tool-end" | "compacting" | "message-start" | "message-end";  // 受控模板；禁正文透传
```

**D1 语义与安全面**（v1 「无正文 delta」修订——脱敏无法安全处理流式增量的旧约束由 D1 接管）：
- **只透 assistant 正文**：user 已知无价值；system 事件含全系统提示/工具清单不外泄（探针实证）。
- **thinking 缺省不透**（服务端聚合器过滤；开关 server 侧配置，非协议面）。
- **节流**：同 (part, contentIndex) 增量 80ms 窗合并；单帧 ≤8KiB 超长切分；单 turn 广播总量 2MiB 软上限（超限停 delta，final 仍发）。
- **disposition 门（白名单）**：只放行 delivered/buffered 两已知记账态（buffered=回复期缓冲，记账行已先落）；其余（旧代/溢出/未知态）不广播。
- **背压**：慢订阅=引擎积压门 4431（既有语义，不杀进程不断其他订阅）。
- message-final 到达=窗内残留丢弃（终局全文权威）；前端拼接以 final 为准（增量流可能缺尾，重同步不承诺恢复 delta）。

- `liveSeq`：订阅实例内每 LiveEvent 递增（首=1）；status 帧不占；**非恢复游标**；重同步重置。**帧语义（精确）**：events 帧的 liveSeq=本批末项序号——帧内首项=liveSeq-events.length+1（客户端呈现须按此回推）。`refSeq`：history 分支=本批末项 seq（帧内首项同法回推）；live 分支=**显式 null 字段**（非「无字段」——判别联合两分支均携带，序列化恒出现）。

### 3.5 宿主历史读取器（C3-R04 修订：归因三元组+块键+final 映射）

`apps/server/src/host/session-reader.ts`（新组件；职责冻结）：
- 只读解析 session JSONL（完整行边界=末 `\n`；半行不判坏不发布）；消息正文投影（role/content 块）；**工具调用=宿主消息内内容块**，块键=`entryId:blockIndex`（多 toolCall 共用 entryId 时块索引分立——C3-R04）；异常行占位 `corrupt-entry`（entryId=`corrupt-<byteOffset>`）；零副作用。
- **归因规则（冻结）**：
  - **用户条目**：hash+attachmentIdentity+ordinal 三元组匹配 journal enqueue（`matchKeyOf` 同构）→携带 intentId+generation。
  - **assistant/toolResult 条目（c6 C5-06 方向修正）**：归因区间=**[本意图 user 锚（consumed.anchorEntryId 的 entryId 字符串身份）, intervalEnd{entryId,lengthHash}]，从锚向后含两端**（`session-attribution.ts` 纯投影已落地：区间内归该 intentId；user-A/assistant-A/user-B/assistant-B 中 assistant-A 归 A——旧「向前到下一锚」方向反了）。锚=entryId 身份非行号/扫描序；终点=entryId+lengthHash 双身份（防同 id 改写伪造终点）。**不得用跨文件扫描先后当归属**。**序前置条件（c7 C5-06+c8 R3 收口，撤销「任意置换不变」过宽承诺）**：consumed 数组按 **journal 行序**给定（宿主扫描两源的调度顺序任意——纯函数收完整数组，调度置换不影响结果；但数组内部序=journal 序是前置条件，不得反转数组）；**同一意图至多一个活跃区间=最新 consumed（journal 序末项）生效，旧锚区间整体作废**（`latest.set` 覆盖；append-only journal 下 consumed 只追加、不撤销——旧锚作废不产生回改）。同意图不同锚多次 consumed（u1→a1 后 u2→a2）=归因 `[null,null,I,I]`（u1/a1 落作废区间）——**非「各区间独立生效」**（旧句作废；fixture 固化）。区间无效（锚/终点不可见、哈希不符、终点在锚前）→`intentId:null` 不猜；重叠区间=最近锚（内层）优先。**迟到更正不回改已发布事件**（发布后归属固定；更正只影响后续编入=延迟编入或永久 null）。
  - **多 toolCall 块**：同 entryId 的第 n 个 toolCall 块=块键 `entryId:blockIndex`（0 起，编入序）；toolResult 以其 toolCallId 回链（无 toolCallId 的孤儿 toolResult→`intentId:null`）。
  - **分支口径（声明）**：v1 投影=当前文件全量；分支切换=文件替换→换流（§1.3）。
- **final 逐项映射（冻结）**：stop→`final:true`；length→`final:true`（截断终局，`textPreview.truncated` 标注——SanitizedText 结构体内字段，无独立 previewTruncated 顶层字段=c6 单模型）；aborted→`final:true`（终局非成功）；toolUse→`final:false`（等待工具结果）；无 stopReason 的 user/toolCall→按角色（user 终局 true；toolCall false）。
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
- **续页幂等（修订，消解「必须=期待下页」vs「重复页幂等」）**：快照上下文保存**最近 2 页**（**完整游标键**=streamId+seq 页首+页内容缓存）；续页请求 `historyNext` 满足以下之一→受理：①=期待下页；②=最近已服务页页首（幂等重发）；③=barrier+1（**追平补页，仅 live 态**受理：空页 done=true 幂等重发；**paging 期 H+1=跳页→4409**；H=0 空流同——首页即空 done 页）。补页同样走页缓存（statusVersion 冻结于首次生成；重试不漂移）。**缓存键必须含完整游标域**（错 streamId 同 seq 不命中缓存→4404）；**页内容可复用，envelope 回显本次 requestId**（不得整帧 JSON 全等重发旧 requestId）。**游标合法域=[1, H+1]**（c9 单模型分立：格式/错流/错 snapshot→4404；seq<1/非安全整数/非法类型→4404；合法域内**未缓存且≠期待页首**→4409；**paging 期 H+1**（跳页）→4409；合法正整数 **>H+1**（超前）→4409）。
- **同连接同 file 唯一订阅目标（c5 B01）**：一连接对同一 file 至多一个活动订阅（新 subscribe 先退旧（4409 stream-replaced 通知）再建新；A/B 并存禁止；resync 失败旧订阅仍持有→新 subscribe 必须显式替换）。「同连接」配额=8 订阅且每 file 唯一；跨连接并发订阅同 file 允许（各自独立流）。**末页宽限**：历史读完（末页已发）后快照资源保留 60s 供网络重试幂等；之后释放→重试收 `error 4409`（streamId 仍有效；客户端按末页 cursor 直接续读即可，无需重建快照）。requestId 在途重复→4404。快照完成/退订/连接关闭→资源释放（60s 宽限起算=末页发出）。
- **重同步**：校验 cursor 域→原子终止旧订阅→新 subscriptionId→补齐→接续。域失效→4409（关联 requestId）。
- **错误帧路由语义（K3-B1 修订）**：`error` 帧按身份分两类——①**请求级错误**（校验失败/在途冲突/订阅时容量拒绝）：`requestId` 指认触发请求，无 `subscriptionId`；②**流终局通知**（4409 stream-replaced（同连接退旧/observe-missed/磁盘换流）；4431 订阅积压超限；4402 流终局型容量出口）：`subscriptionId` 指认所终止的流，`requestId` 恒空字符串——终局是**流**的事件，不冒充任何在途请求的失败（客户端据 subscriptionId 路由清理流状态，不误伤同 file 新快照请求）。服务端撤销旧流待发帧与终局通知的次序=**先撤后发**（cancel-then-notify：撤帧扫描按队列项文本标记匹配，先发后撤会把刚入队的终局帧一并撤走；同一同步 tick 内无 flush，先后对客户端不可见）。
- **双源屏障声明**：H=读索引水位（两源已并入）；两源各自完整行边界发布；**观察一致非跨文件事务一致**；status 独立 statusVersion。
- 快照期缓冲（c9 单模型）：订阅级待发项 ≤1024 条**且**估算字节 ≤262_144B（subscriptionBacklogBytes；按待发项数/字节双门）——超限→**唯一 4431+订阅关闭**（retryable=false；无「快照加速流化」备选出口——未实现不承诺）；1MB 归**连接级**发送队列预算（接线层），非本引擎订阅级。
- 出帧串行化：每订阅独立有序队列+单 drain（§5.6）；请求级帧（snapshot/error）也走连接级队列（C3-R08）。

### 3.7 时序表（十三条；③⑩修正）

1. 初始化：subscribe(f)→snapshot(H=450,page[1..200],historyNext=201,hasMore)→续页×2→末页(liveFrom=451)→events(history,451..)。
2. 空流（无 journal 无 session 消息）：snapshot(H=0,historyNext=null,liveFrom=1)→events。
3. **分页间新增（修正口径）**：两源新增只可能在 H 后编入（编排保证）→历史页止于 H→接续首帧从 H+1 起（含缓冲回放）；无丢失无重复（seq 幂等）。
3b. **字节装页（c5 B04+c7 C6-01 精确化）**：页边界在快照服务（servePage）内按**条数上限（200）贪心装页 → 整帧序列化实测（UTF-8）≤200_000B 终判**双约束决定——粗估仅快筛，**终判=完整帧（含 requestId/游标/冻结 status 信封）真实序列化字节**，超限退末条循环重测；首条必装（退空仍有待发数据→显式 4431，不静默空页）；`done`/`expectNext` 由**核验通过后的实装末位**决定——引擎状态（expectNext/live 化/页缓存）在核验通过后才提交。live 事件合批：每帧 ≤`maxEventsPerLiveFrame`(7) 事件（7×32k 单事件上限+信封 <262_144B 帧硬上限）；帧数（≤16/轮）与每帧事件数**分立常量**；合批帧同样先验字节再提交 liveSeq。
4. 断线续读：hello→subscribe(f,cursor{streamId,455})→补 455..H'→接续。
5. 4409（重启/截断/卸载）：旧 cursor 失配→error 4409→重新初始化。
6. 4431（订阅级）：订阅缓冲超限→error 4431+该订阅 close（retryable=false；引擎已实现：错误恰一份、closed 后无残留普通帧）→客户端新 subscribe+cursor 补齐→追赶节流。连接级 4431（队列 1024 帧/1MB）→连接 destroy→退避重连（§5.3 表分立行）。
7. 同连接主动 resync：A 订阅中 subscribe(f,cursor)→旧订阅终止（新 id）→补齐→续。
8. A→B→A 晚到页：A 的 snapshotId 在 A 终止后失效→4404。
9. 已退订续页：4404。
10. **同页重复请求（修正，c8 单模型）**：网络重试同页（historyNext=最近已服务页）→幂等重发缓存内容（新 requestId envelope+整帧终判）；**期待下页以外的其他合法域内值→4409**（跳页/过期页；按游标续读）；非法 seq→4404。
11. 历史读完与 live 交错：缓冲回放按编入序有序投递（history 帧与 live 帧可交错，各自域内有序）。
12. live 进度未落盘断线：不承诺恢复（终局以 history 补）。
13. 高生产率追赶失败：4431 有界出口（支持条件=可追赶负载）。

---

## 组4 恢复只读投影（C3-R05/R06 修订）

```ts
type RecoveryInfo =
  | AvailableRecovery        // 扁平（availability 判别字段直接携带——与 contracts.ts 单模型，c5 B07）
  | { availability: "unavailable"; reason: "read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot" };
// no-evidence-snapshot（c5 B03）：盘面曾修复且无权威证据快照——恢复结论只对快照负责（recover.ts
// RecoveryEvidenceSnapshot；capture 于任何修复动作之前），冷启动/LRU 重建无快照不得以裸读盘面出结论。

interface RecoverySummary {
  readonly availability: "available" | "unavailable";
  readonly resumeBlocked: boolean | null; readonly diskBlocked: boolean | null;
  readonly unknownEffectCount: number | null; readonly unattributableFragments: number | null;
  readonly intentsCount: number | null; readonly settledCount: number | null;
  readonly evidenceHash: string | null;
}
interface AvailableRecovery {
  readonly availability: "available";       // 判别字段必带（c6 单模型：contracts.ts AvailableRecovery 同构）
  readonly evidenceHash: string;
  readonly resumeBlocked: boolean;          // = diskBlocked || unattributableFragments>0（权威公式原样）
  readonly diskBlocked: boolean;
  readonly blockedReasons: readonly RecoveryBlockReason[];
  readonly unknownEffect: PageOf<string>;   // C6-02：单 offset 派生视图——items=本页行中 verdict="unknown" 的 ID
  readonly resumable: PageOf<string>;       // C6-02：items=本页行中 verdict="not-evaluated" 的 ID；blocked 恒空表
  readonly perIntent: PageOf<RecoveryIntentRow>;
}
<!-- C6-02（c7）：三视图由**同一 offset** 驱动——perIntent 按 recoveryPageSize(500)+整帧实测装页；
     unknownEffect/resumable 从**本页行**按 verdict 派生（不是恒整表）；total=全集权威计数；
     truncated/next 与 perIntent 同步（客户端翻完 perIntent 即拼回三全集）。任何一页帧大小有界
     （旧「整表自然有界」假设被 3000 意图=488KB 反例证伪）。blockedReasons 随整帧终判，超限=显式
     失败（null→宿主转错误帧），不静默截断。 -->
interface PageOf<T> { items: readonly T[]; total: number; returned: number; truncated: boolean; next: { offset: number } | null; }
type RecoveryBlockReason =
  | { kind: "bad-line"; count: number } | { kind: "torn-tail" }
  | { kind: "short-fragment"; count: number } | { kind: "unattributable-fragment"; count: number };
interface RecoveryIntentRow { readonly intentId: string; readonly verdict: "settled"|"delivered"|"unknown"|"cancelled"|"not-evaluated"; readonly provisional: boolean; }
// verdict 优先级（穷尽不重叠）：unknown>cancelled>settled>delivered>not-evaluated；provisional=true 仅当
// unknown 由残片归因/人工裁决派生（非耐久终态事实）。not-evaluated=无终态且非 sending/超时/取消（可重发候选）。
```

**perIntent 穷尽映射表（冻结；C3-R05）**：

| IntentRecord 状态 | verdict | provisional |
| --- | --- | --- |
| lastVerdict=settled/delivered/unknown | 对应值 | false（终态行是耐久事实；unknown 终裁行同） |
| 无 lastVerdict 且 sending 或 responseTimeoutRecorded===true（**journal 耐久记录**） | unknown | **false**（耐久观测事实派生，非残片） |
| 无 lastVerdict 且 sending 仅由**坏行残片可靠关联** | unknown | **true** |
| 无 lastVerdict 且 cancelled | cancelled | false |
| enqueue 后无 sending（未发起） | not-evaluated | false |
| id∈unknownEffect 且 verdict=unknown 由**人工裁决消耗**（consumedVerdictIds） | unknown | **true** |
（c7 C6-07 对齐 recover.ts:455-466 实装：provisional=true 仅当 unknown 由**残片可靠关联或人工裁决消耗**派生（provisionals Set）；settled/delivered/cancelled/not-evaluated 行恒 false；**耐久 sending/超时记录**派生的 unknown=false——与上表第 2 行一致，旧「sending/timeout 恒 true」表述作废）

- short-fragment 无源端分类：blockedReasons 保持计数分类（归因分类归写链，读侧不造）。
- **残片证据口径（c6 单模型）**：坏行残片不随盘面修复消失——权威载体=**RecoveryEvidenceSnapshot**（captureRecoveryEvidence 修复前捕获；recoverFromSnapshot 唯一合法出口；冷启动无快照→unavailable(no-evidence-snapshot)，`recoveryAvailability` 纯选择器可执行门）。旧「索引见过坏行/journal 侧消耗」表述作废。
- **修复后残片（c6 C5-01/C5-07 单模型修订）**：宿主修复盘面**不消耗**残片证据——权威载体=RecoveryEvidenceSnapshot（修复前捕获，bad 永久保留）；`recoverFromSnapshot` 按快照事实分派（未修复快照=diskBlocked 恒阻断+resumable 恒空；`withRepair` 标记后才进残片证据裁决）。若读索引曾编入 journal-corrupt/unknown-line 证据事件而盘面重读已无对应坏行（原始行摘要前缀不符）→`availability:"unavailable"; reason:"concurrent-modification"`（不输出 resumable 假安全；须宿主走写链确认后重置读索引=换流）。旧「journal 侧消耗」表述作废。
- **evidenceHash 输入域（c6 对齐实现+c8 排序键补全）**：`snapshotEvidenceHash`（recover.ts:520-530）=SHA-256 over `JSON.stringify([version, file, sessionId, lines, bad, attributedFragments(按 `raw` 字典序，`raw` 相同再按 `intentId` 字典序排序后), repaired])`——**完整权威快照输入域**（非字节偏移、非 journal 裸 SHA；排序=冻结编码，归因集合顺序不影响哈希；对象内部仍按其序列化字节摘要，不承诺与构造顺序无关的规范化）；跨页固定（get-recovery 首次调用冻结，页缓存同版本）。
- **恢复分页版本（修订）**：get-recovery 首次响应冻结证据版本（evidenceHash+内容页缓存）；续页带 `evidenceHash` 参数→不符→`error 4409 retryable`（证据已变更，客户端重拉）；不带→按当前版本新快照。恢复投影读取有界（§5.6）。

---

## 组5 传输边界

### 5.1 帧协议（六客户端帧）

```ts
type ClientFrame =
  | { t: "hello"; protocolVersion: 1; token?: string } // v1.1（N4-v2）：token 可选——免令牌通道（连接升级面登录会话 cookie 已验，§5.5）；呈令牌时语义不变
  | { t: "list-sessions"; requestId: string; offset?: number; limit?: number }
  | { t: "subscribe"; /* §3.6 三分支互斥 */ }
  | { t: "unsubscribe"; requestId: string; subscriptionId: SubscriptionId }
  | { t: "get-recovery"; requestId: string; file: string; offset?: number; evidenceHash?: string }
  | { t: "ping"; nonce: string };
```

JSON 文本帧（UTF-8）；拒二进制（→4403+close 1003，协议违规非帧错误）；禁 permessage-deflate；单帧 ≤262_144B→4404。

**传输接收硬门（3b-1 兼容性条款，GPT 3b-0 对齐裁定=有界双门）**：传输层接收器（ws 库）设 `maxPayload=1,048,576B` 重组兜底——超限由**接收器直接 close 1009**，畸形 UTF-8 close 1007、协议帧畸形 close 1002；这些传输层关闭**可能先于任何应用 error 帧发生（契约例外：接收器先拒可无应用 error）**。262,145B..1MiB 的合法重组文本仍走网关 4404 门（第 2 级有界包络）——应用帧上限 262,144B 不变，1MiB 绝非业务接受上限。

### 5.2 服务端帧（C3-R03：events 判别联合）

```ts
type ServerFrame =
  | { t: "welcome"; serverBootId: string; serverBuildId: string; protocolVersion: 1 } // serverBootId=进程身份（每次启动唯一）；serverBuildId=代码/构建身份（当前固定切片标识 @3b，发行接线前须替换为真实构建号——R6/3b-1 兼容条款；旧客户端忽略未知字段不受影响）
  | { t: "sessions"; requestId: string; sessions: SessionSummaryDTO[]; total: number; offset: number; hasMore: boolean; listVersion: number; listReliability: "full" | "partial" } // C6-06：页级聚合（目录级输入与条目级保守聚合：任一 partial→partial）
  | { t: "snapshot"; } & SnapshotFrame
  | { t: "events"; subscriptionId: SubscriptionId; origin: "history";
      refSeq: number; events: HistoryEvent[] }                                     // history 续页+快照后落盘续流
  | { t: "events"; subscriptionId: SubscriptionId; origin: "live";
      liveSeq: number; refSeq: null; events: LiveEvent[] }                         // live 旁路（refSeq 显式 null，非缺字段）
  | { t: "status"; subscriptionId: SubscriptionId; status: SessionStatus }
  | { t: "recovery"; requestId: string; file: string } & AvailableRecovery         // unavailable→recovery 帧带 availability（C3-R06）
  | { t: "entry"; requestId: string; entryId: string; source: "session"; digest: string;
      state: "ok" | "truncated"; blocks: EntryBlock[]; stopReason?: "stop" | "length" | "aborted" | "toolUse";
      rawBytes?: number; totalBlockCount?: number }   // D4 批②（K3 审 P2-1 修）：与 contracts.ts EntryFrame 逐字段同形；rawBytes 仅 ok 态；totalBlockCount 可选（可见块=0 时不携）；truncatedAt=块级（EntryBlock 内），帧级无此字段
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
| 4414 | entry 全文展开失败（reason 六值 stale\|unknown-entry\|oversized\|index-evicted\|not-subscribed\|in-flight；retryable=stale\|in-flight=true） | 请求级（不计数不 close，不走 4404 闸门） | reason 依档 |
| 4429 | 订阅数超限 | 请求级 | false |
| 4431（订阅级） | 订阅出帧超预算/订阅缓冲超限（1024 帧/256KB） | **订阅 close**（error 4431 后该订阅终局；连接与其余订阅不受影响） | false（该订阅已终局；恢复=新 subscribe 请求） |
| 4431（连接级） | 连接统一发送队列超限（1024 帧/1MB；接线层实现） | 连接 close（尽力 4431 后 destroy） | true（重连后原请求可续；按游标补齐） |
| 4432 | 心跳超时 | 连接 close **1000**（正常关闭；4432 只在 error 帧标识原因） | true |

**传输层优先例外（冻结）**：接收器硬门（>1MiB→1009；畸形 UTF-8→1007；协议帧畸形→1002）先于本表全部分支——接收器先拒时可不发应用 error 帧；262,145B..1MiB 合法重组文本仍归第 2 级 4404。upgrade 前拒绝（Origin 白名单/TLS 判定不合格）=HTTP 拒绝（403），不产生 WebSocket close 与应用帧。

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
1. **剥控制**：Unicode 类别 Cc+软连字符 U+00AD+U+2028/2029，除 `\n`（折叠空格）与 `\t`（保留）。**Cf 其余成员（RTL/零宽类）不剥除**——剥除会让恶意混入静默通过，一律走第 3 条整段拒绝。
2. **形态替换（全局多次；保证范围据实；c5 B05 顺序=完整语义单元先行）**——替换顺序冻结（前序规则撕碎后序语义单元是 c4 实测缺陷）：
   ① **PEM 整块**（任意大写标签 `[A-Z0-9 ]+`，含 CERTIFICATE/PRIVATE KEY 等）→`[secret]`；② **截断 PEM**（有 BEGIN 无 END）→遮到末尾 `[truncated-secret]`（正文不泄漏）；③ **env 赋值**（`KEY=value`，值可含 `/`）→`[env]`；④ Bearer→`[token]`；⑤ AKIA→`[secret]`；⑥ **ssh-rsa 公钥**（base64 可含 `/`）→`[key]`；⑦ **含 userinfo 的 URL 整条**→`[url]`；⑧ URL 整体（`scheme://…`）→`scheme:[url]`；⑨ POSIX ≥2 段路径→`[path]`（**单段路径=命名性内容，声明允许透出**——不宣称遮蔽所有路径样内容）；⑩ Windows 盘符/UNC→`[path]`。顺序理由：env 值/ssh 公钥/带凭据 URL 若先被 ⑨ 路径规则命中会被撕碎中段（c4 GPT 实测探针）。
   - 机器 ID 哈希（第 5 条）：**UTF-8 全字节折叠**（TextEncoder；`charCodeAt&0xff` 丢高 8 位致 U+0100/U+0200 整类碰撞——c4 实测），不声称 64 位无碰撞。
3. **不安全字符集（精确 Unicode 集合）**：RTL/双向（U+061C,U+200E-200F,U+202A-202E,U+2066-2069）与零宽（U+200B-200D,U+2060,U+FEFF）存在→整段 `[unsafe-content]`。
4. **截断**：preview 200/500、title 80、note 120（代码单元）；置 truncated。
5. **机器 ID（修订：先凭据形态、后白名单、撞键结构性消除）**：字符串 ID 字段（intentId/entryId/toolCallId/streamId 外的传输 ID）：**先跑第 2 条凭据形态替换**（AKIA… 已被替换，不会过白名单——C3-R07 实测泄漏消除）；再白名单 `/^[\w:.-]{1,128}$/`→原样；否则映射 `~id-<FNV-1a64 hex16>`（非密码学哈希；稳定关联所需）——**前缀 `~` 不在白名单字符集**，故映射输出**永不等于任何合法 ID**（撞键结构性消除）。`number` 字段（commandId/generation/ordinal）=数字安全，不映射（澄清）。
6. **受控字段诚实声明**：piType=枚举闭合（§3.4）；toolName 仅字符校验 `/^[\w:.-]{1,64}$/`（非枚举闭合，声明）；自然语言秘密不保证识别。
7. **对拍向量（人工 golden）**：`tests/fixtures/contracts/sanitizer-vectors.json` ≥36 例，含 c3 点名：`/secret`（允许透出）、中文路径（多段遮/单段允许）、UNC、Bearer、AKIA、**PEM 多行整块+截断 PEM**、URL userinfo、RTL、零宽、控制字符、**凭据形态恰为合法 ID 形状**（先替换后白名单）、**映射撞键尝试**（非法输入映射值以 `~` 开头≠任何合法 ID）、多片段混合、Unicode 截断边界、帧字节极值（262_143/262_145）。**向量期望值=人工撰写**（GLM 手写+送审 GPT 逐条审定；测试=真实现对拍人工期望，非自证）。
- UI 渲染：纯文本/受限 Markdown 白名单；无 HTML/脚本/危险 scheme。

### 5.5 认证与授权

- 静态令牌+热轮换（mtime/SIGHUP；**重载失败=保守沿用旧基准**+审计）；不匹配既有连接立即 4401 close。**初始无 token 文件=拒绝启动（fail-closed，Y04）**。24h 有效期；hello 前窗口 10s/3 帧。
- **per-IP 认证失败限速+退避（R6/3b-1；B1/B2=3b1c 勘定）**：键=传输层派生的有效 clientIp（无 trustProxy 时=socket 对端）；滑窗内认证失败达限（默认 10 次/60s）→封锁该 IP 的后续 hello（4401+close 1008）。**封锁期内拒绝不记账不延长**（正确/错误令牌同口径——fails/strikes/blockedUntil 均不变；到期自然恢复）；封锁时长指数退避（60s 起、封顶 10min）；认证成功即清户。**防护表硬上界 1024 条**：满表新观测先淘汰最旧非封锁项（丢失败史，活动封锁不丢）；全表封锁时按最早到期封锁项显式淘汰+审计（不静默丢也不无界增长）。正常客户端无感知。
- **代理头信任边界（部署约束）**：仅在 remoteAddress ∈ trustedProxies 时采信 X-Forwarded-For 最左段/X-Forwarded-Proto；**可信代理必须在转发时覆盖/清洗 XFF/XFP**（用户可控左端追加链不得当身份），多级代理须逐跳配置信任边界；proxied=true 时 tls 以 XFP 严格判定（socket TLS 与 XFP 混合回程不折衷）。缺头回退分立：缺 XFF → clientIp=socket 对端地址；可信代理缺 XFP → tls=false（**不回退 socket TLS**——代理已存在即外部协议事实未知，宁可保守降级）。
- 授权域=双根目录；file 命名域+O_NOFOLLOW 等价校验；Origin 白名单（配置）；缺失 Origin=拒绝（非浏览器客户端显式配置放行列表）；非 loopback 必须 TLS；连接 16/服务、握手 10/min；token 不入日志/URL/前端持久化。
- **登录会话面（v1.1/N4-v2，2026-10-05 拍板；r1 修复批+**r2 修复批**（Origin 三态门/白名单与可信代理构造期快照冻结/体流错误先写后关）收口；仅 staticDir 浏览器部署）**：同端口 HTTP 叠加 `POST /login`（JSON `{token}`）与 `POST /logout`。HTTP 面安全门：①**来源门（r2 三态）**——白名单命中放行；真缺失（无头）仅 loopback 放行（curl/健康检查）；显式异常值（"null" 字串/空串/重复头数组）一律 403——不折叠成"缺失"蹭 loopback 豁免（opaque/sandbox 来源即此形态）；②**媒体门**——Content-Type 非 `application/json`→415；③**明文门**——非 loopback 且有效传输非 TLS→403 login-tls-required（B1）。登录成功→`Set-Cookie: pi-agent-ui-session=<sid>; Path=/; HttpOnly; SameSite=Strict[; Secure]`（Secure=有效传输 TLS 事实，经 trustedProxies X-Forwarded-Proto 派生，与 WS 升级面同一 `deriveConnMeta`；clientIp=同一可信代理链派生——反代部署不再共桶）；sid=HMAC-SHA256(per-boot 32B secret, tokenDigestHex)——**cookie 不含令牌原文；服务重启（新 secret）全会话失效（fail-closed）**；登出=Max-Age=0 清除。**限速=R6 同口径真实现**（非形似）：per-IP 失败滑窗（时间戳队列 60s 窗，默认 10 失败→429）+strikes 指数退避（blockedUntil；成功即清户）；**双门复核**——限速在 body 读取前查门 1、body 读完同步复核门 2（复核→解析→校验→记账无 await 间隙，并发预开必被门 2 拦）；per-IP 在途 body 预算（默认 2，读中并发再入→429）+bodyTimeoutMs 10s→408（**r2：先写错误响应再关流**——408/413 字节真到客户端，有界关停：写完即关+1s 封顶强制）；有界表淘汰（满表先逐非封锁户；全表封锁时按最早到期封锁户显式淘汰+审计——有非封锁项时不丢活动封锁，r3 勘误条件化）。**授权面快照冻结（r2）**：allowedOrigins/trustedProxies 构造期 `Object.freeze([...])` 快照——调用方保留原数组引用热插不生效。**B3 Cookie 歧义拒**：原始头计数 Cookie 恰一头+单头内同名恰一次（早退+终值计数双道）；违者升级仍 101 但会话作废；原始 Cookie 头数 >1 才审计 upgrade-cookie-ambiguous，单头内同名重复只令 sid 为空（不审计）；login/logout 面不解析 Cookie（400 属 body 解析/形态路径，非 Cookie 歧义门；r3 勘误）。**B2 会话身份与撤销**：sid 校验时同时派生 sessionDigest（token 摘要 hex）随 meta 贯通；hello 免令牌通道**复核身份仍有效**（`tokens.hasDigestHex`——升级→reload→hello 竞态窗口闭合：轮换后旧 sid 的 hello→4401）；连接建立后 tokenDigest=真实摘要进撤销链——**热轮换即刻撤既有 cookie 连接**（4401+close 1008，与令牌通道同治）。撤销身份=真实摘要（内部撤销链标识；审计行不输出该摘要，r3 勘误）。残余风险披露（r1-C5 勘定口径，r3 收窄）：sid 同 boot 同令牌=可重放 bearer（登出只清浏览器侧 cookie，复制的 sid 至重启/轮换前仍有效；HttpOnly 禁脚本读取 cookie 但不防本站 XSS 借权或登录输入窃取；SameSite=Strict 是站点级同站拦截、非精确 Origin 匹配；来源门拦异源注入——重放面≈令牌通道）；服务端会话撤销表=后续增强（sid 失效由重启/轮换统治）。非浏览器客户端与无 staticDir 部署=令牌通道不变（双通道并存）。

### 5.6 背压与资源预算（C3-R08/R10 修订：连接级统一+计算并发）

- **连接级统一发送队列（修订）**：每连接一个出帧队列——订阅帧（events/status/snapshot）**与请求级帧（sessions/recovery/error）都过它**；单 drain 循环（§5.6 工作预算）；出帧前序列化+字节计。队列上限：1024 帧/1MB/连接→4431（同前）。
- **在途请求上限**：每连接并发请求级操作（list/get-recovery/subscribe 初始化）≤4（超→4404）。
- **计算并发上限（修订）**：get-recovery 恢复投影与 list 目录扫描共享全局信号量 ≤2 并发；排队超 5s→`error 4409 retryable`（计算繁忙）。
- **有界读取**：恢复投影单次读取 ≤8MB（journal+session 合计）→超=`availability:"unavailable"; reason:"oversized"`；list 目录枚举 ≤1000 文件→超出 total=1000+`listReliability:"partial"`。
- **字节装页规则（c7 C6-01/C6-07 分层修订）**：分三层——①**投影层**（宿主编入前）：单事件序列化 >32KB→文本字段再截断；仍超→`{kind:"unknown-line"}` 占位（计数不丢）；②**装页层**（snapshot/recovery/sessions 帧组装）：贪心逐条粗估→**整帧序列化实测终判**（≤200_000B 页预算），超限退末条循环重测（page/next 指示续拉；**不甩 4404**）；首条即超（退空仍有待发数据/单行）→**显式 4431**（纯函数返 null，宿主转错误帧；不静默空页）；③**硬帧层**：任何帧序列化 >262_144B→4431 关订阅（引擎先验后提交——liveSeq/expectNext 不推进）。
- socket bufferedAmount≥4MB→destroy；drain 每轮 ≤16 帧或 ≤8ms→setImmediate；断开释放全部资源；4431 恢复=退避 1s×2 上限 60s ±20% 抖动，稳定 120s 重置；追赶 ≥50ms/页；支持条件=可追赶负载。
- 心跳：30s ping 建议；90s 无帧→close 1000+error 4432 帧尽力先发。

### 5.7 限额汇总（逐字段表=contracts.ts 冻结源）

订阅 8/连接；列表页 ≤200（默认 50；目录枚举 ≤1000）；事件页 ≤200 条且整帧 ≤200_000B（整帧实测终判）；连接队列 1024 帧/1MB；bufferedAmount 4MB；帧 262_144B；连接 16；在途请求 4；计算并发 2（超时 5s）；恢复读取 8MB；恢复视图=单 offset 派生三视图（perIntent ≤500/页整帧实测；unknown/resumable 从本页行派生，§4）；字符串上限：file ≤120（`/^[\w.-]{1,114}\.jsonl$/`）、requestId `/^[\w-]{1,64}$/`、nonce ≤64、streamId/subscriptionId/snapshotId ≤64、title 80、preview 200|500、note 120；心跳 30s/90s；连接 24h；流 LRU 32 流×20k 事件（含投影**理论估算**≈100~300MB 典型/1.2GB 理论最坏，§1.3；触顶状态机=现流触顶+额度已用才拒）。

### 5.8 列表分页（弱一致+C3 黄项）

- 排序=lastActiveMs 倒序，**次键=file 字典序**（稳定）；offset/limit（默认 0/50，≤200）；total/hasMore/listVersion。
- **弱一致声明**：分页间目录变化可能漏/重；listVersion 变化→UI 丢弃旧页重拉首屏（收敛）；不承诺跨页强一致。
- SessionSummaryDTO：sessionId/file/title(SanitizedText)/lastActiveMs/entryCount/sizeBytes/hasRecoveryNotice+条目级 `listReliability:"full"|"partial"`（单文件读取失败→该条目 partial 其余正常）；**sessions 帧另有页级 `listReliability` 字段**（c6 C5-07 实装：本页含任一 partial 条目→"partial"；纯投影=buildSessionsFrame 字节+条数装页，单条超限→null 宿主转错误帧）。

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
| C3-R01 指纹 | §1.3 原始行字节摘要（c6 C5-02 升级：投影抹平型改写也触发换流）+前缀投影比对+LRU 32×20k（§1.3 理论口径：典型 ≈100~300MB/最坏 ≈1.2GB；触顶=同文件至多一次换流、二次=4402 拒绝）+时序③口径修正（编排保证后编入必>H） |
| C3-R02 快照幂等 | §3.6 完整 SnapshotFrame+状态机+最近 2 页缓存幂等+末页 60s 宽限+4409 出口 |
| C3-R03 线协议 | §5.2 events 判别联合（history 无 liveSeq/live refSeq 显式 null）+origin 统一字面量+note 受控枚举+turn-state 带 statusVersion+快照后落盘走 history 帧 |
| C3-R04 归因/块 | §3.5 三元组匹配（用户）+代次边界邻接（assistant）+blockIndex 块键+分支口径声明+final 逐项映射 |
| C3-R05 残片证据 | §4 concurrent-modification 不可用出口+evidenceHash 完整输入域+perIntent 穷尽表（含 cancelled/not-evaluated/unknownEffect-only 行）+不落新裁决 |
| C3-R06 恢复分页 | §4 evidenceHash 参数续页+4409 证据变更+PageOf 五字段+§5.6 字节装页（不甩 4404）+recovery 帧保 unavailable；**单 offset 派生三视图（c7 起）**——perIntent 装页驱动，unknown/resumable 从本页行派生（total=全集计数；truncated/next 随 perIntent）；c5-c6 旧「恒整表自然有界」口径**作废**（c6 探针 3000×128B=488KB 证伪） |
| C3-R07 脱敏 | §5.4 单段路径允许透出声明+PEM 整块/截断遮蔽+先凭据后白名单+`~` 前缀撞键消除+number 澄清+精确 Unicode 集+SanitizedText 结构化+人工 golden |
| C3-R08 请求预算 | §5.6 连接级统一队列+在途 4+计算并发 2+5s 排队超时+有界读取 8MB/1000 文件 |
| C3-R09 错误矩阵 | §5.3 版本层 4403（合法整数≠1）+有界包络先识别 t+写类不论字段 4405+4432 close 1000+requestId 缺失不回显+file 正则统一 |

## §9 c4 审定请求

1. C3-R01~R09 对照表是否实质闭合（尤其 R02 幂等状态机/R04 归因表/R05 残片出口/R07 实测形态）。
2. 真代码准备包（contracts.ts+sanitizer+人工向量+状态机测试）是否符合冻结门第 4 步要求。
3. sanitize 向量集（36+ 例人工期望）逐条审定。
4. 13 时序可执行断言覆盖是否充分。
5. 其余黄项（次键/listReliability 双级/32MB 预算/终局预览措辞/Y01/Y04）是否残留。

## §10 3c-1 写侧扩展指针（增补：2026-10-03，正文 v1 冻结不改写）

- v1 只读契约（本文 §1-§9）**逐字冻结不变**：写类 t 仍一律 4405+close 1008（第 4 级冻结门），`writeHost` 未接线时网关行为字节级不变（W1 回归案锁定）。
- 写侧扩展（开放面=prompt/stop 两 t；帧形/DTO/在途门/64KiB 上限）权威定义=packages/protocol/src/contracts.ts 写侧段+TECH.md B16 节；测试矩阵=tests/unit/server/ws-gateway-write.test.ts（W1-W12）；变异档=tests/fixtures/mutation-records/3c1.md。
- 本节仅作指针，冲突时以 contracts.ts 源码为准。

### §10.1 写侧身份扩展（r3a/r3b，2026-09-28 增补；正文 v1 冻结不改写）

- 开放面扩为 **prompt/stop/resume** 三 t（contracts.ts WRITE_OPEN_FRAME_TYPES）。resume{requestId,file,intentId,generation} 请求 write 面恢复重发授权与执行；应答帧=**write-resume-ack**（requestId 回带，非 4409 终局帧面）。
- **身份门序**（宿主面 rpc-write-host.resume；全部拒绝零副作用）：①无权威源→identity-rejected{no-recovery-data}（fail-closed）→②读宿主抛错→4402→③报告 null→no-recovery-data→④resumeBlocked 优先→⑤intentId∉resendAuthorized→resume-not-authorized→⑥活代≠帧代→generation-mismatch（活代 null 放行）→⑦执行面（executeFor 同快照复核+payload 读回+执行点代次重查+send；payload 读不回→execution-failed{payload-unavailable}）。
- **WriteResumeOutcomeDTO 终形**（r3b 删 execution-pending）：identity-rejected{cause}|execution-failed{payload-unavailable}|执行面七枝（launched{intentId,commandId}/busy/gate-rejected/gate-failed/invalidated/no-process/not-ready{cause?}——与 prompt 面 SessionSendResult 同构、独立声明）。launched.intentId=重发新意图；原意图关联在审计行 newIntentId；journal 不因 resume 加行型（新 enqueue 即无辜新意图，幂等由 matchKey 同文本语义保护）。
- **prompt 帧**同步加可选 generation（v1 四字段严格形不变——缺省兼容跳过校验）。
- **闸与预算**：resume 读链跨文件 ComputeSemaphore（与 get-recovery 同闸；排队超时→4409 error 帧 retryable，非 write-resume-ack）；单文件 in-flight 合并（同 file 并发读共享同次盘读）；单读合计 8MiB 预算门与 get-recovery 同源。断连口径：帧应答前断连=send 已提交不可撤（至少一次语义；write-resume-ack 可能因断连丢失但重发已生效）。
- 权威源码=packages/protocol/src/contracts.ts+apps/server/src/ws/{rpc-write-host.ts,ws-gateway.ts}+apps/server/src/composition.ts（makeResumeAuthority）；设计=docs/p0-2-write-identity-design.md §2/§2b；测试=W-res（ws-gateway-write-resume.test.ts 18 例）/W-ra（resume-authority.test.ts 10 例）/E2E A-3。

### §10.2 扩展问答透传（D3，契约 v1.2 增补；正文 v1 冻结不改写）

- 权威设计=docs/d3-ui-passthrough-design.md；协议源码=packages/protocol/src/contracts.ts D3 段。三帧+一 LiveEvent：
  - S→C `{t:"ui-request", requestId, file, method:"select"|"confirm"|"input"|"editor", title?, options?, message?, placeholder?, prefill?, timeoutMs?}`（瞬态广播，不进耐久事件流；requestId=pi extension_ui_request.id 原样）。
  - S→C `{t:"ui-closed", requestId, reason:"process-retired"|"no-subscriber"|"overflow"|"answered"}`（撤框通知；UI 按 requestId 幂等撤框）。
  - C→S `{t:"ui-answer", requestId, value?|confirmed?|cancelled?}`（三枝恰其一；非写帧：不触 journal、不经 writerEpoch）。
  - LiveEvent v1.2 `{kind:"ui-note", notifyType:"info"|"warning"|"error", message}`（即显族 notify 耐久流；setStatus 等四法 v1 不透传，审计 ui-unsupported）。
- 规则表：派发=广播给订阅 file 全部活跃连接（任意相可答）；零订阅→立即回 pi cancelled；答案=首答胜出（此后同 requestId→4404 未知或已答）；跨文件答案→4404 非订阅者；方法级校验（select→value∈options；confirm→confirmed；input/editor→value；任一法可 cancelled）违者 4404；末订阅者断开→该 file pending 全回 cancelled；进程换代→pending 全灭+ui-closed(process-retired)；每会话 pending≤8（第 9 个起立即 cancelled+overflow）；宿主不设超时（pi 侧 timeout 自治；晚答照转，pi 忽略过期 id）；ui-answer 未接线→4405。
- 实现源码=apps/server/src/runtime/rpc-session.ts（demux/handleUiRequest/answerUi/closeUiForGeneration）+apps/server/src/ws/{ui-host.ts,ws-gateway.ts}（broadcastUi*/handleUiAnswer/cancelPendingUiForFile）+apps/server/src/composition.ts（晚绑定 uiSink+answer 端口适配）；测试=tests/unit/server/{rpc-session-ui.test.ts（W-ui-s1..9）,ws-gateway-ui.test.ts（W-ui-g1..9）}。

### §10.3 运营三件（M-OPS，契约 v1.4 增补；正文 v1 冻结不改写）

- 权威设计=docs/m-ops-design.md v2；协议源码=packages/protocol/src/contracts.ts M-OPS 段。三处：
  - **prompt.model?**（写帧可选域，v1.1 generation 同式剥除+组装）：精确模型 id（LIMITS.modelPattern=`^[\w./:-]{1,128}$`，非 glob pattern；K3 实测 38/38 现役 id 全过——模型清单为活配置，计数以实测当日为准）。语义=spawn 尾追 `--model`（piArgs 序=基底+extraPiArgs+`--model` 尾追恒胜；extraPiArgs 携带 --model=拒启门禁集扩列，E-ui-0b 同式）；会话级记忆=sidecar `<file>.model`（优先级 prompt.model>sidecar>pi 默认）。运行中会话的 model 域=下次冷启动生效（换代后 spawn 尾追；本轮不生效）。
  - **get-models / models-list 帧对**（挂 list 连接）：C→S `{t:"get-models", requestId}`（两字段恰具）；S→C `{t:"models-list", requestId, models:[{provider,id,context?,thinking?}], cause?}`（失败→空表+cause，不新设错误码）。数据源=spawn `pi --list-models`（首次请求触发+进程内缓存 10min；表头列偏移+`\s{2,}` 切分+列数校验）。
  - **write-ack not-ready.detail?**：启动失败 stderr 尾行（≤500 字符+strip 控制字符；per-generation stderr ring buffer——onStderr 现状生产面未接线，本批新捕获面顺手落审计）。错误源三路=spawn-failed/spawn-exited/readiness-timeout（kind 五值不变；错模型真腿=spawn-exited 实测：spawn 即退 exit=1+stderr 单行含模型名）。**明文政策显式裁决**：write-composer「服务端自由文本永不入 DOM」姿态有意变更（知情价值>泄露风险；React 转义+strip+本机自用；M-DEPLOY 多用户面前须再评——docs/m-ops-design.md §4）。
- 新建会话（§2 面）：file 名 `ops-YYYYMMDD-HHmmss.jsonl`（同秒冲突=并入同会话，声明可接受）；新建态不发 subscribe（时序=写先行，4402=引导文案非错误）；实际落 roots[0]（resolveWithinRoots 相对名恒命中）。
- 测试=tests/unit/contracts-v14.test.ts（V1-V7 纯校验面）+后端批（清单解析/sidecar 优先序/尾追序/detail 净化）+E2E N1-N3（docs/m-ops-design.md §5；N3 断言写死 spawn-exited 路）。

### §10.4 紧凑输入区增量（v1.7/1.8/1.9；历史正文不改写）

- 用户已授权真实图片/UTF-8代码附件与已有会话下一条模型/思考级别；仅此边界允许新增服务端/协议接线。§10.3的“仅下次冷启动”是v1.4历史口径；新写服务使用独立配置RPC命名域、空闲准备租约、实际能力查询及设置后二次核实，实现下一条生效。不成功、不确定均不写用户意图；实际pi是最终权威。
- `prompt.thinkingLevel?` 为 `off|minimal|low|medium|high|xhigh|max`；`prompt.attachments?` 为8个以内的已上传不透明引用，不经WS发大base64。附件上传由同源HTTP、当前登录身份/撤销复核与小引用绑定。服务端在enqueue前固定原字节，journal `prompt-configured`保存v1配置快照；恢复重新核实身份、完整元数据、哈希、重复次数与顺序。缺对象/漂移不得退为纯文本。旧journal解析器拒绝未知种类，不依赖忽略新字段来降级；journal版本号仍3。
- **v1.9只读模型提示**：`models-list.models[]`新增可选 `thinkingLevels?: readonly ThinkingLevel[]`。至多7个、不重复、仅已知枚举；省略表示能力未知，`thinking:"yes"/"no"`绝不是级别表。原requestId/帧t/握手major=1/预算/闭合错误码不变；旧响应没有该字段仍可读，旧客户端忽略额外提示。坏字段整帧忽略，不污染前端快照。
- 提示来源：配置piBin的`--version`须严格等于本候选SDK版本0.99.2（2s/1024B输出门），随后同版本公开`ModelRuntime`与`getSupportedThinkingLevels`只读解析目录。禁模型网络刷新、不读取/修改认证、失败/版本不一致/未知模型均省略提示。清单10min缓存与单在途共享不变；它不是活会话状态，也不调用会话setter。
- UI只允许默认及明确支持的级别；不支持/未知选项禁用并解释。模型切换不静默夹低已有选择，草稿保留；完整id或唯一短名才匹配提示，歧义/默认pi身份/未列自定义均未知。真实RPC发送前再次能力确认，前端提示不能绕过后端拒绝。
- 证据面：`tests/unit/web/{thinking-picker,ws-client}.test.ts`、`tests/unit/server/{models-thinking,model-listing}.test.ts`及`tests/browser/composer-real-bridge.mjs`。真实桥保留原服务端不支持max反例：UI禁选后由同一个真实已认证native WS直接提交非法业务配置，仍须零新增enqueue/提供商请求；不是删除负例。具体通过记录见TEST-MAP；本段不宣称独立验收或真机键盘通过。
