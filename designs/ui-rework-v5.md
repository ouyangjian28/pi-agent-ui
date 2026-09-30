# UI 交互重构设计 v5（v4 按第三次复审 NO-GO 86 原位修订）

- 日期：2026-10-11
- 作者：GLM（编排 owner）
- 状态：v5 送 GPT 设计门复审（第四次）
- 前审：v1 66 → v2 82 → v3 84 → v4 NO-GO 86（报=~/ai/projects/pi-agent-ui/audits/gpt-uirework-design4-review-2026-10-11.md，残留=R4-01 P1/R4-02 P1/R4-03 P2；R3-02/R3-04 闭合不重写）
- 本稿=v4 原位修正三处：§3.1 草稿操作态与当前页面态分列+选 B 后结算行补全；§2.5 撤销计数删除充分条件、改为诚实不足分支（未确认定格）+显示收起策略；§2.8 modelChoice 合法域勘正。

## 0. 本轮补页对照（R4-01..03 → 落点）

| 审报项 | 落点 |
|---|---|
| R4-01 in-flight-away 语义冲突+选 B 结算缺行+恢复入口 | §3.1 表重写（操作态×页面态分列）+恢复规则三行 |
| R4-02 计数覆盖被反例 A/B/C 证伪 | §2.5 重写为诚实不足分支；§7 撤保证 |
| R4-03 modelChoice 合法域排除合法自定义/清单外恢复 | §2.8 勘正 |

## 1. 总纲与竞品范式（v3/v4 原文保留）

**做成一个聊天产品，不是一个仪表盘。** 核心对象=对话。主读面必须是消息不是事件日志；一切实现细节退到后台，但业务失败/未知结果/待答不可消失。

| 环节 | 现状 | 目标范式 |
|---|---|---|
| 新建会话 | 表单 | 直接开聊：新对话=输入框+模型待发配置 |
| 连接状态 | 三格常驻 | 全局健康点三档+点开明细（唯一恢复入口，R1 必需） |
| 会话列表 | 平铺 | 时间四分组+「加载更多」续页 |
| 模型 | 只在新建表单 | 新建时选待发模型；已有会话诚实入口（契约：model 仅下次冷启动生效） |
| 手机端 | 上下挤一屏 | 两视图切换，业务订阅与可见性解耦 |
| 空态 | 一行字 | 中央大输入框=新对话编辑器本体 |

## 2. 组件面

### 2.1-2.2 退役与新增（v3 原文保留）
- 退役 `NewSession` 表单壳（autoFile/readLastModel/writeLastModel/isPersistableModel/__ 哨兵守卫全部抽出保留）与 `connbar`。
- 新增 `HealthDot`（三档聚合+明细+立即重连+绿可点开+Esc/焦点归还+无纯颜色判断）、`EmptyConversation`（Welcome 合一受控编辑器）、`ConversationHeader`（全状态常驻+同源标题+换模型开新对话入口）、`Sidebar`（＋新对话+分组+续页）。

### 2.3 生命周期与状态归属（v3 原文保留）
订阅/业务操作/可见页=三套生命周期；state 归 RealApp 层（view、活动 file、draftId、草稿、重连壳层），不放重连会卸载的分支；转移规则 §3.1。

### 2.4 订阅保活（v3 原文保留）
- 同 file 返回/断点切换仅切可见性零退订；真换 file 待答显式提示；隐藏页 inert；composer 节点稳定（IME/selection/焦点不因导航丢失）。
- `useSessionDetail` cleanup 保留真换 client/file 退旧清理+提交期 file 身份门，仅换 owner 归属；呈现层不挂第二套订阅 effect。

### 2.5 主读面与直播→历史交接（R4-02 重写：诚实不足分支）

**契约事实**：现协议无消息 ID、无轮界广播（live 正文出口仅 delta/part-end/final——live-aggregator.ts:13,149-160,190-196）；`SnapshotFrame` 无 assistant 总数（contracts.ts:202-215，barrier=历史事件水位非 assistant 计数）；订阅 paging 期间 live 事件在非 live 相位不发、末页后补历史（subscription-engine.ts:181-198,273-292,314-325）；cursor 续读保留历史数组清 liveEvents（subscribe-client.ts:720-737）。因此**任何「历史已覆盖直播」的充分条件在现协议下不可证**（v4 的 N0+F≤H 公式被分页/相位门/基线未定三反例证伪，撤销）。

**规则（诚实不足分支为默认，非兜底）**：
1. **历史区照常显示**：由快照/新增耐久事件（origin=history）驱动渲染，含工具前后多 assistant 行，独立于直播区。
2. **直播区逐 final 定格**：每个 final（含零 delta 直达）产生一条独立定格条目，标「已生成（未确认入档）」。定格条目不因任何历史增量被自动删除或替换——**无自动清理**。
3. **显示收起（非删除）**：同世代内新 delta 开始时，先前定格条目收起为一行摘要（「已生成 · 前 40 字…」可点开），信息不丢、不再占主视觉。换 file/订阅重建/client 重建=清空直播区（世代切换，现规则不变）。
4. **诊断计数（可选实现）**：世代内 F（final 计数）与末页累计后 H 增量仅作诊断显示（如「本世代生成 N 条」），不作删除依据。
5. **「未确认」语义**：不仅 N0=null 场景；凡覆盖关系不可证（即恒如此）一律保持标注，直到用户离开世代或刷新。文本相同不触发任何配对（v1 红线）。
6. 诚实范围：接受直播定格与历史行可能短暂并存显示同一内容；这是零服务端改动下诚实性的代价，R2/R3 打磨时可给视觉弱化（未确认条目降透明度）而非删除。

### 2.6 列表续页（R2-05 已闭合，原文保留）
nextOffset=回帧 offset+回帧 sessions.length；去重计数与游标分域；listVersion 变→丢旧页 offset=0 重拉；刷新/换 client=新请求世代旧页不并入；短页 hasMore=true 不跳项；「已载 N/共 M」；弱一致。

### 2.7 空态文案（v3 原文保留）
桌面=「从左侧继续或直接开始新对话」；手机列表页=「点会话继续」。

### 2.8 模型双域与偏好时点（R4-03 勘正）
- **双域**：`modelChoice`（已确认选择）与 `freeText`（自定义草稿）分立。**modelChoice 合法域=`__default__` 或经 `isPersistableModel` 通过的真实模型 id（含合法自定义、重挂恢复的清单外旧值——如 gone/old；清单只提供选项，不收缩已确认域）**。freeText 非空优先（待发=freeText）；清空 freeText 只清草稿、回到 modelChoice；显式 select=放弃 freeText 并更新 modelChoice；清单迟到不覆盖用户输入/选择；清单坏项 disabled 不可选；__ 哨兵永不入帧。
- **偏好写入时点**：发起 sendPrompt 前写入合法有效选择；无效选择不写入。
- not-ready 后选「默认」重试≠清 sidecar（诚实提示保留）。

## 3. 状态与交互细则

### 3.1 页面状态与事件转移表（R4-01 重写：操作态×页面态分列）

**两列分立**（v4 缺陷修正：不再用单一「当前态」混装页面与草稿操作）：
- **页面态**（view）：`list | draft(D) | session(file)`——用户当前看哪里。
- **草稿操作态**（对每个 draft D）：`editing | sending | in-flight-away | settled-{launched|rejected|unknown}`——D 的发送事实，独立于页面。

活动 file 与订阅 owner 跟**页面态**走（session 页=该 file；draft/list 页=无新订，见行）。草稿的回执结算跟**草稿操作态**走，与页面无关。

**三门=独立副作用，并行求值**（v3/v4 保留）：
1. **记账门**：回执无条件记入 D 的操作态与目标会话；页面失配不否定记账。
2. **导航门**：仅页面意图匹配才切页；失配回执零导航副作用。
3. **清稿门**：三元身份（client×file/draftId×文本版本）匹配才清「本次已发送版本」；编辑新版本永不清。

**在途编辑策略（owner 拍板保留）**：允许发送中编辑；launched 清已发送版本、残稿带入 A 的后续 composer；在途期间「＋新对话」**新建 D2 入口禁用**——**恢复已有 D 除外**（两个动作明确分立：新建=生成新 draftId；恢复=找回既有 D/A）。

**事件转移表**（页面态 × 草稿操作态 × 事件 → 各域效果）：

| # | 页面态 | D 操作态 | 事件 | 页面下一态 | 活动 file/订阅 | D 草稿 | 列表 |
|---|---|---|---|---|---|---|---|
| 1 | list | — | 点新建/空态输入 | draft(D) | 不变 | 新 D | — |
| 2 | draft(D) | editing | 发送(v1) | 不变 | 不变 | v1 记账；编辑→v2 | — |
| 3 | draft(D) | sending | launched（意图=D） | session(A) | 订 A | 清 v1；v2 带 A composer；待发模型收起 | ✓ |
| 4 | draft(D) | sending | 拒收/未知（意图=D） | 不变（draft+叠加 rejected/unknown） | 不变 | 全文+模型保留 | — |
| 5 | draft(D) | editing（未发） | 取消/返回 | list | 不变 | 丢弃（无确认） | — |
| 6 | draft(D) | sending | **返回 list** | list | 不变 | **D→in-flight-away（v1/v2 全保留）** | — |
| 7 | list | in-flight-away(D) | launched | **list 不变**（不抢页） | **不新订 A**（记账即可，详情进入时再订） | 清 v1；D→settled-launched；v2 存 D 槽 | ✓ 新行 |
| 8 | list | in-flight-away(D) | 拒收 | list 不变 | 不变 | D→settled-rejected；全文保留 | — |
| 9 | list | in-flight-away(D) | 未知 | list 不变 | 不变 | D→settled-unknown；保留+操作身份 | — |
| 10 | list | in-flight-away/settled(D) | **恢复 D**（用户找回，非新建） | draft(D)+对应叠加（sending 仍在/已结算态） | 不变 | 恢复 v2 残稿 | — |
| 11 | list | in-flight-away(D) | **选择已有会话 B** | session(B) | **订 B**（A-owner 不自动接管） | D 冻结存槽（见行 12-14 结算） | — |
| 12 | session(B) | in-flight-away(D) | A launched | **session(B) 不变** | **保 B**（不订 A） | 清 v1；D→settled-launched；v2 残稿**一次性**带入 A 详情 composer（首次进入时） | ✓ A 新行 |
| 13 | session(B) | in-flight-away(D) | A 拒收（busy/gate/server-error） | session(B) 不变 | 保 B | D→settled-rejected；全文保留（**恢复入口=行 10，从 list 侧找回 D，与成功态无关**） | — |
| 14 | session(B) | in-flight-away(D) | A 未知 | session(B) 不变 | 保 B | D→settled-unknown；保留+操作身份（恢复入口同行 13） | — |
| 15 | session(A) | — | 手机返回/断点切 | view=list（file 仍 A） | **保活零退订** | 保留 | — |
| 16 | list(file A) | — | 点 A 重开 | view=conversation | 已订 | — | — |
| 17 | session(A)/list(file A) | — | 点会话 B | session(B) | 退 A（待答→提示） | — | — |
| 18 | session(A) | —（无在途） | 点新建 | draft(D2) | A 退订（待答提示） | D2 | — |
| 19 | 任意 | 任意 | client 替换（重连） | 态不变 | 重建订阅 | 操作身份换新 client；在途=未知留存 | ✓ |
| 20 | 任意 | 任意 | 重连完成 | view/file/草稿保留 | — | — | ✓ |

- **恢复身份规则**（行 10/12-14 配套）：恢复未 launched 的 D→以 draft(D) 身份（file 仍将用 D 的 autoFile）；恢复已 launched→进 session(A)（A composer 残稿带入只此一次，file=订阅=A）。迟到回执通则：三门独立判定；旧回执可刷列表，不把 B/新草稿抢回。
- settled-rejected/unknown 的 D 人工找回入口常驻（列表侧「未完成草稿」区），不依赖成功路径。

### 3.2 发送结果语义（v3/v4 保留，R3-02 已闭合）

| 域 | outcome | 语义 | 清稿 | 出口 |
|---|---|---|---|---|
| 服务端 DTO | launched | 已受理 | 三元匹配才清 | 进详情/列表刷新 |
| | busy / gate-rejected / identity-rejected | 明确未启动 | 保留全文+模型 | 显式重试/改配置 |
| | not-ready | 明确未启动 | 保留 | 等就绪重试；选「默认」≠清 sidecar |
| | no-process | 明确未启动（无进程） | 保留 | 显式重试（将重启进程） |
| | invalidated | 明确拒收（stdin 前） | 保留 | 重试 |
| | gate-failed | 阶段型失败 | 保守未知 | 未知流程 |
| 本地零帧 | 超长/local-invalid/not-ready/closed | 确定零副作用 | 保留（可编辑） | 改输入/重连 |
| | in-flight（同 file×prompt 拦截） | 重复拦截 | 保留 | 查看在途/等回执 |
| 已发后·连接级 | 传输失败/连接终局/长期无回执/UI 等待截止 | 未知（可能已受理） | 保留+操作身份 | 未知流程 |
| 已发后·请求级 | WriteSendError kind="server"（4402 宿主异常等；连接仍 ready） | 默认保守未知 | 保留+旧操作身份 | 未知流程；retryable 不授权自动补发；连接 ready 允许其他操作 |

- **未知流程**（统一）：提示「可能已受理」+可查看目标会话/刷新；显式二次发送须①用户确认+重复风险文案②解除本地 in-flight 槽（重建 client 或显式清槽+新操作身份）③禁自动补发/自动换 file。UI 等待截止=仅结束等待显示，不伪造协议取消。
- hook 返回结构化 outcome；`use-write.ts:163` boolean 吞稿链废除。首条/后续语义一致；prompt/stop 并行、停止仅显式。

### 3.3-3.7（v3 原文保留）
§3.3 导航与待答=§2.4/§3.1。§3.4 健康点聚合表=认证受控面优先>全 ready 绿>全终态红>其余黄；只述传输健康；手动重连提示不补发。§3.5 键盘/IME=真 onKeyDown+composing 不发+软键盘发送钮+贴底跟随+焦点/滚动恢复。§3.6 分组=四互斥组本地自然日+null/无效 Date→「更早」。§3.7 列表状态不回退=loading/empty/error/auth/closed/aria-current/同源标题/刷新/partial 可发现。

## 4. 测试策略

### 4.1 旧杀点迁移附表（v3/v4 保留，R3-04 已闭合）

| 旧簇（文件:行域） | 去向 | 新真实观察点 | 窄变异 |
|---|---|---|---|
| new-session.test 22 例·模型域 | empty-conversation+模型待发面 | 帧缺 model 键；哨兵零帧；**清单空重挂恢复自定义 id；旧合法 id+loading 永不回包→可选默认→发送帧无 model；清单后到不抹原锚**（R4-03 例并入） | model=哨兵发出；裸正则收 __；迟到覆盖锚 |
| 同上·清单生命周期 | 同上 | ready 后补拉后可选；失败手打直达 | 删 ready 补拉 |
| 同上·目录减法 | real-app 新面 | sendPrompt 恒不携 cwd；roots 订阅幂等 | 恢复 cwd 携带 |
| 同上·偏好与重挂 | 同上+§2.8 | sendPrompt 前 writeLastModel 恰一次；重挂恢复选择 | 写入时点后移/删 |
| 同上·取消与非成功 | §3.2 四态面 | rejected 保全文+重试钮 | ack=true 清稿 |
| mux-b1:267·B2 稳定 file | 新语义：重试同份不换 | 重试 file 恒定 | 重试重新生成 |
| mux-b1·autoFile/时区 | empty-conversation 面 | crypto.getRandomValues 恰 1 次；名字本地推导（双时区） | 每 render 生成 |
| mux-b1·标题/launched 补拉 | real-app 新面 | 真 AppRoot+假 socket：launched→snapshot→新行实际出现 | 漏补拉/订错 file |
| mux-b2:255-324·D04 全族 | 模型双域面 | 锚不被草稿/迟到清单覆盖；清空回锚 | 迟到覆盖锚/清空清锚 |
| mux-b2:95-140·D05a 请求结算 | ws-client 保留域 | 结算 getTimerCount===0 | 删成功 clearTimeout |
| mux-b2:95-140·D05b 消费者卸载 | 组件保活面 | 卸载后迟到回包入缓存+重挂零重发 | cleanup 错关共享 client |
| （新）订阅保活 | §2.4 保活面 | 返回零 unsubscribe/pending 不取消/隐藏页 inert | 返回触发退订 |
| （新）直播交接 | §2.5 诚实面 | **每个 final 独立定格不因历史增量删除；连续 final/零 delta/工具前后多行不互相覆盖；换世代清空；收起后可展开；未确认标注常在** | 任意「历史增量→清直播」实现复活即红 |
| （新）选 B 后结算 | §3.1 行 12-14 | D 发送→编辑→返回→选 B→注入 launched/busy/server-error：B 页三域不动+B composer 不污染+A/D 事实可查+非成功可从 list 找回 D 全文+在途可恢复 D 不可新建 D2 | 回执抢页/自动订 A/清 B |
| real-app·重连三例 | 保留不动 | 二次断线归 1 次/1s | 去退避/去归零 |
| 三客户端协议回归 | 原样保留 | — | — |

注：D05 的「零 unsubscribe」（订阅保活）与 D05b「卸载后数据请求归真 client」（WsClient 数据请求）分属两种生命周期，互不替身。

### 4.2 防假绿门（v3 原文保留+R4-02 杀点）
必杀矩阵规范性引用 v1 审报 §五+本表；浏览器验收=无 demo=1 真 RealApp+本地假 socket；390/1280×明暗；记入口/构建 ID/viewport；「帧携 model」只证携参；请求级 4402 例不得用断线例代理（连接须 ready）；**交接断言=「未证实入档的正文仍在」而非「计数或清理函数被调用」**；分页反例三态（首页部分/相位门丢 final/续页保留旧数组）各设独立例。

## 5. 施工切批（v3 矩阵保留）

| 批 | 交付 | 验收 | 回滚 |
|---|---|---|---|
| R1 核心闭环 | 新壳+HealthDot（含明细恢复）；分组+续页；两视图+保活；Welcome=同一编辑器；转移表全行+五域结果；新建模型+诚实入口+双域；主读面/二级+诚实不足交接；键盘 IME | 真模式全链；转移表逐行有例；交接杀点（连续 final/零 delta/多助手/换世代/分页三反例）；全量+tsc+窄变异+真浏览器+looker+交叉审≥85 | §5.1 |
| R2 打磨 | 信息层级/动效/reduced-motion/相对时间/高级面+未确认视觉弱化 | R1 矩阵全过+两主题+触屏键盘 | 回 R1 产物 |
| R3 可选 | 摘要预览/标题过滤/诊断显示 | 逐项独立验收 | 逐项撤 |

R1 内部提交顺序：状态所有权→新首链→可见布局→列表与消息层级。

### 5.1 回滚验法清单（原文保留）
html+asset 同切；实际加载旧构建 ID 核验；旧 asset 可取；原会话可继续；token/theme/model 键兼容；不回滚业务会话文件。

## 6. 验收门（原文保留）
每批全量绿+tsc 0+窄变异真红+真模式浏览器操作验收+looker+交叉审≥85；高分不豁免 P0/P1；终态用户实测。

## 7. 风险与边界（R4-02 撤保证后）
- 零服务端红线（越界即停）；模型真值诚实；断线不承诺保题。
- **交接诚实范围（撤 v4 保证）**：直播定格与历史行并存是常态非缺陷；前端不宣称任何覆盖/配对证明；唯一清理=世代切换；显示收起≠删除。
- 未确认条目堆积的显示负担由 §2.5-3 收起策略+R2 视觉弱化承担，不回自动删除。
