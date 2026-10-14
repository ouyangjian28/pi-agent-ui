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
  </div>;
}
