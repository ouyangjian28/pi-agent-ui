# RealApp → 应用 → 实际 pi 0.99.2 独立链

## 边界与重放

- `python3 tests/fixtures/pi099-real-app.py` 启动仅本机受控 SSE 模型服务，在独立临时 HOME/agentDir/workspace、白名单环境、网络护栏下运行 `tests/browser/pi099-real-bridge.mjs`。护栏先在自有子进程做拒绝外部 fetch 自检，不将 offline 当沙箱。
- 浏览器为实际生产构建 AppRoot→RealApp，native WebSocket→真实 startServer/write.piBin→真实 PiProcessHost/RpcSession→本地 CLI；只替身模型响应，不替换 SDK/后端/传输/业务 UI 状态。认证为临时随机测试值，不使用/记录生产凭据。
- 明确 flags 关闭资源/上下文自动发现、仅 read 工具。此处验证生产同款组合根写链，不声称 main CLI 默认启动配置/扩展全准入/外部模型/计费/真机键盘/取消中止/恢复都已过。
- 覆盖计划：真实模型清单到浏览器；选模型新建首条；真实 delta/final 显示；按 intent 耐久写序；实际订阅切换回来草稿与同一 composer DOM；同会话续聊；真实暖进程停止确认；工作目录和实际 assistant 转录。
- 每次运行落独立 `.pi/upgrade-checks/app-bridge/runs/<UTC>`，失败不覆盖，`latest.json` 仅索引。默认 Vitest 1879/24 的原 opt-in 套件不改、不加 skip，独立链另记。

## 首次启动器失败（f00d8b2 / ba281ef0a）

- `first-loader-failure/` 保存原日志和 provider-result。精确 `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild' imported from .../tests/browser/pi099-real-bridge.mjs`。
- 判断错误在启动器：项目 Vite 8 未提供我假设的 esbuild 包，尚未启动应用/聊天链；providerRequests=[]，外部活动0。护栏自检已过，不据此判断 SDK 不兼容。
- 7e5df4e 改用已经安装的公共 Vite createServer/ssrLoadModule，关闭 dev HTTP/HMR/watch；不安装新依赖、不改产品后端。Python log_message override 类型错误同时修正；两变更文件主动 LSP error=0。
- 后续 b0b3036ab exit 0，首轮记录在 `first-mechanical/`（hash+原始 gzip/可读日志/帧/截图/两次受控请求）。真实 SDK 双轮、耐久顺序和暖进程 confirmed-stop 已实测；但旧夹具缺 D，实际旧订阅返回 4402，原 selection 断言漏检；不能记录完整切换/UX 已过。
- d74b758 增有效旧双树与实际旧原文、必须旧 snapshot 成功/正文可见且零 protocol error；b0f3c980a 严格8项通过，记录 `strict-switch/`。两次真实本机模型请求，无提供商错误/非本机连接；原失败不覆盖。
- 原截图另显示合法 writer 被投成损坏、两份正文副本同级、回执等待字样过时；不能把真实收发通过冒充可用。用户授权只读 writer 识别窄修正后，三行补丁通过 bbc4527ec：1895默认回归/24原opt-in skip、构建/三包类型、36投影单测及真实浏览器/投影零误报。记录 `writer-fixed/`；不改 schema/写入/恢复/接口字段，原坏字段与未知裁决保护保留。
- `writer-fixed/verification/copy-only-mutations/`：提交基线36绿，删除识别3红、绕schema13红、epoch冒充回合2红、unknown冒充settled2红；公开包导入显式绑定副本，原源码未改。不外推恢复/单写者/全部UI变异已验。
- 副本展示/提交回执随后单独调整；UI新两条先真红，修后32定向通过。旧DOM全集文本断言加强为“旧副本仍在hidden节点、主显示仅新增量”，不是删掉断言。b34cae323在1897/24与构建/三包类型通过后因等待旧标签超时，捕获和此任务真实链未完成；失败保留于 `../ui-hybrid-real/receipt-copy-selector-failure/`。ca7bf61更新标签并加强实际收折/全文/主流断言，b2dd049ad的1897/24和build/三包类型绿后，展开字体检查抓到实际mono继承，视口未完成/真实链未跑。第二失败在 `../ui-hybrid-real/receipt-copy-font-failure/`；ca460ee仅一行作用域hy-font，b78f32f48复验中，不混报源版本；UX/用户试用/真机/独立门未过。
