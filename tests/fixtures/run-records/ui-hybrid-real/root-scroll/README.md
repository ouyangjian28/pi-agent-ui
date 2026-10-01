# 短屏根滚动漏检：红灯与修正

- 原 UI 8c30ff4 的 65 条脚本判据通过，但 `../final-capture/390-light-short-viewport.png` 的真实短视口图显示顶部导航被滚出屏幕；发送命中不等于整体界面可用。旧图/原通过结果保留。
- 原因：绝对定位的 sr-only 直播状态没有内部 containing block，其长历史后的静态位置扩展了根文档；root scrollHeight=38570，聚焦后 scrollY=187/headerTop=-187，应用本身仍是420px。
- 9250834 新增 root documentScrollY=0、headerTop>=0、scrollHeight<=viewport+1，在未改 UI 上真正触发精确失败，日志 `short-root-red.log` 与原始字节 gzip。本条是新回归用例证明，不冒充注入变异。
- 7842c0b 只添加 real-app/hybrid-ui 的 `.live-stream { position: relative; }`，让无障碍状态留在聊天内部滚动区域；不删屏幕阅读器状态、不强制 JS 重置滚动、不改业务/协议。
- 完整复验任务 ba1d5ff80 exit 0：定向→1879 回归/24 原有 opt-in skip→build/三包类型→全 65 视口与行为记录均过。`capture/` 镜像原 `.pi/hybrid-real/root-contained-capture/` 同名图；原 manifest 保留 .pi 路径，result.json 记录对应关系、codeCommit=7842c0b62c57c989eae779df5116297edf2f11aa、任务/HTML和JS hash/证据文件 hash。原始 gzip 日志与可读日志成对保存。
- 聚焦后 documentScrollY=0、documentScrollHeight=viewportHeight=420、headerTop=0，读者上翻仍为0，composer/草稿保存、业务帧差0、发送命中、IME无误发；65条记录页面异常/横溢均0。人工读修后短屏图确认导航在顶部、底部不再空缺，不把机械结果冒充独立视觉审。
- 已解除本次短屏漏检；实际应用接本地 pi 0.99.2、窄变异、外部交叉/视觉审与用户试用仍待验。短视口模拟不是实机软键盘，未替换日常服务。
