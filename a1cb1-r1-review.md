# A1c B1 修复复审报告

## ① 评分与裁决

**100/100，GO：B1 真闭合；新增合法 stop/no-process 正例能独立杀死 M4，且合并基线回归与还原复绿均通过。**

评分只针对本次 B1 修复，不重评整个 A1c，不代表上轮低项全部销案。

| 本次验收项 | 满分 | 得分 | 实证结论 |
| --- | ---: | ---: | --- |
| 新增正例的关联、结算和记账语义 | 30 | 30 | stop 独立结算，prompt 在途保留并随后正常结算，lastResult 精确断言 |
| M4 检出及排除新例对照 | 35 | 35 | 1 failed / 42 passed；排除新例后 42 passed / 1 skipped |
| 必做回归及还原 | 25 | 25 | 定向 43 绿、web 273 绿、tsc/eslint exit 0；副本还原 43 绿 |
| 修复范围与合并一致性 | 10 | 10 | 单提交、单测试文件；两审读文件合并前后一致 |

## ② 探针实录

### 基线、范围与隔离

- 审读 cwd：`/home/yyj/ai/repos/pi-agent-ui/worktrees/gpt-a1cb1-r1-review`。
- 分支：`wt/gpt-a1cb1-r1-review`；审读 HEAD：`d46db5079dfabf25ee8080d29fe18223bec69fa9`。
- 修复提交：`a57dc51f9c56d32f078b137359d18015c1f0ba98`。
- `git log -p 873436d..a57dc51` 亲读：该范围恰一个提交，仅改 `tests/unit/web/write-client.test.ts`。除了新增正例，还有换行、引号等格式变化。用 TypeScript AST 排除该新增 it 后比较前后结构，结果 `true`，其余测试语义结构未变。
- `git diff a57dc51 d46db50 -- tests/unit/web/write-client.test.ts apps/web/src/ws/write-client.ts` 无输出，exit 0：本次两个审读文件在合并前后完全一致。
- 全程使用 `PATH=/home/yyj/.nvm/versions/node/v24.18.0/bin:$PATH`；实测 Node `v24.18.0`、Vitest `5.0.1`。
- 四项必做命令均从上述 worktree 仓根运行；依赖由祖先仓根现有 node_modules 解析，未安装或升级依赖。
- 变异只在 `git archive HEAD` 导出的仓外副本 `/tmp/a1cb1-r1-mutation-9jvKAi` 执行，副本 node_modules 链接到现有依赖。未修改审读 worktree 的生产代码或测试，也未操作其他 worktree。

### 必做命令的实际输出

| 命令 | 结果 | exit |
| --- | --- | ---: |
| `npx vitest run tests/unit/web/write-client.test.ts` | 1 file，43 passed，658ms | 0 |
| `npx vitest run tests/unit/web` | 12 files，273 passed，1.69s | 0 |
| `npx tsc -p apps/web --noEmit` | 零输出 | 0 |
| `npx eslint tests/unit/web/write-client.test.ts` | 零输出 | 0 |

原始日志：`/tmp/a1cb1-r1-regression-Ctj0Et/{targeted,web,tsc,eslint}.log`；各命令退出码另存同目录 `results.txt`。后台包装命令 exit 0 不作为子命令成功证据，此处使用逐条记录的退出码与实际日志。

### 新增正例语义核对

定位：`tests/unit/web/write-client.test.ts:252–271`。

1. 同一 `a.jsonl` 先 `sendPrompt`，再 `sendStop`；实发帧断言区分 `wr-p-1` 与 `wr-s-2`。
2. 注入 `write-stop-ack`，使用 stop 自身的 `requestId: "wr-s-2"`、正确 file 与 `outcome: {kind: "no-process"}`。
3. `await expect(stopPromise).resolves.toEqual({kind: "no-process"})` 明确要求正常 resolve，不是拒绝分支或仅验证解析器无异常。
4. 快照 inflight 严格等于仅有 prompt 的数组：stop 已出账，prompt 尚在途。
5. `lastResult` 严格等于 `{ok:true, kind:"stop", file:"a.jsonl", outcome:{kind:"no-process"}}`，不会被 null、错误 kind/file 或其他 outcome 混过。
6. 最后仅向 `wr-p-1` 注入 `LAUNCHED`，要求原 prompt Promise 正常得到该结果且 inflight 归零；不是只看表面快照而放任 prompt 被误结算。
7. `:234–246` 的错 kind 负例独立保留，未与正例合成一条可能提前退出的路径。

参照生产链：`apps/web/src/ws/write-client.ts` 的 `isStopOutcome` 接纳 no-process，`parseWriteStopAck` 验形，`takePending` 按 requestId/kind/file 交叉匹配，stop 分支发布 inflight 与 lastResult 后 resolve。

### M4：删除 stop 的 no-process 合法分支

仅在副本中将 `isStopOutcome` 的如下代码删除一行，保持 prompt 的同名分支不变：

```diff
 case "deadline-exceeded":
-case "no-process":
 case "stopping":
   return true;
```

执行 `npx vitest run tests/unit/web/write-client.test.ts`：

```text
exit=1
Tests  1 failed | 42 passed (43)
FAIL G1 requestId 关联 > 合法 write-stop-ack no-process 正向结算：stop 以自身 requestId 结算，prompt 在途零误伤
Error: Test timed out in 5000ms.
```

失败位置是新增 `it`（`:252`）：非法化后的 no-process 帧被丢弃，stop Promise 不结算，因此在默认 5 秒超时处红。没有编译失败、加载失败或无关测试失败掩盖杀点。

同一变异保持不动，再执行：

```sh
npx vitest run tests/unit/web/write-client.test.ts -t '^(?!.*合法 write-stop-ack no-process 正向结算)'
```

结果 **exit 0，42 passed / 1 skipped**。这是当前测试集排除新例的消融对照，不冒称完整检出旧提交；结合前述其余测试 AST 等价，证明 M4 的新增检出能力来自这一个新例。

日志：副本根 `m4-new.log`、`m4-without-new.log`。

### 补充变异：stop 成功后漏记 lastResult

先恢复 M4，再仅把 stop-ack 路径改为：

```diff
-this.publish({ inflight: taken.inflightView, lastResult: { ok: true, kind: "stop", file: frame.file, outcome: frame.outcome } });
+this.publish({ inflight: taken.inflightView });
```

执行相同定向命令，结果 **exit 1，2 failed / 41 passed**：

- 新例在 `:262` 明确报 `expected null to deeply equal { ok: true, kind: 'stop', … }`，实际杀中 lastResult 缺失，而非超时。
- 原有 G6 stop 交互例在 `:730` 报 `expected '可发送' to contain '已停止'`。

日志：副本根 `stop-last-result.log`。

### 还原与源文件未变证明

从未改动的审读 worktree 将生产文件原样复制回副本，重新运行定向命令：**exit 0，43 passed，668ms**。日志：副本根 `restored.log`。

审读 worktree 探针前后及副本还原后的 SHA-256 一致：

```text
apps/web/src/ws/write-client.ts
2d98cfdf4d20cec8b70266ffd188de3befb36a581d34b8a938b85a1080e9f89c

tests/unit/web/write-client.test.ts
df58aa26bcd1212081168224dcf666a798aa8a4f52a9dafe2c86982b0d9e1357
```

### 合并面检查与证据边界

- `d46db50` 双亲为 `b7ac9cc` 和 `a57dc51`。`git show --remerge-diff` 显示 `TEST-MAP.md` 冲突处保留了两侧章节并移除冲突标记；未见本次审读文件被合并改写。
- 合并基线的 web 全集 273 例通过，未发现本范围内的合并引入测试问题。
- 未跑全仓套件、真服务器/浏览器 E2E，不将修复提交自述的“全仓 1245 passed / 11 skipped”当作本轮实证。
- 会话未见【流程门】自动注入块，开场已披露并手动读取项目规则；`session_search` 工具未暴露，未声称完成历史会话检索。本次裁决取证自明确提交、源文件和亲跑日志，不依赖历史口述。
- 时间使用本机实际 ISO 时钟；不沿用历史审报文件名中的日期。临时原始日志在 `/tmp`，其关键命令、差异、失败原文和结果已固化到本报告。

## ③ 阻断项

**零 open。** 上轮唯一阻断 B1（合法 stop/no-process 正向结算防线缺失）关闭：正例存在、M4 恰被该例击杀、移除该例则存活、还原复绿，证据链完整。

## ④ 低项

本轮未新增低项，未发现需登记的合并引入测试面问题。上轮其余低项不在此次复审范围，不重审、不默认销案。

## ⑤ 建议

接受该 B1 修复，保持合法正例与错 kind 负例独立。后续重写此测试文件时继续以 M4 为回归探针；当前 5 秒超时能可靠杀死 M4，但若需改善失败定位，可另行考虑有界等待辅助器，不作为本轮通过条件。

工作区边界：仅新增本报告；原有未跟踪输入 `a1cb1-brief.md` 原样保留，不纳入报告提交。不合并或改动 master。

A1CB1-R1-REVIEW-DONE 2026-09-28T05:21:07+08:00
