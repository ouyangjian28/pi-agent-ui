# pi-agent-ui 部署 runbook v2（M-DEPLOY 批④已上线版；目标=pi.yangyijian.com 外网可达）

> 计划档：docs/m-deploy-plan.md。**v2 架构变更（2026-09-30 实拍板）**：弃批② VPS 直跑方案，改用本机成熟工作流——**服务跑家机（SER9Max）+SSH 反向隧道+VPS nginx 只做管道**（pi-web/dsh/birthprep 同族模式）。VPS 1.6G 内存跑不动 pi 子进程群是主因；家机有 nvm/模型凭据/完整 pi 环境。
> 铁律：凭据只住 ~/.secrets/（600，家机），永不入仓/对话/日志。

## 0. 现行链路（已切流，2026-09-30）

```
浏览器 https://pi.yangyijian.com
  → VPS(43.108.11.202) nginx 443 SNI 分流(stream.d/sni-split.conf，pi.→默认28085)
  → conf.d/pi-ser9max.conf server 块(28085 ssl，证书 /etc/nginx/tls/pi.yangyijian.com/)
  → 127.0.0.1:28148（SSH 反向隧道）
  → 家机 piagent-web.service（node main.ts --port 18787 --host 127.0.0.1）
```

- 切流备份：VPS `/etc/nginx/conf.d/pi-ser9max.conf.bak-20260930-piagentui`（回滚=cp 回原+reload）
- 旧链路（28142→30141 pi-web-ui）**保留不断**：webui.yangyijian.com 照旧服务；pi-web-ui.service/pi-web-tunnel.service 不动
- fail2ban jail nginx-pi-auth 仍在（盯 pi-web.access.log 401；自研面 POST /login 401 同入 log，jail 兼容）

## 1. 家机组件（systemd --user）

| 服务 | 文件 | 作用 |
|---|---|---|
| piagent-web.service | ~/.config/systemd/user/ | server 主进程（ts 源直跑=repo pull 即生效） |
| piagent-tunnel.service | 同上 | ssh -R 127.0.0.1:28148→18787（镜像 birthprep-tunnel 保活参数） |

关键参数：
- `WorkingDirectory=%h/piagent-sessions`=`--root`（pi 子进程 cwd=会话根；写面最小化——独立树，不掺 ~/ai 仓）
- `--token-file %h/.secrets/piagent-tokens.json`（0600；{version:1,tokens:[原文]}；热轮换=改文件+SIGHUP）
- `--static-dir <repo>/apps/web/dist`（前端产物）
- `--origin https://pi.yangyijian.com`（WS Origin 白名单）
- Environment：PATH 含 nvm v24.18.0 bin（pi 子进程）+NO_PROXY=localhost,127.0.0.1,::1（防代理劫持，M-033 族）

运维口诀：
- 起停：`systemctl --user {start|stop|restart} piagent-web piagent-tunnel`
- 日志：`journalctl --user -u piagent-web -f`
- 更新：repo `git pull`+`npm run build -w apps/web`→`systemctl --user restart piagent-web`
- 换 token：写 ~/.secrets/piagent-tokens.json→`systemctl --user kill -s SIGHUP piagent-web`

## 2. token 模式（用户拍板：老一套）

- 浏览器入口：`https://pi.yangyijian.com/?token=<值>`（前端存 localStorage+WS hello 自动携）
- 登录面：POST /login（HttpOnly cookie sid，Strict）——nginx `location = /login` 挂 pi_auth_rl 限流 5r/m
- WS 面：hello 帧 {t:"hello",protocolVersion:1,token}；错 token=error 4401+close 1008

## 3. 验证清单（2026-09-30 全绿）

- [x] https 静态 200+TLS（外网）
- [x] POST /login 错密码 401
- [x] WS hello 对 token→welcome；错 token→4401+close 1008
- [ ] 浏览器全功能手测（列表/写会话/读会话/模型下拉/UI 问答/断线重连）——用户面验收
- [ ] 长跑观察（隧道保活/内存/日志）

## 4. 回滚

```bash
# VPS 侧（切回 pi-web-ui）：
ssh aliyun-vps 'cp /etc/nginx/conf.d/pi-ser9max.conf.bak-20260930-piagentui /etc/nginx/conf.d/pi-ser9max.conf && nginx -t && systemctl reload nginx'
# 家机组件保留不删（不碍事，随时再切回）
```

## 5. 批② VPS 直跑方案（存档备用）

原批②方案（VPS /opt/pi-agent-ui 直跑+piagent 用户）档=git 651fbfd..6e88e71 的 deploy/；适用于未来换大内存 VPS 或家机不可达场景。执行按 runbook v1（git 历史）。
