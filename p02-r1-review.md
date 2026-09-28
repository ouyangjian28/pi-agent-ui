# P0-2 r1 装配批独立审报

## 一、结论

**NO-GO，58/100。** 审对象为主仓 `/home/yyj/ai/repos/pi-agent-ui` 的 `137dffa`（实现批 `7d48f09`）；审读 worktree 同基线。生产代码未改。

锁→扫描→宣誓→初始化的正常路径、同文件缓存、生产两入口接线和序列化同源成立；但**装配生命周期未被关停等待、检查/写入/记账未整体串行、异步装配异常未封口**。三个 P1 均属 r1，不涉及帧身份延期。

| 审查面 | 已兑现 | 未兑现 |
|---|---|---|
| 单文件装配 | 同路径同步缓存，同一个 boot Promise | 关停不等待 boot，旧 boot 可在释放锁后宣誓 |
| 写路径 | TurnGate/Coordinator 都经过壳 | 仅 inner 排队；自身写入可被误判 foreign 并粘性冻结 |
| fail-closed | held 活/死、bad-tail、非法 oath 拒业务写 | 非 EEXIST 取锁异常可成为未处理拒绝并退出进程 |
| 字节同源 | FileDurability 与壳共用 UTF-8 序列化 | 不能据此推出“整个检查到记账临界区已串行” |
| 证据 | 定向单测 29 绿、tsc 通过、A-1/A-2 实跑 2 绿 | 并发/关停交错未被原测试覆盖；进程崩溃重启不在 A-1 证据内 |

全仓 **1440 绿仅引用 brief/TEST-MAP，本轮未重跑、未独立认证该数字**。4409、write-ack 呈现及 resume 帧身份均标为 **r2 面预留**，不是本次 NO-GO 依据。

## 二、高优发现

### R1 · P1 必须修：close/dispose 不汇合 boot，能泄漏锁或释放后追加旧宣誓

**位置：** `apps/server/src/runtime/guarded-journal-writer.ts:51-62,77-99,137-160`；`apps/server/src/runtime/rpc-session.ts:264-272`；`apps/server/src/runtime/session-registry.ts:154-180`；`apps/server/src/composition.ts:320-321`。

两条确定性交错：

1. `writerFor()` 启动 acquire，但尚未 `releases.push` → `close()` 只关闭 inner → factory dispose 遍历空 releases 并返回 → acquire 完成，向已经结束的列表登记 release → boot 继续落 oath。结果：**dispose 返回后新增 oath，锁遗留**。后续业务 append 虽被 disposed 拒绝，不能补救锁/宣誓副作用。
2. acquire 已完成，暂停在 readJournal → `close(); dispose()` 释放锁 → 新工厂 B 获取锁、写 epoch=1 oath 和业务行 → 恢复 A 的旧 boot（读到的历史为空）→ A 无锁追加 epoch=1、bootId=old 的 oath。盘面出现 `[[1,"new"],[1,"old"]]`，新持有者下一写被 **foreign-write-detected** 冻结。同 epoch 扫描保留首个最高代持有者，故此处不是 writer-superseded。

**证据：** `/tmp/gpt-p02-r1-probe/races.test.ts` 的 P1/P2。另有 `registry-dispose.mts` 直接经过真实 `SessionRegistry.sessionFor → stop/dispose → factory.dispose`（没有 spawn 的冷会话；host 空替身不被调用）：日志明确 `lockMissingBeforeResume:true`，随后仍落 `registry-old` oath。这不是仅违反“调用者先关会话”的裸工厂误用；现有 registry 链确实不等待新增的 boot。

**影响：** 正常关停承诺不成立，后继实例可被已退役 boot 污染；FF-P02-3 违反。既有 close 对 inner 已接收业务写的排空，不覆盖 boot 的直接 `appendWriterOath`。

**修复方向/验收：** 将 boot 纳入单文件生命周期汇合；关闭后禁止新的装配副作用或等待既有装配完全结束再 release；释放责任不可丢。close/dispose 共享关闭完成结果，清理集合前确保所有获取锁的任务已归档。补上述两条交错及真实 registry 关停测试，断言关停返回后盘面不再变化、无残锁、后继正常续写。

### R2 · P1 必须修：check→append→note 未整体串行，合法同写者会永久自冻

**位置：** `apps/server/src/runtime/guarded-journal-writer.ts:117-134`；`apps/server/src/runtime/file-durability.ts:69-110`；`packages/protocol/src/dispatch-coordinator.ts:157-185,216-229,257-295`。

`FileDurability.queue` 只保护其内部写入，不保护壳层的 check 和 note：

- A 已把自己的行写入文件，尚在 datasync/Promise 返回窗口，未 note；
- B 调用壳 append，stat 看见 A 的字节，但守卫基线仍是旧值；
- B 把合法自身追加判为 foreign-write 并永久冻结；A 返回后的 note 不会解冻。

**生产可达链：** response-timeout 写入在途时，晚到 success 可以把 coordinator 置为 run-open；紧接 settled 经 TurnGate 发起另一个 append。RpcSession 的 timer 与 demux 异步回调没有把这些操作整体串行化。

**证据：** P3 在真实 FileDurability 写完、返回壳前用可控 Promise 放大窗口（无他写）；第二、第三 append 均 foreign 拒。`coordinator-overlap.mts` 进一步使用真实 TurnGate + DispatchCoordinator：timeout 写在途 → success=accepted → settled=`settle-durability-failed`，Gate=`closed/durability-failure`；盘面有 timeout 而无 settled。日志为 `/tmp/gpt-p02-r1-probe/coordinator-overlap.log`。这里只延迟耐久端口返回，未篡改 WriterGuard 的判决。

**影响：** 一次普通超时/响应交错即可让该文件在整个工厂生命周期无法再写；不是已经接受的 L2“他写 check→append 检测非预防”边界。

**修复方向/验收：** 在壳层按 journal 排队完整的 boot/check/inner.append/note 临界区；close 也应汇合该队列。不能改用写后 stat 重建基线，否则会吞他写。补超时/结算交错、并发追加、关停排空的确定性测试。

### R3 · P1 必须修：构造即启动的 boot Promise 无拒绝归一化，取锁 I/O 错误可杀进程

**位置：** `apps/server/src/runtime/guarded-journal-writer.ts:53-58,110-114`；`apps/server/src/runtime/writer-oath.ts:103-133`；`apps/server/src/runtime/session-registry.ts:108-113`。

`acquireJournalLock` 对非 EEXIST 错误直接 throw；壳的 `.then(success)` 没有 rejection 分支。writerFor 在构造时就开始 I/O，而第一次 append 可能要等 RpcSession 启动/readiness，甚至从未发生。因此，bootP 在有消费者 await 之前拒绝，Node 默认未处理拒绝行为可终止服务，而不是仅关闭该 journal 写面。

**复现：** `boot-reject.mts` 创建临时目录，调用 `writerFor(temp/absent-parent/j.jsonl)`，不调用 append（模拟等待 readiness）；Node v24.18.0 `--experimental-transform-types` 运行结果 **exit=1**，栈为 `open → acquireJournalLock:103 → bootFile:53`，错误 ENOENT，未到 `SURVIVED`。日志 `boot-reject.log`。原 FileDurability 在 `file-durability.ts:60-66` 会递归建父目录，新取锁先于该行为；此外 EACCES/EMFILE 等也走同一未封口分支（后两者为代码推理，未注入实跑）。

**修复方向/验收：** boot 必须从创建当刻就消费所有异常并归一为永久 failed 结果，不能只等 append 捕获；定义新目录准备策略，并保证部分获取锁后的错误清理。补独立子进程测试：无 append 消费者时装配失败也不崩服务，随后 append 一致拒绝，其他 journal 正常。

### R4 · P2 应修：测试与设计过称，当前绿灯没有证明 FF-P02-3 和崩溃恢复

**位置：** `tests/unit/server/guarded-journal-writer.test.ts:101-130,155-162`；`tests/integration/p02-assembly-e2e.test.ts:63-81,96-145`；`docs/p0-2-write-identity-design.md:57,84-94`。

- W-asm-5 只有“写完→dispose→再 append”，没有关停期间在途 boot/append。幂等用例构造后立即 dispose，却不检查 boot 完成及残锁；afterEach 删临时目录不能证明释放成功。
- A-1 实际是**同一测试 Node 进程内两次 startServer 实例重建，并拉起真实 pi 子进程**，不是 server 进程 SIGKILL/重启；没有 stale 锁→运维清锁的 E2E。设计 §5 W-asm-6、§6 的“崩溃残留 E2E”声明超出证据。
- A-1 盘面两代 writer、不同 bootId、两个 settled 是有效独立证据；但 epoch1 没有直接 `toBe(1)`，全局 audit 的 `includes("epoch=1")` 也可匹配 epoch=10，未按 file/boot 绑定。不能用日志替代盘面身份断言。
- A-2 ack=gate-failed(enqueue) + 即时行数相等 + 两条审计，能证明当下拒写；“until 相等”通常首次就成功，不是 10 秒稳定性观察，也未在关停排空后比较原始字节。相同行数的改写可漏检。审计来自同一被测实现，仅作辅助，不能独自证明零写。
- 测试未用 try/finally 确保所有 Live 实例收尾；shutdown 又吞掉 dispose 错误，失败样本可能留子进程/句柄，或遮蔽关停错误。

应补 R1/R2/R3 杀点并按实际能力收窄文档；如保留崩溃链承诺，须真 server 子进程验证。原有 A-1/A-2 通过并不推翻三个 P1。

## 三、低优发现与边界

1. **P3 文档勘正。** 设计 `:77,84` 仍写“装配中 not-ready 拒/同步拒”，实现是 await boot；`:57` 声称 registry 由 gateway/write-host 触发、tokens 后释放，真实是 composition 显式 registry→guardedWriters→tokens（`:320-322`）。§6 以 inner 队列声称完整串行已兑现，应随 R2 修复更正。
2. **P3 释放诊断不实。** 残锁 fail-closed、下次拒起的安全取舍可接受；但 `writer-oath.ts:122` 的 unlink catch 吞错，壳 `:158` 的 release-error audit 通常拿不到真实 unlink 失败。故“失败只 audit”准确说是“部分失败可能静默残锁”。这是继承组件行为，不单独重开 P0-3，也不是本次阻断依据。
3. **裸工厂边界。** P4 暂停 `checkBeforeAppend` 后直接 factory.dispose、随后恢复，确实可在锁释放后追加业务行（`:129` 后没有 disposed 复核）。但接口注明调用者先排空；生产默认 inner.close 会拒绝晚到业务写，故**不把这个裸工厂探针独立算生产 P1**。真正生产关停阻断是 R1 的 oath 绕过 inner.close。统一生命周期队列可一并消除此窗口。
4. **序列化同源认可。** `packages/protocol/src/journal.ts:68-73` 与 `file-durability.ts:86-91` 共用 `serializeJournalLine`，部分写循环也覆盖同一 Buffer。稳定 JournalLine 的中文/emoji 实测通过，+1 字节记账变异能被下一 check 杀掉。未声称它提供对象快照或对任意可变对象/toJSON 的恒等保证；生产调用是普通行对象，本轮不据此扩张缺陷。
5. **r2 面预留（不扣阻断分）。** 设计 `:47-50` 的 4402/not-ready.cause、writerState 呈现，与当前 gate-failed/现有 status 不一致，必须标注延期，不能写成 r1 已交付。4409/generation/resume/writer-authority 连接接管均留 r2。

## 四、核销清单（实际执行与限制）

### 代码走查

- 同路径 writerFor：构造后同步 Map.set，普通调用不会在 await 窗口双 boot；引用相等已验证。未声称不同路径别名/任意用户注入回调重入同样由字符串 Map 合并。
- 生产接线：composition `:166` → registry `:113` → RpcSession `:143,149`，两个写入口同一个壳。
- initialize 唯一流入是本次 oath 成功 byteEnd；失败分支不开放业务写。
- registry→factory 顺序存在，但没有等待 boot，详 R1；不能把“调用顺序正确”等同“写面静止”。

### 命令与探针

所有测试在主仓运行；PATH 前置 Node v24.18.0；单条命令上限均小于 5 分钟，无嵌套后台命令、无长 sleep。背景工具仅托管单条测试命令，未调用子代理。

| 核销项 | 实际结果 |
|---|---|
| `npx vitest run tests/unit/server/guarded-journal-writer.test.ts tests/unit/server/writer-oath.test.ts` | 2 文件、29 测试通过，486ms |
| `npx tsc --noEmit -p apps/server` | 与上述命令串行执行，整条 exit 0 |
| `PI_E2E=1 npx vitest run tests/integration/p02-assembly-e2e.test.ts` | 2 测试通过，28.81s；真实 pi 三轮 |
| races P1：立即 close/dispose + boot 在途 | 复现关停后 oath、锁遗留；同文件引用相等 |
| races P2：read 暂停→释放→新工厂写→旧 boot 恢复 | 重复 epoch/不同 bootId 已断言；首跑错误分类预期写成 superseded，实际 foreign，故此探针首跑红；已修正预期，仅复跑此项：1 通过、5 跳过，exit 0（281ms） |
| races P3：合法自写的落盘/记账窗口 | 复现粘性 foreign 冻结 |
| races P4：guard await 窗口直接 factory dispose | 复现释放后业务追加；仅裸工厂边界，不外推默认生产 |
| races P5：Unicode 连写 / +1 记账注入 | 正常连写通过，漂移被下一 check 拒；恢复 prototype |
| races P6：非法 oath at | 连续两次 writer-oath-failed，journal ENOENT，零业务行 |
| `registry-dispose.mts` | exit 0；真实 registry 收尾后锁已消失，旧 oath 仍落盘 |
| `coordinator-overlap.mts` | exit 0；真实协议组件产生 settle-durability-failed、closed/durability-failure |
| `boot-reject.mts` | **预期缺陷证据 exit 1**；ENOENT 未处理拒绝终止 Node |

探针源码与独立日志保留在 `/tmp/gpt-p02-r1-probe/`；前三个后台任务日志位于主仓 `.pi/tasks/session-2417935-2417935/`：`b0ad4dfb5.output`、`b99619ae9.output`、`ba79a032d.output`，P2 定向复核为 `b65a4c304.output`。原竞态套件首轮为 **5/6 通过**，失败是审读探针的错误分类断言，不隐瞒也不算产品回归测试失败；缺陷本身由盘面及真实 registry/coordinator 独立探针交叉确认。

过程限制：未见【流程门】注入块，已开场披露；当前无 session_search 工具，使用项目索引、长期记忆、当前 HEAD 源码及 brief 交叉定位。未跑全仓、未跑 SIGKILL server E2E、未验证多机/绕锁原子防护，不外推对应结论。

## 五、给 r2 的输入

1. **先收 r1 三个 P1 再叠帧身份。** 帧代次检查不能修复退役 boot 越权宣誓或同写者误冻。
2. 明确区分 server bootId、journal writer epoch、pi process generation、WS writer-authority epoch；A-1 证的是前两者的实例重建，不是四者都已联动。
3. 将 lock-held / bad-tail / oath-failed / superseded / foreign / I/O boot failure 的内部原因保留为结构化事实，再定义 write-ack/status/关闭码呈现；r1 的 gate-failed 不要包装成已实现 4409。
4. resume 必须绑定实际盘面可授权 intent 与当前身份；拒绝断言应检查 journal 字节不变和无 stdin 发送，而非只看审计或 ack。
5. 延续 P0-3 边界：stale 锁不自动抢占，L2 是检测非存储原子 fencing；不要把帧校验宣称为多机双写防护。
