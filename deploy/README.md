# pi-agent-ui 部署 runbook（M-DEPLOY 批②；目标=pi.yangyijian.com 外网可达）

> 计划档：docs/m-deploy-plan.md。服务器：43.108.11.202（阿里云 Ubuntu，nginx/1.18.0）。
> 铁律：凭据（token/模型 API key）只住服务器文件系统（0600），永不入仓/对话/日志。

## 0. 前置确认

- [ ] DNS：pi.yangyijian.com A 记录 → 43.108.11.202（hichina dns21/22——已有，当前指向旧服务）
- [ ] webui.yangyijian.com（现有 pi-web-ui）零改动承诺：只新增 server 块，不动旧配置
- [ ] 443/80 云防火墙已通（现有服务在用）

## 1. 服务器基础（root）

```bash
useradd -m -s /bin/bash piagent            # 专用用户（写面要起 pi 子进程+写 sessions）
apt-get update && apt-get install -y nginx
# node 24（nodesource）：
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
node -v   # 确认 v24.x；ExecStart 的 NODE_BIN 按 which node 改
```

## 2. 应用落地（piagent）

```bash
sudo -u piagent git clone https://github.com/ouyangjian28/pi-agent-ui.git /opt/pi-agent-ui
cd /opt/pi-agent-ui && sudo -u piagent npm install && sudo -u piagent npm run build -w apps/web
# 或本机构建后 rsync dist+src（跳过服务器构建）
sudo -u piagent mkdir -p /opt/pi-agent-ui/sessions    # --root（会话 journal 落此）
```

pi CLI（写面要起真 pi）：`sudo -u piagent npm install -g @mariozechner/pi-coding-agent`（版本以仓内 .nvmrc/实际通道为准）；模型 API 凭据放 `piagent` 家目录 600 文件（pi 自身配置面）。

## 3. token 与 systemd

```bash
mkdir -p /etc/pi-agent-ui && chmod 700 /etc/pi-agent-ui
# 生成 token（就是浏览器访问用的那个密码）：
openssl rand -hex 24
# 写 tokens.json（deploy/tokens.example.json 格式）：
echo '{"version":1,"tokens":["<生成的 token>"]}' > /etc/pi-agent-ui/tokens.json
chown piagent:piagent /etc/pi-agent-ui/tokens.json && chmod 600 /etc/pi-agent-ui/tokens.json
cp /opt/pi-agent-ui/deploy/pi-agent-ui.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pi-agent-ui
systemctl status pi-agent-ui   # 看 main ready 行
curl -s http://127.0.0.1:18787/ -o /dev/null -w "%{http_code}\n"   # 期望 200
```

## 4. nginx 切流

```bash
cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak-$(date +%s)  # 全量备份兜底
cp /opt/pi-agent-ui/deploy/nginx-pi.yangyijian.com.conf /etc/nginx/sites-available/pi.yangyijian.com
ln -sf /etc/nginx/sites-available/pi.yangyijian.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 5. TLS 证书

```bash
# 查现有证书覆盖域：
openssl x509 -in /etc/letsencrypt/live/yangyijian.com/fullchain.pem -noout -text | grep -A1 "Subject Alternative Name"
# 无 pi.：certbot --nginx -d pi.yangyijian.com --expand（并回改 nginx conf 证书路径若 live 目录名变化）
# certbot 自动续期已有（systemctl list-timers | grep certbot）
```

## 6. 外网验证清单（本机浏览器）

- [ ] https://pi.yangyijian.com/ → 200 出前端
- [ ] 无 token → hello 4401 面（token 输入框）
- [ ] `?token=<token>` 直通 → 列表加载
- [ ] 写会话（新会话+发 prompt+看回包）——云端 pi 起动
- [ ] 模型下拉（get-models）
- [ ] UI 问答弹框（若有扩展在飞）
- [ ] 断线重连（手机热点切网络）
- [ ] `https://webui.yangyijian.com` 仍正常（旧服务零损）

## 7. 回滚

```bash
rm /etc/nginx/sites-enabled/pi.yangyijian.com && nginx -t && systemctl reload nginx   # 秒回旧态（DNS 不动）
systemctl disable --now pi-agent-ui   # 停服务
```

## 8. 日常运维

- 日志：`journalctl -u pi-agent-ui -f`
- token 轮换：改 /etc/pi-agent-ui/tokens.json（原子写：写临时文件+mv）→ 自动热轮换（mtime 轮询）或 `systemctl kill -s HUP pi-agent-ui`
- 升级：`cd /opt/pi-agent-ui && sudo -u piagent git pull && npm install && npm run build -w apps/web && systemctl restart pi-agent-ui`
