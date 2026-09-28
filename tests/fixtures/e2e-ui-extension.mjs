// D3-T1 E2E fixture：真实 pi 扩展（-e 显式加载，配合 --no-extensions 隔离全局扩展）。
// 场景=每轮 before_agent_start 弹 select 问答（timeout 兜底）→收到答案后 notify 回执——
// 验证宿主三透传之「问答」全链：extension_ui_request → ui-request 帧 → ui-answer →
// extension_ui_response → 扩展 resolve → notify → ui-note 帧。
// before_agent_start（非 session_start）：readiness 探针先回，问答发生在轮内（贴近真实
// permission-gate 工具确认场景），避免启动期阻塞面引入不确定性。
export default function (pi) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const v = await ctx.ui.select("E2E 扩展问答", ["甲", "乙"], { timeout: 90_000 });
    ctx.ui.notify(`e2e-ui-answered:${v === undefined ? "undefined" : v}`, "info");
  });
}
