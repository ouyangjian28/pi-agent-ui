# M-OPS 运营三件·设计稿 v2

> v2（2026-10-10）：K3 审 78 NO-GO 修复轮（审报归档 audits/k3-mops-design-review-2026-10-10.md）——
> P1-1 spawn 顺序拍板=尾追恒胜+禁集扩列/P1-2 sidecar 持久化/错误源三路正名/明文政策显式裁决/
> 闭码面清单七处补全/非法 --model 实测定性 spawn 即退。
> 定位=迁移就绪里程碑倒数第二格（PROJECT 迁移链）。三件=新建会话+模型下拉+错模型响亮报错。
> 实证基础（PROJECT M-SEC 收口节摸底）：真壳无新建入口；写面对全新 file 首 prompt 即建 journal
> 宣誓+起 pi（后端零改动面）；pi --list-models=39 行固定列宽表格；启动失败=write-ack
> not-ready{cause?}（stderr 细节留审计不透传 UI）。

## 1. 范围与不做面

- 做：①新建会话前端入口+全链；②模型下拉（契约 v1.4 prompt.model+服务端 models 清单面+
  spawn 尾追 --model）；③错模型响亮报错（not-ready 细节透传+前端红条）。
- 不做：会话内切模型（RPC 复活不回放模型+单会话单模型语义清晰，探针实测锚）；模型健康探测；
  多 provider 路由配置面（pi models.json 已管）；M-DEPLOY 面（build/systemd/tunnel）。

## 2. 新建会话（前端批为主，后端零改动声明+验证）

- 真壳 SessionList 头加「＋新建」→生成 file 名（`ops-YYYYMMDD-HHmmss.jsonl`，同秒冲突
  极低+filePattern 合规）→进入新建态：工作目录提示（实际落 roots[0]——文案明示）+模型
  下拉+composer。
- 同秒文件名冲突语义=两新建态并入同一 session file（filePattern 已兼容）——声明可接受。
- 首条 prompt 发出=写面自动建 journal 宣誓+起 pi（既有链，E2E 已证）。**订阅面时序**：新
  file 无 journal→load null→subscribe 得 4402「会话不可读」——新建态 UI 不发 subscribe，
  首条 write-ack launched 后再 subscribe（时序=写先行）。4402 不算错误面（新建态引导文案）。
- 首 prompt 前断线：既有 view.ready 禁用面已覆盖（write-composer.tsx:106），无需新做。
- E2E 腿 N1：全新 file 首条消息全链（新建态→prompt→write-ack launched→事件流→第二轮消息）。

## 3. 模型下拉（契约 v1.4+服务端清单+spawn 透传）

- **契约 v1.4**：`prompt` 帧加可选 `model?: string`（校验正则 `^[\w./:-]{1,128}$` 不变——
  K3 实测 39/39 id 全过、\w 含大写；注释声明只收精确 id 非 glob pattern；非法→4404 帧）。
  stop/resume 不加（会话级模型）。
- **服务端清单面**：新帧对 `get-models`（客户端发，挂 list 连接 wsClient——三连接分立面
  real-app.tsx:167-169）→服务端回 `models-list`
  `{t:"models-list",requestId,models:[{provider,id,context,thinking}]}`。数据源=spawn
  `pi --list-models`（首次请求触发+进程内缓存 10min；spawn 失败→空表+cause；解析=表头列
  偏移定位+`\s{2,}` 切分+列数校验，非脆弱固定列宽）。
  **同步面清单（七处，K3 P2-3 补全）**：①ClientFrame union 加 get-models；②validateClientFrame
  校验（requestId 恰具+无多余字段）；③ServerFrame union 加 models-list；④网关帧分派 switch
  加 case get-models+in-flight ≤4 槽位口径（与既有 inFlightRequestsPerConn 同面）；⑤客户端
  subscribe-client parsed.t case 显式分支（**default=静默丢弃，漏了帧即丢**）；⑥客户端 keyed
  载入+下拉渲染；⑦docs/ws-ui-contracts-v1.md v1.4 节。errorTextFor/KNOWN_ERROR_CODES 不涉
  （无新错误码）——K3 核实为真。
- **spawn 透传（P1-1 拍板：尾追恒胜+禁集扩列）**：piArgs 序=基底+extraPiArgs+`--model <id>`
  尾追（last-wins ⇒ prompt.model 恒胜）；同时 **--model 加进 extraPiArgs forbidden Set**（携带
  即拒启门，与 --mode/--session 同构，E-ui-0b 同式加腿）——部署方 --model 死配置应响亮报错
  而非静默被覆盖。
- **会话级模型记忆（P1-2 拍板：sidecar 持久化）**：写面首 prompt 带 model 时落 sidecar
  `<file>.model`（同目录一行=model id）；后续 spawn（换代/server 重启后）读 sidecar 补
  --model；优先级=prompt.model（更新 sidecar）> sidecar > pi 默认。registry 保留进程内 Map
  作快路径。UI 显示当前模型不下发订阅面（留观，非本批）。
- **前端**：新建态模型下拉（models-list 数据+free-text 兜底「手动输入」）；选中→首 prompt
  帧带 model 字段。
- E2E 腿 N2：prompt 带 model → spawn 断言参数含 `--model <id>`（FakeRpcHost spawn 断言
  面，E-ui-0b 同式）。

## 4. 错模型响亮报错（not-ready 细节透传+前端红条）

- **服务端**：WriteSendOutcomeDTO not-ready 加可选 `detail?: string`。错误源三路（K3 P2-1
  正名；kind 五值=spawn-failed/spawn-exited/readiness-timeout/superseded/not-running，错模型
  真腿=spawn-exited 实测）：per-generation stderr ring buffer（尾部 N 行；onStderr 接线——
  现状生产面未接线 stderr 直丢，本批新捕获面顺手落审计），失败时取尾行 ≤500 字符+strip 控制
  字符。
- **明文政策显式裁决（K3 P2-2）**：write-composer.tsx 头部既有政策「服务端自由文本（error.message、
  not-ready.cause）永不入 DOM」——本批 detail 透传=**有意变更该姿态**。裁决理由：模型错误文案
  是用户可操作修复线索（换模型/改模型名），知情价值>泄露风险；控制面=React 文本节点转义+
  ≤500 strip 控制字符+仅本机自用（M-DEPLOY 多用户面前须再评，落 §6）。前端实现时头部政策注释
  同步改写并引本节。
- **前端**：现状更正=UI 对 not-ready 非静默，已有受控文案「未入队：会话未就绪」（role=status
  结果行）。本批升级=write-ack not-ready→会话面板顶部红条（role=alert）+detail 折叠展开+
  「重试/换模型新建」两按钮。
- E2E 腿 N3：错模型（model="nonexistent-model-xyz"）prompt→not-ready+detail 含模型名
  （真 pi 腿 PI_E2E=1；已定性 spawn 即退 exit=1+stderr 单行——两审探针一致，断言直接写死
  spawn-exited 路）。

## 5. 测试计划与验收

- 单测：模型清单解析（表头列偏移+`\s{2,}`+列数校验边界）/prompt.model 校验正则/sidecar 读写
  与优先级（prompt>sidecar>默认）/not-ready detail 截断+净化（三路 kind）/rpc-session spawn
  尾追序/forbidden Set --model 拒启门。
- E2E：N1 新建全链+N2 spawn 断言（FakeRpcHost）+N3 错模型真腿（PI_E2E=1，断言写死
  spawn-exited 路+detail 含模型名）。变异面：Mu-o1 spawn 尾追删→N2 红/Mu-o2 not-ready
  detail 剥离→N3 红/Mu-o3 prompt.model 校验死→非法模型 4404 不回红/Mu-o4 detail 控制字符
  净化删→断言红（K3 建议加）。
- **E2E 实交同步（2026-10-10，Kimi 审 P2-1）**：实交=七腿真 composition+假 pi
  （tests/integration/m-ops-e2e.test.ts+fixture mops-fake-pi.mjs 五模式），非上述原计划。
  映射：N2 spawn 断言→腿2（argv 尾两值+sidecar，真进程面取代 FakeRpcHost）；N3 错模型
  →腿3a（假 pi exit 模式，替换 PI_E2E=1 真 pi 腿——替代理由=①假 pi 常跑无门可进 CI
  常规套件（真 pi 腿 PI_E2E=1 门历史上极少开）；②确定性：坏模型 stderr 面可精确驱动；
  ③正是它钓出 P1 语义缺口——真 pi 探针往返已有 pi-child.smoke 覆盖不重复）。N1 新建
  全链→前端消费面已有 real-app 假链覆盖（E2E 增量在服务端装配面，不重验）；
  超出原计划的腿：1/1b 清单链/3b ENOENT/3c 超时/4 4405。变异实交 Mu-e1..e4 见 TEST-MAP
  M-OPS E2E 批节。
- 分工（K3 建议采纳：契约先行冻结→两批并行）：GLM 契约批（v1.4 三处=prompt.model+
  get-models/models-list+not-ready.detail→K3 审单点）→GLM 后端批（清单服务+spawn 透传+
  sidecar+stderr 聚合+网关 case）∥Kimi 前端批（新建入口+下拉+红条+sendPrompt 形参）→E2E/
  变异批 GLM 主。互审 ≥85。
- 验收：三腿绿+变异 4/4+全仓绿+三包 tsc 0+TEST-MAP M-OPS 节。

## 6. 风险与裁决记录（v2）

- ~~非法 --model 失败面未实测~~已实测关闭：spawn 即退 exit=1+stderr 单行
  `Error: Model "xxx" not found. Use --list-models...`（干净无敏感；两审探针一致）。
- detail 透传的 M-DEPLOY 面：stderr 可能含路径/环境信息，多用户部署前须再评（裁决见 §4）。
- models-list 缓存 10min：新装 provider 不即时反映——运营可接受（重连/重启刷新）。
- 会话内切模型不做：理由换锚=RPC 复活不回放模型（K3 探针二：--model deepseek 起的会话，无
  --model 重启回落全局默认 litellm/glm-5.3）+单会话单模型语义清晰。
- 同秒文件名冲突：冲突语义=两新建态并入同一 session file（filePattern 已兼容）——声明可接受。
- 新会话落地根：resolveWithinRoots 相对名恒命中 roots[0]——新建态文案明示「实际落第一个根」。
- 首 prompt 前断线：既有 view.ready 禁用面已覆盖（write-composer.tsx:106），无需新做。
- get-models 承载连接：挂 list 连接（wsClient）——三连接分立面（real-app.tsx:167-169）。
