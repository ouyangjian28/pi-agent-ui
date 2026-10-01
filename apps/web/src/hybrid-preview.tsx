import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./hybrid-preview.css";

type Message = { role: "user" | "assistant"; text: string; activity?: boolean; stopped?: boolean };
type Conversation = {
  id: number;
  title: string;
  project: string;
  group: string;
  draft: string;
  messages: Message[];
  running: boolean;
  progress: number;
};
type GlyphName = "plus" | "arrow" | "menu" | "folder" | "search" | "chevron" | "check" | "terminal" | "moon" | "close";
const paths: Record<GlyphName, string> = {
  plus: "M12 5v14M5 12h14",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  folder: "M3 7V5h6l2 2h10v13H3Z",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  terminal: "m4 5 6 7-6 7m9 0h7",
  moon: "M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11",
  close: "m6 6 12 12M6 18 18 6",
};
function Icon({ name }: { name: GlyphName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const seed: Conversation[] = [
  {
    id: 1,
    title: "让聊天界面更清爽",
    project: "pi-agent-ui",
    group: "今天",
    draft: "",
    running: false,
    progress: 100,
    messages: [
      {
        role: "user",
        text: "我们把界面重新整理一下：整体参考 OpenChamber，聊天里的动态展示参考 pi-web-ui。电脑为主，手机也要好用。",
      },
      {
        role: "assistant",
        activity: true,
        text: "好，我们保留 pi 引擎，不搬别人的执行架构。\n\n这次先把最常用的一条路做顺：新建会话 → 聊天 → 切换会话 → 回来继续。\n\n我会把正文留给答案，把工具过程收进可以展开的小卡片。输入框固定在底部，切换会话时，各自的草稿不会丢。",
      },
      { role: "user", text: "别再让我猜最后长什么样，先给我一个能点的样板。" },
      {
        role: "assistant",
        text: "这就是第一版可点击样板。你可以切换会话、写草稿、展开工具过程，或者新建一个会话试试。\n\n所有内容都是模拟数据，发送与停止也是演示；不会调用模型，也不会读写你的日常会话。",
      },
    ],
  },
  {
    id: 2,
    title: "升级 pi，保留原有能力",
    project: "pi-agent-ui",
    group: "今天",
    draft: "这条草稿留在升级会话里。",
    running: false,
    progress: 100,
    messages: [
      { role: "user", text: "先升级 pi，再适配新 UI。" },
      {
        role: "assistant",
        activity: true,
        text: "候选工作区已安装 pi 0.99.2。默认回归 1876 项通过，原有 24 项真实模型测试未启用。\n\n构建和包级类型检查也已通过；这些结果不等于生产服务已切换，更不等于 UI 体验通过。",
      },
    ],
  },
  {
    id: 3,
    title: "手机上的输入体验",
    project: "pi-agent-ui",
    group: "昨天",
    draft: "",
    running: false,
    progress: 100,
    messages: [
      { role: "user", text: "手机打开时，不要把电脑的三栏硬塞进小屏幕。" },
      {
        role: "assistant",
        text: "手机只保留一列聊天，用左上角进入会话列表；输入框随视口适配。\n\n当前只是浏览器样板，还没有做真机键盘验收。",
      },
    ],
  },
  {
    id: 4,
    title: "本周学习计划",
    project: "学习笔记",
    group: "今天",
    draft: "",
    running: false,
    progress: 100,
    messages: [
      { role: "user", text: "另一个项目的会话和草稿，也要分开。" },
      { role: "assistant", text: "这里是第二个模拟项目。你可以通过侧栏顶部切换回来。" },
    ],
  },
];
function Activity({ running, progress, stopped }: { running: boolean; progress: number; stopped?: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = stopped ? "演示已停止" : running ? "正在演示工具过程" : "查看过程 · 3 项活动";
  return (
    <div className="activity">
      <button className="activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={running ? "pulse" : "activity-icon"}>
          <Icon name={running ? "terminal" : "check"} />
        </span>
        <span>{summary}</span>
        <span className="activity-caption">{running ? `${Math.min(progress, 99)}%` : "仅模拟"}</span>
        <span className={open ? "chevron expanded" : "chevron"}>
          <Icon name="chevron" />
        </span>
      </button>
      {open && (
        <div className="activity-body">
          <div className="thought">
            <strong>思考摘要</strong>
            <p>先核对约束，再检查输入与会话切换；过程属于样板，不代表真实思考或工具执行。</p>
          </div>
          {["读取界面结构", "检查输入与草稿", "整理可见状态"].map((label, i) => (
            <div className="tool-row" key={label}>
              <Icon name={stopped || (running && progress < (i + 1) * 28) ? "terminal" : "check"} />
              <span>{label}</span>
              <small>{stopped ? "已停止" : running && progress < (i + 1) * 28 ? "演示中" : "模拟完成"}</small>
            </div>
          ))}
          <pre>
            <code>ui-preview / local fixture{`\n`}no provider calls · no production sessions</code>
          </pre>
        </div>
      )}
    </div>
  );
}
function Preview() {
  const [sessions, setSessions] = useState(seed);
  const [selected, setSelected] = useState(1);
  const [project, setProject] = useState("pi-agent-ui");
  const [query, setQuery] = useState("");
  const [mobileList, setMobileList] = useState(false);
  const [dark, setDark] = useState(false);
  const [model, setModel] = useState("GPT-6（示例）");
  const nextId = useRef(10);
  const timers = useRef(new Map<number, ReturnType<typeof setInterval>>());
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followStream = useRef(true);
  const session = sessions.find((s) => s.id === selected)!;
  const visible = sessions.filter((s) => s.project === project && s.title.toLowerCase().includes(query.toLowerCase()));
  const update = (id: number, fn: (s: Conversation) => Conversation) =>
    setSessions((all) => all.map((s) => (s.id === id ? fn(s) : s)));
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearInterval(timer);
    },
    [],
  );
  useEffect(() => {
    followStream.current = true;
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [selected, session.messages.length]);
  useEffect(() => {
    if (followStream.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [session.progress]);
  function choose(id: number) {
    setSelected(id);
    setMobileList(false);
  }
  function newSession() {
    const id = nextId.current++;
    setSessions((all) => [
      { id, title: "新会话", project, group: "今天", draft: "", messages: [], running: false, progress: 0 },
      ...all,
    ]);
    choose(id);
    setQuery("");
    setTimeout(() => input.current?.focus(), 0);
  }
  function send() {
    const text = session.draft.trim();
    if (!text || session.running) return;
    const id = session.id;
    update(id, (s) => ({
      ...s,
      title: s.messages.length ? s.title : text.slice(0, 22),
      draft: "",
      running: true,
      progress: 0,
      messages: [...s.messages, { role: "user", text }, { role: "assistant", text: "", activity: true }],
    }));
    const answer =
      "收到。这是模拟回复，用来体验正文与过程分开的阅读方式。\n\n你现在可以切到另一个会话，再回来查看这段回复；草稿和演示状态分别保留。正式 UI 会接回 pi，而不是使用这段模拟逻辑。";
    let progress = 0;
    const timer = setInterval(() => {
      progress = Math.min(progress + 5, 100);
      const step = progress;
      update(id, (s) => ({
        ...s,
        progress: step,
        running: step < 100,
        messages: s.messages.map((m, i) =>
          i === s.messages.length - 1 ? { ...m, text: answer.slice(0, Math.floor((answer.length * step) / 100)) } : m,
        ),
      }));
      if (progress === 100) {
        clearInterval(timer);
        timers.current.delete(id);
      }
    }, 130);
    timers.current.set(id, timer);
  }
  function stop() {
    const timer = timers.current.get(session.id);
    if (timer) clearInterval(timer);
    timers.current.delete(session.id);
    update(session.id, (s) => ({
      ...s,
      running: false,
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 ? { ...m, text: m.text || "演示在回复出现前停止。", stopped: true } : m,
      ),
    }));
  }
  function changeProject(value: string) {
    setProject(value);
    setQuery("");
    const first = sessions.find((s) => s.project === value);
    if (first) setSelected(first.id);
  }
  return (
    <div className={`preview ${dark ? "dark" : ""} ${mobileList ? "mobile-list-open" : ""}`}>
      <aside className="sidebar" aria-label="会话导航">
        <div className="brand">
          <span className="brand-mark">π</span>
          <strong>pi</strong>
          <span className="brand-caption">workspace</span>
          <button className="icon-button mobile-only" aria-label="返回会话" onClick={() => setMobileList(false)}>
            <Icon name="close" />
          </button>
        </div>
        <label className="project-selector">
          <Icon name="folder" />
          <select aria-label="项目" value={project} onChange={(e) => changeProject(e.target.value)}>
            <option>pi-agent-ui</option>
            <option>学习笔记</option>
          </select>
        </label>
        <div className="branch">
          main <span>·</span> 本地样板项目
        </div>
        <button className="new-session" onClick={newSession}>
          <Icon name="plus" />
          <span>新建会话</span>
        </button>
        <label className="search">
          <Icon name="search" />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav className="sessions">
          {["今天", "昨天"].map((group) => (
            <React.Fragment key={group}>
              {visible.some((s) => s.group === group) && <h2>{group}</h2>}
              {visible
                .filter((s) => s.group === group)
                .map((s) => (
                  <button
                    key={s.id}
                    className={s.id === selected ? "session selected" : "session"}
                    aria-current={s.id === selected ? "page" : undefined}
                    onClick={() => choose(s.id)}
                  >
                    <span className="session-title">{s.title}</span>
                    <span className="session-meta">
                      {s.running ? (
                        <>
                          <i className="live-dot" />
                          演示运行中
                        </>
                      ) : s.draft ? (
                        "有草稿"
                      ) : (
                        `${s.messages.length} 条样本消息`
                      )}
                    </span>
                  </button>
                ))}
            </React.Fragment>
          ))}
          {visible.length === 0 && <p className="empty-search">没有匹配的样本会话</p>}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setDark(!dark)}>
            <Icon name="moon" />
            {dark ? "切换浅色" : "切换深色"}
          </button>
          <span className="version">
            <i />
            pi 0.99.2 候选
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="打开会话列表" onClick={() => setMobileList(true)}>
            <Icon name="menu" />
          </button>
          <span className="breadcrumb">
            {project}
            <Icon name="chevron" />
          </span>
          <strong>{session.title}</strong>
          <span className="top-status">
            <i className={session.running ? "live-dot" : "idle-dot"} />
            {session.running ? "演示运行中" : "样板"}
          </span>
        </header>
        <div className="preview-notice">可点击样板 · 全部为模拟数据 · 不接模型和日常会话</div>
        <div
          className="transcript"
          ref={transcript}
          aria-label="会话消息"
          onScroll={(e) => {
            const element = e.currentTarget;
            followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          }}
        >
          <div className="reading-column">
            {session.messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-logo">π</div>
                <h1>从一个想法开始</h1>
                <p>留足空间阅读，让过程不再打断答案。</p>
                <div className="starter-chips">
                  {["帮我梳理一个方案", "检查一段代码", "整理今天的笔记"].map((text) => (
                    <button
                      key={text}
                      onClick={() => {
                        update(session.id, (s) => ({ ...s, draft: text }));
                        input.current?.focus();
                      }}
                    >
                      {text}
                      <Icon name="arrow" />
                    </button>
                  ))}
                </div>
                <small>这里只演示交互，不会真的执行任务。</small>
              </div>
            ) : (
              session.messages.map((m, i) => (
                <article className={`message ${m.role}`} key={`${session.id}-${i}`}>
                  <div className="speaker">
                    {m.role === "user" ? (
                      "你"
                    ) : (
                      <>
                        <span className="mini-mark">π</span>pi <span>· 模拟回复</span>
                      </>
                    )}
                  </div>
                  {m.role === "assistant" && m.activity && (
                    <Activity
                      key={`${session.id}-activity-${i}`}
                      running={session.running && i === session.messages.length - 1}
                      progress={session.progress}
                      stopped={m.stopped === true}
                    />
                  )}
                  <div className="message-text">
                    {m.text.split("\n\n").map((p, j) => (
                      <p key={j}>{p}</p>
                    ))}
                    {session.running && i === session.messages.length - 1 && (
                      <span className="typing-cursor" aria-label="演示生成中" />
                    )}
                  </div>
                  {m.stopped && <div className="stopped-note">演示已停止 · 当前文字保留</div>}
                </article>
              ))
            )}
          </div>
        </div>
        <div className="composer-area">
          <div className="composer">
            <textarea
              ref={input}
              aria-label="消息草稿"
              placeholder="说说你想做什么…"
              rows={3}
              value={session.draft}
              onChange={(e) => update(session.id, (s) => ({ ...s, draft: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-toolbar">
              <label className="model-label">
                <select aria-label="示例模型" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option>GPT-6（示例）</option>
                  <option>Kimi K3（示例）</option>
                </select>
              </label>
              <span className="keyboard-hint">Enter 发送 · Shift Enter 换行</span>
              {session.running ? (
                <button className="stop-button" onClick={stop} aria-label="停止演示">
                  <span />
                  停止
                </button>
              ) : (
                <button
                  className="send-button"
                  onClick={send}
                  disabled={!session.draft.trim()}
                  aria-label="发送演示消息"
                >
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          </div>
          <div className="composer-footnote">
            <span>{session.running ? "切换会话不会中断本次演示" : "草稿按会话保留"}</span>
            <span>发送与停止均为模拟</span>
          </div>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
