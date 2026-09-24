# M1 Design — pi-agent-ui

> Status: design frozen for M1. This document is the public distillation of the internal design notes; internal review artifacts are omitted.

## 1. What & why

A self-hosted web UI for the pi coding agent with two faces: an IDE-style desktop workspace and a Telegram-style mobile chat. The architectural bet: **drive pi through its official RPC protocol, one process per session, and make failure states honest** (nothing silently lost, no hidden dual writers).

## 2. Architecture overview

```
Browser (SPA, two forms: desktop IDE skeleton / mobile Telegram-style)
  ↕ WebSocket · nginx facade (WS upgrade, proxy_buffering off) + auth
Central server (Node) — one official RpcClient per session process
  ├─ Session process pool: spawn `pi --mode rpc` × per session
  ├─ Process supervision: managed-process registry (per-pid JSON records)
  ├─ Journal: prompts persisted to disk BEFORE dispatch; reconcile on restart
  ├─ RPC UI passthrough router: extension_ui_request → browser → stdin
  └─ Session discovery: official SessionManager.list(cwd) + fs.watch for live files
Session processes ×N
  ├─ Source of truth = session files (~/.pi/agent/sessions/, JSONL tree, v3)
  └─ pi extensions auto-load as usual (global + project)
```

## 3. Topology: RPC direct-drive

Not a bridge/attach topology. The server **owns** every session process it talks to:

- We spawn the processes, so we never need to attach to unknown ones.
- The official RPC protocol is the contract; the official `RpcClient` class ships in the SDK. Zero homegrown framing (LF-delimited JSONL has sharp edges — U+2028/2029 line breaks — that the official client already handles).
- The M2 plugin channel ("RPC UI passthrough") is a native protocol feature in this topology: `extension_ui_request` events block agent-side waiting for a `extension_ui_response` we route from the browser.

One process per session: a crash is contained; single-writer is structural, not advisory. Idle sessions are gracefully shut down after 30 min (drain queue → `session_shutdown`) and cold-restarted from disk in ~1–2 s when reopened.

## 4. Process supervision

Learned from and modeled on production-grade registries (OpenChamber's managed-process registry):

- **Spawn**: detached process group (survives server death), all three stdio pipes attached — stdin is the command channel; stdout+stderr are drained constantly (a full 64 KB pipe blocks pi entirely — measured).
- **Registration**: one JSON file per pid (owner pid, session file, binary, start time). Atomic tmp+rename writes. **Fail-closed**: if registration fails, the child is killed before ever being dispatched — no unregistered writer may live.
- **Startup reaping**: only reap pids we recorded; re-verify the pid is really our pi RPC process (pid reuse guard); only kill when the previous owner is provably dead.
- **No fake adoption**: v1 does not pretend to re-attach to orphaned RPC processes (raw stdio has no re-attach facility). Orphans are surfaced honestly in the reconciliation state.
- **Async I/O everywhere**: reaping and registry writes never block the event loop (a real-world incident where synchronous reaping froze an entire server is the cautionary tale).

## 5. Zero-silent-loss delivery

The design pillar: after any crash, every dispatched prompt resolves to exactly one of four states — **safe-to-resend / in-flight / delivered / unknown** — never a silent assumption.

- Prompts hit an fsync'd journal **before** dispatch to the process.
- On restart, the journal is reconciled against the session file's user entries.
- **Never auto-resend a round that had started** (only the first, never-started send is mechanically provable side-effect-free — that one auto-resends with a notification).
- Truncated JSONL lines (crash mid-write) are skipped and never count as completion evidence.
- Unknown writers (a possible still-alive orphan) freeze new writes instead of guessing.

## 6. Multi-writer safety

The terminal pi and the web server share session files; pi has no file lock, so we build the discipline:

- Web UI opens sessions in **view mode**; typing the first character (or pressing takeover) requests write ownership.
- Server-side write-ownership manager with generation counters broadcasts yield/refresh events; the detector is the server, the terminal never participates in any protocol.
- Takeover during an in-flight round transfers to the existing process (never spawns a duplicate).
- Concurrent interleaved writes from a rogue writer are surfaced loudly (alarm + reconciliation marked untrusted), not papered over.

## 7. Protocol surface (M1 uses)

Commands: `prompt` (with `streamingBehavior` steer/followUp), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `switch_session`, `get_entries(since)` (persistent cursor), `get_state`, bash passthrough, `get_session_stats`.
Events: `agent_start/end`, `agent_settled` (UI state-machine anchor: no retries/compactions/queue left), `message_*` (delta accumulation client-side), `tool_execution_*`, `queue_update`, `compaction_*`, `extension_ui_request/response`, `extension_error`.

## 8. M1 acceptance (summary)

Full-chain on phone over public internet; list/resume/stream/steer/interrupt; extension dialogs natively rendered; reconnect replay with per-session ring buffer (bounded, overflow falls back to full refresh with honest gap markers); kill -9 crash reconciliation matrix; idle recycling; view-then-takeover with yield detection. Desktop: multi-tab + session tree + status bar.

## 9. Non-goals (M1)

No forking UI, no plugin runtime (M2), no sandboxed iframes (M2+), no model switching UI (M2), no desktop/mobile native apps (browser is a hard constraint).

## 10. Credits

Architecture lessons drawn from the public work of: OpenChamber (process registry, ops facade), pi-web-ui (plugin system, snapshot/backpressure), agegr/pi-web (pi integration layer), and the pi project's own RPC/extension design.
