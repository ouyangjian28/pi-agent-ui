import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoot } from "./app-root";
import { applyTheme, readTheme } from "./theme";
import "./styles.css";

// 启动即应用持久化主题（html[data-theme]；system=移除属性交系统媒体查询兜底）
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
