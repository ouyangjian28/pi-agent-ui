#!/usr/bin/env python3
"""3c-3 变异四连：M6 REGISTRY-CACHE-BYPASS / M7 STATUSFOR-BASE-ONLY / M8 COMPOSE-DISPOSE-SKIP / M9 DISPOSE-SHARE-DELETE。
纪律：每变=apply→定向跑→(永远)restore→验哈希；日志含 stderr 并入（第19c/19d教训）。"""
import subprocess, sys, hashlib, datetime

REPO = "/home/yyj/ai/repos/pi-agent-ui"
ENV = {"PATH": "/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin", "HOME": "/home/yyj"}
TESTS = "tests/unit/server/session-registry.test.ts tests/unit/server/composition-write.test.ts"

MUTS = {
  "M6-REGISTRY-CACHE-BYPASS": (
    "apps/server/src/runtime/session-registry.ts",
    "    const cached = sessions.get(file);",
    "    const cached = undefined as ReturnType<typeof sessions.get>;",
  ),
  "M7-STATUSFOR-BASE-ONLY": (
    "apps/server/src/runtime/session-registry.ts",
    "    const s = sessions.get(file);",
    "    const s = undefined as ReturnType<typeof sessions.get>;",
  ),
  "M9-DISPOSE-SHARE-DELETE": (
    "apps/server/src/runtime/session-registry.ts",
    "      if (disposeP !== null) return disposeP; // 20轮F3：共享收尾 Promise——并发第二等待者不得提前完成",
    "      if (false && disposeP !== null) return disposeP; // MUT-M9 并发第二等待者不共享收尾",
  ),
  "M8-COMPOSE-DISPOSE-SKIP": (
    "apps/server/src/composition.ts",
    "        if (registry !== null) await registry.dispose(); // 3c-3：写侧统一销毁（全量 stop+dispose；网关先告别再杀进程）",
    "        if (registry !== null) void registry; // MUT-M8 跳过销毁",
  ),
}

def sha(path):
    return hashlib.sha256(open(f"{REPO}/{path}", "rb").read()).hexdigest()[:16]

def run(cmd, timeout=300):
    return subprocess.run(cmd, shell=True, cwd=REPO, env=ENV, capture_output=True, text=True, timeout=timeout)

fails = []
for name, (path, old, new) in MUTS.items():
    base = sha(path)
    src = open(f"{REPO}/{path}").read()
    assert src.count(old) == 1, f"{name}: 锚点非唯一或未命中（count={src.count(old)}）"
    log = [f"# {name}  {datetime.datetime.now().isoformat()}  baseline={REPO.split('/')[-1]}@ce9e4c8",
           f"# 锚点文件={path} 基线sha256[:16]={base}", f"# stderr 已并入本档（第19c/19d轮证据口径）", ""]
    try:
        open(f"{REPO}/{path}", "w").write(src.replace(old, new))
        r = run(f"npx vitest run {TESTS} 2>&1")
        log.append(f"$ npx vitest run {TESTS}   (exit={r.returncode})")
        log.append(r.stdout[-14000:])
        if r.stderr:
            log.append("--- stderr ---")
            log.append(r.stderr[-4000:])
        n_fail = r.stdout.count("FAIL ") + r.stdout.count("× ")
        log.append(f"\n# 失败测试计数(FAIL/× 行)={n_fail}  期望>0")
        if r.returncode == 0:
            fails.append(f"{name}: 未被杀（exit=0）")
    finally:
        open(f"{REPO}/{path}", "w").write(src)
        after = sha(path)
        log.append(f"# restore 后 sha256[:16]={after}  与基线一致={'OK' if after == base else 'MISMATCH!'}")
        git = run("git status --porcelain --untracked-files=no")
        assert git.stdout.strip() == "", f"{name}: restore 后树不净\n{git.stdout}"
    open(f"{REPO}/tests/fixtures/run-records/3c3-mut-{name}.log", "w").write("\n".join(log))
    print(f"{name}: exit见档 restore={'OK' if after == base else 'MISMATCH'}")

if fails:
    print("\n".join(["未杀变异:"] + fails)); sys.exit(1)
print("四变异全杀+全还原（树净）")
