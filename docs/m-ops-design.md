# M-OPS 运营三件·设计稿 v1

> 定位=迁移就绪里程碑倒数第二格（PROJECT 迁移链）。三件=新建会话+模型下拉+错模型响亮报错。
> 实证基础（PROJECT M-SEC 收口节摸底）：真壳无新建入口；写面对全新 file 首 prompt 即建 journal
> 宣誓+起 pi（后端零改动面）；pi --list-models=39 行固定列宽表格；启动失败=write-ack
> not-ready{cause?}（stderr 细节留审计不透传 UI）。

## 1. 范围与不做面

- 做：①新建会话前端入口+全链；②模型下拉（契约 v1.4 prompt.model+服务端 models 清单面+
  spawn 尾追 --model）；③错模型响亮报错（not-ready 细节透传+前端红条）。
- 不做：会话内切模型（pi 会话文件自带模型记忆，换模型=新会话——交互从简）；模型健康探测；
  多 provider 路由配置面（pi models.json 已管）；M-DEPLOY 面（build/systemd/tunnel）。

## 2. 新建会话（前端批为主，后端零改动声明+验证）

- 真壳 SessionList 头加「＋新建」→生成 file 名（`ops-YYYYMMDD-HHmmss.jsonl`，同秒冲突
  极低+filePattern 合规）→进入新建态：工作目录提示（当前 roots 只读展示）+模型下拉+composer。
- 首条 prompt 发出=写面自动建 journal 宣誓+起 pi（既有链，E2E 已证）。**订阅面时序**：新
  file 无 journal→load null→subscribe 得 4402「会话不可读」——新建态 UI 不发 subscribe，
  首条 write-ack launched 后再 subscribe（时序=写先行）。4402 不算错误面（新建态引导文案）。
- E2E 腿 N1：全新 file 首条消息全链（新建态→prompt→write-ack launched→事件流→第二轮消息）。

## 3. 模型下拉（契约 v1.4+服务端清单+spawn 透传）

- **契约 v1.4**：`prompt` 帧加可选 `model?: string`（校验：`/^[\w.\/:-]{1,128}$/`——
  provider/id 形+thinking 后缀容忍；非法→4404 帧）。stop/resume 不加（会话级模型）。
- **服务端清单面**：新服务帧 `models-list`（welcome 后由客户端 `get-models` 请求触发，或
  首次 prompt 前拉取）：`{t:"models-list",requestId,models:[{provider,id,context,thinking}]}`。
  数据源=spawn `pi --list-models`（启动后首次请求触发+进程内缓存 10min；spawn 失败→空表+
  cause；解析=固定列宽 split）。闭码面同步：errorTextFor/分派 switch/KNOWN_ERROR_CODES 不涉
  及（新帧不涉错误码）；客户端 keyed 载入+下拉渲染。
- **spawn 透传**：rpc-session spawn 参数在 extraPiArgs 之后追加 `--model <id>`（last-wins
  与 extraPiArgs 禁改语义兼容——forbidden Set 只拦 --mode/--session/--session-id，--model
  可被 extraPiArgs 覆盖属部署方权限，默认面=prompt.model）。会话级：首 prompt 带 model→
  registry 记住→该 file 后续 spawn 沿用（进程重启同模型）。
- **前端**：新建态模型下拉（models-list 数据+free-text 兜底「手动输入」）；选中→首 prompt
  帧带 model 字段。
- E2E 腿 N2：prompt 带 model → spawn 断言参数含 `--model <id>`（FakeRpcHost spawn 断言
  面，E-ui-0b 同式）。

## 4. 错模型响亮报错（not-ready 细节透传+前端红条）

- **服务端**：WriteSendOutcomeDTO not-ready 加可选 `detail?: string`（spawn/readiness 失败
  的 stderr 尾行，≤500 字符+strip 控制字符；模板注入面=前端 React 文本渲染天然转义）。
  readiness-timeout/readiness-failed 两路接 stderr 聚合。审计行照旧全量。
- **前端**：write-ack not-ready→会话面板顶部红条（role=alert）+detail 折叠展开+「重试/
  换模型新建」两按钮。现状 UI 对 not-ready 静默（compose 输入框无反馈）。
- E2E 腿 N3：错模型（model="nonexistent-model-xyz"）prompt→not-ready+detail 含模型名/
  报错文本（真 pi 腿——错误输出形需实测先行：pi 对非法 --model 是 spawn 即退还是
  readiness 超时，实现批首跑定性）。

## 5. 测试计划与验收

- 单测：模型清单解析（列宽 split 边界）/prompt.model 校验正则/registry 会话级模型记忆/
  not-ready detail 截断+净化/rpc-session spawn 尾追序。
- E2E：N1 新建全链+N2 spawn 断言（FakeRpcHost）+N3 错模型真腿（PI_E2E=1）。变异面：
  Mu-o1 spawn 尾追删→N2 红/Mu-o2 not-ready detail 剥离→N3 红/Mu-o3 prompt.model 校验
  死→非法模型 4404 不回红。
- 分工：GLM 后端（契约+清单+透传+detail）→Kimi 前端（新建入口+下拉+红条）→互审 ≥85。
- 验收：三腿绿+变异 3/3+全仓绿+三包 tsc 0+TEST-MAP 节。

## 6. 风险与裁决记录

- pi 对非法 --model 的失败面未实测（spawn 即退 vs readiness 超时）→N3 实现批首跑定性，
  设计面两者都收敛到 not-ready{detail}。
- models-list 缓存 10min：新装 provider 不即时反映——运营可接受（重连/重启刷新）。
- 会话级模型（非 per-prompt）：换模型=新会话——交互从简拍板，异议留观。
