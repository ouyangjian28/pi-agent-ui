# P0-1a r4 对抗性复审

## 1. 评分与裁决

**82/100，NO-GO。** r3 四项指定反例的修复成立，但新增发现「无锚 pending 首捕污染 seen，导致串行死结」及「起点对齐检查的非等价变异全仓存活」两项中阻断；不能以 1261 项全绿放行。

| 对照 | 分数 | 裁决 | 说明 |
|---|---:|---|---|
| r3（指令提供的上轮结论） | 76 | NO-GO | 四项阻断 |
| r4（本次亲验） | **82** | **NO-GO** | 原四项指定缺陷修复成立；新增两项中阻断，零 open 高 |

审读基线：`95b26015d93e1e9f5980a9b927b3d51d49dc1bd0`，代码修复提交 `5d6b311`；亲读 `git log -p 6475bd0..95b2601`。评分提高来自旧反例闭合；扣分主要是合法首捕路径的收敛性和关键破坏性分支的回归守护不足。不是将变异后才出现的数据删除误报为当前生产实现的数据删除。

范围与方法：当前工作树只新增本审报，不改生产代码或既有测试；自构测试与 Python 变异只在从该基线 `git archive` 得到的 `/tmp` 副本运行，未操作其他审读工作树。没有委派模型代跑。启动时未见【流程门】注入块，已披露；按只读审边界执行。历史 `session_search` 工具不可用，本审以指令、提交差异及当前实现为准。

## 2. 探针实录

### 2.1 环境、命令与基线

所有 Node 命令统一前置：

```sh
export PATH=/home/yyj/.nvm/versions/node/v24.18.0/bin:$PATH
# 实测 node=v24.18.0，npm=11.16.0，vitest=5.0.1
```

| 编号 | 亲跑命令（基线工作树根执行，除明确 cd） | 真实输出摘要 | 结论 |
|---|---|---|---|
| T1 | `npx vitest run` | `64 passed / 2 skipped` 文件；`1261 passed / 15 skipped` 测试；exit 0；10.62s | 全仓绿；skipped 不算执行通过 |
| T2 | `npx vitest run tests/unit/server/repair-tail.test.ts tests/unit/server/recover.test.ts tests/unit/server/recovery-evidence-source.test.ts` | 3 文件、115 测试通过，exit 0 | 定向绿 |
| T2b | 同 T2 加 `--reporter=verbose` | repair-tail **34**、recover **36**、recovery-evidence-source **45**；115 passed | 三文件计数与宣称一致 |
| T3 | `cd apps/server && npx tsc --noEmit` | 无诊断，exit 0 | server 类型检查通过 |
| T4 | `git log -p 6475bd0..95b2601` | 两提交；三生产文件、三测试文件和 TEST-MAP 的增量 | 非只读说明文档，逐块核对实现 |
| T5 | `git diff --exit-code 95b2601 -- apps/server/src/runtime tests/unit tests/fixtures/TEST-MAP.md` | 无差异，exit 0 | 审读源面未改 |

T1 覆盖配置中的 unit/integration 项目，包括 N4 登录/体流/WS 面以及 A1a/A1b/A1c 前端既有测试。核读 `tests/integration/composed-e2e.test.ts` 的 `PI_E2E === "1"` 与 `describe.skipIf(!RUN)`：⑤C 继续按上轮口径挂账，本次未设 PI_E2E、未运行真 LLM/真组合根 E2E。未新增 ESLint 通过宣称。

基线日志：`/tmp/p01a-r4-{full,target,target-verbose,tsc}.log`；完整差异：`/tmp/p01a-r4-diff.log`。基线工作树无本地 node_modules，沿祖先依赖解析；另核对祖先仓 protocol 相对 95b2601 无差异。实验副本单独将 `@pi-agent-ui/protocol` 指向各自副本，避免变异误读别的源码。

### 2.2 四项修法的实现核对

| 原项 | 真实实现 | 本轮判定 |
|---|---|---|
| B1-r3：旧快照丢阴影 | `recover.ts:409,489-491,520-541`：阴影三链；hash 含 pending/undecided；withRepair OR 保留历史；recoverFromSnapshot 传递新字段 | 指定洗白路径闭合。并非只有类型字段或注释变化 |
| B3a-r3：部分行上界 | `repair-tail.ts:338-378`：先 bounds+hash 全等，再起点对齐+严格字节前缀，之后同 bounds 哈希冲突/其余冲突 | 原尾长度不再作为部分修复行上界；实际等长/超长边界见 P3 |
| B3b-r3：捕获写穿与拒前截断 | provider `:390-433` 在验旧锚/写锚前检测 marker；pending 跳过这两步；repair-tail `:349-362` 在 truncate 前拒覆盖 marker 起点的锚 | 有旧锚的 P4 闭合，但无旧锚组合引入新死结，见 B1-r4 |
| B6-r3：M-H/M-R/M-P 存活 | RT41/RT38/RT37 确有对应断言；M-H/M-R 亲手重放红→还原绿；非匹配尾由自构 P3 再验 | 指定杀手补齐；另有新非等价变异存活，见 B6-r4 |

### 2.3 独立场景（不是照抄 RT35 的四个长度）

实验副本：`/tmp/p01a-r4-lab-oR13SZ`。

```sh
cd /tmp/p01a-r4-lab-oR13SZ
npx vitest run tests/unit/server/r4-adversarial.test.ts --reporter=verbose
# 真实结果：12 passed / 1 failed；失败为 P7 的正确性断言，非环境/编译错误。
npx vitest run tests/unit/server/r4-first-authority.test.ts --reporter=verbose
# 真实结果：1 passed（P8 三组对照，断言当前缺陷的观察结果）。
```

下表每项均可单独执行：在实验副本根运行 `npx vitest run tests/unit/server/r4-adversarial.test.ts -t '<筛选名>' --reporter=verbose`；筛选名逐项列出。默认夹具为真实临时 journal/evidence 目录、中文/emoji enqueue；先调用修复工具持久 marker 并 truncate，借 FileHandle.write 抛错模拟中断；随后手工写入合法/非法部分行。非真实进程断电，不冒称掉电验证。

| 探针 / 命令筛选名 | 构造及真实输出摘要 | 结论 |
|---|---|---|
| P1 / `R4-P1` | 截断后真 provider 捕获 S：lines 无 repair、bad=[]、pending=true；物理补完后 withRepair(S)：pending=false、undecided=true、resumable=[]；二次 withRepair 深等于第一次，原 S 不变 | 旧快照不再洗白，幂等成立 |
| P1 归因组合 / 同上 | 加 i2 与不可归因残片 `?`，显式归因给 i1 后：unattributable=0、unknown=[i1]，但 resumable 仍=[] | 清残片归因不能清 undecided 阴影，未发现组合洗白 |
| P1 正对照/hash / 同上 | 无 pending 历史对照 withRepair 后 resumable=[i1]；仅切换 pending/undecided 得三个不同 SHA256；修复后新捕获有 repairLog=1 | 正当解锁未误伤，身份字段有实效 |
| P3 / `no-newline` | 修复行含换行全长 226B，写 225B（只缺换行）：repaired / marker-complete | 严格前缀极限可收敛 |
| P3 / `exact-row` | 写恰好 226B 完整行：reconciled / marker-reconcile，盘面原文不变 | 全行不误走部分行回截 |
| P3 / `over-row` | 完整行后再加 X，共 227B：aborted / repair-marker-conflict；journal、anchor 不变，marker 保留 | 超全行长度不误修 |
| P3 / `same-size-garbage` | 原尾 44B，写 44B 的 X，bounds 全等但哈希/前缀不等：aborted / file-changed，三份盘面事实保留 | 同 bounds 冲突门成立 |
| P3 / `cross-bound` | 原 marker 起点 222；在该点先插入完整 i2 行，再写修复行前 11B；当前尾起点已变：aborted / repair-marker-conflict，455B 原文不动 | 当前实现正确守住 byteStart 对齐 |
| P3 / `build-early` | 旧 build 的前 19B（尚未到 buildId）换新 build 重试：repaired / marker-complete | 跨 build 并非一律拒；共同前缀可收敛 |
| P3 / `build-late` | 旧 build 前 224B，已包含不同 buildId，换新 build：aborted / repair-marker-conflict，盘面不动 | 不匹配的跨 build 部分行保守拒绝成立 |
| P3 / `utf8-cut` | 在 buildId 的中文字符第一个字节处切断，163B 前缀：repaired / marker-complete | 判据是真字节前缀，不被半个 UTF-8 字符破坏 |
| P4 / `R4-P4` | 写部分行 164B；新 provider 实例捕获 pending，旧锚仍 len=222 且 sha 原样；重试 repaired；复捕获 pending=false、新锚 len=448 且 sha=H(全文)、resumeBlocked=true | 串行全链收敛，修复与授权分离 |
| P5 / `R4-P5` | 两形：模拟旧 provider 锚写穿 31B；含原坏尾首捕后截断。均 aborted / anchor-stale，journal/anchor 不变，传入 true 授权回调均调用 0 次 | RT39b 是保守拒绝，不是“带授权就修好”；授权不能豁免前缀证据 |
| P6 / `R4-P6` | marker 改成 `not-json`，journal 任意替换为 FORGED enqueue；捕获确实放行快照，但 pending=true、resumeBlocked=true、withRepair 后仍阻断，锚不动；工具拒 marker；删 marker 后 provider 拒 concurrent-modification | 不是重发授权放行；也不是对改写内容的锚认证。恶意写 evidenceDir 属披露的信任域破坏 |
| P7 / `R4-P7` | 不建旧锚；修复截断后显式授权首捕成功 pending=true；补完 repaired / anchor=null；新 provider 返回 unavailable / concurrent-modification | **新缺陷：预期可首建权威的安全盘面被锁死，正确性断言红** |

P1 实际 hash（三者仅相关布尔维度不同）：

```text
plain     3a091f198f22c99464aa612ca247ceaaeaf54c6a0edadbf44108e94d9f00a9b0
pending   ff70e1ddb4672b7cf86f2c1a3fb2f2c9a460fc8b32957be7078a3556c3e8e331
undecided 66c580824404cc13592afc0c7c0d612feac363c4b710f535367c7c870bd8955e
```

P8 命令：`npx vitest run tests/unit/server/r4-first-authority.test.ts --reporter=verbose`。三路真实结果：

| 首捕时机/入口 | 第一次 | 第二次/物理修复后 | 迁移出口 |
|---|---|---|---|
| 修复完成后才首捕 | 成功建锚，repair 行在场 | 正常 | noop，anchor 非空 |
| provider 在 pending 期间首捕 | 快照成功，pending=true | **第二次捕获已 concurrent-modification；修复成功后仍同拒** | rejected；anchor=null、registered=yes |
| migrateLegacyEvidence 在 pending 期间首迁 | **migrated / fresh-capture，但 anchor=null、registered=yes** | 第二次迁移 rejected；修复成功后仍同拒 | 再迁移仍 rejected，不是恢复出口 |

P8 使用真实默认文件操作与新 provider 实例，未篡改 marker/seen/anchor；唯一故障接缝是修复写行抛错。日志：`/tmp/p01a-r4-probes.log`、`/tmp/p01a-r4-first-authority.log`。

### 2.4 Python 变异：两支宣称抽验 + 四支新变异

副本：`/tmp/p01a-r4-mut-i2RjkB`；命令：

```sh
python3 /tmp/p01a-r4-mutations.py
# 每支：唯一文本命中断言 → 注入 → npx vitest run 三文件 → finally 原字节还原 → 三文件复绿。
# 对存活者额外 npx vitest run 全仓，再用 cross-bound 独立探针验证非等价。
python3 /tmp/p01a-r4-alignment-detail.py
# 对存活者再次注入：输出真实删除前后盘面；还原后同探针转绿。
```

| 变异 | 真正改变的表达式 | 红/绿实录 | 判定 |
|---|---|---|---|
| claim-H（宣称 Mu-r3BH / M-H） | canonical 删 `snap.pendingRepair` | RT41 失败：两个 hash 相等；114 pass / 1 fail；还原 115 pass | KILLED |
| claim-R（宣称 Mu-r3BR / M-R） | `expectedRow = builtRow` | RT38 失败：`read-back-short file=q.jsonl got=429/435`；114 pass / 1 fail；还原 115 pass | KILLED（本次失败点是短读，不能照抄宣称写成 row-mismatch） |
| new-shadow | repairShadow 删 `opts.repairUndecided` 链 | RT40 失败：resumeBlocked false；还原 115 pass | KILLED |
| **new-alignment** | 部分行判据删 `marker.byteStart === byteStart` | **115 pass；全仓 1261 pass / 15 skipped**；自构 cross-bound 则 `expected repaired to be aborted`；还原三文件及该探针均绿 | **SURVIVED，非等价** |
| new-provider-check | `if (!pendingRepair && anchor !== null)` 恢复为 `if (anchor !== null)` | RT39b 失败：pending 捕获被 concurrent-modification 拒；还原 115 pass | KILLED |
| new-undecided-hash | canonical 删 `snap.repairUndecided` | RT41 失败：hash 相等；还原 115 pass | KILLED |

new-alignment 追加实证（不是仅用断言失败推测数据丢失）：

```text
变异：result=repaired/marker-complete, beforeLen=455, afterLen=448,
      beforeI2=true, afterI2=false
还原：result=aborted/repair-marker-conflict, beforeLen=455, afterLen=455,
      beforeI2=true, afterI2=true
```

两次都无编译错误。说明该对齐条件是保护完整行不被截掉的必要条件，不能把存活归为等价/冗余变异。当前生产代码有此条件，问题是仓内测试漏守护。

原字节还原 SHA256 与工作树一致：

```text
recover.ts                  77600314d9e6cb0195bf2a966c036841575c4c15b18c0b199183a85ef155da76
repair-tail.ts              29c752e859d4c442bd33622afd5bbf135cb41ce4318b78597f45373a153f8b30
recovery-evidence-source.ts a18a64fe1a04d15d66d4a961699232bf3a77e0c9a9aba73f7f9b28f931fac485
```

变异证据：`/tmp/p01a-r4-mutations.json`、`/tmp/p01a-r4-{claim-H,claim-R,new-shadow,new-alignment,new-alignment-full,new-alignment-own,new-provider-check,new-undecided-hash}.log` 及对应 `*-restored.log`；盘面二验为 `/tmp/p01a-r4-alignment-detail{,-restored}.log`。临时文件保留供本机复核，但不以其永久可用作保证；下节给出自包含复现步骤与必要代码形态。

## 3. 阻断项

### B1-r4【中】无旧锚的 pending 首捕写入 seen，制造无法收敛的“锚丢失”状态

**位置**：`apps/server/src/runtime/recovery-evidence-source.ts:371-375,420-445`；与 `repair-tail.ts` 的“无锚不建锚”契约组合。

**原因**：pending 跳过锚写入是正确方向，但后面的 seen 提交未同步区分“原本有锚”与“从未建锚”。无锚首次授权得到快照时，文件已进入 seen，而锚从未建立。下一次调用在 marker 检测之前就被“seen 有记录 + anchor=null”判为证据丢失。修复工具也按既定契约不会替无锚文件建首锚。

**复现步骤（P7/P8）**：

1. 空 evidenceDir，journal 为合法 enqueue+撕裂 sending 尾；不调用 provider 建锚。
2. 调用 repairJournalTail，用 `openHandle` 包装真实安全 FileHandle，仅覆盖 `write` 为抛错：真 marker 已落盘，真 truncate 已完成。
3. 使用默认 provider + `trustFirstCapture: () => true` 捕获：返回 pending 快照，seen 登记了该文件，但 `.evidence.json` 不存在。
4. 再捕获：`unavailable/concurrent-modification`。恢复默认修复工具重试：`repaired, via=marker-complete, anchor=null`。
5. 新 provider 显式授权再捕获仍拒；`migrateLegacyEvidence` 也拒。对照：不做第 3 步，待修复完成再首捕正常。
6. 把第 3 步换成真实迁移工具，还会误报 `migrated/fresh-capture`（anchor=null、registered=yes），随后重试拒绝。

关键复现代码形态（所需导入及夹具见步骤，不依赖伪造 marker）：

```ts
const openCrash = async (abs: string) => {
  const { fh } = await openSafeReadWrite(abs);
  fh.write = (async () => { throw new Error("crash"); }) as typeof fh.write;
  return fh;
};
await expect(repairJournalTail({ ...opts, openHandle: openCrash }))
  .rejects.toThrow("crash");
const provider = () => createRecoveryEvidenceProvider({
  roots: opts.roots, evidenceDir: opts.evidenceDir,
  trustFirstCapture: () => true,
});
const first = await provider()(opts.file); // pending=true
const done = await repairJournalTail(opts); // repaired, anchor=null
const next = await provider()(opts.file); // unavailable/concurrent-modification
```

**影响/严重度依据**：非攻击者改 evidenceDir、非重叠写者、非越权首捕；均为受支持的宿主操作串行组合。合法恢复/迁移流程误造持久拒绝状态，需要人工介入，故中阻断；未观察到重发授权洗白，不升高危。

**建议**：pending 且无旧锚时不得发布“已建权威”的 seen 登记。可明确拒绝首捕并保持无副作用，待 repair 完成后再正常首捕；若要支持待决快照，需单独持久状态，不能复用已建锚 seen。不要通过 pending 写穿当前盘面锚来修，否则重引 B3b；也不要自动放行所有 seen+missing-anchor，破坏 Q03 防丢锚门。将 P8 三路对照入仓，要求迁移不得报告 `migrated` 却无锚。

### B6-r4【中】起点对齐条件缺乏仓内杀手，非等价变异全仓存活

**位置**：`apps/server/src/runtime/repair-tail.ts:349-351`；测试缺口在 `tests/unit/server/repair-tail.test.ts` 的部分行/marker 冲突组合。

**复现步骤**：

1. 正常 enqueue i1 首捕建锚；追加坏尾，再制造 marker+truncate 后中断。令 marker.byteStart=222。
2. 在截断处追加一整行合法 enqueue i2（222B），再追加 marker 对应 repair 行前 11B；此时当前撕裂尾起点=444，与 marker 不对齐，全文 455B。
3. 仅在副本把：

   ```ts
   const isPartialRow = marker.byteStart === byteStart
     && tail.byteLength < mrow.byteLength
     && mrow.subarray(0, tail.byteLength).equals(tail);
   ```

   改成去掉首项的表达式，其他不变。
4. 三文件 115 pass，全仓 1261 pass / 15 skipped；自构 cross-bound 探针报红。真实结果 `repaired`，全文 448B，完整 i2 行已消失。
5. 还原条件：同输入 `aborted/repair-marker-conflict`，455B 原文及 i2 保留；三文件 115 pass。

**影响/严重度依据**：当前实现没有该删除缺陷，但阻止错误回截的关键条件被删后，仓内所有现有测试都不能察觉。与 r3 对非等价变异存活列中阻断的标准一致；不是以任意新变异数量抬高门槛。

**建议**：增加“旧锚前缀正确，但 marker 起点之后多一条完整合法行，尾又恰为 repair 严格前缀”的真盘测试；断言结果冲突、journal/anchor/marker 逐字节不变，并证明删对齐条件红→还原绿。不能只补一个非前缀垃圾尾，RT37 已覆盖那一形但守不住这里。

**阻断汇总：open 高=0，中=2。原 B1-r3/B3a-r3/B3b-r3 的指定反例已闭合；原 B6-r3 指定专杀成立，不等于新的测试缺口已闭合。**

## 4. 低项 / 挂账

- **L1：信任域条件仍是硬前提。** pending 捕获会接受任意改写盘面的“受阻快照”，不只是特定事务后像；本轮 P6 已实证。必须继续将 resumeBlocked 作为重发授权门，不能把 available 或 diskBlocked=false 当作认证/授权通过。evidenceDir 访问隔离与修复期禁写按 Q16 部署兑现；不能因本次 NO-GO 把这个已披露前提另算高危。
- **L2：跨 build 披露须精确。** 已写部分尚未包含不同 buildId 时，两 build 共享前缀仍会收敛（19B 亲验）；包含不同 buildId 时才保守拒绝（224B 亲验）。不是“跨 build 部分行一律拒”。完整旧 build 行的 M-R 抽验成立。
- **L3：RT39b 的标题误导。** 标题写“授权重试收敛”，实际断言与 TEST-MAP 正文是带授权仍 anchor-stale；回调根本未触发（本轮实测 0 次）。标题应写“保守拒绝且不改盘”。“重走迁移/调查”不得宣传为 `migrateLegacyEvidence` 能自动重建所有脏锚；该工具复用 provider，未提供越过证据门的授权出口。
- **L4：TEST-MAP 小计口径。** 本次全仓实际 64 passed 文件 + 2 skipped，不是正文“65 文件”；新增 it 从 diff 计为 8（repair-tail 4、recover 2、provider 2；1253→1261），不是“新增9例”。不影响测试真实通过数。
- **L5：保留既有边界。** marker 的 removedSha256 无独立真实性认证，截断形无法重新核验已删原尾；本审没有提升它的认证保证。readBack 到锚原子写之间的写窗、无目录 fsync、无真实断电试验继续挂账；本轮故障注入不等于真实掉电证据。
- **L6：⑤C/真 pi E2E 未执行。** PI_E2E 守卫及 15 skipped 维持既有口径，不用单测绿代销。
- **L7：新字段语义偏保守。** withRepair 无条件 OR pending/已有 undecided，即使 lines 已有 repair 行也可置 undecided；因此字段实际表示“曾见 pending 且未显式裁决”的保守粘滞标记，不严格证明“lines 从未含裁决事实”。目前只会多保守，P0-1b 设计时应统一术语，避免用清任一布尔绕过另一阴影。
- **时间口径**：TEST-MAP 标注 2026-10-06，但本机实际 UTC 为 2026-09-27（本轮执行窗口）。哨兵使用真实主机时钟，不伪造与文档日期一致的执行时间。

## 5. 排序建议

1. **先闭 B1-r4**：明确无锚 pending 首捕策略，保持 seen/anchor 权威建立的一致性；入仓 P8 的 provider/迁移/修复完成后首捕三路对照，并守住已有 Q03、RT39/RT39b。
2. **同批闭 B6-r4**：固化交叉起点且尾为真前缀的盘面不变测试；重放新对齐变异，必须红→还原绿。其余五支变异继续保持杀伤。
3. **复审通过后推进 P0-1b 裁决持久化**：以耐久裁决事实显式解除 repairLog/pending 历史/undecided 对应的授权阻断；绑定证据身份、旧快照与重启重放，不用一次 withRepair、归因消耗或手动清 marker 代替裁决。
4. **同步改正文案，不扩本批实现面**：修正 RT39b 标题、TEST-MAP 小计和跨 build 措辞。Q13/Q16、真实断电与⑤C 按部署/E2E 专项兑现。

本次交付仅为审报；未修复或更改生产代码、仓内测试、TEST-MAP，也未替实现方宣称上述两项已解决。

R4-REVIEW-DONE 2026-09-27T20:54:35Z
