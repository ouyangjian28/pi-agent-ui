# P0-1a r6 对抗复审

## ① 评分与裁决

**92/100，GO（门槛 85）。B1-r5 协议越界/类型错误与 L1 错路径漏杀均已实证闭合；零 open 高/中，保留两项低优先级记录/断言精度问题。**

基线：`98dd8627047ef9c94a1a6921a1c81fc2b6eecea3`（代码 `0db291e`）；分支 `wt/gpt-p01a-r6-review`。本结论仅放行 P0-1a 本批，不等于 P0-1b 裁决持久化或整产品验收。

| 复审面 | r5 状态（委托给定） | r6 亲证 |
|---|---|---|
| 综合 /100 | 84，NO-GO | **92，GO** |
| B1-r5 类型与协议 | TS2345；线上帧越出四值 | tsc 0；真网络帧回到四值；反向变异双杀 |
| L1 seen 副作用 | 查错路径；变异漏杀 | 正确 seen.json；目录快照在第 1136 行击红 |
| 文档勘误 | 声称修正 r4 tsc 记录 | **未完全兑现：实际错改 r3，r4 原句仍在**（低项） |

运行时间以机器 UTC 为准（2026-09-27），不沿用委托/TEST-MAP 的 2026-10-06 叙事日期。会话未见【流程门】注入，已在开工时披露；本次仅执行明确授权的审读、隔离探针及报告输出。

## ② 探针实录

### T1–T4：基线裸命令

环境：`export PATH=/home/yyj/.nvm/versions/node/v24.18.0/bin:$PATH`。vitest 均从指定 worktree 根运行；每条命令单独捕获 `$?`，不以流水线末端或包装脚本 exit 0 冒充子命令成功。

| 命令 | 实测 | 裸退出码 |
|---|---|---:|
| `npx vitest run` | **69 files passed + 2 skipped；1370 passed + 15 skipped** | 0 |
| `npx vitest run tests/unit/server/recovery-evidence-source.test.ts` | **46 passed** | 0 |
| `cd apps/server && npx tsc --noEmit` | 零输出，日志 0 字节 | **0** |
| `npx eslint apps/server/src/runtime/recovery-evidence-source.ts tests/unit/server/recovery-evidence-source.test.ts` | 零输出，日志 0 字节 | 0 |

全仓结果覆盖委托要求的 N4/A1/⑤C 既有回归面；15 个跳过项不是通过，不扩称为这些跳过场景也获实证。

### P1：差异与契约核对

执行并保存 `git log -p b7ac9cc..98dd862`，定向审查两份代码/测试及 TEST-MAP 的修复 diff。该历史区间还包含前端合并，最终合计 27 文件变更；不能把整个区间称为仅三文件补丁。

- provider 的区间变化只有 `0db291e` 的映射及注释：`recovery-evidence-source.ts:410–415` 保留 `pendingRepair && anchor === null` 拒绝门和审计行，返回值改为 `no-evidence-snapshot`。没有以改类型联合来迁就第五值。
- `git diff b7ac9cc..98dd862 -- packages/protocol/src/contracts.ts` 为空。修复批 `0db291e^..98dd862` 的 contracts/docs diff 也为空。
- `packages/protocol/src/contracts.ts:231–232` 与 `docs/ws-ui-contracts-v1.md:232–233` 仍为 `read-failed | concurrent-modification | oversized | no-evidence-snapshot` 四值。
- 语义认可：此门没有权威快照，且修复事务未完；对外拒绝恢复结论，用既有 no-evidence-snapshot，具体原因留 `recovery-pending-no-anchor` 审计，不构成放宽授权。
- `seenPath()`（生产 :167–169）确为 `seen.json`，RT43 :1137 已改成同路径，不再查 `evidence-seen.json`。
- 本环境通过父仓 node_modules 解析工作区 protocol 包；对本 worktree 与实际解析目标 `packages/protocol/src` 做了 `git diff --no-index`，exit 0，未发现借到异版协议源码。

### P2–P4：自构 P6 真网络网关 + 三路门序

没有以 mock provider 或手工拼 recovery 帧代替网关。使用 `git archive HEAD` 创建 `/tmp/p01a-r6-probes-RZX7Pj` 隔离副本，新增独立探针 `tests/integration/r6-review.test.ts`：

1. 写入一条合法 enqueue + 30 字节撕裂尾，调用真实 `repairJournalTail`。
2. 只在文件句柄 write 接缝抛 `r6-crash-after-marker`，形成真实 marker 已落盘、截断已完成、repair 行未完成、无锚的残局。
3. 通过真实 `startServer` 组合根接入真实 WsGateway + provider；用 `ws` 客户端连接实际 loopback TCP 端口，hello 成功后发送 `get-recovery`。
4. 三种状态各自独立目录；每次检查实际收到的 recovery 帧、具体审计行、证据目录文件名和十六进制字节快照全等。

`npx vitest run tests/integration/r6-review.test.ts`：**3/3 绿，exit 0**；增加出帧 JSON 留证后重跑仍 **3/3 绿，exit 0**。

| 场景 | 实际 reason | 专属审计 | 目录不变 |
|---|---|---|---|
| 授权首捕 + 无锚 + pending（P6） | `no-evidence-snapshot` | `recovery-pending-no-anchor file=q.jsonl` | 是 |
| 未授权首捕 + 无锚 + pending（P3） | `no-evidence-snapshot` | `recovery-no-first-authority file=q.jsonl` | 是 |
| seen 已登记 + 锚缺失 + pending，仍给首捕授权（Q03） | `concurrent-modification` | `recovery-evidence-lost file=q.jsonl` | 是 |

“未授权”指宿主未授予首捕权威，不是 WS 未认证。Q03 通过写入真实 seen.json 构造已登记丢锚状态。三条帧都有 `t=recovery, requestId=r6, file=q.jsonl, availability=unavailable`，reason 均属冻结四值；网关另记对应 `recovery-unavailable`。这证实首捕授权不能越过丢锚门，也不能越过无锚 pending 门。

授权 P6 原始帧：

```json
{"t":"recovery","requestId":"r6","file":"q.jsonl","availability":"unavailable","reason":"no-evidence-snapshot"}
```

### M1–M3：亲手变异重放（全部在独立 /tmp 副本）

每支均从同一 HEAD 归档重新创建，只有被测 provider 的对应一处变异；没有改 RT43 来帮助杀死变异。共同命令：

```sh
npx vitest run tests/unit/server/recovery-evidence-source.test.ts -t RT43
```

| 变异 | 精确改动 | 实测杀点 |
|---|---|---|
| M1 / Mu-r5L1 | pending 无锚门内审计前插入 `await persistSeenLike(evidenceDir, { version: 1, files: [...new Set([...seen, file])].sort() });` | **exit 1，1 failed /45 skipped**；RT43 :1136 目录快照红，Received 多出 `seen.json:{"version":1,"files":["q.jsonl"]}`。不是后续死锁偶然杀死 |
| M2 / B1 反向 | 仅本门 `no-evidence-snapshot` 改回 `repair-pending-first-capture` | **exit 1，RT43 :1134 reason 断言红**；再跑 `cd apps/server && npx tsc --noEmit` 得 **exit 2 / TS2345，:414:30**，明确第五值不属于四值联合 |
| M3 / 审计删除 | 删除 `audit(\`recovery-pending-no-anchor file=${file}\`)` | **exit 1，RT43 :1135 审计断言 false→true 红**；具体成因不是仅有注释无锁定 |

未变异隔离副本最后运行同一 RT43 命令：**1 passed /45 skipped，exit 0**。原 worktree 定向 46 绿已先验；全过程原 worktree 生产代码/测试未修改，无需 checkout 还原，避免还原吞改动。

### 可复核证据

本 worktree 忽略目录 **`.pi/r6-evidence/`** 留存：

- `full.log`、`target.log`、`tsc.log`、`eslint.log`、`contracts.diff`、`history.patch`。
- 独立探针源码 `r6-review.test.ts`，`r6-network*.log`、`r6-result-{authorized,untrusted,lost-anchor}.json`、`r6-control.log`。
- `mutation-{seen,reason,audit}.patch`；`mutation-seen.log`、`mutation.log`（reason）、`mutation-tsc.log`、`mutation-audit.log`。

原始副本：`/tmp/p01a-r6-{probes-RZX7Pj,seen-6oovAL,reason-q9cQXU,audit-iFsFM0}`；基线原始日志 `/tmp/p01a-r6-baseline-A42JYX`。证据为本机临时/忽略面，不随报告 git 提交自动携带。原工作树 `git diff --exit-code`、`git diff --check` 均通过；原有 `p01a-r6-brief.md` 保持未触碰。未进入或修改其他 worktree。

## ③ 阻断项

**零 open 高 / 中。**

- B1-r5 关闭：真实 tsc 0、真实网关四值帧、反向变异 TS2345 + RT43 双杀，三条证据相互独立。
- L1-r5 关闭：路径已对齐，原 seen 副作用变异在新增目录快照处直接击红。
- 映射未弱化拒绝门；Q03 与未授权首捕的前置拒绝仍成立。

## ④ 低项与挂账

**L1-r6【低】TEST-MAP 勘误落错章节（本轮新发现，未闭合）。**

- `tests/fixtures/TEST-MAP.md:852` 位于 **r3** 节，却新增了“当时 tsc exit0 失实、GPT r5 TS2345”的勘误。
- 真正 **r4** 节 :865 仍写“全仓 1263 绿；tsc exit0；eslint 0”。`git show 98dd862` 明确只改了 r3 的原行。
- `git log -S 'repair-pending-first-capture'` 与 `git show a80432f` 证明第五值由 r4 修复提交 a80432f 新增，不能把该原因直接归到 r3。
- 建议把该勘误正确落到 r4；r3 是否 tsc 通过须用它自己的证据判断，不能用后来 r5 的失败倒推。本次当前 HEAD tsc 已实测 0，因此不据此重新阻断代码放行。

**L2-r6【低】RT43 / TEST-MAP 的“ENOENT、逐字节”措辞强于断言精度。**

- :1137 使用 `.rejects.toThrow()`，没有检查 `code === 'ENOENT'`；“ENOENT 专断言”不准确。目录文件名快照构成补强，所以原 L1 功能缺口确已关闭。
- :1129–1131 读取 Buffer 后 `toString('utf8')`，再用 `:`/`|` 拼接。当前合法 JSON marker 夹具足以杀掉本轮 seen 新建变异，但并非无损二进制快照，也不能证明发生后恢复原字节的瞬时写入从未发生。
- 建议改为结构化 `[filename, Buffer/hex]` 深比较，并显式断言 ENOENT；或把文案限缩为“当前 JSON 文件集的拒绝前后内容不变”。独立网关探针已采用 hex 快照，但本轮不替修测试。

沿承而不扩称：未执行真实断电；marker 依赖 evidenceDir 信任域、无独立认证；禁止重叠写者/修复期并发写等部署前提仍在。`repairUndecided` 保守保留是现阶段安全语义，不因本次 GO 自动解除。

## ⑤ 排序建议：P0-1b 裁决持久化

1. **优先进入 P0-1b**：把人工裁决作为可重启恢复的耐久事实，绑定文件/会话和对应证据身份；不能靠删 marker、清内存 flag 或物理修复完成推导“允许重发”。
2. 先锁定失败次序：落盘成功前不发成功确认、不释放恢复授权；断在落盘/确认之间时，重试须幂等，旧证据裁决不得作用于新证据。
3. 验收先列崩溃/重启矩阵，再实现：裁决写失败、已落盘未确认、重复裁决、证据已变化、裁决文件损坏、repairUndecided 跨重启保留，以及合法裁决后只解锁对应意图的正对照。
4. 同批顺手纠正 L1-r6 文档错位与 L2-r6 断言精度；二者不要求再改协议枚举，也不需要重开本轮已闭合的 provider 拒绝门。

R6-REVIEW-DONE 2026-09-27T21:26:42Z
