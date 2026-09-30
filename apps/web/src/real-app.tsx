// A1d 真模式组合根：token 门→createAppClients 三件套→列表选择→详情+写面。
// 时序铁律：token 未确定前不建任何连接；token 确定后（或点「重新连接」/自动重连）才 createAppClients。
// 自动重连（M-UX 体验收敛批）：任一连接意外终态（非认证失败）→壳层指数退避自动重建三件套
//（1s/2s/4s…≤0s 封顶，永续）；重连后 welcome→自动拉清单/订阅/写面全自恢复。认证失败（4401）不重连。
// 认证失败（任一客户端 errorKind=auth-failed）→受控错误面+「清除 token 重输」（清 localStorage 回输入面）。
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { WriteComposer } from "./components/write-composer";
import { ConversationState } from "./ws/conversation-state";
import { autoFile, readLastModel, writeLastModel, MODEL_DEFAULT, effectiveModel, isPersistableModel } from "./ws/draft-model";
import { useSessionDetail } from "./ws/use-session-detail";
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
import { resolveTitle } from "./ws/resolve-title";
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

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RealAppProps {
  /** 测试注入假 socket；缺省=浏览器全局 WebSocket。 */
  readonly createSocket?: WebSocketFactory | undefined;
}

export function RealApp({ createSocket }: RealAppProps) {
  const [token, setToken] = useState<string | null>(null);
  const [clients, setClients] = useState<AppClients | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // 自动重连：意外断线→退避计时重建（attempts 跨重建存续，恢复归零）。timer/计划态为 ref（非渲染数据）。
  const reconnectRef = React.useRef<{ attempts: number; timer: number | null; nextDelayMs: number | null }>({
    attempts: 0,
    timer: null,
    nextDelayMs: null,
  });
  const [reconnectUi, setReconnectUi] = useState<{ attempts: number; nextInMs: number } | null>(null);
  const clientsRef = React.useRef<AppClients | null>(null);
  const [owner] = useState(() => new ConversationState(() => clientsRef.current?.wsClient.requestSessions()));
  useEffect(() => () => owner.dispose(), [owner]);
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
  // 自动重连的重建也走本 effect（retryNonce++）——新三件套=全新身份，无残留在途。
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
    clientsRef.current = created;
    owner.setClient(created.writeClient);
    setClients(created);
    return () => {
      // 保持呈现 owner 挂载到新 client 替换；不以 clients=null 闪断整棵编辑器。
      created.dispose();
    };
  }, [token, retryNonce, createSocket, owner]);

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

  // —— 自动重连状态机（壳层；三客户端内部不变式零改动）——
  // 意外断线（任一连接终态且非认证失败）→指数退避重建；恢复（三连接全部非终态）→计数归零。
  // 手动「立即重连」=清退避计时+立即重建（计数归零——手动介入后重新观察）。
  const clearReconnectTimer = (): void => {
    const r = reconnectRef.current;
    if (r.timer !== null) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    r.nextDelayMs = null;
    setReconnectUi(null);
  };
  const handleConnDown = (down: boolean): void => {
    const r = reconnectRef.current;
    if (!down) {
      r.attempts = 0; // 恢复归零（下一轮故障重新从 1s 起）
      clearReconnectTimer();
      return;
    }
    if (r.timer !== null) return; // 已在退避中（同一故障窗不叠加）
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(r.attempts, 5), RECONNECT_MAX_MS);
    r.nextDelayMs = delay;
    setReconnectUi({ attempts: r.attempts + 1, nextInMs: delay });
    r.timer = window.setTimeout(() => {
      r.timer = null;
      r.attempts += 1;
      r.nextDelayMs = null;
      setReconnectUi(null);
      setRetryNonce((n) => n + 1); // 重建三件套（新身份；旧 effect 清理 dispose）
    }, delay);
  };
  const reconnectNow = (): void => {
    reconnectRef.current.attempts = 0;
    clearReconnectTimer();
    setRetryNonce((n) => n + 1);
  };
  // 卸载时清退避计时（防重建后孤儿 timer）
  useEffect(() => () => clearReconnectTimer(), []);

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
      owner={owner}
      onRetry={reconnectNow}
      onConnDown={handleConnDown}
      reconnectUi={reconnectUi}
      onClearToken={() => {
        clearStoredToken();
        setToken(null); // effect 清理负责 dispose 旧三件套
      }}
    />
  );
}

function ConnectedApp({
  clients,
  owner,
  onRetry,
  onConnDown,
  reconnectUi,
  onClearToken,
}: {
  clients: AppClients;
  owner: ConversationState;
  onRetry: () => void;
  onConnDown: (down: boolean) => void;
  reconnectUi: { attempts: number; nextInMs: number } | null;
  onClearToken: () => void;
}) {
  const wsSnap = useSyncExternalStore(clients.wsClient.subscribe, clients.wsClient.getSnapshot);
  const subSnap = useSyncExternalStore(clients.subscribeClient.subscribe, clients.subscribeClient.getSnapshot);
  const writeSnap = useSyncExternalStore(clients.writeClient.subscribe, clients.writeClient.getSnapshot);
  const ui = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const file = ui.activeFile;
  // 唯一订阅 owner：隐藏/返回不改变 file，本钩子只在真换目标或 client 时清旧。
  const detail = useSessionDetail(clients.subscribeClient, file);
  const isNew = ui.view.kind === "draft" || file === null;
  const slot = ui.view.kind === "draft" ? ui.drafts.get(ui.view.id) ?? null : file ? ui.sessions.get(`session:${file}`) ?? null : null;
  const pendingQuestions = detail.uiRequests.length > 0;
  const allowLeave = (): boolean => !pendingQuestions || window.confirm("当前对话仍有待回答的问题。切换会话将退订，并可能取消待答。确定离开吗？");
  const newDraft = (): string | null => {
    if (!owner.canCreate || !allowLeave()) return null;
    return owner.create(autoFile(), readLastModel() ?? MODEL_DEFAULT);
  };
  const select = (target: string): void => { if (target === file || allowLeave()) owner.open(target); };
  const restore = (id: string): void => { if (allowLeave()) owner.restore(id); };
  const ensureDraft = (): string | null => slot?.id ?? newDraft();

  const authFailed =
    wsSnap.errorKind === "auth-failed" ||
    subSnap.errorKind === "auth-failed" ||
    writeSnap.errorKind === "auth-failed";
  const states: readonly ConnState[] = [wsSnap.state, subSnap.connState, writeSnap.connState];
  const anyDown = states.some((s) => s === "closed" || s === "error");
  // 上报连接健康（自动重连驱动面；须在 authFailed 早退前=hooks 顺序稳定）：
  // 认证失败不重连（重试无意义且撞限速）→上报恒 false。
  useEffect(() => {
    onConnDown(authFailed ? false : anyDown);
  }, [authFailed, anyDown, onConnDown]);

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
        {reconnectUi !== null && (
          <span className="reconnect-note">
            自动重连中…（第 {reconnectUi.attempts} 次，约 {Math.round(reconnectUi.nextInMs / 1000)} 秒后）
          </span>
        )}
        {anyDown && (
          <button type="button" onClick={onRetry}>
            立即重连
          </button>
        )}
      </div>
      <div className="workspace two-col">
        <nav className="session-panel" aria-label="会话列表">
          <div className="panel-heading">
            <h1>会话</h1>
            <div className="panel-actions">
              <button type="button" className="refresh" onClick={() => clients.wsClient.requestSessions()}>
                刷新
              </button>
              <button type="button" className="new-session-btn" disabled={!owner.canCreate} onClick={() => { newDraft(); }}>
                ＋新对话
              </button>
            </div>
          </div>
          <SessionList client={clients.wsClient} selectedFile={file} onSelect={select} />
          {ui.drafts.size > 0 && <section className="unfinished-drafts" aria-label="未完成草稿"><h3>未完成草稿</h3>{[...ui.drafts.values()].filter((draft) => draft.operation !== null).map((draft) => <button key={draft.id} type="button" onClick={() => restore(draft.id)}>{draft.phase === "settled-launched" ? "打开已受理对话" : draft.phase === "settled-unknown" ? "找回结果未知的草稿" : draft.operation?.pending ? "找回发送中的草稿" : "找回未发送成功的草稿"}<small>{draft.operation?.text.slice(0, 40)}</small></button>)}</section>}
        </nav>
        <main className="conversation" aria-label="当前会话">
          <div className="conversation-body">
            {isNew ? <div className="welcome"><span className="welcome-mark">π</span><h1>从一个想法开始</h1><p>从左侧继续或直接开始新对话</p></div> : <SessionDetail managed client={clients.subscribeClient} file={file} title={resolveTitle(wsSnap.sessions?.find((session) => session.file === file) ?? { file: file!, title: { text: "", truncated: false } })} />}
          </div>
          <WriteComposer client={clients.writeClient} file={slot?.file ?? null} editor={{
            slot, source: clients.wsClient, isNew,
            onEdit: (text) => { const id = ensureDraft(); if (id) owner.edit(id, text); },
            onConfigure: (choice, text) => { if (!isPersistableModel(choice)) return; const id = ensureDraft(); if (id) owner.configure(id, choice, text); },
            onCancel: () => owner.back(),
            onViewTarget: () => { if (slot && allowLeave()) owner.open(slot.file); },
            onSend: (confirmed) => {
              if (!slot) return Promise.resolve({ status: "local", kind: "local-invalid", message: "请输入消息。" });
              const model = isNew ? effectiveModel(slot.modelChoice, slot.freeText) : undefined;
              if (isNew) writeLastModel(model ?? MODEL_DEFAULT);
              return owner.send(slot.id, model, confirmed);
            },
          }} />
        </main>
      </div>
    </div>
  );
}
