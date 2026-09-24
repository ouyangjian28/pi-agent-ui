# Roadmap

## M1 — Session core (in progress)

The minimal loop that makes it self-hostable and daily-usable:

- [ ] Session list (all sessions incl. terminal-created ones, grouped by cwd)
- [ ] New session (spawn isolated pi RPC process, cwd picker)
- [ ] Resume with persistent entry cursor (fast re-entry, no full reload)
- [ ] Streaming render (delta accumulation), steer / follow-up queue
- [ ] Interrupt (abort + clear queue)
- [ ] Cross-visibility with the terminal + view-then-takeover write ownership
- [ ] Idle session recycling (graceful shutdown after 30 min, cold-restart ~1–2 s)
- [ ] Journal reconciliation after crashes (nothing silently lost)
- [ ] Extension dialog passthrough (select/confirm/input rendered natively in browser)
- [ ] Reconnect + replay; background-tab WS kill recovery + re-auth
- [ ] Mobile: full chain over public internet (nginx facade + auth)
- [ ] Desktop skeleton: multi-tab + session tree sidebar + status bar

## M2 — Plugin runtime

- Manifest + trusted first-party plugins, UI slot registry (panel/workbench/chat-card)
- RPC UI passthrough as the default channel for plugin UI
- Quota plugin (credit limits, same data source as `pi-usage`)

## v0.x+

- Sandboxed iframe runtime for third-party plugins
- Session forking / tree branching UI
- Model & thinking-level switching UI
- Compaction controls, session stats (tokens/cost/context usage)
- Public release hardening

Design details: [docs/m1-design.md](docs/m1-design.md)
