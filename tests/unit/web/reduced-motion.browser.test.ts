// B2 浏览器计算样式实测（不是 JSDOM 推断、不是静态字符串断言）：
// node 读 styles.css 原文字节，内存拼 data URL HTML（亮/暗两组四元素：选中列表钮/聚焦 textarea/
// 写按钮/详情 header），spawn 真实 Chromium headless shell（--force-prefers-reduced-motion --dump-dom），
// 断言 8 个元素 animationName=none 且 transitionDuration=0s。
// 教训（GPT 审 B2/N3）：静态字符串断言不足——媒体查询内低优先级选择器压不过启用侧高优先级
// 状态选择器（.session-list button[aria-current]、.write-composer:focus-within textarea），
// 只有真实引擎级联能发现；theme.test.ts 的静态断言保留为回归下限，本文件是有效性上限。
// 浏览器不存在时 skipIf 优雅跳过（CI/他机无该二进制不红）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHROME =
  "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

interface ComputedState {
  readonly group: string;
  readonly name: string;
  readonly animation: string;
  readonly transition: string;
}

/** 组内四元素：选中列表钮 / composer textarea（逐一 focus 测 :focus-within）/ 写按钮 / 详情 header。 */
const GROUP_HTML = (id: string, dark: boolean) => `
<div id="${id}"${dark ? ' data-theme="dark"' : ""}>
  <nav class="session-list"><button aria-current="page">s</button></nav>
  <div class="write-composer"><textarea></textarea></div>
  <div class="write-actions"><button>send</button></div>
  <section class="session-detail"><header>h</header></section>
</div>`;

const PROBE_SCRIPT = `
const out = [];
for (const id of ["light", "dark"]) {
  const root = document.getElementById(id);
  const ta = root.querySelector(".write-composer textarea");
  ta.focus(); // :focus-within 只在真实引擎对聚焦元素生效
  const targets = [
    ["selected", root.querySelector(".session-list button")],
    ["textarea", ta],
    ["write", root.querySelector(".write-actions button")],
    ["header", root.querySelector(".session-detail header")],
  ];
  for (const [name, el] of targets) {
    const cs = getComputedStyle(el);
    out.push({ group: id, name, animation: cs.animationName, transition: cs.transitionDuration });
  }
  ta.blur();
}
document.getElementById("out").textContent = JSON.stringify({
  reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
  states: out,
});
`;

describe("B2 减动效浏览器实测（真实 Chromium 计算样式）", () => {
  const hasChrome = existsSync(CHROME);

  it.skipIf(!hasChrome)(
    "reduce 偏好下亮/暗两组四元素 animationName=none 且 transitionDuration=0s",
    { timeout: 30_000 },
    () => {
      const css = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
      const html =
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>` +
        GROUP_HTML("light", false) +
        GROUP_HTML("dark", true) +
        `<pre id="out"></pre><script>${PROBE_SCRIPT}</script></body></html>`;
      const result = spawnSync(
        CHROME,
        [
          "--no-sandbox",
          "--disable-gpu",
          "--disable-background-networking",
          "--force-prefers-reduced-motion",
          "--dump-dom",
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(result.stdout);
      expect(m, "dump-dom 中应含探针输出").not.toBeNull();
      const probe = JSON.parse(m![1]!) as { reduce: boolean; states: ComputedState[] };
      expect(probe.reduce).toBe(true); // 减动效偏好确实生效，否则本测试无意义
      expect(probe.states).toHaveLength(8); // 亮/暗 × 四元素
      for (const s of probe.states) {
        expect(s.animation, `${s.group} ${s.name} animationName`).toBe("none");
        expect(s.transition, `${s.group} ${s.name} transitionDuration`).toBe("0s");
      }
    },
  );
});
