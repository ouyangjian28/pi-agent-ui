// A1d 真模式组合根：token 门→createAppClients 三件套→列表选择→详情+写面。
// 时序铁律：token 未确定前不建任何连接；token 确定后（或点「重新连接」）才 createAppClients。
// 断开后不自动重连（现状客户端无重连）：状态条显三客户端连接态+「重新连接」按钮（=重建三件套）。
// 认证失败（4401，任一客户端 errorKind=auth-failed）→受控错误面+「清除 token 重输」（清 localStorage 回输入面）。
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { SessionDetail } from "./components/session-detail";
import { SessionList } from "./components/session-list";
import { ThemeToggle } from "./components/theme-toggle";
import {
  TokenGate,
  clearStoredToken,
  clearUrlToken,
  readStoredToken,
  readUrlToken,
  storeToken,
} from "./components/token-gate";
import { createAppClients, isSameOriginWsTarget, resolveWsUrl } from "./ws/app-clients";
import type { AppClients } from "./ws/app-clients";
import type { WebSocketFactory } from "./ws/ws-client";

type ConnState = "connecting" | "authenticating" | "ready" | "closed" | "error";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "连接中",
  authenticating: "认证中",
  ready: "已连接",
  closed: "已断开",
  error: "连接错误",
};

export interface RealAppProps {
  /** 测试注入假 socket；缺省=浏览器全局 WebSocket。 */
  readonly createSocket?: WebSocketFactory | undefined;
}

export function RealApp({ createSocket }: RealAppProps) {
  const [token, setToken] = useState<string | null>(null);
  const [clients, setClients] = useState<AppClients | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // 选中会话留在 RealApp：重连（重建三件套）后选择不丢
  const [file, setFile] = useState<string | null>(null);
  // B1：当前连接目标为跨源（dev 覆盖）时为真——拒绝面接管（不拨线+明白提示）
  const [untrustedTarget, setUntrustedTarget] = useState(false);
  const [untrustedUrl, setUntrustedUrl] = useState<string | null>(null);

  // 挂载时一次性解析 token：URL ?token=（读取后清参数+存 localStorage）→localStorage→输入面。
  useEffect(() => {
    const fromUrl = readUrlToken(window.location.search);
    // N1：只要出现过 token 键（含空值/重复键）就清参；有效 token 为空时继续走 localStorage
    if (fromUrl.hadTokenParam) clearUrlToken(fromUrl.cleanedSearch);
    if (fromUrl.token !== null) {
      storeToken(fromUrl.token);
      setToken(fromUrl.token);
      return;
    }
    const stored = readStoredToken();
    if (stored !== null) setToken(stored);
  }, []);

  // token 确定（或重试）才建三件套；换 token/重试/卸载时统一 dispose（close 屏障幂等）。
  useEffect(() => {
    if (token === null) return;
    const url = resolveWsUrl(window.location, window.location.search);
    // B1 凭据目的地绑定（用户拍板 2026-10-05 选项 A）：跨源目的地（仅 dev ?server= 可达；
    // 生产覆盖已被 resolveWsUrl 忽略）一律不拨线——三件套不建、hello 永不发出，已存令牌绝不出本源。
    const trusted = isSameOriginWsTarget(window.location, url);
    setUntrustedTarget(!trusted);
    if (!trusted) {
      setUntrustedUrl(url);
      return; // 拒绝面提供「改连本站默认/重新输入令牌」
    }
    setUntrustedUrl(null);
    const created = createAppClients({ url, token, createSocket });
    setClients(created);
    return () => {
      setClients(null);
      created.dispose();
    };
  }, [token, retryNonce, createSocket]);

  // 选项 A：「改连本站默认」= 清 ?server=（保留 pathname/其余参数/hash/state）后重试拨线。
  // B3（GPT r2）：目标 URL 必须显式含 pathname——空串/纯 hash 是相对引用，会原样保留原 query，
  // 「仅 server 一个参数」时清不掉 server、永远出不了拒绝面。
  const connectDefaultTarget = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("server");
    const cleaned = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${cleaned ? `?${cleaned}` : ""}${window.location.hash}`,
    );
    setRetryNonce((n) => n + 1);
  };
  const restartWithFreshToken = () => {
    clearStoredToken();
    setToken(null); // effect 清理负责 dispose 旧三件套
  };

  if (token === null) {
    return (
      <TokenGate
        onSubmitToken={(next) => {
          storeToken(next);
          setToken(next);
        }}
      />
    );
  }
  if (untrustedTarget) {
    return (
      <div className="app">
        <section className="empty" role="alert">
          <h2>已拒绝连接：目标不是本站</h2>
          <p>跨源目标不支持凭据，已拒绝拨线（通行证不会发给别家门牌）：</p>
          <p>
            <code>{untrustedUrl}</code>
          </p>
          <p>
            <button type="button" onClick={connectDefaultTarget}>
              改连本站默认
            </button>{" "}
            <button type="button" onClick={restartWithFreshToken}>
              重新输入令牌
            </button>
          </p>
        </section>
      </div>
    );
  }
  if (clients === null) {
    return (
      <div className="app">
        <div className="empty" role="status" aria-busy="true">
          <h2>正在建立连接…</h2>
        </div>
      </div>
    );
  }
  return (
    <ConnectedApp
      clients={clients}
      file={file}
      onSelectFile={setFile}
      onRetry={() => setRetryNonce((n) => n + 1)}
      onClearToken={() => {
        clearStoredToken();
        setToken(null); // effect 清理负责 dispose 旧三件套
      }}
    />
  );
}

function ConnectedApp({
  clients,
  file,
  onSelectFile,
  onRetry,
  onClearToken,
}: {
  clients: AppClients;
  file: string | null;
  onSelectFile: (file: string) => void;
  onRetry: () => void;
  onClearToken: () => void;
}) {
  const wsSnap = useSyncExternalStore(clients.wsClient.subscribe, clients.wsClient.getSnapshot);
  const subSnap = useSyncExternalStore(clients.subscribeClient.subscribe, clients.subscribeClient.getSnapshot);
  const writeSnap = useSyncExternalStore(clients.writeClient.subscribe, clients.writeClient.getSnapshot);

  const authFailed =
    wsSnap.errorKind === "auth-failed" ||
    subSnap.errorKind === "auth-failed" ||
    writeSnap.errorKind === "auth-failed";
  if (authFailed) {
    return (
      <div className="app">
        <section className="empty" role="alert">
          <h2>认证失败</h2>
          <p>服务拒绝了访问令牌（4401）：令牌可能已轮换或输入有误。可清除已存令牌并重新输入。</p>
          <p>
            <button type="button" onClick={onClearToken}>
              清除 token 重输
            </button>
          </p>
        </section>
      </div>
    );
  }

  const states: readonly ConnState[] = [wsSnap.state, subSnap.connState, writeSnap.connState];
  const anyDown = states.some((s) => s === "closed" || s === "error");
  return (
    <div className="app">
      <header className="topbar">
        <strong>
          <span className="brand">π</span> pi 工作台
        </strong>
        <ThemeToggle />
      </header>
      <div className="connbar" role="status" aria-live="polite">
        <span>列表：{CONN_LABEL[wsSnap.state]}</span>
        <span>订阅：{CONN_LABEL[subSnap.connState]}</span>
        <span>写：{CONN_LABEL[writeSnap.connState]}</span>
        {anyDown && (
          <button type="button" onClick={onRetry}>
            重新连接
          </button>
        )}
      </div>
      <div className="workspace two-col">
        <nav className="session-panel" aria-label="会话列表">
          <div className="panel-heading">
            <h1>会话</h1>
          </div>
          <SessionList client={clients.wsClient} selectedFile={file} onSelect={onSelectFile} />
        </nav>
        <main className="conversation" aria-label="当前会话">
          {file === null ? (
            <div className="welcome">
              <span className="welcome-mark">π</span>
              <h1>选择会话开始</h1>
              <p>从左侧列表选择一个会话文件查看详情并发送消息。</p>
            </div>
          ) : (
            <SessionDetail client={clients.subscribeClient} file={file} writeClient={clients.writeClient} />
          )}
        </main>
      </div>
    </div>
  );
}
