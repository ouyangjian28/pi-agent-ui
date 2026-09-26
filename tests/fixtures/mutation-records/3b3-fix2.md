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
- **还原哈希**（还原后、本轮 fix3 改动前采样）：apps/server/src/ws/ws-gateway.ts sha256=5cc104978586ec6f…（f870b40 版本内容）；apps/server/src/runtime/history-source.ts sha256=56ed402211afc392…。与基线 commit 内容一致（`git show f870b40:<path> | sha256sum` 可复核）。
- **阶段说明（785 vs 787）**：变异复跑时点=785+7（F1/F3 修复+杀手已入、F4 补测与文档收尾未入）；fix2 终态=787+7（+F4 根 typecheck 用例修正与文档/本档）。两数差异=F4/文档面，与 M-F1/M-F3 杀手集无关。
- fix1 档（3b3-fix1.md）勘误头已在上轮补齐；其独立复演证据=GPT fix2 复审报告 §5 六杀复演 6/6 KILLED（/home/yyj/ai/worktrees/gpt-3b3-fix2-review/projects/pi-agent-ui/audits/gpt-adapter-3b3-fix2-review-2026-09-30.md）。
