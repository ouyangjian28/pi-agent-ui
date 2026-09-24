# pi-agent-ui

**Unofficial** web UI / web console / dashboard for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — not affiliated with the pi project.

A self-hosted web workspace that drives pi from your browser:

- **Desktop form**: multi-tab IDE-style workspace — session tree sidebar, status bar, command palette (rolling in)
- **Mobile form**: Telegram-style two-level chat — phone is a first-class target, not an afterthought
- **Every session spawns an isolated `pi --mode rpc` process** — RPC direct-drive over the official protocol; one process per session, so a crash in one never touches another
- **Zero-silent-loss delivery** — every prompt is journaled to disk before dispatch; after a crash, the reconciliation pass tells you exactly what was sent, in-flight, or interrupted. Nothing is silently dropped
- **Multi-writer safety** — sessions are visible to both the terminal and the web UI; view-then-takeover semantics prevent two writers from ever corrupting a session file

> **Status: developing.** M1 (session core: list / resume / streaming / steer / interrupt / extension dialogs / mobile) is specced and under construction. See [ROADMAP.md](ROADMAP.md) and [docs/m1-design.md](docs/m1-design.md).

## Install (when released)

Published on npm: [pi-agent-ui](https://www.npmjs.com/package/pi-agent-ui)

```bash
# quick try — no global install (always pin @latest: bare npx reuses stale cache)
npx pi-agent-ui@latest

# or install globally
npm i -g pi-agent-ui
```

Currently pre-release; the design docs above describe what is being built.

## Why

The pi ecosystem has strong web UIs already. This project exists because:

1. **Mobile-first**: most existing options treat mobile as a shrink-to-fit desktop. This one is designed Telegram-first for phones.
2. **Crash-honest architecture**: process supervision, journal reconciliation and single-writer semantics are first-class design pillars (see design doc), not best-effort flags.
3. It's also a public engineering showcase: architecture decisions and trade-offs are documented in the open.

## License

MIT
