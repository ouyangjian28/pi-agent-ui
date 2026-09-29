# M-SEC 安全扩展适配实证·设计稿 v2

> 定位=迁移就绪里程碑第三格（PROJECT 迁移链；TECH §22 承接）。**实证批**——非新面建设：
> D3 问答管道+D1 事件面+读面已建，本批装上 permission-gate 语义的 fixture 扩展，端到端
> 证明「宿主三透传」（问答/事件/记录）在真实 pi 扩展消费下成立，并暴露缺口。

## 1. 背景与定性

- TECH §22 拍板：三层防线（permission-gate 事前确认+pi-verdict 规则引擎+filter-output 事后
  脱敏）=**pi 进程内公民**（`-e` 显式加载，spawn 自然带入）；宿主不重造权限系统，只管三透传。
- 本批=第一个真实消费者画像落地：**fixture 扩展（permission-gate 语义子集）×真 pi ×UI 应答**
  的全链 E2E。装真社区扩展（npm 包）属 M-DEPLOY 后运维面——不可复现+第三方供应链风险，
  实证批不用。
- 与减法哲学（TECH §21）同构：宿主零权限逻辑；扩展在 pi 进程内自决。

## 2. 事实核验（pi 官方 extensions.md 锚点；实现唯一依据）

- `pi.on("tool_call", async (event, ctx))`：工具执行前触发，**可 block**；返回
  `{ block: true, reason?: string, terminate?: boolean }` 拦截（:814）。
- bash 输入=`event.input`（mutable）形 `{ command: string; timeout?: number }`（:820-831）；
  `event.toolName === "bash"` 判别（官方样例 :70-74=permission-gate 原型，照抄语义）。
- `ctx.ui.confirm(title, message)`→`Promise<boolean>`（对话族；经 D3 管道=extension_ui_request
  method:"confirm"→ui-request 帧→ui-answer confirmed|cancelled→extension_ui_response）。
- confirm 超时：对话族可携 timeout（rpc.md §Extension UI；agent 侧到点自答、不通知 client，client 无需跟踪）。**confirm() 超时返回 false**（extensions.md Timed Dialogs 节；undefined 是 select/input 的返回值）→扩展按 falsy 走拒绝分支。
- `pi.appendEntry(customType, data)`：审批记录落会话 JSONL（custom 行，不进 LLM 上下文）；行形 `{"type":"custom","customType":"m-sec-approval","data":{...}}`。
- 事件面现状（K3 审勘误；如实登记）：**tool_execution_* 无直播透传**（LiveEvent 合同无此种类；live-aggregator 只产 message 族——摘要面 pi-progress 未建=缺口候选，M-OPS 后议）；**extension_error 全仓零透传点**（本批 fixture 正常运行不触发，零断言；同登记缺口候选）。两者均非本批依赖面。
- **读面边界（如实声明）**：custom 行在扫描面投影=unknown-line 跳过（sessionToScanRows 只投
  message 行；D4 entry 面同）。审批记录的 UI 面板=观感面，M-OPS 后按日用痛点再议；本批审批
  行证据=**E2E 层直接 readFile 断言会话文件含 appendEntry 行**（不依赖 UI 投影）。

## 3. fixture 扩展设计（tests/fixtures/m-sec-gate.mjs）

```
export default function (pi) {
  const DANGER = /rm -rf|dd if=|curl[^|]*\|\s*bash|mkfs|chmod -R 777/;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && DANGER.test(String(event.input?.command ?? ""))) {
      const t = Number(process.env.SEC_E2E_CONFIRM_TIMEOUT_MS ?? "");
      const ok = await ctx.ui.confirm("危险命令确认", `\`${event.input.command}\` 放行？`,
        Number.isFinite(t) && t > 0 ? { timeout: t } : undefined);
      pi.appendEntry("m-sec-approval", { decision: ok === true ? "allowed" : "denied", command: event.input.command, at: Date.now() });
      if (ok !== true) return { block: true, reason: "用户拒绝（m-sec-gate）" };
    }
  });
}
```

- env 在 handler 内每次读（spawn 默认继承父 env——process-host.ts 不传 env 项；S3 腿内 set/腿后 delete 隔离，防泄漏污染他腿复跑）。

- 正则=源档 permission-gate 危险模式子集（实证够用）；命中→confirm 问答→appendEntry 审批行
  （allowed/denied 两态）→!ok 则 block。
- timeout 经 env `SEC_E2E_CONFIRM_TIMEOUT_MS` 注入（S3 腿用短超时；缺省不带=长等待 UI 应答）。
- 加载=`--no-extensions -e tests/fixtures/m-sec-gate.mjs`（E-ui-4 同式；隔离全局扩展）。

## 4. E2E 腿设计（tests/integration/m-sec-e2e.test.ts；PI_E2E=1 门=真调 LLM 三轮）

装置=startServer（write 段 piBin+extraPiArgs fixture 注入）+真 ws+订阅；prompt 用极明确指令
（「用 bash 工具执行这个精确命令：…」，模型照做率高；/tmp 无害路径）。

- **S1 放行链**：预造 `/tmp/m-sec-probe-dir`（touch 文件）→prompt「bash 执行
  `rm -rf /tmp/m-sec-probe-dir`」→断言链：①ui-request 帧（method=confirm）到达；②ui-answer
  confirmed 回写 stdin；③probe 目录**真被删**（执行证据——放行后命令落地）；④会话文件含
  `customType:"m-sec-approval"` 行且 `data.decision=allowed`；⑤会话文件含 bash 工具调用的
  toolResult 行（与 ④ 同法 readFile 断言——tool_execution 直播透传=未建面，勿锚）。
- **S2 拒绝链**：prompt 同式（probe2 目录）→ui-answer cancelled→断言：①probe2 目录**仍在**
  （block 证据）；②会话文件审批行 decision=denied；③后续轮正常收尾（stop 收口，agent 收到
  blocked 工具结果继续对话——不挂死）。
- **S3 超时自答链**：腿内 `process.env.SEC_E2E_CONFIRM_TIMEOUT_MS="2000"`（腿后 delete）起
  server→prompt 同式（probe3）→UI **不应答**→断言：①probe3 仍在（confirm 超时返 false→拒绝
  分支）；②审批行 data.decision=denied；③轮正常收口不卡死；④**现状如实断言**：超时后无
  ui-closed 帧+宿主 pendingUi 残留至换代（pi 侧自答不通知 client；宿主删除仅 answerUi/换代两路
  无超时自清）——**已知缺口登记 PENDING**（问答框滞留 UI 观感面，M-OPS 后另立批）。
- 证据面注：S1/S2/S3 各起独立 server+会话（目录独立；S3 置末腿+env 腿内 set/delete 隔离）。
  三腿 until 超时分支输出诊断（message-final 正文+会话文件 tail）——区分「模型不配合」与
  「管道断」（prompt 附「这是 E2E 测试，目录为预造空目录」卸阻力）。

## 5. 测试计划与变异面

- 单测：无新增（fixture 纯 pi 侧；宿主零改动面）。E2E 三腿即测试面。
- 变异（基线提交后）：Mu-s1 fixture 正则恒 false→S1 无问答直接执行（ui-request 不到达）红；
  Mu-s2 confirm 分支反转（!ok→放行）→S2 目录被删红；Mu-s3 appendEntry 删→S1 ④断言红。
- 验收：三腿全绿+变异 3/3+TEST-MAP M-SEC 节+发现缺口（若有）修复闭环。
- 成本：真调 LLM 三轮（小 prompt）；PI_E2E=1 手动门与既有 E-ui-4/composed 同。

## 6. 不做面（边界声明）

- 不装真社区扩展（npm supply-chain+不可复现）；不做审批记录 UI 面板（custom 行投影=既有
  unknown 边界，观感面 M-OPS 后议）；不做 pi-verdict 多选项渲染实证（select 四法 D3 已测，
  E2E 真腿复用 confirm 即可代表对话族）；filter-output=pi 进程内透明零需求（TECH §22 表），
  其透传无阻碍已由 S1 ⑤（工具输出经事件流到达）覆盖。
- 宿主源码**预期零改动**；若 E2E 暴露缺口（如 confirm 超时与宿主 UI_PENDING 生命周期打架）
  →缺口修复另立批+回归。
