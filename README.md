# pi-console

> Web console for the [pi coding agent](https://github.com/earendil-works/pi) — run multiple isolated agent sessions from your browser.

🚧 In active development — first release coming soon.

## Highlights

- 🔒 **Isolated sessions** — each session spawns its own `pi --mode rpc` process; refreshes and crashes never lose your conversation
- 🖥️ **Desktop workbench** — VS Code-style multi-tab UI with session tree, plus a Telegram-style mobile chat view
- 👀 **Full-chain observability** — traces, token cost analytics, context assembly inspection
- 🧩 **Plugin kernel** — TUI plugin slots with web-native panels
- 🤝 **Interops with the TUI** — session files are the single source of truth; see and resume TUI sessions from the web

## Roadmap

- **v1**: web console (desktop workbench + mobile chat)
- later: desktop app / VS Code extension attaching to the same server — the architecture is client-agnostic by design

## Install (coming soon)

```bash
npm i -g pi-console
```

---

*Unofficial community project — not affiliated with the pi project.*
