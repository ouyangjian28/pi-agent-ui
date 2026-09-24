# UI 第一切片

只读 fixture 演示，不消费 `packages/protocol`、不连接服务器、不发送写命令或 ACK。

## 运行

- 安装：在仓根执行 `npm install --package-lock=false --ignore-scripts`，同时安装根已有的 Vitest 与 web 依赖（本切片边界不允许改根 lockfile；合入时由集成负责人更新锁文件，当前根 npm ci 尚不覆盖新增依赖）。
- 构建：`npm run build -w apps/web`（先 TypeScript 检查再 Vite 构建）。
- 测试：`npx vitest run tests/unit/web`。
- 本地预览：`npm run dev -w apps/web`。

## 本切片实现

PC 三栏；≤767px 手机列表/详情互斥两级壳；返回按钮与 Esc 恢复触发点焦点；列表上下/Home/End 导航、原生按钮 Enter 打开。顶部场景下拉演示空态、加载和断线；返回样本不冒充真实重连。

会话三色只投影注意力，unknown/recovering 均用中性色「状态待确认」。浏览器已读≠agent ACK，导航不核销任何计数。待答持久显示且未读独立计数。新建入口已保留目录和模型下拉，但创建按钮禁用，不虚构可用模型来源。

组件边界：App 管布局/瞬态导航；MessageList 使用稳定消息 ID/seq，小样本自然排版、长列表 TanStack Virtual；part 带 source/version，未知类型降级，不解析 HTML、不打开链接、不渲染权限卡。主题使用外置 CSS tokens + 系统明暗模式。此切片不持久化布局，避免手机操作污染桌面状态。

## 验收边界

覆盖 A1 壳与导航、A2a 最小断线呈现；不宣称完整 A1/A2a 已验收。I-R9 已有动态视口、安全区、非颜色提示、非 live 消息区域；输入禁用，因此 IME 发送/软键盘实机验收留输入切片。I-R11 待答/未读样本持续可见，不生成 toast（无重放重弹）。上传、认证过期、写权冲突、真实恢复与控制卡协议均未接入。

组件测试用 matchMedia 事件验证窄屏挂载/卸载与焦点；jsdom 不证明真实 CSS 几何尺寸、虚拟滚动或真机软键盘行为。这些需要集成期浏览器 E2E/真机验收。
