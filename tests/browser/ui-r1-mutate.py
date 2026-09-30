#!/usr/bin/env python3
"""R1 窄变异：只在已提交基线的 git archive 副本注入，原施工树只读。
每例记录真实 unified diff、裸退出码、失败用例与还原哈希；无 Tests 实败不算杀。
"""
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ui-r1-evidence/mutations")
OUT.mkdir(parents=True, exist_ok=True)
def run(args, cwd=ROOT, env=None):
    return subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
if run(["git", "diff", "--exit-code"]).returncode or run(["git", "diff", "--cached", "--exit-code"]).returncode:
    raise SystemExit("STOP: 变异前基线必须已 commit 且 tracked 树干净")
BASELINE = run(["git", "rev-parse", "HEAD"]).stdout.strip()
COPY = Path(tempfile.mkdtemp(prefix="ui-r1-mutation-"))
archive = OUT / "baseline.tar"
subprocess.run(["git", "archive", "--format=tar", "--output", str(archive), BASELINE], cwd=ROOT, check=True)
with tarfile.open(archive) as tar:
    tar.extractall(COPY, filter="data")
(COPY / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
S = "apps/web/src/ws/conversation-state.ts"
R = "apps/web/src/real-app.tsx"
W = "apps/web/src/ws/ws-client.ts"
L = "apps/web/src/components/live-stream.tsx"
cases = [
    ("M01-premature-subscribe", [(S, 'this.put(this.blank(id, file, true, modelChoice));\n    this.publish({ view: { kind: "draft", id }, activeFile: null });', 'this.put(this.blank(id, file, true, modelChoice));\n    this.publish({ view: { kind: "draft", id }, activeFile: file });')], "conversation-state.test.ts", None),
    ("M02-old-version-clears", [(S, ' && current.version === op.version', '')], "conversation-state.test.ts", None),
    ("M03-ack-steals-B", [(S, ' && view.kind === "draft" && view.id === id', '')], "conversation-state.test.ts", None),
    # 转移一次和目标槽保护为两层防线；组合撤销代表同一“恢复重灌”故障，不冒称单层各自可杀。
    ("M04-residual-reinject", [(S, ' || draft.transferred', ''), (S, 'if (session.version === 0 && session.text === "")', 'if (true)')], "conversation-state.test.ts", None),
    ("M05-server-as-rejected", [(S, 'if (error.kind === "server" ||', 'if (error.kind === "server") return { status: "rejected", outcome: { kind: "busy" } };\n    if (false ||')], "conversation-state.test.ts", None),
    ("M06-cutoff-cancels-pending", [(S, 'phase: "settled-unknown", result: { status: "unknown", message: "等待已截止', 'phase: "settled-unknown", operation: { ...current.operation, pending: false }, result: { status: "unknown", message: "等待已截止')], "conversation-state.test.ts", None),
    ("M07-reserved-model-accepted", [("apps/web/src/ws/draft-model.ts", '!value.startsWith("__") && ', '')], "new-session.test.ts", None),
    ("M08-preference-not-restored", [("apps/web/src/ws/draft-model.ts", 'return value !== null && isPersistableModel(value) ? value : null;', 'return value !== null && isPersistableModel(value) ? null : null;')], "new-session.test.ts", None),
    ("M09-preference-after-send", [(R, 'if (isNew) writeLastModel(model ?? MODEL_DEFAULT);', 'void model;')], "r1-real-app.test.ts", None),
    ("M10-model-ready-not-repulled", [("apps/web/src/components/model-picker.tsx", '[source, snapshot.state]', '[source]')], "new-session.test.ts", None),
    ("M11-partial-green", [("apps/web/src/components/health-dot.tsx", 'if (states.every((state) => state === "ready"))', 'if (states.some((state) => state === "ready"))')], "health-dot.test.ts", None),
    ("M12-back-unsubscribes", [(R, 'const file = ui.activeFile;', 'const file = ui.view.kind === "list" ? null : ui.activeFile;')], "r1-real-app.test.ts", None),
    ("M13-IME-sends", [("apps/web/src/components/write-composer.tsx", ' || event.nativeEvent.isComposing || event.keyCode === 229', '')], "r1-real-app.test.ts", None),
    ("M14-dedup-offset", [(W, 'nextOffset: frame.offset + frame.sessions.length', 'nextOffset: sessions.length')], "r1-list.test.ts", None),
    ("M15-mixed-list-version", [(W, 'if (this.listOffset > 0 && frame.listVersion !== this.snapshot.listVersion)', 'if (false && this.listOffset > 0 && frame.listVersion !== this.snapshot.listVersion)')], "r1-list.test.ts", None),
    ("M16-old-list-generation", [(W, 'if (needRepull || this.pendingListGeneration !== this.listGeneration)', 'if (false && (needRepull || this.pendingListGeneration !== this.listGeneration))')], "r1-list.test.ts", None),
    ("M17-fixed-day-DST", [("apps/web/src/ws/session-groups.ts", 'const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();', 'const yesterday = day - 86_400_000;')], "r1-list.test.ts", "America/New_York"),
    ("M18-history-deletes-live", [(L, 'pending.current = { text:', 'if (_historyEvents.some((event) => event.kind === "message" && event.role === "assistant")) frozen.current = [];\n    pending.current = { text:'), (L, '[liveEvents, generationKey]', '[liveEvents, generationKey, _historyEvents]')], "r1-live-handoff.test.ts", None),
    ("M19-finals-overwrite", [(L, 'frozen.current.push({ id: ++serial.current, text: event.text, thinking: thinkingTextOf(state.current), collapsed: false });', 'frozen.current = [{ id: ++serial.current, text: event.text, thinking: thinkingTextOf(state.current), collapsed: false }];')], "r1-live-handoff.test.ts", None),
    ("M20-true-client-drops-final", [("apps/web/src/ws/subscribe-client.ts", 'return v.role === "assistant" && str(v.text);', 'return false && v.role === "assistant" && str(v.text);')], "r1-real-app.test.ts", None),
    ("M21-more-button-no-frame", [("apps/web/src/components/session-list.tsx", 'onClick={() => client.requestMoreSessions?.()}', 'onClick={() => {}}')], "r1-real-app.test.ts", None),
    ("M22-message-activity-mixed", [("apps/web/src/components/session-detail.tsx", 'view.events.filter((event) => event.kind === "message" && (event.role === "user" || event.role === "assistant"))', 'view.events.filter(() => true)')], "r1-real-app.test.ts", None),
    ("M23-scroll-always-bottom", [(R, 'if (nearBottom.current) element.scrollTop = element.scrollHeight;', 'if (true) element.scrollTop = element.scrollHeight;')], "browser", None),
    ("M24-Strict-destroys-owner", [("apps/web/src/ws/use-conversation-lifetime.ts", 'const lease = ++epoch.current;', 'epoch.current += 1;'), ("apps/web/src/ws/use-conversation-lifetime.ts", 'return () => queueMicrotask(() => {\n      if (epoch.current === lease) owner.dispose();\n    });', 'return () => owner.dispose();')], "r1-real-app.test.ts", None),
    ("M25-unmount-leaks-wait-timer", [("apps/web/src/ws/use-conversation-lifetime.ts", 'if (epoch.current === lease) owner.dispose();', 'if (epoch.current === lease) { /* no cleanup */ }')], "r1-lifetime.test.ts", None),
    ("M26-screenreader-every-token", [(L, 'className="live-stream" aria-live="off"', 'className="live-stream" aria-live="polite"')], "r1-live-handoff.test.ts", None),
]
results = []
for name, edits, test, timezone in cases:
    originals = {path: (COPY / path).read_text() for path, _, _ in edits}
    changed = dict(originals)
    try:
        for path, old, new in edits:
            if changed[path].count(old) != 1:
                raise RuntimeError(f"{name}: 锚点不是恰一处：{path} {old}")
            changed[path] = changed[path].replace(old, new)
        patch = "".join("".join(difflib.unified_diff(originals[path].splitlines(keepends=True), changed[path].splitlines(keepends=True), fromfile=f"a/{path}", tofile=f"b/{path}")) for path in originals)
        if not patch:
            raise RuntimeError("STOP: 空变异")
        patch_path = OUT / f"{name}.diff"
        patch_path.write_text(patch)
        check = run(["git", "apply", "--check", str(patch_path)], COPY)
        if check.returncode:
            raise RuntimeError("不可应用的 patch: " + check.stdout)
        for path in changed:
            (COPY / path).write_text(changed[path])
        env = dict(os.environ)
        if timezone:
            env["TZ"] = timezone
        if test == "browser":
            build = run(["npm", "run", "build", "-w", "apps/web"], COPY, env)
            (OUT / f"{name}-build.log").write_text(build.stdout)
            if build.returncode:
                raise RuntimeError("浏览器变异必须先 build 真绿，不能语法破损假杀")
            outcome = run(["node", "tests/browser/ui-r1-capture.mjs", str(OUT / "mutated-browser"), "--behavior-only"], COPY, env)
            killed = outcome.returncode != 0 and "向上阅读被直播抢回底部" in outcome.stdout
            failed = [{"fullName": "真浏览器向上阅读不抢滚动", "message": outcome.stdout}] if killed else []
        else:
            json_path = OUT / f"{name}.json"
            outcome = run(["npx", "vitest", "run", f"tests/unit/web/{test}", "--no-cache", "--configLoader", "runner", "--reporter=json", f"--outputFile={json_path}"], COPY, env)
            data = json.loads(json_path.read_text()) if json_path.exists() else {}
            failed = [{"fullName": assertion.get("fullName"), "messages": assertion.get("failureMessages", [])} for suite in data.get("testResults", []) for assertion in suite.get("assertionResults", []) if assertion.get("status") == "failed"]
            killed = outcome.returncode != 0 and data.get("numFailedTests", 0) > 0 and bool(failed)
        (OUT / f"{name}.log").write_text(outcome.stdout + f"\nEXIT={outcome.returncode}\n")
        row = {"name": name, "baseline": BASELINE, "test": test, "timezone": timezone, "exit": outcome.returncode, "killed": killed, "failed": failed, "patch": str(patch_path), "restored": {}}
    finally:
        for path, text in originals.items():
            (COPY / path).write_text(text)
            if (COPY / path).read_text() != text:
                raise RuntimeError("STOP: 还原失配")
    row["restored"] = {path: hashlib.sha256((COPY / path).read_bytes()).hexdigest() for path in originals}
    results.append(row)
    (OUT / "manifest.json").write_text(json.dumps({"baseline": BASELINE, "source": str(ROOT), "copy": str(COPY), "results": results}, ensure_ascii=False, indent=2))
    print(f"{name}: {'KILLED' if killed else 'SURVIVED'} exit={outcome.returncode} failed={len(failed)}", flush=True)
    if not killed:
        raise SystemExit("STOP: 非真红；原施工树未改，副本已还原")
print(f"R1 narrow mutations: {len(results)}/{len(cases)} KILLED; baseline={BASELINE}; source untouched", flush=True)
