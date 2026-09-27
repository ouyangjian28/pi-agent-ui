// B2 浏览器计算样式实测（不是 JSDOM 推断、不是静态字符串断言）：
// node 读 styles.css 原文字节，内存拼 data URL HTML，spawn 真实 Chromium headless shell
// （--force-prefers-reduced-motion --dump-dom），亮/暗分两份独立文档——主题挂在 <html data-theme>
// （:root[data-theme="dark"] 级联要求根元素，N7：旧版写在普通 div 上暗组从未激活），
// 断言每组四元素（选中列表钮/聚焦 textarea/写按钮/详情 header）animationName=none 且
// transitionDuration=0s，并断言根 --c-bg 双主题取值不同（证明主题真的切了，防两组同色假覆盖）。
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

/** 四元素骨架：选中列表钮 / composer textarea（逐一 focus 测 :focus-within）/ 写按钮 / 详情 header。 */
const GROUP_HTML = `
<nav class="session-list"><button aria-current="page">s</button></nav>
<div class="write-composer"><textarea></textarea></div>
<div class="write-actions"><button>send</button></div>
<section class="session-detail"><header>h</header></section>`;

const PROBE_SCRIPT = `
const out = [];
const ta = document.querySelector(".write-composer textarea");
ta.focus(); // :focus-within 只在真实引擎对聚焦元素生效
const targets = [
  ["selected", document.querySelector(".session-list button")],
  ["textarea", ta],
  ["write", document.querySelector(".write-actions button")],
  ["header", document.querySelector(".session-detail header")],
];
for (const [name, el] of targets) {
  const cs = getComputedStyle(el);
  out.push({ group: document.documentElement.dataset.theme ?? "light", name, animation: cs.animationName, transition: cs.transitionDuration });
}
ta.blur();
document.getElementById("out").textContent = JSON.stringify({
  reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
  bg: getComputedStyle(document.documentElement).getPropertyValue("--c-bg").trim(),
  states: out,
});
`;

/** 单主题整档：data-theme 挂 documentElement（与 ThemeToggle/theme.ts 生产行为一致）。 */
const buildDoc = (css: string, theme: "light" | "dark") =>
  `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
  GROUP_HTML +
  `<pre id="out"></pre><script>${PROBE_SCRIPT}</script></body></html>`;

/** 跑一份主题档并返回探针结果（reduce 必须为真，否则本测试无意义）。 */
function probeTheme(theme: "light" | "dark") {
  const css = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
  const result = spawnSync(
    CHROME,
    [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--force-prefers-reduced-motion",
      "--dump-dom",
      `data:text/html;charset=utf-8,${encodeURIComponent(buildDoc(css, theme))}`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(result.stdout);
  expect(m, "dump-dom 中应含探针输出").not.toBeNull();
  const probe = JSON.parse(m![1]!) as { reduce: boolean; bg: string; states: ComputedState[] };
  expect(probe.reduce).toBe(true);
  return probe;
}

describe("B2 减动效浏览器实测（真实 Chromium 计算样式，亮/暗分档挂根）", () => {
  const hasChrome = existsSync(CHROME);

  it.skipIf(!hasChrome)(
    "reduce 偏好下亮/暗两档（:root[data-theme]）四元素 animationName=none 且 transitionDuration=0s",
    { timeout: 60_000 },
    () => {
      const light = probeTheme("light");
      const dark = probeTheme("dark");
      // N7：先证主题真切换（根令牌取值不同），再谈关停——防「两组同色」假覆盖
      expect(light.bg).not.toBe(dark.bg);
      for (const probe of [light, dark]) {
        expect(probe.states).toHaveLength(4);
        for (const s of probe.states) {
          expect(s.animation, `${s.group} ${s.name} animationName`).toBe("none");
          expect(s.transition, `${s.group} ${s.name} transitionDuration`).toBe("0s");
        }
      }
    },
  );
});
