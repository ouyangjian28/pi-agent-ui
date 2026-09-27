// 视觉基建批（I8）主题面：亮/暗/跟随系统三态，读写走 html[data-theme]+localStorage。
// 机制：light/dark=显式写 data-theme 属性；system=移除属性，交由 styles.css 的
// prefers-color-scheme 媒体查询兜底（单一事实源=CSS 令牌块，JS 只管属性与持久化）。
// 红线：非法存储值一律回退 system；存储不可用（隐私模式等）降级为当次有效、不持久。

export const THEME_STORAGE_KEY = "pi-agent-ui.theme";

export type ThemeName = "light" | "dark" | "system";

export const THEME_NAMES: readonly ThemeName[] = ["light", "dark", "system"];

/** 色彩令牌（与 styles.css :root 族一一对应；亮/暗两值域均须定义，测试同源断言）。 */
export const COLOR_TOKENS = [
  "--c-bg",
  "--c-panel",
  "--c-fg",
  "--c-muted",
  "--c-accent",
  "--c-accent-bg",
  "--c-border",
  "--c-ok",
  "--c-ok-bg",
  "--c-warn",
  "--c-warn-bg",
  "--c-err",
  "--c-err-bg",
  "--c-neutral",
  "--c-neutral-bg",
] as const;

/** 圆角令牌。 */
export const RADIUS_TOKENS = ["--r-sm", "--r-md", "--r-lg"] as const;

/** 间距令牌。 */
export const SPACING_TOKENS = ["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6"] as const;

/** 阴影令牌（亮/暗两值域均须定义：暗色=none）。 */
export const SHADOW_TOKENS = ["--shadow-sm", "--shadow-md"] as const;

/** 动效令牌（主题无关，:root 单值域）。 */
export const MOTION_TOKENS = ["--t-fast", "--t-base", "--t-slow", "--ease-out", "--ease-spring"] as const;

/** 会话正文等宽字体栈令牌。 */
export const FONT_MONO_TOKEN = "--font-mono";

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式等：降级为「跟随系统」
  }
}

function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark" || value === "system";
}

/** 读持久化主题；缺省/非法值/存储不可用一律回退 system。 */
export function readTheme(): ThemeName {
  try {
    const raw = safeStorage()?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemeName(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

/** 持久化主题选择（存储不可用时静默忽略——当次 applyTheme 仍生效）。 */
export function writeTheme(theme: ThemeName): void {
  try {
    safeStorage()?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 同上：忽略
  }
}

/** 应用主题到根元素：system=移除属性（交系统媒体查询），light/dark=显式写属性。 */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

/** 一步设定：持久化+应用（ThemeToggle 点击路径）。 */
export function setTheme(theme: ThemeName): void {
  writeTheme(theme);
  applyTheme(theme);
}
