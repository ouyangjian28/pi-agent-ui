// A1d 真模式组合根：token 门→createAppClients 三件套→列表选择→详情+写面。
// 时序铁律：token 未确定前不建任何连接；token 确定后（或点「重新连接」）才 createAppClients。
// 断开后不自动重连（现状客户端无重连）：状态条显三客户端连接态+「重新连接」按钮（=重建三件套）。
// 认证失败（4401，任一客户端 errorKind=auth-failed）→受控错误面+「清除 token 重输」（清 localStorage 回输入面）。
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { SessionDetail } from "./components/session-detail";
import { SessionList } from "./components/session-list";
import {
  TokenGate,
  clearStoredToken,
  clearUrlToken,
  readStoredToken,
  readUrlToken,
  storeToken,
} from "./components/token-gate";
import { createAppClients, resolveWsUrl } from "./ws/app-clients";
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

  // 挂载时一次性解析 token：URL ?token=（读取后清参数+存 localStorage）→localStorage→输入面。
  useEffect(() => {
    const fromUrl = readUrlToken(window.location.search);
    if (fromUrl.token !== null) {
      clearUrlToken(fromUrl.cleanedSearch);
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
    const created = createAppClients({ url, token, createSocket });
    setClients(created);
    return () => {
      setClients(null);
      created.dispose();
    };
  }, [token, retryNonce, createSocket]);

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
