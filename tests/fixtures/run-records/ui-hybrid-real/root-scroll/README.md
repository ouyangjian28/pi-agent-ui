# 短屏根滚动漏检：红灯与修正

- 原 UI 8c30ff4 的 65 条脚本判据通过，但 `../final-capture/390-light-short-viewport.png` 的真实短视口图显示顶部导航被滚出屏幕；发送命中不等于整体界面可用。旧图/原通过结果保留。
- 原因：绝对定位的 sr-only 直播状态没有内部 containing block，其长历史后的静态位置扩展了根文档；root scrollHeight=38570，聚焦后 scrollY=187/headerTop=-187，应用本身仍是420px。
- 9250834 新增 root documentScrollY=0、headerTop>=0、scrollHeight<=viewport+1，在未改 UI 上真正触发精确失败，日志 `short-root-red.log` 与原始字节 gzip。本条是新回归用例证明，不冒充注入变异。
- 7842c0b 只添加 real-app/hybrid-ui 的 `.live-stream { position: relative; }`，让无障碍状态留在聊天内部滚动区域；不删屏幕阅读器状态、不强制 JS 重置滚动、不改业务/协议。
- 当前完整复验任务 ba1d5ff80，写本记录时待结果；当前不推荐作为试用/视觉通过候选。短视口模拟不是实机软键盘。
