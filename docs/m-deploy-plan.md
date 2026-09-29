# M-DEPLOY 部署计划 v1（2026-09-29 拍板稿）

> 权威：REQ R-3 节尾 2029-09-29 拍板（档C 公网反代/pi. 子域让自研/webui. 保留/单用户单 token）。
> 调研依据：~/ai/infra/docs/research/pi-agent-ui-deploy-2026-09-29.md。
> Token 政策（用户 2026-09-29 拍板）：「老一套的那个密码」=沿用现有 pi-web-ui 的 PI_WEB_TOKEN query token 模式（?token=…）。凭据本体住服务器 env（EnvironmentFile 指向 root-only 文件），永不入仓/对话/日志。

## 目标终态

https://pi.yangyijian.com/?token=… —— 外网可达，token 门拦一切（HTTP+WS 升级面），本机服务只听 127.0.0.1，systemd 常驻，nginx TLS 终结，webui.yangyijian.com（现有 pi-web-ui）零改动。

## 四批（每批独立可审可回滚）

### 批① 认证门（代码面，GLM 写 → 交叉审）
- env `PI_AGENT_UI_TOKEN`（未设=仅 loopback 放行——开发态兼容；设了=非 loopback 请求全门）。
- HTTP 面：中间件校验 `?token=`；失败 401 文案对齐现有习惯（`unauthorized: PI_WEB_TOKEN required (?token=…)`）。
- WS 升级面：同一 token 门（query 携带；升级请求在中间件拦）——写连接与读连接同门。
- 审计/日志脱敏：token 不进任何日志行（safeAudit 面过滤）。
- 前端：URL ?token= → sessionStorage 存 → WS/HTTP 自动携带；无 token 访问=显示提示页（「需 ?token= 访问」+输入框）。
- 测试：未设 token loopback 放行/未设 token 非 loopback 拒/设 token 对/错/缺/WS 升级四态/日志无 token 泄漏。

### 批② 部署配置面（仓内 deploy/ 目录，无凭据）
- systemd unit 模板（pi-agent-ui.service：node apps/server、EnvironmentFile=/etc/pi-agent-ui.env（600）、Restart=on-failure、硬化项 NoNewPrivileges/ProtectSystem）。
- nginx server 块模板（pi. 443 TLS→127.0.0.1:8787；WS Upgrade/Connection 头；HSTS；client_max_body_size 1m）。
- 部署 runbook（deploy/README.md：装 node/clone/构建/起服/切 nginx/验证/回滚）。

### 批③ 两钉复核（硬前置）
- 钉①：detail 形状门（后端 string 断言+前端 isSendOutcome 双门）——已落（DS-flash P2-1 修复批）；批①审时复核杀点仍在。
- 钉②：detail 显文政策公网态复评——单用户+token 门+TLS 下维持显文（m-ops-design §4 政策不变）；结论记 TECH。

### 批④ 上线+外网验证（需用户开服务器通道）
- 服务器（43.108.11.202）：装 node 24/clone 仓/构建/写 env（token）/systemd 起/nginx 加 pi. server 块/证书（现有证书若无 pi. SAN 则 certbot 扩）/reload。
- 外网手测清单：列表/写会话/读会话/模型下拉/UI 问答/断线重连/token 错误页。
- 回滚预案：nginx 配置备份+reload 前 -t 校验；webui. 域零改动；systemd 失败=回旧 nginx 配置即恢复。

## 风险与对策
- 部署机=云服务器：写会话面在云端跑 pi——部署机装 pi CLI（npm i -g）+模型凭据入服务器 env（600）。用户已确认单用户自己用（写面=完整功能）。
- 云防火墙：443 已通（现有服务在用），无需开新端口。
