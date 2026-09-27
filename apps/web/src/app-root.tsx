// A1d 组合根（模式分叉）：?demo=1 → fixture 演示（App 原样保留，既有测试零改动）；
// 其余 → 真模式（RealApp：token 门→三件套→真工作区）。模式在挂载时按 URL 读取一次；
// 切换模式=改 URL 刷新页面。
import React, { useState } from "react";
import { App } from "./App";
import { RealApp } from "./real-app";
import type { WebSocketFactory } from "./ws/ws-client";

/** demo 开关（纯函数，独立可测）。 */
export function isDemoMode(search: string): boolean {
  return new URLSearchParams(search).get("demo") === "1";
}

export function AppRoot({ createSocket }: { createSocket?: WebSocketFactory | undefined }) {
  const [demo] = useState(() => isDemoMode(window.location.search));
  return demo ? <App /> : <RealApp createSocket={createSocket} />;
}
