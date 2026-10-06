# pi-agent-ui

**Unofficial** web UI / web console / dashboard for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — not affiliated with the pi project.

A self-hosted web workspace that drives pi from your browser:

- **Desktop form**: multi-tab IDE-style workspace — session tree sidebar, status bar, command palette (rolling in)
- **Mobile form**: Telegram-style two-level chat — phone is a first-class target, not an afterthought
- **Every session spawns an isolated `pi --mode rpc` process** — RPC direct-drive over the official protocol; one process per session, so a crash in one never touches another
- **Zero-silent-loss delivery** — every prompt is journaled to disk before dispatch; after a crash, the reconciliation pass tells you exactly what was sent, in-flight, or interrupted. Nothing is silently dropped
- **Multi-writer safety** — sessions are visible to both the terminal and the web UI; view-then-takeover semantics prevent two writers from ever corrupting a session file

> **Status: developing.** M1 (session core: list / resume / streaming / steer / interrupt / extension dialogs / mobile) is specced and under construction. See [ROADMAP.md](ROADMAP.md) and [docs/m1-design.md](docs/m1-design.md).

## UI provenance

The current UI-rework candidate directly reuses **OpenChamber's frontend source, layout, styles, and components**. It is not an independently designed UI. The original source is copyright (c) 2025 Bohdan Triapitsyn and is reused under the MIT license; the complete original [license](vendor/openchamber-frontend/LICENSE) is retained.

Our work on this candidate is the adaptation to the existing pi runtime and its conversation-state, delivery, and recovery contracts. Native end-to-end UI integration is still in progress; a working visual preview is not a functional release. Gradual visual changes will follow integration, without removing upstream attribution. This project is not affiliated with or endorsed by OpenChamber.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance and publication boundaries. The desktop/mobile descriptions above describe project goals; the new frontend candidate uses OpenChamber's original desktop and mobile shells rather than claiming a new Telegram-style design.

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
