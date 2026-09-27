// 视觉基建批（I8）主题开关：亮/暗/跟随系统三段（segmented 形态，aria-pressed 标记当前项）。
// 初始值=localStorage 持久化选择（theme.ts 单一读写面）；挂载即 applyTheme 一次，
// 保证未走 main.tsx 启动路径（测试/demo 直挂）时持久化主题同样生效。纯视觉，零行为改动。

import React, { useEffect, useState } from "react";
import { applyTheme, readTheme, setTheme, THEME_NAMES } from "../theme";
import type { ThemeName } from "../theme";

const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  light: "亮色",
  dark: "暗色",
  system: "跟随系统",
};

export function ThemeToggle() {
  const [theme, setThemeState] = useState<ThemeName>(() => readTheme());

  // 挂载时把持久化选择应用到根元素（启动路径 main.tsx 已应用过一次，幂等）
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="theme-toggle" role="group" aria-label="主题">
      {THEME_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={theme === name}
          onClick={() => {
            setTheme(name);
            setThemeState(name);
          }}
        >
          {THEME_LABELS[name]}
        </button>
      ))}
    </div>
  );
}
