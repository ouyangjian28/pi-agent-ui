import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { attentionLabels, fixtureAdapter, type DraftAdapter, type DraftMessage, type DraftSession, type DemoState } from './fixtures/adapter';

export const MOBILE_QUERY = '(max-width: 767px)';
const subscribe = (callback: () => void) => {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
};
function Message({ message }: { message: DraftMessage }) {
  // 文本仅作文本渲染：不解析 HTML、链接或权限卡；未知 part 安全降级。
  return <article className={`message ${message.role}`}><small>{message.role === 'user' ? '你' : '助手'} · #{message.seq}</small>
    {message.parts.map((part, index) => <p key={index}>{part.type === 'text' ? part.text : '不支持的内容'}</p>)}
  </article>;
}
function MessageList({ session }: { session: DraftSession }) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: session.messages.length, getScrollElement: () => scroll.current,
    estimateSize: () => 136, getItemKey: index => session.messages[index]!.id, overscan: 5 });
  // 短样本直接排版；长会话从 day-1 保留虚拟化边界、稳定 ID 与 seq。
  return <div className="messages" ref={scroll} aria-label="消息列表" tabIndex={0}>
    {session.messages.length < 30 ? session.messages.map(message => <Message key={message.id} message={message} />) :
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>{virtual.getVirtualItems().map(item =>
        <div key={item.key} ref={virtual.measureElement} data-index={item.index} style={{ position: 'absolute', width: '100%', transform: `translateY(${item.start}px)` }}>
          <Message message={session.messages[item.index]!} />
        </div>)}</div>}
  </div>;
}
export function App({ adapter = fixtureAdapter, initialState = 'ready' }: { adapter?: DraftAdapter; initialState?: DemoState }) {
  const mobile = useSyncExternalStore(subscribe, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const [state, setState] = useState<DemoState>(initialState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const returnToNew = useRef(false);
  const selected = adapter.sessions.find(session => session.id === selectedId);
  const detail = Boolean(selected) || creating;
  const showList = !mobile || !detail;
  const showDetail = !mobile || detail;
  const sessions = state === 'empty' || state === 'loading' ? [] : adapter.sessions;
  useEffect(() => {
    if (detail) heading.current?.focus();
    else if (returnFocus.current) {
      (returnToNew.current ? newButton.current : rows.current[active] ?? newButton.current)?.focus();
      returnFocus.current = false;
    }
  }, [selectedId, creating, mobile]);
  function back() { returnFocus.current = true; returnToNew.current = creating; setSelectedId(null); setCreating(false); }
  function changeDemo(next: DemoState) { setState(next); setSelectedId(null); setCreating(false); }
  return <div className="app" data-layout={mobile ? 'mobile' : 'desktop'} onKeyDown={event => {
    if (event.key === 'Escape' && detail && !event.nativeEvent.isComposing) { event.preventDefault(); back(); }
  }}>
    <header className="topbar"><strong><span className="brand">π</span> pi 工作台</strong><span className="demo-label">只读演示 · 未连接服务</span>
      <label className="demo-picker">场景 <select value={state} onChange={event => changeDemo(event.target.value as DemoState)}>
        <option value="ready">会话样本</option><option value="empty">空态</option><option value="loading">加载中</option><option value="offline">连接异常</option>
      </select></label></header>
    {state === 'offline' && <div className="connection" role="alert">连接异常 · 状态待确认。当前仅展示静态样本，未发送任何命令。<button onClick={() => changeDemo('ready')}>返回样本演示</button></div>}
    <div className="workspace">
      {showList && <nav className="session-panel" aria-label="会话列表">
        <div className="panel-heading"><h1>会话</h1><button ref={newButton} onClick={() => { setSelectedId(null); setCreating(true); }}>＋ 新建</button></div>
        <div className="attention-summary">待答 {sessions.reduce((sum, s) => sum + s.pending, 0)} · 未读 {sessions.reduce((sum, s) => sum + s.unread, 0)}<small>样本计数 · 两者独立</small></div>
        {state === 'loading' ? <div className="empty" role="status" aria-busy="true"><h2>正在加载会话…</h2><p>静态加载演示，请切换场景查看样本。</p></div> : sessions.length === 0 ?
          <div className="empty"><h2>还没有会话</h2><p>从「新建」开始，先选工作目录与模型。</p></div> :
          <ul className="session-list">{sessions.map((session, index) => <li key={session.id}>
            <button ref={element => { rows.current[index] = element; }} tabIndex={index === active ? 0 : -1}
              aria-current={selectedId === session.id ? 'page' : undefined} onFocus={() => setActive(index)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 :
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + sessions.length) % sessions.length;
                setActive(next); rows.current[next]?.focus();
              }} onClick={() => { setActive(index); setCreating(false); setSelectedId(session.id); }}>
              <span className="row-title">{session.title}<span className={`badge ${session.attention}`}>{attentionLabels[session.attention]}</span></span>
              <span className="summary">{session.summary}</span><small>{session.cwd} · 待答 {session.pending} · 未读 {session.unread}</small>
            </button></li>)}</ul>}
        <p className="key-hint">↑ ↓ 选择 · Enter 打开 · Esc 返回</p>
      </nav>}
      {showDetail && <main className="conversation" aria-label="当前会话">
        {detail ? <><div className="conversation-heading"><button className="back" onClick={back}>← 返回列表</button><h1 ref={heading} tabIndex={-1}>{creating ? '新建会话' : selected?.title}</h1></div>
          {creating ? <section className="new-session"><h2>从一个新想法开始</h2><label>工作目录<input defaultValue="pi-agent-ui" /></label>
            <label>模型<select defaultValue={adapter.models[0]}>{adapter.models.map(model => <option key={model}>{model}</option>)}</select></label>
            <p>模型下拉保留在新建入口；当前为 draft 样本，不会启动会话。</p><button disabled>创建会话（尚未接入）</button></section> : selected && <>
            <div className="session-status"><span className={`badge ${selected.attention}`}>{attentionLabels[selected.attention]}</span><span>只读查看 · 不申请写权</span></div>
            {selected.pending > 0 && <div className="pending">待答 {selected.pending} · 演示问题尚未接入确认通道，不能提交。</div>}
            <MessageList key={selected.id} session={selected} />
            <div className="composer"><label htmlFor="composer">消息</label><textarea id="composer" disabled placeholder="只读演示，暂不发送消息" /><small>输入、图片与停止操作将在后续切片接入。</small></div>
          </>}</> : <div className="welcome"><span className="welcome-mark">π</span><h1>留一处空间，专注当前会话</h1><p>从左侧打开会话，查看进度与待答事项。</p><small>蓝色运行 · 黄色待答 · 绿色已完成 · 灰色待确认</small></div>}
      </main>}
      {!mobile && <aside className="inspector" aria-label="详情侧栏"><h2>会话详情</h2><p>{selected ? selected.cwd : '尚未选择会话'}</p><hr /><h3>观察，而不猜测</h3><p>注意力色标不是完整生命周期。恢复暂定与未知状态不会显示为成功。</p><p>详情、产物与 trace 面板将在后续切片接入。</p></aside>}
    </div><footer className="statusbar">draft fixtures <span>本地展示 · 无写命令</span></footer>
  </div>;
}
// 浏览器已读≠agent ACK：浏览、聚焦、切换会话均不发送 ACK，也不清除待答或未读样本。
