#!/usr/bin/env python3
"""3c-5 ⑤B 变异四连：S1 TRAVERSAL-GATE-OFF / S2 DOTFILE-GATE-OFF / S3 DISPOSE-NOCLOSEALL /
S4 CLI-PORT-GATE-OFF。纪律承 3c3：apply→定向跑→(永远)restore→验哈希→树净断言；
日志含命令头/exit 码/stderr 并入/FAIL 块；HEAD 取实时 git rev-parse；基线已先提交（M-240/M-245）。"""
import subprocess, sys, hashlib, datetime

REPO = "/home/yyj/ai/repos/pi-agent-ui"
ENV = {"PATH": "/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin", "HOME": "/home/yyj"}
TESTS = "tests/unit/server/static-serve.test.ts"

MUTS = {
  "S1-TRAVERSAL-GATE-OFF": [
    ("apps/server/src/ws/static-serve.ts",
     '  if (full !== root && !full.startsWith(root + sep)) return null; // 穿越门（含 ..、绝对段拼接逃逸）',
     '  if (false && full !== root && !full.startsWith(root + sep)) return null; // MUT-S1 穿越门关闭'),
  ],
  "S2-DOTFILE-GATE-OFF": [
    ("apps/server/src/ws/static-serve.ts",
     '    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return null; // 点文件=404',
     '    if (seg === "..") return null; // MUT-S2 点段门收窄到仅 ..'),
  ],
  "S3-STATIC-GUARD-OFF": [
    ("apps/server/src/composition.ts",
     '      throw new Error("staticDir 模式必须显式指定固定 port（同源 origin 白名单需预知端口）");',
     '      // MUT-S3 固定端口门关闭（staticDir+port 0 不再拒启）'),
  ],
  "S4-CLI-PORT-GATE-OFF": [
    ("apps/server/src/main.ts",
     "    throw new Error(`--port 必填且为 1-65535 整数（固定端口=同源 origin 可预知）\\n${usage()}`);",
     "    if (false) throw new Error(`--port 必填且为 1-65535 整数（固定端口=同源 origin 可预知）\\n${usage()}`); // MUT-S4 端口门关闭"),
  ],
}

def sha(path):
    return hashlib.sha256(open(f"{REPO}/{path}", "rb").read()).hexdigest()[:16]

def run(cmd, timeout=300):
    return subprocess.run(cmd, shell=True, cwd=REPO, env=ENV, capture_output=True, text=True, timeout=timeout)

head = run("git rev-parse --short HEAD").stdout.strip()
if head == "":
    print("取 HEAD 失败"); sys.exit(2)

fails = []
for name, pairs in MUTS.items():
    path = pairs[0][0]
    base = sha(path)
    src = open(f"{REPO}/{path}").read()
    for (_, old, _) in pairs:
        assert src.count(old) == 1, f"{name}: 锚点非唯一或未命中（count={src.count(old)}）"
    log = [f"# {name}  {datetime.datetime.now().isoformat()}  repo@{head}（实时 git rev-parse）",
           f"# 锚点文件={path} 基线sha256[:16]={base}", f"# stderr 已并入本档（3c2-19c/d 证据口径）", ""]
    mutated = src
    try:
        for (_, old, new) in pairs:
            mutated = mutated.replace(old, new)
        open(f"{REPO}/{path}", "w").write(mutated)
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
        git = run("git status --porcelain --untracked-files=no -- ':!tests/fixtures/run-records/3c5-mut-*.log'")
        log.append(f"# git status --porcelain（排除 mut 日志）原始输出：{git.stdout!r}  树净={'OK' if git.stdout.strip() == '' else 'NOT-CLEAN'}")
        assert git.stdout.strip() == "", f"{name}: restore 后树不净\n{git.stdout}"
    open(f"{REPO}/tests/fixtures/run-records/3c5-mut-{name}.log", "w").write("\n".join(log))
    print(f"{name}: exit见档 restore={'OK' if after == base else 'MISMATCH'}")

if fails:
    print("\n".join(["未杀变异:"] + fails)); sys.exit(1)
print(f"四变异全杀+全还原（树净；repo@{head}）")
