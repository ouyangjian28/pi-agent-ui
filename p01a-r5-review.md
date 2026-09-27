# P0-1a r5 对抗性复审

## ① 评分与裁决

**84/100，NO-GO（门槛 85）。** 原 B1-r4 无锚 pending 首捕死锁与 B6-r4 起点对齐缺杀手均已闭合；但新增拒绝原因未接入类型和冻结协议，server 类型检查实跑失败，网关也确实输出契约外 reason，仍有一项中阻断。

| 对照 | 评分 | 裁决 | 事实 |
| --- | ---: | --- | --- |
| r4 审报 | 82 | NO-GO | 无锚首捕污染登记、起点对齐非等价变异存活 |
| r5 本轮 | **84** | **NO-GO** | 原两项闭合；新增类型／协议阻断；RT43 零文件断言存在低项漏检 |

基线：`b7ac9cc5b640830a801eed428d9eed97a5c6882b`。亲读 `git log -p 95b2601..b7ac9cc`，含 `a80432f` 代码／测试修复、`32bb5a7` 清误入 gitlink、`b7ac9cc` TEST-MAP。对实现成立的修复给予认可，不把变异后的行为误报成基线生产缺陷；也不以 Vitest 全绿替代类型／协议验收。

边界：本 worktree 只新增本审报，不改生产代码、既有测试或 TEST-MAP；未操作其他审读 worktree。独立探针及全部变异在 `git archive b7ac9cc` 生成的 `/tmp` 副本执行，无模型委派。启动未见【流程门】注入块，已披露并人工核读流程；`session_search` 工具不可用，已查项目索引、长期记忆及 r4 原审报，本次裁决以当前代码和实跑证据为准。

## ② 探针实录

### 2.1 环境、命令、真实结果

统一环境：

```sh
export PATH=/home/yyj/.nvm/versions/node/v24.18.0/bin:$PATH
# 实测 node=v24.18.0，npm=11.16.0，Vitest 日志=v5.0.1
```

| 编号 | 实际命令／位置 | 真实结果 | 结论 |
| --- | --- | --- | --- |
| T1 | worktree 根：`npx --no-install vitest run` | `64 passed / 2 skipped` 文件；`1263 passed / 15 skipped` 测试；exit 0；10.03s | 宣称计数成立，skipped 不计通过 |
| T2 | 根：`npx --no-install vitest run tests/unit/server/repair-tail.test.ts tests/unit/server/recover.test.ts tests/unit/server/recovery-evidence-source.test.ts` | 3 文件，117 passed；exit 0 | 定向绿 |
| T2b | 同三文件：`npx vitest run … --reporter=verbose` | repair-tail **35**、recover **36**、provider **46**；exit 0 | 35+36+46=117 亲验 |
| T3 | `cd apps/server && npx --no-install tsc --noEmit`；再用 `npx tsc --noEmit` 独立复跑 | 两次均 **exit 2 / TS2345** | **“tsc exit0”不成立** |
| T4 | `git log -p 95b2601..b7ac9cc` | 三提交，生产新增 8 行门控；RT42/43 和文案更新 | 逐块核读，不只读宣称 |
| T5 | `git diff --exit-code b7ac9cc -- apps/server/src tests` | 无差异，exit 0 | 原生产／测试面未改 |

T3 原文（两次一致）：

```text
src/runtime/recovery-evidence-source.ts(412,30): error TS2345: Argument of type '"repair-pending-first-capture"' is not assignable to parameter of type '"read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot"'.
```

基线日志：`/tmp/p01a-r5-baseline-OWKBiP/{full,target,tsc}.log`；明细复验：`/tmp/p01a-r5-target-verbose.log`、`/tmp/p01a-r5-tsc-confirm.log`。第一次后台包装的末尾汇总命令找不到 `rg`，总 exit 127；此前三项实际退出码已打印为 `FULL_EXIT=0 / TARGET_EXIT=0 / TSC_EXIT=2`，不是把包装错误算成类型失败。第二次包装明确 `TARGET_EXIT=0 / TSC_EXIT=2`，无该汇总问题。

本 worktree 无本地 node_modules，沿祖先依赖解析；核对祖先 protocol/src 与本基线无差异。两个实验副本的 `@pi-agent-ui/protocol` 分别指回自身源码，其余使用已安装依赖，未安装或更新包。

跨面：T1 覆盖默认配置的 N4/A1 等既有单测及非守卫集成面。`composed-e2e.test.ts`（⑤C）、`ws-write-e2e.test.ts`、`pi-e2e.test.ts` 的真 LLM 部分仍有 `PI_E2E === "1"` 守卫；本次未开启，不能将 15 skipped 或默认全仓绿写成⑤C真组合根验收。没有新增 ESLint／真实断电通过宣称。

### 2.2 两阻断修法与文案核对

| 项 | 实际实现／测试 | 裁定 |
| --- | --- | --- |
| B1-r4 | provider `:409-413` 在 marker 检测之后、任何锚点／seen 写入之前，以 `pendingRepair && anchor === null` 拒绝；Q03 防丢锚和首捕授权仍在此前 | 运行时修法成立；无锚不会登记，授权不豁免；新 reason 的类型／协议问题另列 B1-r5 |
| B6-r4 | `repair-tail.ts:349-351` 原起点条件仍在；RT42 位于 `repair-tail.test.ts:696`，确实先插完整 i2 再拼 11B repair 前缀，断言 conflict、journal 逐字节不变、marker 原文保留 | 杀手成立，亲删条件后 RT42 红；本批没改 repair-tail 生产算法 |
| RT43 | `recovery-evidence-source.test.ts:1106-1142` 串起 pending 拒绝、迁移 rejected、补完后建锚及 resumable 空 | 核心死锁回归成立；`:1126` 查错登记文件名，零文件证明不完整，见低项 L1 |
| L2/L3/L4 文案 | TEST-MAP 按 buildId 前缀边界描述；RT39b 标题为带授权仍保守拒绝；r3 小计改 8 例／64+2 文件 | 指定修订已落地，跨 build 独立探针也吻合；本批“tsc exit0”仍需纠正 |

注意拒绝顺序：未授权首捕会先返回 `no-evidence-snapshot`；已登记丢锚先返回 `concurrent-modification`。不是每一个无锚 pending 输入都必返回新 reason，但它们均未绕过拒绝门，也没有放宽 Q03。

### 2.3 独立盘面探针

副本：`/tmp/p01a-r5-lab-oy6xyJ`。命令：

```sh
cd /tmp/p01a-r5-lab-oy6xyJ
npx --no-install vitest run tests/unit/server/r5-adversarial.test.ts --reporter=verbose
# 最终：1 passed 文件，17 passed 测试，exit 0，482ms
# 单项可附 -t 'R5-P1' / 'R5-P2' / 'R5-P3' / 'R5-P4 cross-bound' / 'R5-P5' / 'R5-P6'
```

日志：`/tmp/p01a-r5-probes-corrected.log`。夹具自构：中文／emoji enqueue、235B 合法前缀、独立 intent A/B/C、固定 buildId 和时间；故障包装真实 FileHandle，只在指定阶段抛错。既检查目录全量文件名及逐文件字节，也检查 journal 原文；不是仅检查 result.kind。故障注入是模拟 I/O 中断，不冒称真实断电。

**P1：P7/P8 无锚首捕链，扩为四个中断时点。**

每一形均从无锚、无 seen 开始，真实修复工具生成 marker：

1. marker 写完、truncate 前抛错；
2. truncate 完成、补行前抛错；
3. 写入 repair 行前 23B 后抛错；
4. repair 整行已写、第二次 datasync 完成后抛错，尚未清 marker。

随后：授权 provider 连捕两次 → 真实迁移工具 → 重试修复 → 全新 provider 首捕 → 无首捕授权的新实例复捕 → 再迁移。四形均实际得到：

```text
pending 捕获：unavailable / repair-pending-first-capture（两次）
捕获写原语／seen 接缝调用：0
捕获及迁移前后 evidenceDir：仅原 marker，文件名及内容完全相同
迁移：total=1, migrated=0, noop=0, rejected=1；anchor=null, registered=no
修复：前三形 repaired；整行形 reconciled
修复后首捕：pending=false，repair 行恰 1，resumable=[]
锚：len=458，sha=H(真实全文)；seen.json.files=[审读.jsonl]
无授权新实例复捕：成功；再迁移：noop=1
```

这是 B1-r4 全链闭合证据：不是“拒绝了就算修好”，还验证了随后能建权威、重启式重建后仍可捕获，且物理补完不放行重发。零副作用同时由受控写接缝计数与默认迁移路径目录实证支持。

**P2/P3：相邻不变量。**

| 探针 | 构造与真实输出 | 结论 |
| --- | --- | --- |
| P2 有锚 pending + 缺登记 | 先建锚，再删测试数据目录内 seen 模拟旧锚残局；写部分 repair；首捕授权回调设为抛错。捕获成功 pending=true，锚原文不变，seen 补登记，resumable=[]；重试 repaired，再捕获成功 | 新门未误伤有锚 pending；B13-2 成功返回前须登记仍成立；不请求首捕授权 |
| P3 Q03 丢锚 | 先建锚登记，制造 pending 后删测试锚；授权捕获仍 `concurrent-modification`，blessCalls=0，证据目录不变 | 不把已登记丢锚误当可信首捕 |
| P3 未授权对照 | 无锚、未登记、pending，trustFirstCapture=false | `no-evidence-snapshot`，保守拒绝；授权门未被新门取代 |

**P4：交叉起点与字节边界（九形）。**

以下拒绝形均额外断言 journal **及整个 evidenceDir（含锚／seen／marker）逐字节不变**；表内长度是真实日志，不沿用 r4 的 455→448B 夹具数字。

| 筛选名 | 自构盘面 | 真实结果 | 长度／盘面 |
| --- | --- | --- | --- |
| `cross-bound` | marker 起点后插完整 B 行，再拼 repair 前 17B | aborted / repair-marker-conflict | **487→487B，不变** |
| `multi-line` | 插 B、C 两整行及空行，再拼前 37B | aborted / repair-marker-conflict | **743→743B，不变** |
| `insert-before-marker` | 在原已锚前缀之前插 B，再拼 repair 前 19B | aborted / anchor-mismatch | **489→489B，不变**；在旧锚校验即拒，不误走回截 |
| `full-row` | marker 原位置补恰好整条 mrow（含换行） | reconciled / marker-reconcile | **458→458B，journal 原文不变**；合法整行走转移／清理，不走部分行回截 |
| `full-row-plus-tail` | 整条 mrow 后再加 X | aborted / repair-marker-conflict | **459→459B，不变** |
| `only-newline-missing` | mrow 只缺末换行 | repaired / marker-complete | 457→458B，合法严格前缀补完 |
| `utf8-cut` | 切在 buildId 中“中”的首字节后 | repaired / marker-complete | 398→458B，按字节比较，不误按解码文本 |
| `build-early` | 29B 共同前缀，换 build 重试 | repaired / marker-complete | 264→457B，跨 build 共同前缀可收敛 |
| `build-late` | 已含旧 buildId、缺末 2B，换 build 重试 | aborted / repair-marker-conflict | 456→456B，不变 |

**P5：其他入口。** 在真 marker+截断残局调用 `captureRecoveryEvidence`：`pendingRepair=false`、`recoverFromSnapshot(...).resumable=[A]`；同盘 production provider 则拒绝。`rg -n 'captureRecoveryEvidence' apps/server/src tools` 仅命中定义／注释，没有生产调用；`composition.ts` 组装的是 provider。该宿主 helper 没有 evidenceDir 视角，代码已披露为修复前／测试工具入口，因此“任何入口都不能绕过”不能宣称；但未发现它被生产恢复路由接入，不据此新增生产高／中阻断，继续列信任边界挂账。

**P6：新 reason 真网关出帧。** 使用真实 `WsGateway`、真实 provider 和真实盘面，内存传输连接完成 hello → get-recovery（不是伪造 provider 返回值）。实收：

```json
{"t":"recovery","requestId":"r5-request","file":"r5.jsonl","availability":"unavailable","reason":"repair-pending-first-capture"}
```

断言此 reason 不属于协议现有四值成功；证明问题不是只留在内部类型层。此探针走真实网关逻辑，不是 TCP／浏览器 E2E。

探针自身纠错披露：初跑 15 pass / 2 fail。P5 错把 `resumable` 的字符串元素当对象；P6 用中文文件名，被协议正确回 `4404 file 非法`，未到恢复逻辑。仅修正 `/tmp` 自编夹具（直接比较字符串；P6 改合法 `r5.jsonl`），再跑 17/17。初始日志保留 `/tmp/p01a-r5-probes.log`，两失败不列产品缺陷。

### 2.4 变异亲验及还原

隔离副本：`/tmp/p01a-r5-mut-9wMbGB`。命令：

```sh
python3 /tmp/p01a-r5-mutations.py
# 每支唯一文本命中断言→注入→Vitest→finally 逐字节还原→三文件117复绿
python3 /tmp/p01a-r5-seen-assertion.py
# 仅副本修正RT43路径后对照杀伤；finally还原生产文件和测试文件
```

| 变异 | 注入与实际杀手 | 真实结果 | 裁定 |
| --- | --- | --- | --- |
| Mu-r4B6 重放 | 删 `isPartialRow` 中 `marker.byteStart === byteStart`；`repair-tail.test.ts -t RT42` | **1 fail / 34 skip**；`expected 'repaired' to be 'aborted'`；还原三文件 **117 pass** | RT42 确为起点杀手，原 B6-r4 关闭 |
| Mu-r4B1 重放 | 删除新增无锚 pending 门；provider 测试 `-t RT43` | **1 fail / 45 skip**；收到 snapshot 而非 unavailable；还原 **117 pass** | RT43 核心门杀伤成立，原 B1-r4 指定死锁回归受守护 |
| 新 OR 变异 | `pendingRepair && anchor === null` 改逻辑 OR；`-t 'RT39\|RT43'` | **3 fail / 43 skip**；RT39/39b 首捕失败，RT43 补完后首捕仍拒；还原 **117 pass** | KILLED，误拒已有场景可被发现 |
| 新 seen 副作用 | 门内拒绝前插 `await persistSeenLike(evidenceDir, { version: 1, files: [...seen] });` | 三文件 **117 pass**；全仓 **1263 pass / 15 skip，64+2 文件**；还原 **117 pass** | **SURVIVED**：拒绝仍返回同 reason，但空仓会多出 `seen.json`；零证据文件副作用未被原 RT43 守住 |
| seen 路径对照 | 保持上行变异，只在副本把 RT43 `evidence-seen.json` 改成 `seen.json` | RT43 **1 fail**，`expected true to be false`；还原生产代码但保留正确路径 **1 pass**；全部还原再跑 **1 pass** | 实证漏检来自错误断言路径，不是推测 |

变异的 skip 是 `-t` 过滤，不是新增跳过正式验收。四次生产字节还原后的三文件均通过；变异测试不承担 server 类型检查，基线 TS2345 仍在。

日志索引：`/tmp/p01a-r5-mutations.json`；`/tmp/p01a-r5-{claim-B6,claim-B1,new-or,new-seen-side-effect}.log` 及对应 `*-restored.log`；全仓存活日志 `...-new-seen-side-effect-full.log`；路径对照 `...-seen-correct-path-{mutant,base}.log`、`...-seen-final-restored.log`。

已核对副本还原 SHA256 与工作树一致：

```text
repair-tail.ts                  29c752e859d4c442bd33622afd5bbf135cb41ce4318b78597f45373a153f8b30
recovery-evidence-source.ts      12d2faae6ed2e934b812ab3adcfbbe092bc3fac34f2add7a6cdaad6adcde3854
recovery-evidence-source.test.ts d2d835c469478795a7f6c1e1e10f5638b5749dcd409ebbdaadb3605673b4a010
```

临时证据留在本机供复核；不以 `/tmp` 永久可用为保证。上文已提供复现场景、关键变异和实际输出。

## ③ 阻断项

### B1-r5【中】新增 reason 未闭合类型／冻结协议，正式类型检查失败并真实出帧越界

**位置**：

- `apps/server/src/runtime/recovery-evidence-source.ts:54-57,241-242,409-413`：结果类型和 `unavailable()` 参数仍仅允许原四值，新门却传入第五值；
- `packages/protocol/src/contracts.ts:229-232`、`docs/ws-ui-contracts-v1.md:232`：对外 `UnavailableRecovery.reason` 仍是原四值；
- `apps/server/src/ws/ws-gateway.ts:1212-1215`：unavailable reason 原样进入恢复帧。

**复现**：不改基线、不注入变异，执行 `cd apps/server && npx tsc --noEmit` → exit 2，诊断见 T3。再建立无锚 pending 真实残局，授权 provider 接入网关，hello 后发送合法 get-recovery → 收到 P6 的第五种 reason 帧。

**影响**：必做检查硬失败；转译执行路径仍能运行，因此 Vitest 全绿没有拦住冻结协议之外的新枚举。这不是编译器版本猜测或模拟返回值，亦不只是文案失真。未观察到此问题造成重发放行或删除数据，不升高危；类型／协议与发布可验性必须闭合后再 GO。

**修正建议**：优先保持现有对外契约，把此不可建立权威的状态映射到已有 `no-evidence-snapshot`，具体原因保留在审计；若确需对外新增枚举，则同步 provider helper／结果 union、protocol、契约文档及消费端／出帧测试。不能仅加 `as any`、压制 TS2345，或只拓宽 helper 而遗漏其他边界。

**复验条件**：server tsc exit 0；全仓／117 定向仍绿；新增真实 provider→gateway 场景，断言 refusal reason 属于最终批准的契约；无锚 pending 零文件副作用和补完后重建链仍成立；TEST-MAP 运行证据改为真实结果。

**汇总：open 高=0，中=1。原 B1-r4/B6-r4 指定问题均关闭；不是延续原死锁或原删除风险。**

## ④ 低项／挂账

- **L1（新增）：RT43 登记文件名错误，零副作用断言虚空通过。** `recovery-evidence-source.test.ts:1126` 查 `evidence-seen.json`，生产 `seenPath()` 在 `recovery-evidence-source.ts:168` 返回 `seen.json`。路径对照变异已证明漏检。建议使用正确路径并断言 ENOENT，或更强地比较捕获前后整个 evidenceDir；已有 seen 时也比较原文字节，覆盖“既不创建、也不重写、也不留 tmp”。当前真实门没有此副作用，新增变异只创建／重写同一登记集合，未登记当前 file、未形成死锁／删行／授权绕过，故列低项，不因任意存活变异重复升中；这与 r4 删除完整 i2 的关键防护缺口不同。
- **L2：原 L2/L3/L4 修订认可。** buildId 共同前缀可收敛／包含不同值保守拒已亲验；RT39b 标题与保守断言一致；小计 8 例、64+2 文件已修正。不能因这些正确修订连带认可新增的“tsc exit0”。
- **L3：宿主裸读 helper 仍非权威来源。** P5 可返回无 pending 的 resumable 结果；现有代码已明确仅修复前／测试入口，未发现生产接线。P0-1b 不得将它作为 provider 的错误兜底；必要时将测试便利入口与生产权威类型进一步隔离。
- **L4：信任域和耐久边界沿承。** marker／锚目录必须隔离，修复期禁并发写；available 不等于重发授权，必须守 resumeBlocked。marker 的 removedSha256 无独立认证；原尾删除后无法再独立重验；readBack→锚写窗口、无目录 fsync、无真实断电实测未在本轮销案。
- **L5：⑤C 真组合根／真 LLM 守卫面未执行。** 15 skipped 如实保留，不用默认全仓结果代销。repairUndecided 的保守粘滞语义继续由 P0-1b 统一。
- **时间口径**：TEST-MAP 节日期为 2026-10-06，git 提交／本次主机 UTC 属 2026-09-27/28 时间口径；哨兵使用本次实际主机 UTC，不编造与文档日期一致的运行时间。

## ⑤ 排序建议

1. **先闭 B1-r5 类型／协议面**：本次拒绝策略方向正确，不回退防死锁门；收敛 reason 映射／枚举并跑 tsc、真实出帧回归，纠正运行证据。
2. **同批补 RT43 正确 seen 路径及目录零副作用断言**：成本很小；重放本轮 seen 副作用变异要求红→还原绿，同时保留 RT42、RT39/39b、Q03、B13-2 的回归保护。
3. **复审放行后推进 P0-1b 裁决持久化**：裁决绑定证据身份与修复事务；显式解除对应 repairLog／pending 历史／undecided 阻断，覆盖旧快照、重启重放和冲突裁决；不以清 marker、withRepair 或裸读 helper 代替裁决。
4. **部署专项继续兑现 Q13/Q16 与⑤C**：访问隔离、修复期禁写、掉电耐久和真组合根证据独立验收，不把模拟故障注入当作全部完成。

本轮只交付审报，不代实现方修复上述问题，也不将 NO-GO 写成需求实现完成。

R5-REVIEW-DONE 2026-09-27T21:16:54Z
