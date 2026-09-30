import React, { useEffect, useRef, useState } from "react";
export type ConnectionState = "connecting" | "authenticating" | "ready" | "closed" | "error";
export const CONNECTION_LABELS: Record<ConnectionState, string> = { connecting: "连接中", authenticating: "认证中", ready: "已连接", closed: "已断开", error: "连接错误" };
/** v6 §3.4：只聚合真实传输事实，不推断模型/业务成功。 */
export function connectionHealth(states: readonly ConnectionState[], authFailed = false): { tone: "ok" | "warn" | "err"; text: string } {
  if (authFailed) return { tone: "err", text: "认证失败" };
  if (states.every((state) => state === "ready")) return { tone: "ok", text: "全部已连接" };
  if (states.every((state) => state === "closed" || state === "error")) return { tone: "err", text: "连接已断开" };
  return { tone: "warn", text: states.some((state) => state === "closed" || state === "error") ? "部分不可用" : "连接中" };
}
export function HealthDot({ states, onReconnect, reconnect }: { states: readonly ConnectionState[]; onReconnect: () => void; reconnect: { attempts: number; nextInMs: number } | null }) {
  const health = connectionHealth(states); const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null); const retry = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    retry.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  return <div className="health-control" ref={root}>
    <button type="button" ref={trigger} className={`health-dot health-${health.tone}`} aria-label={`连接状态：${health.text}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><span className="health-indicator" aria-hidden="true" /><span>{health.text}</span></button>
    {reconnect && <span className="reconnect-note" role="status">自动重连中…（第 {reconnect.attempts} 次，约 {Math.round(reconnect.nextInMs / 1000)} 秒后）</span>}
    {open && <section className="health-popover" role="dialog" aria-label="连接明细"><h2>连接明细</h2><dl>{states.map((state, index) => <div key={index}><dt>{["列表", "订阅", "写"][index]}：</dt><dd>{CONNECTION_LABELS[state]}</dd></div>)}</dl><p>这里只表示传输健康，不代表模型可用或消息完成。</p><p>立即重连不会自动补发未决消息。</p><button type="button" ref={retry} onClick={onReconnect}>立即重连</button><button type="button" onClick={close}>关闭明细</button></section>}
  </div>;
}
