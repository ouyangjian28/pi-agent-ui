# 3b3-fix2 变异记录（GPT 复审 74→修复轮；2026-09-29）

标准（GPT 复审 §6-5 要求）：每条=真实 diff + 复现命令 + 退出码 + 还原校验。
（对照：3b3-fix1 档为摘要式旧标准，勘误说明见该文件头部。）

## M-F1 屏障判定移除（publishLoop 直投旧快照已含行）

- 目标：证明 F1 发布循环的「恰一次」依赖 historyBarrier 判定——去掉后旧快照已含的行会经 live 直投重复/乱序。
- diff（apps/server/src/ws/ws-gateway.ts，publishLoop 内逐条投递处）：
  ```diff
  -            this.forEachEngine(file, (e) => {
  -              const floor = e.historyBarrier;
  -              if (floor === null || floor >= seq) return; // init/快照已含：跳过（恰一次）
  -              e.onHistoryAppend(ie.event);
  -            });
  +            this.forEachEngine(file, (e) => {
  +              e.onHistoryAppend(ie.event); // MUT-M-F1: 屏障判定移除（旧快照已含行直投→越序/重复）
  +            });
  ```
- 命令：`npx vitest run tests/unit/server/ws-gateway.test.ts -t "P-ORDER"`
- 结果：exit 1，KILLED。失败面：`Error: pageThrough：翻页不收敛`（B 订阅翻页 64 轮不收敛——屏障失效使快照已含行进 live 缓冲，expectNext 错位永不收敛；顺序数组断言前即崩）。
- 还原：`cp /tmp/mut-f1-orig.ts apps/server/src/ws/ws-gateway.ts` → 复跑 ws-gateway 76/76 过。

## M-F3 inode 交接核对读移除（rescanOnce append 分支重挂后不补窗）

- 目标：证明 F3 的 inode-handoff-verify 核对读是「重挂前追加」的兜底——去掉后读后追加在重挂窗口内漏读。
- diff（apps/server/src/runtime/history-source.ts，rescanOnce 末尾 rearmWatcher 后）：
  ```diff
  -    if (handoffVerify) {
  -      slot.followUpReason = "inode-handoff-verify"; // F3：核对读原因穿透（审计可辨）
  -      this.queueRescan(slot, "inode-handoff-verify"); // 交接核对读（重挂后）
  -    }
  +    // MUT-M-F3: inode 交接核对读移除（重挂后不补窗→读后追加漏读）
  ```
- 命令：`npx vitest run tests/unit/server/history-source.test.ts -t "W5"`
- 结果：exit 1，KILLED。失败面：`Error: until timeout`（W5 杀手：读后重挂前追加的第 3 行事件永不通知——appends 恒缺）。
- 还原：`cp /tmp/mut-f3-orig.ts apps/server/src/runtime/history-source.ts` → 复跑 history-source 67/67 过。

## 汇总

| 变异 | 目标面 | 杀手 | 退出码 | 还原后 |
|---|---|---|---|---|
| M-F1 | F1 屏障恰一次 | F1/P-ORDER（ws-gateway） | 1 KILLED | 76/76 过 |
| M-F3 | F3 重挂后核对读 | W5（history-source） | 1 KILLED | 67/67 过 |

还原校验：`git diff` 仅含本轮计划内改动（11 文件 +337/-49）；全套 npm test 44 files 785+7 过（见 TEST-MAP 3b3-fix2 节）。

## 补强（GPT fix2 复审 §4 黄项要求；2026-09-30 追加）

- **基线 commit**：变异执行时点工作区=基线 f870b40（`3b3-fix2: F1 ordered publish loop + ...`，f870b40d7c3dfd23b10704a469818ab230b7a0f4）之上的变异与还原；变异只动 ws-gateway.ts / history-source.ts 两文件。
- **还原哈希（fix4 勘正）**：fix3 补强时误将**当时工作树**（ce527e4 世代）内容哈希标为 f870b40——张冠李戴，撤回。f870b40 真实内容哈希（`git show f870b40:<path> | sha256sum`）：
  - apps/server/src/ws/ws-gateway.ts = ed18e6e4e8053c0bfb3951e35447638cf84f760ad55a66b72b54c058169a7c5e
  - apps/server/src/runtime/history-source.ts = 56ed402211afc392ea15540a7c6a106c4dff24ff78276a1cd48d6c56ffe85325
  - 误记的 5cc104978586ec6f… = ce527e4（fix3 提交）世代 ws-gateway 内容，非本档基线。
- **阶段说明（785 vs 787；fix4 勘正归因）**：变异复跑时点=785+7（F1/F3 修复+杀手已入）；fix2 终态=787+7。增量 +2=real-fs 集成新增 RF13（撕裂尾指纹）/RF14（非前缀分支真指纹）两个 it——原记「F4 补测」有误（F4=composition.test.ts 类型修正，不新增用例）。与 M-F1/M-F3 杀手集无关。
- fix1 档（3b3-fix1.md）勘误头已在上轮补齐；其独立复演证据=GPT **fix1 复审报告**（audits/gpt-adapter-3b3-fix1-review-2026-09-29.md，worktree gpt-3b3b-fix1-review commit 9af578f）六杀复演 6/6 KILLED、探针日志 /tmp/pi-fix1-mutations/（fix4 勘正：原写「fix2 复审报告 §5」错引——fix2 复审 §5 为文档勘误清单）。
