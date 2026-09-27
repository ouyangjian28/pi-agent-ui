// @vitest-environment jsdom
// 视觉基建批测试（I8+I7）：
// ①令牌静态面——styles.css 令牌在亮/暗两值域均定义、令牌块外无硬编码色值、
//   动效时长一律引用 --t-* 令牌、reduced-motion 段关停四类动效、会话正文走 --font-mono；
// ②theme.ts 读写面——localStorage('pi-agent-ui.theme') 持久化+非法值回退 system+
//   html[data-theme] 应用语义（system=移除属性交系统媒体查询兜底）；
// ③ThemeToggle 组件面——三段渲染/点击切换生效/持久化/挂载即应用持久化选择。
// CSS 断言经 ?raw 导入同源文件做静态解析，不靠 jsdom 的 CSSOM（jsdom 不算媒体查询）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// vitest 默认将 CSS 导入 stub 为空串（?raw 亦被截获）；jsdom 下 import.meta.url 非 file scheme——
// 故按 vitest 仓根 cwd 直读原文件字节（静态断言面，与运行环境无关）
const stylesCss = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
import { ThemeToggle } from "../../../apps/web/src/components/theme-toggle";
import {
  applyTheme,
  readTheme,
  setTheme,
  writeTheme,
  COLOR_TOKENS,
  FONT_MONO_TOKEN,
  MOTION_TOKENS,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  SPACING_TOKENS,
  THEME_STORAGE_KEY,
} from "../../../apps/web/src/theme";

/* ---- 极简 CSS 规则解析器（测试内工具）：去注释后按花括号配对，@规则递归展平 ---- */
interface CssRule {
  readonly selector: string;
  readonly body: string;
}

function parseRules(css: string): CssRule[] {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const open = cleaned.indexOf("{", i);
    if (open === -1) break;
    const selector = cleaned.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === "{") depth += 1;
      else if (cleaned[j] === "}") depth -= 1;
      j += 1;
    }
    rules.push({ selector, body: cleaned.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

/** 展平全部规则（@media/@keyframes 内层一并列出，保留各自选择器）。 */
function allRules(css: string): CssRule[] {
  const flat: CssRule[] = [];
  const visit = (rules: CssRule[]): void => {
    for (const rule of rules) {
      flat.push(rule);
      if (rule.selector.startsWith("@")) visit(parseRules(rule.body));
    }
  };
  visit(parseRules(css));
  return flat;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

function findBody(css: string, selector: string): string | null {
  const hit = allRules(css).find((rule) => normalizeSelector(rule.selector) === selector);
  return hit === undefined ? null : hit.body;
}

describe("令牌静态面（styles.css 与 theme.ts 令牌常量同源断言）", () => {
  it("亮色 :root 值域定义全部色彩令牌", () => {
    const body = findBody(stylesCss, ":root");
    expect(body).not.toBeNull();
    for (const token of COLOR_TOKENS) expect(body).toContain(token);
  });

  it("暗色 :root[data-theme=\"dark\"] 值域定义全部色彩令牌+阴影令牌", () => {
    const body = findBody(stylesCss, ':root[data-theme="dark"]');
    expect(body).not.toBeNull();
    for (const token of [...COLOR_TOKENS, ...SHADOW_TOKENS]) expect(body).toContain(token);
  });

  it(":root 定义圆角/间距/动效/字体令牌", () => {
    const body = findBody(stylesCss, ":root");
    expect(body).not.toBeNull();
    for (const token of [...RADIUS_TOKENS, ...SPACING_TOKENS, ...MOTION_TOKENS, FONT_MONO_TOKEN]) {
      expect(body).toContain(token);
    }
  });

  it("跟随系统兜底：prefers-color-scheme: dark 媒体查询内暗色值域色彩令牌齐全", () => {
    expect(findBody(stylesCss, "@media (prefers-color-scheme: dark)")).not.toBeNull();
    const body = findBody(stylesCss, ':root:not([data-theme="light"])');
    expect(body).not.toBeNull();
    for (const token of COLOR_TOKENS) expect(body).toContain(token);
  });

  it("令牌块（:root 族）之外无硬编码十六进制色值", () => {
    const offenders: string[] = [];
    for (const rule of allRules(stylesCss)) {
      if (rule.selector.startsWith("@")) continue; // @规则自身无声明，内层已单独展平
      if (normalizeSelector(rule.selector).startsWith(":root")) continue; // 令牌值域合法
      const found = rule.body.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (found !== null) offenders.push(`${rule.selector}: ${found.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("动效时长一律引用 --t-* 令牌（令牌块外无字面毫秒）", () => {
    const offenders: string[] = [];
    for (const rule of allRules(stylesCss)) {
      if (rule.selector.startsWith("@media")) continue; // 媒体查询自身无声明
      if (normalizeSelector(rule.selector).startsWith(":root")) continue;
      const found = rule.body.match(/\d+ms/g);
      if (found !== null) offenders.push(`${rule.selector}: ${found.join(",")}`);
    }
    expect(offenders).toEqual([]);
    expect(stylesCss.match(/var\(--t-/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("reduced-motion 段关停四类动效（animation/transition 双 none）", () => {
    const body = findBody(stylesCss, "@media (prefers-reduced-motion: reduce)");
    expect(body).not.toBeNull();
    expect(body).toContain("animation: none");
    expect(body).toContain("transition: none");
    // 四类动效宿主：列表选中/详情切换/发送按钮/composer 聚合
    expect(body).toContain(".session-list button");
    expect(body).toContain(".session-detail");
    expect(body).toContain(".write-actions button");
    expect(body).toContain(".write-composer textarea");
  });

  it("会话正文走 --font-mono（消息/事件列表/写输入）", () => {
    expect(findBody(stylesCss, ".message p")).toContain(`var(${FONT_MONO_TOKEN})`);
    expect(findBody(stylesCss, ".session-detail .history-list, .session-detail .live-list")).toContain(
      `var(${FONT_MONO_TOKEN})`,
    );
    expect(findBody(stylesCss, ".write-composer textarea")).toContain(`var(${FONT_MONO_TOKEN})`);
  });
});

describe("theme.ts 读写面（localStorage + html[data-theme]）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("readTheme 缺省（无存储）回退 system", () => {
    expect(readTheme()).toBe("system");
  });

  it("readTheme 非法存储值回退 system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon-pink");
    expect(readTheme()).toBe("system");
  });

  it("writeTheme→readTheme 持久化 roundtrip（light/dark/system）", () => {
    for (const theme of ["light", "dark", "system"] as const) {
      writeTheme(theme);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
      expect(readTheme()).toBe(theme);
    }
  });

  it("applyTheme dark/light 显式写 data-theme 属性", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("applyTheme system 移除 data-theme（交系统媒体查询兜底）", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("setTheme 一步完成持久化+应用", () => {
    setTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("ThemeToggle 组件（亮/暗/跟随系统三段开关）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    cleanup();
  });

  it("渲染三选项；默认（无存储）跟随系统为当前项", () => {
    render(React.createElement(ThemeToggle));
    const group = screen.getByRole("group", { name: "主题" });
    expect(group).toBeTruthy();
    const light = screen.getByRole("button", { name: "亮色" });
    const dark = screen.getByRole("button", { name: "暗色" });
    const system = screen.getByRole("button", { name: "跟随系统" });
    expect(light.getAttribute("aria-pressed")).toBe("false");
    expect(dark.getAttribute("aria-pressed")).toBe("false");
    expect(system.getAttribute("aria-pressed")).toBe("true");
  });

  it("点击「暗色」：主题切换生效（data-theme=dark）+ localStorage 持久化 + pressed 翻转", async () => {
    const user = userEvent.setup();
    render(React.createElement(ThemeToggle));
    await user.click(screen.getByRole("button", { name: "暗色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "暗色" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "跟随系统" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("「亮色」→「跟随系统」：属性移除 + localStorage=system", async () => {
    const user = userEvent.setup();
    render(React.createElement(ThemeToggle));
    await user.click(screen.getByRole("button", { name: "亮色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("挂载即应用持久化主题（预置 dark 存储→渲染后根元素即暗色）", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(React.createElement(ThemeToggle));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "暗色" }).getAttribute("aria-pressed")).toBe("true");
  });
});
