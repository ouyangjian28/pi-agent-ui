import React from "react";

/** Only completed public source text enters here, never rendered DOM or preview text.
 * A loader may reuse entry-get; clipboard rejection must remain a failure, not an
 * execCommand guess. Manual selection is a local, read-only fallback. */
export function CopyReply({ text, loadText }: {
  readonly text: string | null;
  readonly loadText?: () => Promise<string>;
}) {
  const [status, setStatus] = React.useState<"idle" | "pending" | "copied" | "failed">("idle");
  const [manual, setManual] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  const busy = React.useRef(false);
  const id = React.useId();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const copy = async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus("pending");
    setManual(null);
    let source: string | null = null;
    try {
      source = text !== null ? text : loadText ? await loadText() : null;
      if (!alive.current) return;
      if (source === null) throw new Error("Full public text unavailable");
      // Access and call are both inside try: missing API, policy denial, sync
      // throws and rejected writes all fail honestly. Never read the clipboard.
      await navigator.clipboard.writeText(source);
      if (alive.current) setStatus("copied");
    } catch {
      if (alive.current) { setManual(source); setStatus("failed"); }
    } finally {
      busy.current = false;
    }
  };
  return <div className="reply-copy">
    <button type="button" className="reply-copy-button" aria-label="复制完整回复原文" aria-describedby={id} disabled={status === "pending"} onClick={() => { void copy(); }}>复制原文</button>
    <span id={id} role={status === "idle" ? undefined : status === "failed" ? "alert" : "status"} aria-live="polite" className={status === "failed" ? "reply-copy-error" : "reply-copy-status"}>
      {status === "pending" ? "正在复制…" : status === "copied" ? "已复制" : status === "failed" ? manual !== null ? "复制失败，请在下方手工复制原文。" : "复制失败：未获取到完整公开原文，请重试。" : ""}
    </span>
    {manual !== null && <textarea className="reply-copy-source" aria-label="回复原文（手工复制）" readOnly value={manual} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />}
    <DownloadReply text={text} {...(loadText ? { loadText } : {})} />
  </div>;
}

/** Shares CP's exact source and read-only loader in every final/frozen/history
 * mount. Browser save completion is not observable here: only report initiation. */
function DownloadReply({ text, loadText }: {
  readonly text: string | null;
  readonly loadText?: () => Promise<string>;
}) {
  const [status, setStatus] = React.useState<"idle" | "pending" | "started" | "failed">("idle");
  const busy = React.useRef(false);
  const epoch = React.useRef(0);
  const urls = React.useRef(new Map<string, ReturnType<typeof setTimeout> | null>());
  const id = React.useId();
  React.useEffect(() => () => {
    epoch.current++;
    for (const [url, timer] of urls.current) {
      if (timer !== null) clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch { /* Best-effort cleanup, no success claim. */ }
    }
    urls.current.clear();
  }, []);
  const download = async () => {
    if (busy.current) return;
    busy.current = true;
    const started = epoch.current;
    setStatus("pending");
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const source = text !== null ? text : loadText ? await loadText() : null;
      if (started !== epoch.current) return;
      if (source === null) throw new Error("Full public text unavailable");
      // Default transparent line endings preserve CRLF and trailing whitespace.
      // No DOM extraction, HTML parsing, BOM, trim or rendered-content limits.
      const blob = new Blob([source], { type: "text/markdown" });
      url = URL.createObjectURL(blob);
      urls.current.set(url, null);
      anchor = document.createElement("a");
      anchor.href = url;
      // No file path, session name, response content or untrusted ID in filename.
      anchor.download = `reply-${Date.now()}.md`;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const allocated = url;
      // Do not revoke synchronously before the browser consumes the click.
      const timer = setTimeout(() => {
        urls.current.delete(allocated);
        try { URL.revokeObjectURL(allocated); } catch { /* Best-effort cleanup. */ }
      }, 1000);
      urls.current.set(url, timer);
      setStatus("started");
    } catch {
      try { anchor?.remove(); } catch { /* Still attempt URL cleanup below. */ }
      if (url !== null) {
        urls.current.delete(url);
        try { URL.revokeObjectURL(url); } catch { /* Preparation already failed. */ }
      }
      if (started === epoch.current) setStatus("failed");
    } finally {
      busy.current = false;
    }
  };
  return <div className="reply-copy reply-download">
    <button type="button" className="reply-download-button" style={{ minWidth: 44, minHeight: 44, fontSize: 12, flexShrink: 0 }} aria-label="下载完整回复原文为 Markdown" aria-describedby={id} disabled={status === "pending"} onClick={() => { void download(); }}>下载 Markdown</button>
    <span id={id} role={status === "idle" ? undefined : status === "failed" ? "alert" : "status"} aria-live="polite" className={status === "failed" ? "reply-copy-error" : "reply-copy-status"}>
      {status === "pending" ? "正在准备下载…" : status === "started" ? "已发起下载" : status === "failed" ? "下载失败：未能准备完整公开原文文件，请重试。" : ""}
    </span>
  </div>;
}
