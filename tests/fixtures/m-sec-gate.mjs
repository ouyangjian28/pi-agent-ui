// M-SEC E2E fixture：permission-gate 语义子集（设计稿 docs/m-sec-design.md §3）
// 危险正则命中→confirm 问答→appendEntry 审批行→!ok 则 block。
// timeout 经 env SEC_E2E_CONFIRM_TIMEOUT_MS 注入（S3 腿用短超时；缺省不带=长等待 UI 应答）。
// 纯 JS（.mjs）——pi 用 Node 直接加载，禁 TS 语法。
export default function (pi) {
  const DANGER = /rm -rf|dd if=|curl[^|]*\|\s*bash|mkfs|chmod -R 777/;
  pi.on("tool_call", async (event, ctx) => {
    const command = String(event.input?.command ?? "");
    if (event.toolName === "bash" && DANGER.test(command)) {
      const t = Number(process.env.SEC_E2E_CONFIRM_TIMEOUT_MS ?? "");
      const ok = await ctx.ui.confirm(
        "危险命令确认",
        `\`${command}\` 放行？（E2E 测试目录，无实害）`,
        Number.isFinite(t) && t > 0 ? { timeout: t } : undefined,
      );
      pi.appendEntry("m-sec-approval", {
        decision: ok === true ? "allowed" : "denied",
        command,
        at: Date.now(),
      });
      if (ok !== true) return { block: true, reason: "用户拒绝（m-sec-gate）" };
    }
  });
}
