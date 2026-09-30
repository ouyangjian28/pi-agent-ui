#!/usr/bin/env bash
# 一键部署（deploy/README.md runbook v2 的脚本化；M-DEPLOY 提速项 #9）
# 用法：deploy/deploy.sh [--skip-build]
# 前提：本机=家机（服务 piagent-web 跑本 repo ts 源）；未 commit 的改动拒绝部署。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "① 工作区检查"
if ! git diff --quiet && git diff --cached --quiet; then :; else
  echo "✗ 有未提交改动——先 commit 再部署（落盘即提交纪律）" >&2; exit 1
fi
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "→ push $LOCAL"; git push origin master
fi

if [ "${1:-}" != "--skip-build" ]; then
  echo "② 前端构建"
  npm run build -w apps/web -w apps/server
fi

echo "③ 重启服务（ts 直跑=pull 后 restart 即生效）"
systemctl --user restart piagent-web

echo "④ 健康复查"
sleep 2
systemctl --user is-active --quiet piagent-web || { echo "✗ piagent-web 未活" >&2; journalctl --user -u piagent-web -n 20 --no-pager; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18787/ || true)
[ "$CODE" = "401" ] || [ "$CODE" = "200" ] || { echo "✗ 健康查异常 http=$CODE" >&2; exit 1; }
echo "✓ 部署完成 $(git log -1 --format='%h %s') http=$CODE"
