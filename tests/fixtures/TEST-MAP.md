# §9.1 测试行编号→fixture→断言映射（P0-3；开工轮一审指令 3「可判读 fixture」）

标注口径：✅=可执行断言已绿（文件@用例）；🟡=部分覆盖（断言在但口径不全）；🔴=缺测（无对应断言——不得算通过）。
语义权威=TECH §9.1；本表只做映射，不改语义。

## N 行（通知/恢复对账）

| 编号                                                           | 断言落点                                                                                | 状态                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| N6 迟到重投墓碑                                                | notification.monotonic@迟到重投墓碑——现状如实：derived 重投测试断言实为 accepted=true（非拒绝）；expired 终态重投直拒未单独断言；收口幂等≠重投拒绝，二者分立断言 | 🟡（挂 N6 补测：补 derived/expired 重投拒绝真断言）|
| N12 三 ACK 分立                                                | notification.monotonic@done 收口裁决（零/二缺一/三齐/未开栓/终态单调）                  | ✅                                        |
| N12b expired 独立收口                                          | notification.monotonic@expired 独立终态（证据驱动+迟到 ACK 不升 done）                  | ✅                                        |
| N14 done 单调（迟到 started 不降）                             | notification.monotonic@主线跃迁+done 单调                                               | ✅                                        |
| N18 连扫两次不造锚                                             | b-face.regressions@B1（部分轮两扫收敛）+recovery.two-pass@两遍式                        | ✅                                        |
| N18b 新增身份证据才落锚（反面：新终答≠天然归属）               | n18b.evidence@歧义组完整轮不解锁+锚后组内仍歧义                                         | ✅                                        |
| N18b 正向解除（二扫真证据落锚）                                | b-face.regressions@C1（首扫双暂定→补齐后双 delivered+I2 锚 e2）                         | ✅                                        |
| N18b 全链正向（首扫产物→journal 重放→二扫，不手填）            | r2.regressions@全链正向样例（newConsumed 落 journal→replayIntents→同判 delivered）      | ✅（二审任务 3 修正：重放链真实衔接）      |
| R2-01 既有锚同验证（assistant/错文本/附件/跨组共享/锚缺失→untrusted） | r2.regressions@R2-01×2+r3.regressions@三审⑥×3（全类覆盖）                          | ✅                                        |
| R2-02 终点更新行（首锚 append-only+新行承载终点）              | recovery.two-pass@两遍式（I1 双行同锚+最新终点收窄）+r3.regressions@三审②（历史终点也耐久化） | ✅                              |
| R2-03 P 排他+untrusted 拦水位（区间排他另列）                  | r2.regressions@R2-03×2（终答在 P/冲突锚）+r3.regressions@三审③（审者反例）——旧「候选落他人 C」用例走超界分支已由三审⑥真命中用例替代 | ✅                |
| R2-04 clear 行重放+cancelled 恰一 verdict                      | r2.regressions@R2-04×2（journal 层+recovery 层）                                       | ✅                                        |
| R2-05 缺 ID/坏行拒绝闭合                                       | r3.regressions@三审⑥ R2-05 段（intervalToolCallsPaired 缺 toolCallId/corrupt 双表示→false 直接断言）+session-file.ts 代码面 | ✅                                        |
| R2-06 通知两域（derived 可收口+expired 账本域 done）           | notification.monotonic@expired 独立终态+accountDomainClose（outbox expired→账本 done） | ✅                                        |
| R2-07 前置条件门（不满足=全部暂定）                             | r2.regressions@R2-07×3（水位身份/外部闩/写者未静止）                                   | ✅                                        |
| 三审① clear 不改写历史终局（lastVerdict 保护）                 | r3.regressions@三审①（enqueue→consumed→delivered→clear 重放保持 delivered）           | ✅                                        |
| 三审② 历史 consumed 终点漂移耐久化（重放来的也追加更新行）     | r3.regressions@三审②（首扫 u1→二扫 a1 追加同锚新终点行+重放锚存在断言）               | ✅                                        |
| 三审③ untrusted 锚不作可信分区（审者反例）                     | r3.regressions@三审③（B 错锚 x→A 不被切分救成 delivered+水位 null）                  | ✅                                        |
| 三审④ 前置必填+超时开终裁窗                                    | r3.regressions@三审④（失败=空水位空消费+roundTimedOut 等同恢复态歧义源）             | ✅                                        |
| 三审⑤ 通知双域结构化成因（doneReason 字段+双域输入）           | notification.monotonic@done 收口裁决（expired 面）+r4.regressions@四审⑤（doneReason="acks" 直断+derived+outbox expired→"expired" 跨域映射直断） | ✅（四审⑤补 acks/derived 面）|
| 三审⑥ R2-01 补类（附件不一致/跨组共享/锚缺失→untrusted）       | r3.regressions@三审⑥×3                                                              | ✅                                        |
| 三审⑥ R2-05 直接断言（缺 toolCallId/corrupt 双表示→不闭合）    | r3.regressions@三审⑥ R2-05 段（intervalToolCallsPaired 直接断言）                    | ✅                                        |
| 四审① 历史 delivered+clear 不授权新增尾部（证据定格）          | r4.regressions@四审①（区间不扩展到 x+无更新行+水位 null）                            | ✅                                        |
| 四审③ untrusted 不占候选排他位（预扫）                          | r4.regressions@四审③×2（[B,A]/[A,B] 双顺序：B 错锚不挡 A 落锚）                      | ✅                                        |
| 四审④ 超时开终裁窗（终裁 vs 暂定区分）                          | r4.regressions@四审④（同文本组歧义→untrusted 终裁+单意图完整轮 delivered 正例）      | ✅                                        |
| 五审① 无 clear 历史终局不降级                                  | r4.regressions@五审①×2（delivered/settled 无 clear：如数输出 delivered+无更新行+水位 null） | ✅（变异验证：删该分支→两用例挂）        |
| W1 双 tab 写权代次（让位广播+旧代次拒）                        | writer-authority.test@W1（B 接管代次+1+yield 广播+A 旧 epoch 提交 stale-epoch+not-holder） | ✅（逻辑面；双 tab 集成=WS 层后置，W2 是断网重连非双 tab——r8 勘误）|
| W1a 在飞接管=转接（无双写者）                                   | writer-authority.test@W1a（进程存活转接：不发停止信号） | ✅（逻辑面；真实在飞轮+延迟落盘无双写者验证=adapter 集成面，r8 复核降级）|
| W1b SIGKILL 未退出（截止冻结+核验转正）                        | writer-authority.test@W1b×2（全链 frozen→核验→可接管+正常 confirmExit）+frozen 期命令拒 | ✅（逻辑面；核验=受信通知接口，非本模块核验闭环）|
| r8-01 交接期提交门（terminating/killed 拒；complete 清 holder） | writer-authority.test@r8-01×3（逐阶段拒+转正后 not-holder+默认转接不受影响） | ✅（逻辑面；变异验证：去门+不清 holder→两用例挂）|
| opId 通用命令去重（占位/缓存/不同参拒/崩溃闭环）               | command-dedup.test@6（admitted/cached/different-args/unknown-effect 重放（占位记录重建的逻辑测试，非耐久链路）/无占位 settle/sweep） | ✅（逻辑面；耐久 fsync=adapter 面）|
| r8-02/r8b 去重清理=生命周期判据分离（SweepLifecycle）          | command-dedup.test@sweep（active 一律不删/判据缺失或坏=不删/退出时刻 T24 于 T25 清=保留（最后消息时刻≠退出时刻反例）/退出满 24h+占位过 24h 才删/保留期 cached 与 unknown-effect 分立/清理后可重新 admitted） | ✅（逻辑面；变异验证：去退出保留窗→反例挂）|
| 会话列表扫描（§6 查看≠接管：身份/排序/坏 header/缺目录/watch）  | session-list.test@8（tmpdir 真测：身份=header.id 与 file 定位键分离（真实命名格式）/坏 header 不吞行（sessionId:null 显式）/首行非 session 不吞/倒序+首 user 标题+多 user 不覆盖/撕裂尾跳过/limit/watch 门铃） | ✅（真 IO 面；变异验证：位置法 header→四用例挂）|
| 事件泵行缓冲（§5 事实 6 stdout 常驻排空）                      | line-pump.test@8（整块多行/半行跨块/CRLF/多字节跨块（StringDecoder，中文+4字节 emoji）/撕裂尾置换符/flush/reset） | ✅（逻辑面；变异验证：逐块独立 decode 旧实现→多字节三用例挂）|
| pi 子进程冒烟（--mode json 事件流真跑）                        | integration/pi-child.smoke.test.ts | ✅（集成面；真 spawn 事件流+agent_end 或 agent_settled 任一+exit 0——settled 必现未断言，r8 复核如实降级；根因=stdin 须 EOF+timeout 勿当 wrapper——主仓 research/pi-bash-tool-ask-hang §⑥ 追加）|
| pi-child 泵接路径防护（解析错/无 type/null·数组·原始值/回调错） | pi-child-pumps.test@2（[stdout-nonjson]/[handler-error]/泵继续交付；r8b-01：JSON.parse("null") 成功但 e.type 抛 TypeError 的回归——null/数组与正常事件同块继续交付；独立 42 行进 nonjson、后续事件继续——不炸泵） | ✅（逻辑面；r8b-01 修复+变异验证：去形状验证→同块回归挂）|
| 六审① 历史终局+同组 sending 歧义优先                           | r4.regressions@六审①×2（delivered/settled+B 同组 sending→unknown+untrusted 非直输出） | ✅（变异验证：换回旧顺序→两用例挂）      |
| 变异验证（四审轮）                                              | 删 finalizedIds 隔离→四审①挂；删 untrustedEarly 占位过滤→四审③×2 挂；还原 68/68    | ✅                                        |
| 三审⑥ R2-03 区间排他真命中（候选在他人既有 C 区间内不落锚）    | r3.regressions@三审⑥ 区间排他段（组内两 user 真命中——旧用例走超界分支已弃）          | ✅                                        |
| N18b 防御断言（首扫落锚+重放锚存在+二扫不重落锚）              | r3.regressions@三审② 内嵌（newConsumed=1+锚存在+仅更新行）                           | ✅                                        |
| 变异验证（三审轮）                                              | 删 lastVerdict 保护→三审①挂；同时删区间+静止隔离→三审③挂（单层冗余多层联合防护）；还原 61/61 | ✅                          |
| N19 两遍式收敛（A/B 同轮）                                     | recovery.two-pass@两遍式（单遍误拦修）                                                  | ✅                                        |
| N19b 混合路径（A 自有锚+B 新匹配同轮；A 借不到 B 终答）        | b-face.regressions@N19b（provisional 标记）                                             | ✅                                        |
| N1-N5/N7-N11/N13/N15-N17（账本行序/接收面/GC 后重投/幂等键等） | 待 journal/通知执行层实现（server 侧）                                                  | 🔴 缺测（服务端未建，非 protocol 面可测） |

## 恢复算法面（D8 锚点族+B 面）

| 编号                           | 断言落点                                                                       | 状态 |
| ------------------------------ | ------------------------------------------------------------------------------ | ---- |
| 五反例ⒺⒶⒷⒸⒹ                    | recovery.two-pass@四联终检五反例                                               | ✅   |
| B1 部分轮重算收敛              | b-face.regressions@B1                                                          | ✅   |
| B3 水位重算终点（非锚/旧终点） | b-face.regressions@B3（advanceTo=a1 终答）                                     | ✅   |
| B5 锚冲突=组歧义双 unknown     | b-face.regressions@B5                                                          | ✅   |
| B6 仅 user 入组                | b-face.regressions@B6（assistant 同 hash 不认锚）                              | ✅   |
| B7 工具多重集配对              | b-face.regressions@B7（孤立 result/重复 id/1:1）                               | ✅   |
| B8 区间坏行                    | b-face.regressions@B8                                                          | ✅   |
| 八审水位不吞未决               | identity-gate@水位不吞（A 未决 B 完成水位停）                                  | ✅   |
| 十一审①原始序号禁重编          | identity-gate@原始序号（运行态取法 e2 非 e3）                                  | ✅   |
| 十八审①数量相等歧义不落锚      | identity-gate@数量相等+组级 unknown                                            | ✅   |
| clear 四分支（B9）             | 分支③不改写=r3@三审①（delivered+clear 保持 delivered）✅；①身份不确定/②执行未终局取消/④通知独立支=代码面无逐支断言 🟡（并入 N19 系补测） | 🟡（③✅；①②④🟡）|

## 变异验证（二审建议：删保护后测试须失败）

| 变异（禁用保护）                    | 结果                                      |
| ----------------------------------- | ----------------------------------------- |
| R2-01 锚验证恒真                    | r2.regressions 1 failed（锚指向 assistant 被 delivered） |
| R2-07 前置门恒过                    | r2.regressions 3 failed（前置不满足仍终裁） |
| R2-03 终检不传 P                    | r2.regressions 1 failed（P 中终答作证据）  |

还原后 51/51 恢复（测试防御力=真实，非固化旧语义的假绿）。

## UI 面（I 行，GPT 切片 1）

| 编号                                     | 断言落点                      | 状态               |
| ---------------------------------------- | ----------------------------- | ------------------ |
| I-R9/I-R11 返回/键盘/窄屏                | tests/unit/web/（8 组件测试） | ✅（draft 数据面） |
| unknown/recovering 不冒充成功            | web 测试「状态待确认」断言    | ✅（draft）        |
| 真实链路 I 行（WS 重放/问题卡/上传拒绝） | 待 WS 层+真实链路             | 🔴（依赖服务端）   |

## W/J/R/B/D 行（服务端机制面）

端到端验收面全部 🔴 缺测——RPC adapter 真进程集成/journal 真文件系统耐久/通知执行链未开工（r8c 风险序 2-6）；范围=服务端端到端机制验收，与上方纯逻辑局部 ✅ 及下方 adapter 逻辑面不冲突；本表不虚报。

### adapter 切片 1（r8c 风险序 1：派发屏障与耐久接口；纯逻辑+注入耐久端口）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| 屏障硬序（enqueue→sending 两 fsync 完成→才发 send 许可；stdin 首字节不早于 sending fsync） | turn-gate.test@硬序（行序断言+resolve 后才许可）+@硬序 pending 面（s1b：sending 挂起期间 submit 不 resolve 直接断言） | 🟡（逻辑面；stdin 首字节归发送器验收，未测） |
| 屏障占用/释放（in-flight 中 submit=busy；settling 期间 submit=busy；settled 行 fsync 成功才 idle 放下一意图） | turn-gate.test@占用/释放+@settling pending busy | ✅（逻辑面；pending 窗口已断言） |
| 耐久 fail-closed（enqueue/sending/settled 任一 fsync 失败→closed 保持；reopen 由宿主裁决；续加前置契约=reject 后须先恢复可安全追加状态再纳新行） | turn-gate.test@三处 fsync 失败（写前拒绝）+@写后拒绝（A1-02） | 🟡（逻辑面；注：reject 不证明盘上无行（写后拒绝已证）；恢复以实际重放裁决；续加前置契约=接口注释层已补（DurabilityPort/OpLedgerPort），真实现归后续切片；变异：去屏障→3 挂、settled fail-open→1 挂） |
| A1-01 关闭失效（close/reopen 使 pending 旧 submit/旧 settled 失效：不发放 send、不覆盖新状态、旧失败不关新轮） | turn-gate.test@A1-01 组×6（enqueue/sending/settled 三窗口+invalidated 优先于 failed+旧失败不关新轮+settling busy） | ✅（限六反例本身；生命周期整体含 B1-01（已修见下行）；变异：去 submit 复核→2 挂、去 settled catch 复核→1 挂） |
| B1-01 假失败 reopen 无副作用（非 closed 的 reopen=false 且不递增 epoch；不取消 pending 有效操作；失败路径不受污染（s1c 补：sending/settled 拒绝窗口两例固化）；真 closed 后 reopen 仍有效） | turn-gate.test@B1-01 组×4+补遗×2（六窗口全覆盖） | ✅（逻辑面；s1b 探针反例修复；s1c 探针六路径验证） |
| B1-02 审计钩子异常隔离（onAudit 同步抛错不影响 rejected-different-args/send-failed 返回语义；仅同步钩子契约——异步拒绝归宿主（C1-02）） | command-channel.test@B1-02 组×2 | ✅（逻辑面；同步抛错隔离；观测层失败不进主链路） |
| success 仅受理（onAccepted 不释放屏障；settled 先于 success 可收口；晚到回执 no-op 不开新轮） | turn-gate.test@仅受理+乱序基础+晚到 | 🟡（逻辑面；跨新轮晚到事件归属（A1-04 前半）=关联层切片 2） |
| 轮超时中断呈现（超窗→closed(turn-timeout) 不自动重发；窗口内不裁决；reopen 解锁） | turn-gate.test@轮超时 | 🟡（逻辑面；reopen 只证解锁非「超时恢复安全已证明」；响应超时 vs 整轮超时分立归切片 2（TECH.md:169）） |
| 通用命令占位先行（placeholder fsync→send→result fsync→settle；占位失败=未发送+内存留置（同 opId=unknown-effect，新 opId 重发）；send 失败=效果未知留置；结果耐久失败=内存占位态+同通道重试 unknown-effect（s1b 补）；cached 不重发；同键不同参拒+审计；send 返回 null=违规留置+审计） | command-channel.test@12（含写前/写后两替身+A1-05 null+同通道重试补断言+结果写后重放=cached 非洗白） | 🟡（逻辑面；耐久等待窗口未挂起锁；变异：占位序倒置→3 挂、回滚内存退化→2 挂、去 null 防御→1 挂） |
| opId 通用命令去重（admit/缓存/同键不同参拒/崩溃重放重建；rollback 已删 A1-03） | command-dedup.test@6 | ✅（逻辑面；公开危险接口已移除） |

### adapter 切片 2（风险序 2：带身份乱序协调层；TECH §169④ 事件归属屏障；纯逻辑；s2+s2b+s2c 修复后 35 it）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| 事件归属先于回调（TurnKey=intentId+commandId+generation；send 许可后才登记；带 id settled 精确归因；未登记/错 id 回执=ignored-unknown+审计；**许可交接窗口（C3）：send 返回后登记前复核 Gate 现态（须仍 in-flight 且同 intentId），否则 invalidated/post-send 不登记不 launched**） | dispatch-coordinator.test@正常序（错 commandId=ignored-unknown）+反例6（close 插入 enqueue 挂起窗口=invalidated 无登记+晚到 response=ignored-unknown）+S2-C3 两例（sending 完成微任务窗口 close / close+reopen 后 B 在飞旧 A 续跑不覆盖 B 登记） | 🟡（逻辑面含 await 后 opEpoch 复核成/败两侧（S2-02）+post-send 交接窗口（C3）；「stdin 首字节前完成登记」的机械序归发送器接线验收；变异：M-C3 去交接复核→C3 两例挂） |
| 旧超时跨换代/新轮失效（opEpoch：retire/abandonHeld 递增；旧超时 append 完成/失败=invalidated，不覆盖新登记、不关新 Gate、不结算新轮；A 晚到 settled 丢弃；**超时槽位绑 key：退役释放、旧 finally 不清新槽、失败侧验所有权；正常收口=槽位释放边界（C1：挂起超时不占位新轮，旧续体 epoch+key 复核自归 invalidated）**） | dispatch-coordinator.test@S2-02 两例+S2-B2 两例（退役释放可自发起/旧 finally 不清新槽不双 append）+S2-B3（正常更替后旧 reject=invalidated 不关后继轮）+S2-C1 两例（success+settled 正常收口含双挂起/B 合并式结算） | ✅（逻辑面；变异：M2 去成功侧 epoch 复核→挂；M4 换代不失效→2 挂；M-B2 finally 无条件清槽→B2b 挂；M-B3 失败侧不验所有权→B3 挂；M-C1 去 finishSettle 槽位释放→C1 首例挂） |
| 超时记录等待窗口合并裁决（挂起期 event/settled 到达不被旧快照吞；合并移出+bufferedSettled 即结算；挂起期 success 回绑=superseded 超时未生效；重入=pending 不双 append；**结算等待窗口新增事件取登记最新缓冲一并交付（B1 两窗口）**） | dispatch-coordinator.test@S2-01 三例+S2-B1 两例（timed-out→settled 窗口/bufferedSettled→超时第二次窗口） | ✅（逻辑面；变异：M1 旧快照覆盖→挂；M-B1 交付丢缓冲→5 挂） |
| settled 先到保留缓冲（prompt 在途+settled 先到=回绑时消费不丢不等第二个；回绑即结算 accepted-and-settled；awaiting 重复=duplicate；**结算失败缓冲保留在登记上不交付不丢**） | dispatch-coordinator.test@反例1（含 awaiting 重复 duplicate）+反例3+S2-03 三例（失败保留+写后拒绝行在+abandonHeld 拒活轮/空登记） | ✅（逻辑面；变异：去缓冲直接结算→反例1/3 挂；M3 失败丢缓冲→2 挂） |
| 响应超时协议（先耐久 response-timeout 行再移出在途；移出后晚到 success 不回绑不开 run+审计；晚到 settled（含无 id 唯一在途归因）结算记录解屏障；记录 fsync 失败=fail-closed 不移出） | dispatch-coordinator.test@反例2+无 id 归因+记录 fsync 失败 | ✅（逻辑面；变异：跳过耐久记录直接移出→2 挂；晚到 success 仍回绑→挂） |
| 带缓冲 settled 的超时分派（记录+结算一次=recorded-and-settled；**结算行恰一次断言**；不再等第二个 settled） | dispatch-coordinator.test@反例3（settled 行恰一次）+S2-01a | ✅（逻辑面） |
| gate 结算结果契约（TurnSettleResult：settled=唯一解锁证据；not-in-flight/invalidated/durability-failure=held 缓冲保留，不以 idle 推测） | turn-gate.test@轮超时（晚到 settled=not-in-flight）+四值直接断言组（settled/durability-failure/结算窗口 close=invalidated）+coordinator 反例4/S2-03 各 held 用例 | ✅（逻辑面；S2-04 前半：解锁证据=Gate 返回值；reopen 不证明收口仍归宿主） |
| held 弃置恢复手续（abandonHeld：gate closed/idle 才可弃；丢弃计数审计不静默（含 releasedPendingTimeout 字段：弃置=登记释放边界同步释放同 key 槽位）；弃后可 submit 新轮；活轮/空登记拒绝） | dispatch-coordinator.test@S2-03a/b（reopen→abandon→submit 全链）+拒活轮 | ✅（逻辑面；S2-04 后半最小实做；「恢复走真实退出确认」归进程面） |
| 终态耐久失败保持关闭（settled 行 fsync 失败→gate closed；重复 settled 再呈现不改写；旧轮 late 事件不改写新轮） | dispatch-coordinator.test@反例4+反例5（A 晚到带 id settled 不得结算 B） | ✅（逻辑面；与 TurnGate A1-01 epoch 复核互补） |
| 事件缓冲有界（awaiting 期事件按代次缓冲有界；溢出=gate closed(buffer-overflow)+审计+已缓冲保留呈现不静默丢；run-open 直交；旧代次丢弃；**换代清非空缓冲计数审计**） | dispatch-coordinator.test@溢出+run-open 直交+反例7（clearedEvents=2） | ✅（逻辑面；变异：溢出静默丢不关闭→挂） |
| 迟到 settled 四联丢弃（无开启 run+无在途命令+无未结算记录+缓冲空→丢弃+审计；不满足=保留：在途→buffered/归因，有记录→结算） | dispatch-coordinator.test@四联空丢弃+反例1 尾（结算后）+无 id 归因（有记录→结算）+反例7（换代后） | ✅（逻辑面；三分支均断言） |
| drain 回调隔离（onBufferDrain 抛错不中断结算+审计 drain-callback-failed；回调可靠性归宿主） | dispatch-coordinator.test@S2-Y4 | ✅（逻辑面；s2b Y4） |
| journal 重放标记（response-timeout 行→responseTimeoutRecorded=true；行在+lastVerdict=null=效果未知呈现；settled 行承载终态） | dispatch-coordinator.test@重放标记（S2-06 最小实做） | ✅（逻辑面；恢复对账消费=对账算法接线验收） |
| 进程换代隔离（onGenerationRetired 清登记+计数审计+opEpoch 失效 pending；旧代次晚到事件全丢弃；新代次轮不受影响；**无关代次退役=no-op 不失效在飞轮（Y1）；失效身份分立（C2）：仅登记匹配才递增 epoch，仅槽位匹配=只清槽不取消当前命令（slot-only 分支公开 API 下不可达=C1 后不变量固化，无行为级测试/无变异杀伤，如实披露）**；屏障解除=宿主换代手续 close+reopen 非协调器自动） | dispatch-coordinator.test@反例7+S2-02+S2-Y1（无关代次 no-op）+S2-B2（槽位释放+旧续体不动新轮） | 🟡（逻辑面；退出确认/换代手续本体=进程面后续切片；「旧 timer/旧 Promise 失效」同归接线验收；变异：M-Y1 去 no-op→挂；M-C2 不可杀伤=分支不可达（披露）） |
| 响应失败（ok=false）与整轮超时分立（response-failure 屏障不动宿主处置；turn-timeout 委托 gate checkTimeout） | dispatch-coordinator.test@ok=false+整轮超时委托 | ✅（逻辑面；§169④ 两类超时分立已落） |

端到端面（真 spawn+真文件系统+乱序压力+连续派发）待 adapter 后续切片，仍 🔴。
