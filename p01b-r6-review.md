# P0-1b r6 独立审读报告

## ① 总分与判定

**83/100，NO-GO。原 r5 两个具体反例已修复，四连变异全部真杀；仍有一处 P1：热态结构归因到持久裁决目标集之外的意图，冷捕获后仍可绕过覆盖判定。**

这不是“abandon 没加入 txImpacted”本身造成的漏洞：有效 abandon 的目标已被独立终局排除。剩余问题是**持久裁决目标集不一定覆盖热态已知的效果影响对象**，而 r6 把“没有持久归因指向它”当成“事务无关”。该反例需要宿主提交与残片顶层身份不一致的归因；本报告明确此前提，不宣称正确一致归因也会触发，亦不宣称不可信远端能够调用该受信工具。

### 范围与验证证据

- 审读 HEAD：`2d8cab1c385088d5f9e129e5acd9dae4d524d37f`；实现提交 `3b682f0`。审了 `1b6084a..2d8cab1` 五文件差异及关联实现，不把最后一笔文档提交误当实现批。
- 权威：设计稿 §11、`recover.ts`、adjudicate 全部 27 例、TEST-MAP r6；对照 r5 报告和主仓 `projects/pi-agent-ui/PROJECT.md:733–745`。
- 简称：R=`apps/server/src/runtime/recover.ts`；A=`apps/server/src/runtime/adjudicate-journal.ts`；T=`tests/unit/server/adjudicate.test.ts`。行号均为上述 HEAD。
- 当前未见【流程门】注入块，开工已披露；已查索引、记忆和指定 r5 审报。工具无 `session_search`，未冒称已搜索历史会话。不委派；不改实现；不触真实业务 journal。
- 变异和探针使用 `git archive HEAD` 创建的仓外副本 `/tmp/p01b-r6-audit-i2svZI`。复用已安装依赖；Vitest 配置把 protocol 包名及 `protocol/src/` 子路径显式指回副本，避免工作区软链接错读主仓实现。主仓 HEAD 也核实为相同基线。
- **adjudicate 原 27/27 通过；四个指定变异逐一“定向基线绿→单改→定向红→复原→定向绿”，最后 27/27。** 另加三项窄变异，均红后复绿。
- **独立探针 6/6 通过**：包含原 r5 真实双事务链闭合、无关 enqueue 正例、abandon/resend 并存、影响域内授权/执行蕴含、影响域外真实 IO 反例、G2 并集与冲突门。注意：其中 S5 断言的是缺陷实际存在，“探针通过”不等于安全性通过。
- **全仓 1403 passed、15 skipped；71 文件通过、2 文件跳过。1403=原仓 1397+本审 6 探针。** 未启用真实 LLM E2E，不把跳过项算已验。
- 审读树运行 `npx --no-install tsc -p apps/server/tsconfig.json --noEmit --incremental false` exit 0；R/A/T 三份变更 TS 定向 ESLint exit 0。不是整仓 lint/build 的认证。
- 最后副本 R、审读树 R、`git show HEAD:R` 逐字节相同，SHA-256=`c3a8ba8998acb68335976cdd9c973202e40850e1536a8bd3f9ab49169c013cc8`；审读树 tracked 源码无修改。
- 本审脚本首轮误以为 Vitest 5 的 JSON reporter 写 stdout，实际写文件，因解析失败停在基线，未施加变异。修正为显式 `--outputFile` 后完整重跑；首轮作废，非实现缺陷。

证据文件：副本内 `audit-mutations.cjs`、`audit-extra.cjs`、`audit-*.json/log`、`tests/unit/server/r6-review-probe.test.ts`；后台记录 `b7c60c535`（四连+全仓）、`b758b93f3`（静态检查）、`b849fb0c1`（三项补充变异）。临时副本不是长期档案，核心反例、变异替换及结果在本报告固化。

## ② P1 发现

### P1-r6-1：影响域只持久化“裁决指向谁”，没有覆盖“热态证据已经影响谁”，目标集外仍冷放宽

**证据：R:448–460、466–481、519–522、539–544；A:127–131、232–241；`recovery-evidence-source.ts:457`。**

1. R:449–450 根据残片顶层结构自动关联，可靠关联的 id 并入 `unknown`；R:456–460 记录其 sha 来源。
2. `txImpacted`（R:481）仅来自有效 fragment resend 的**裁决目标**；abandonKeys 同样只含裁决目标。
3. 写工具身份门只要求目标属于 enqueue∪sending，未核验它与被移除残片的结构身份一致。repair 四元组只保存哈希/区间/时间，不保存可供冷捕获复原的原始结构归因。
4. 全部事务各有某个有效 fragment 裁决即解除 repairShadow。冷捕获的 `bad=[]`、`attributedFragments=[]`，于是曾受残片影响但不在裁决目标集中的 id 同时不在 unknown、txImpacted、abandonKeys 中，绕过 scopeCovers，进入 resumable。

#### 真实 IO 最小反例

本审 S5 使用真实临时文件、真实修复/追加/锚点链，无 IO 替身，无伪造 repair 区间：

1. 写 enqueue i1/i2/i3（**无完整 sending**）；尾部追加 `{"t":"sending","intentId":"i1"`，不加换行。
2. provider 捕获并留锚；`repairJournalTail` 真修复，取得真实四元组。
3. 调用 `adjudicateJournal`，同四元组 fragment 归因 **i2**，分别测试 resend 与 abandon。两次独立试验均返回 `adjudicated`。
4. 全新 provider，以 `trustFirstCapture:false` 重捕获。冷态使用该新快照；热态保持相同 lines，携回原 raw、设 repaired=true。两态都调用 `recoverFromSnapshot`。
5. i3 为无关 enqueue 正对照；没有新增 i1 活动，也没有 i1 的 resend 裁决。

实测（`audit-S5-resend.json` / `audit-S5-abandon.json`）：

| 持久裁决 | 证据态 | resumeBlocked | unknownEffect | resumable | resendAuthorized |
| --- | --- | --- | --- | --- | --- |
| tx→i2 resend | 热 | false | `[i1]` | `[i2,i3]` | `[i2]` |
| tx→i2 resend | 冷 | false | `[]` | **`[i1,i2,i3]`** | `[i2]` |
| tx→i2 abandon | 热 | false | `[i1]` | `[i3]` | `[]` |
| tx→i2 abandon | 冷 | false | `[]` | **`[i1,i3]`** | `[]` |

因此：**i2 的放弃终局确实安全，但 i1 的旧效果证据在冷态消失，i1 无授权进入执行资格。** 把 abandon 目标也加入 txImpacted 不能修本例，因为该集合仍不含 i1。

以下最小读面回归可直接放入现有 T 的 describe 内，复用其 helper；末断言在本轮实现上失败，真实 IO 链已排除“硬编码区间造成虚构输入”的解释：

```ts
it("cold must not release a structurally attributed non-target", () => {
  const raw = '{"t":"sending","intentId":"i1"';
  const at = "2026-10-05T00:00:00.000Z";
  const rows = [jl("i1"), jl("i2"), repairRow(30, 66, sha(raw), at),
    adjFrag(sha(raw), 30, 66, at, "i2", "resend")];
  const lines = parseJournalText(`${rows.join("\n")}\n`).lines;
  const hot = buildRecoverReport(lines, "q", { blocked: false,
    fragments: [{ raw, error: "tail", partialTail: true }] });
  const cold = buildRecoverReport(lines, "q", { blocked: false });
  expect(hot.resumeBlocked).toBe(false);
  expect(cold.resumeBlocked).toBe(false);
  expect(hot.resumable).not.toContain("i1");
  expect(cold.resendAuthorized).not.toContain("i1");
  expect(cold.resumable).not.toContain("i1"); // 当前失败
});
```

#### 信任前提与定级边界

此例**依赖受信宿主提交与结构扫描不同的归因**。没有证据表明通常正确归因会触发本例，不能将其包装成外部权限漏洞。但当前契约没有定义“人工归因明确推翻结构归因并解除另一意图的未知效果”，热态实现也没有如此处理；它仍将 i1 留作 unknown，冷态却仅因丢 raw 放行。原 R12/R25 本来就允许相同 raw 的事务被分别裁给不同目标，并据此要求保守覆盖，不能只在本例临时增加“该输入不可能”的前提。

在派单明确要求检查“热态残片归因但在授权面外的意图”、且冷热不放宽仍为约束的情况下，判 **P1 必修**。它是此前不完整影响域模型的残留，不是声称 r6 新增了这条路径。

**验收要求：** 明确并兑现结构归因与持久裁决不一致时的处理：要么在证据尚在时拒绝/留置不一致归因并持久化必要证明；要么持久化足够的影响对象/冲突事实，让冷态不遗忘；若确要支持人工覆盖，须显式定义撤销旧 unknown 的事实与安全前提，不能把普通 i2 裁决暗当 i1 的解除证据。不要无差别封禁所有 enqueue，也不要恢复完整 sending 放宽。新增 target 外的 resend/abandon 两态真实链及定向测试后重审。

## ③ P2/L 发现及验证细节

### P2-r6-1：闭合声明仍宽于证据；注释债仅部分清理

- 设计稿 §11:115、TEST-MAP:991–993、PROJECT:745 的集合定义与实现一致；但“无任何归因=事务无关”和整体冷热闭合须限定/修订，不能忽略 P1-r6-1 的热态结构归因。
- 七落点勘误已写入设计稿 §11.4、TEST-MAP:996、PROJECT r5/r6 节。实查为 repair-tail 117/138/139、adjudicate-journal **96**（本轮头注多一行，旧记 95）、evidence-migration 112、recovery-evidence-source 209/342，共七处。§10 历史“六处”有后节勘误，认可，不另算缺陷。
- A:15–18 双证合法共存、T:624 授权/执行分层注释均已真修。
- 仍留 T:1、84 的“R1–R10”，实际 27 例/R1a/R1b/R2–R26；T:548 仍把 resumable 断言称为无映射杀点，T:549 又写“旧形**无** send 行时被 sending 门遮蔽”（应为有 send 行）；R:461–465 仍笼统描述 resend/abandon 同向全覆盖，与紧随的 abandon 提前返回需加例外说明。R12 原旧负例 T:369–375 的阻断原因注释也仍把自动可关联残片说成 unattributable。

这些残留注释本身不另构成 P1；但 P2-r5-2 的“注释债全清+全部闭合”不能整项打勾。修订文档应保留本轮四连真杀及原反例闭合成果，不抹成“r6 无效”。

### L-r5-1 延续：孤儿 ID 与投影消费契约留 P0-3，条件性接受

R:544 从 resendKeys 枚举，不与 replay intents 求交；A:127–131 接受 sending-only id。r5 已用真实写工具复现 orphan，本轮相关代码未变，仍可存在 `intents=[]` 而 proof 含孤儿 ID。本轮未重复跑 orphan IO，不冒称新增实证。

生产源码检索显示 resendAuthorized 目前只在 R 定义/产生，没有实际执行消费者；`packages/protocol/src/projection-frames.ts:42–49、65–83` 不投影该证明字段，且按 perIntent 的 not-evaluated 重派生 resumable items，未按报告 ID 集过滤。这是 r5 已列的接线风险，本轮不重复升级为新增 P1；**P0-3 必须校正对象域、生命周期和投影集合，不得以本批单元测试绿宣布宿主端到端可安全重发。** 漂移锚解困 S-r3-1 仍 open，未纳入本轮解决范围。

### 方向分离与授权/执行关系的实际结论

- **abandon 目标无需再进 txImpacted 才安全。** 有效 abandonKeys 的 have 在场，R:469 返回 true，R:542 的独立排除足以阻止执行，R:544 同时从授权证明面剔除。
- 同四元组 resend/abandon 矛盾→conflictKeys→repairShadow，全局阻断；不同事务对同一 id 一弃一发→abandon 优先，两输出均不含该 id。S2 已验证热/冷两态，包括热态 resend 覆盖本来能成立的形态。
- 对持久 fragment 目标域内的对象，当前代码有 `resumable(id) ⇒ resendAuthorized(id)`：resend 目标经过 txImpacted/resendCovers；abandon 目标不可能执行。S3 枚举双事务 verdict、目标及冷热组合核对了这一关系。
- **全域上两列表不能强行等同。** 真正无关的普通 enqueue 可以执行且不在 resendAuthorized，这是预期正常路径；S1/S2 的 i3/i2 正对照通过。P1-r6-1 的 i1 则不是无关对象：热态有结构归因证据，只是在冷态失忆。
- 无源 resend 的 `repairLog.every × effectiveFragAdj.some` 保持 §10；G2 补 sha 在最终覆盖调用前完成、与已有源做并集。S6 两种残片顺序及冲突组对照通过。

### 四连变异复验

每条均定向基线 1 passed、变异 1 failed、复原 1 passed，其余 26 条为定向过滤跳过，不拿跳过当通过；全套前后 27/27。

| 变异 | 精确改动 | 实际首个失败断言 | 结论 |
| --- | --- | --- | --- |
| Mu-r6-1 | 删 filter 中影响域 OR 项 `txImpacted.has(r.intentId)` | T:663 R25 **热态**实际 `[i2]`，期望 `[]` | ✅ 真杀；不冒称首先死在冷态 |
| Mu-r6-2 | 删除 `if (kind === "abandon") return true;` | T:683 R26 post 的 resumable 含 i1 | ✅ 增量不复活独立杀点 |
| Mu-r6-3 | `fragments.filter((b) => b.raw === raw)` → `fragments` | T:392 R12 g2wrong：resumeBlocked 实际 false | ✅ r5 存活变异已杀 |
| Mu-r6-4 | 无映射 `return false` → `continue` | T:549 R17：resendAuthorized 含 i1 | ✅ r5 存活变异已杀 |

额外三项窄变异，仍逐条基线绿→红→复原绿：

| 补充变异 | 实际失败 | 证明边界 |
| --- | --- | --- |
| 将影响域门变为 `fragments.length > 0 && txImpacted.has(id)`，保留热态保护、只撤冷态门 | T:666 R25 cold 实际 `[i1,i2]` | 冷态断言本身真杀，并非只靠前面的热态断言 |
| 无源 every 分支改 `return true` | T:648 R21 cold.resendAuthorized 含 i1 | §10 resend 全覆盖门仍独立受测 |
| 删 `!r.sending` | T:629 R20 resumable 含 i1 | 完整 sending 禁执行未退回旧放宽 |

R25 真无 send 行、两态 resumeBlocked=false；R26 pre/post 也是 false，pre 仍允许无关 i2；二者不是全局阻断假杀。R21 将 cold i2 改 not.toContain **是正确的收紧迁移而非放松**：i2 已是 tx2 的 resend 归因目标，而无源时没有 tx1 的 i2 授权。原 i1 的 sending 仍在，R21 不能独自证明 enqueue-only 路径，补充的 R25 和真实链才完成该部分验证。

## ④ 必修闭合判定表

### r5 两 P1、两 P2

| 原必修 | 判定 | 依据 |
| --- | --- | --- |
| P1-r5-1 冷捕获 enqueue-only 绕过 | ❌ 部分闭合 | **指定双事务各归一意图反例已闭合**：R25 真杀、冷态窄变异真杀、本审 S4 真 IO 热冷均只允许无关 i3。更广的影响域外残片对象仍漏，见 P1-r6-1，不认整体冷热闭合 |
| P1-r5-2 abandon 被无关事务复活 | ✅ | R:469 独立负向排除；R26 pre/post 与 Mu-r6-2；跨事务一弃一发/abandon-only 探针通过，不靠全局阻断 |
| P2-r5-1 R17/R12-G2 杀点 | ✅ | 两处旧存活变异分别死在 T:549 授权断言、T:392 g2wrong；生产来源门及 raw 全等门未被替代 |
| P2-r5-2 文档与注释债 | ❌ 部分闭合 | 写面头注、R20 注释、七落点勘误已落；整体闭合过称及测试头/杀点说明残留见③ |

### r5 再送审条件逐条验收

| 条件 | 判定 | 说明 |
| --- | --- | --- |
| 修原两 P1 指定反例 | ✅ | S4 真双事务 IO、R26 增量链均通过 |
| 不用全局阻断遮蔽 | ✅ | R25/R26 明断 resumeBlocked=false；S1/S4 无关 i3 仍可执行 |
| 不恢复完整 sending 放宽 | ✅ | 代码门保留；R20 补充窄变异真杀 |
| R17/R12-G2 指定杀点 | ✅ | 四连中 Mu4/Mu3 如实独立击杀 |
| 同步权威文档 | ❌ 部分 | 集合/方向分离定义和计数已同步，但未覆盖新边界，注释债未全清 |
| 原 25 例及新增例全绿 | ✅ | 原生 27/27；全仓原 1397+探针6=1403 通过，15 跳过如实列明 |
| 新增反例 | ✅ 原指定范围 | R25/R26 已落；target 外新反例仅在本审副本复现，待转为正式安全回归 |
| 定向变异 | ✅ | 四连全杀+补充三连，全部复原 |
| P0-1b 全面收口 | ❌ | 新发现的影响域外证据缺失未闭合，不以原用例全绿替代 |

### 派单八项逐项结论

| 必查项 | 判定 |
| --- | --- |
| 1 txImpacted、真实 IO、过阻断/漏口 | 原真链 ✅；无关 enqueue 正例 ✅；abandon 目标独立排除 ✅；热态结构目标在持久域外 ❌ |
| 2 abandon 终局与并存证据 | ✅；同事务冲突全局拒，不同事务弃置优先，两输出均排除目标 |
| 3 R25/R26 真形态与遮蔽 | ✅；R25 无 send、两态直接执行集；R26 真 pre/post；四门与额外冷态窄变异证据吻合 |
| 4 R17/R12-G2 附加变异 | ✅；分别在新增授权/错 raw 断言处失败 |
| 5 §10 与既有回归迁移 | ✅ 指定断言；R9/R12/R21/R22 保留真效果；i2 的 not.toContain 收紧正确，完整 sending 禁执行保持 |
| 6 新缝与孤儿 ID | 目标域内执行⇒授权 ✅；全域存在正常无关 enqueue 差异，也存在 P1 的不安全冷热差异 ❌；孤儿/投影留 P0-3 有条件接受 |
| 7 文档/计数 | 七处勘误 ✅；实现定义对齐 ✅；整体闭合宣称和部分旧注释 ❌ |
| 8 四连复验 | ✅ 全部重放；脚本首轮 reporter 错误已剔除，不混作实现结果 |

## ⑤ 评分明细

| 维度 | 满分 | 得分 | 依据 |
| --- | ---: | ---: | --- |
| 覆盖与闭合（必修验证） | 30 | 24 | 原两例实修，真实 IO 闭合；影响域外的热证据在冷态仍失忆 |
| 代码质量与架构一致性 | 15 | 12 | 正负方向分离正确；目标域与完整影响域的区别未进入耐久模型 |
| 测试矩阵真实性与杀点有效性 | 25 | 22 | R25/R26/R17/R12 真杀，冷态独立杀点也成立；缺 target 外正式反例与证据不一致契约测试 |
| 变异与验证证据 | 15 | 15 | 四连+三项窄变异实跑复原，真实 IO 探针、全仓及定向静态检查均有边界明确的证据 |
| 文档对齐 | 10 | 8 | §11/计数/写面头注实质同步；全闭合过称和旧注释仍在 |
| 回归面与遗留风险 | 5 | 2 | 原 abandon 回归已闭，完整 sending 保持；冷热残留 P1 与 P0-3 消费限制仍不能忽略 |
| **合计** | **100** | **83** | **NO-GO，一处 P1 必修阻断** |

再次送审：闭合 P1-r6-1 的结构归因/裁决目标不一致路径，保持无关 enqueue 正对照、abandon 终局和完整 sending 禁执行；把新反例转正式回归，同步边界文档及残留注释，再跑原矩阵、新例和定向变异。不得以修改断言承认“丢证据就放行”来换绿。P0-3 的孤儿 ID、投影集合及实际发送前生命周期复核仍是独立接线准入条件，本报告不放行端到端自动重发。

交付范围：仅本审报告，审读分支 `wt/gpt-p01b-r6-review`；保留开工前已有未跟踪 `p01b-r6-review-brief.md`，不代提交、不修改。实现主干不合并、不改动。
