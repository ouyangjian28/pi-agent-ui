#!/usr/bin/env python3
"""R1 前端候选产物发布/回滚验法：只改 apps/web/dist，零服务重启、零认证请求。
默认在临时副本自测；--apply 先自测，再备份旧产物并按资源先行、HTML 原子切换发布。
旧 hash 资产保留可取；测试临时回旧 HTML 核实构建身份，再切回候选。
"""
import argparse
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
TARGET = Path("/home/yyj/ai/repos/pi-agent-ui/apps/web/dist")
SOURCE = ROOT / "apps/web/dist"
OUT = Path("/tmp/ui-r1-evidence/deploy")
def digest(data): return hashlib.sha256(data).hexdigest()
def build_of(html):
    match = re.search(r'assets/index-[^" ]+\.js', html.decode())
    if not match: raise RuntimeError("HTML 无真实 hash 构建入口")
    return match.group(0)
def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".ui-r1-", delete=False) as file:
        file.write(data); file.flush(); os.fsync(file.fileno()); name = file.name
    os.replace(name, path)
def stage_assets(source, target):
    for path in source.rglob("*"):
        if not path.is_file() or path.name == "index.html": continue
        if path.is_symlink(): raise RuntimeError("候选构建不接受 symlink 文件")
        relative = path.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink(): raise RuntimeError("目标资产为 symlink，拒绝覆盖")
        content = path.read_bytes()
        if destination.exists():
            if destination.read_bytes() != content: raise RuntimeError("hash 资产同名异字节，拒绝覆盖")
        else: atomic(destination, content)
def get(url):
    # 无 cookie、无 token、无 query、无 Authorization；只读取公开静态构建文件。
    with urlopen(url, timeout=5) as response:
        if response.status != 200: raise RuntimeError(f"static HTTP {response.status}")
        return response.read()
def switch_and_verify(source, target, url):
    previous = (target / "index.html").read_bytes(); candidate = (source / "index.html").read_bytes()
    old_build = build_of(previous); new_build = build_of(candidate)
    old_asset = (target / old_build).read_bytes()
    if build_of(get(url)) != old_build: raise RuntimeError("服务入口不对应目标 dist，暂停发布")
    stage_assets(source, target)
    try:
        atomic(target / "index.html", candidate)
        if build_of(get(url)) != new_build: raise RuntimeError("候选 HTML 身份未加载")
        if get(url + new_build) != (source / new_build).read_bytes(): raise RuntimeError("候选资源字节失配")
        atomic(target / "index.html", previous)
        if build_of(get(url)) != old_build: raise RuntimeError("回滚 HTML 身份失配")
        if get(url + old_build) != old_asset: raise RuntimeError("旧资源不可取或字节失配")
        atomic(target / "index.html", candidate)
        if build_of(get(url)) != new_build: raise RuntimeError("回候选未加载")
        return {"previousBuild": old_build, "candidateBuild": new_build, "oldAssetRetained": True, "candidateSha256": digest(candidate), "oldAssetSha256": digest(old_asset), "atomicHtmlRollbackVerified": True}
    except BaseException:
        atomic(target / "index.html", previous)
        raise
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass

def selftest():
    temporary = Path(tempfile.mkdtemp(prefix="ui-r1-publish-selftest-"))
    source = temporary / "candidate"; target = temporary / "served"
    for directory, version in [(source, "new"), (target, "old")]:
        (directory / "assets").mkdir(parents=True)
        (directory / "assets" / f"index-{version}.js").write_text(version)
        (directory / "index.html").write_text(f'<script src="/assets/index-{version}.js"></script>')
    server = ThreadingHTTPServer(("127.0.0.1", 0), lambda *args, **kwargs: QuietHandler(*args, directory=str(target), **kwargs))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        result = switch_and_verify(source, target, f"http://127.0.0.1:{server.server_port}/")
        assert result["candidateBuild"] == "assets/index-new.js"
        assert (target / "assets/index-old.js").read_text() == "old"
        return result
    finally: server.shutdown(); server.server_close(); thread.join()
parser = argparse.ArgumentParser(); parser.add_argument("--apply", action="store_true"); args = parser.parse_args()
OUT.mkdir(parents=True, exist_ok=True)
preflight = selftest()
if not args.apply:
    (OUT / "selftest.json").write_text(json.dumps(preflight, indent=2))
    print("副本预演：资源保留、HTML 原子切换、回滚构建 ID 及字节验证 PASS；未改生产 dist")
else:
    if not SOURCE.is_dir() or not TARGET.is_dir() or TARGET.is_symlink(): raise SystemExit("STOP: 构建/目标目录异常")
    backup = Path(tempfile.mkdtemp(prefix="ui-r1-dist-backup-")) / "dist"
    shutil.copytree(TARGET, backup)
    result = switch_and_verify(SOURCE, TARGET, "http://127.0.0.1:18787/")
    result.update({"backup": str(backup), "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "selftest": preflight, "serviceRestarted": False, "productionTokenUsed": False, "businessSessionFilesTouched": False, "scope": "frontend dist only; original sessions continuity needs independent owner check"})
    (OUT / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"候选构建已发布并完成静态回滚演练：{result['candidateBuild']}；备份={backup}；零认证请求/零服务重启")
