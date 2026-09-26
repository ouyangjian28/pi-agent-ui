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

### adapter 切片 2（风险序 2：带身份乱序协调层；TECH §169④ 事件归属屏障；纯逻辑；s2+s2b+s2c 修复+s2d 清理后 37 it，90/100 通过）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| 事件归属先于回调（TurnKey=intentId+commandId+generation；send 许可后才登记；带 id settled 精确归因；未登记/错 id 回执=ignored-unknown+审计；**许可交接窗口（C3）：send 返回后登记前复核 Gate 现态（须仍 in-flight 且同 intentId），否则 invalidated/post-send 不登记不 launched**） | dispatch-coordinator.test@正常序（错 commandId=ignored-unknown）+反例6（close 插入 enqueue 挂起窗口=invalidated 无登记+晚到 response=ignored-unknown）+S2-C3 三例（sending 完成微任务窗口 close / close+reopen 后 B 抢先派发：A 续跑时 B 已接管（dispatching）→最终 B in-flight，旧 A 续跑不覆盖 B 登记 /【受控替身·分支面】in-flight 但另一意图→定向单杀「仅删 intentId 比较」窄变异） | 🟡（逻辑面含 await 后 opEpoch 复核成/败两侧（S2-02）+post-send 交接窗口（C3）+intentId 分支定向测试（s2d 窄变异已可杀）；「stdin 首字节前完成登记」的机械序归发送器接线验收；变异：M-C3 去交接复核→C3 两例挂；narrow-C3 删 intentId 比较→分支面例挂） |
| 旧超时跨换代/新轮失效（opEpoch：retire/abandonHeld 递增；旧超时 append 完成/失败=invalidated，不覆盖新登记、不关新 Gate、不结算新轮；A 晚到 settled 丢弃；**超时槽位绑 key：退役释放、旧 finally 不清新槽、失败侧验所有权；正常收口=槽位释放边界（C1：挂起超时不占位新轮，旧续体 epoch+key 复核自归 invalidated）**） | dispatch-coordinator.test@S2-02 两例+S2-B2 两例（退役释放可自发起/旧 finally 不清新槽不双 append）+S2-B3（正常更替后旧 reject=invalidated 不关后继轮）+S2-C1 两例（success+settled 正常收口含双挂起+B 槽重查（pending(B) 零追加）+append 计数/A 合并式结算后 B 自行超时） | ✅（逻辑面；变异：M2 去成功侧 epoch 复核→挂；M4 换代不失效→2 挂；M-B2 finally 无条件清槽→B2b 挂；M-B3 失败侧不验所有权→B3 挂；M-C1 去 finishSettle 槽位释放→C1 首例挂；narrow-C1 finally 无条件清槽→C1 首例 B 槽重查挂（s2d 补）） |
| 超时记录等待窗口合并裁决（挂起期 event/settled 到达不被旧快照吞；合并移出+bufferedSettled 即结算；挂起期 success 回绑=superseded 超时未生效；重入=pending 不双 append；**结算等待窗口新增事件取登记最新缓冲一并交付（B1 两窗口）**） | dispatch-coordinator.test@S2-01 三例+S2-B1 两例（timed-out→settled 窗口/bufferedSettled→超时第二次窗口） | ✅（逻辑面；变异：M1 旧快照覆盖→挂；M-B1 交付丢缓冲→5 挂） |
| settled 先到保留缓冲（prompt 在途+settled 先到=回绑时消费不丢不等第二个；回绑即结算 accepted-and-settled；awaiting 重复=duplicate；**结算失败缓冲保留在登记上不交付不丢**） | dispatch-coordinator.test@反例1（含 awaiting 重复 duplicate）+反例3+S2-03 三例（失败保留+写后拒绝行在+abandonHeld 拒活轮/空登记） | ✅（逻辑面；变异：去缓冲直接结算→反例1/3 挂；M3 失败丢缓冲→2 挂） |
| 响应超时协议（先耐久 response-timeout 行再移出在途；移出后晚到 success 不回绑不开 run+审计；晚到 settled（含无 id 唯一在途归因）结算记录解屏障；记录 fsync 失败=fail-closed 不移出） | dispatch-coordinator.test@反例2+无 id 归因+记录 fsync 失败 | ✅（逻辑面；变异：跳过耐久记录直接移出→2 挂；晚到 success 仍回绑→挂） |
| 带缓冲 settled 的超时分派（记录+结算一次=recorded-and-settled；**结算行恰一次断言**；不再等第二个 settled） | dispatch-coordinator.test@反例3（settled 行恰一次）+S2-01a | ✅（逻辑面） |
| gate 结算结果契约（TurnSettleResult：settled=唯一解锁证据；not-in-flight/invalidated/durability-failure=held 缓冲保留，不以 idle 推测） | turn-gate.test@轮超时（晚到 settled=not-in-flight）+四值直接断言组（settled/durability-failure/结算窗口 close=invalidated）+coordinator 反例4/S2-03 各 held 用例 | ✅（逻辑面；S2-04 前半：解锁证据=Gate 返回值；reopen 不证明收口仍归宿主） |
| held 弃置恢复手续（abandonHeld：gate closed/idle 才可弃；丢弃计数审计不静默（含 releasedPendingTimeout 字段：弃置=登记释放边界同步释放同 key 槽位，true/false 两值直断言+旧挂起续体 invalidated 不占槽）；弃后可 submit 新轮；活轮/空登记拒绝） | dispatch-coordinator.test@S2-03a/b（reopen→abandon→submit 全链）+拒活轮+槽位释放字段例（s2d 补） | ✅（逻辑面；S2-04 后半最小实做；「恢复走真实退出确认」归进程面） |
| 终态耐久失败保持关闭（settled 行 fsync 失败→gate closed；重复 settled 再呈现不改写；旧轮 late 事件不改写新轮） | dispatch-coordinator.test@反例4+反例5（A 晚到带 id settled 不得结算 B） | ✅（逻辑面；与 TurnGate A1-01 epoch 复核互补） |
| 事件缓冲有界（awaiting 期事件按代次缓冲有界；溢出=gate closed(buffer-overflow)+审计+已缓冲保留呈现不静默丢；run-open 直交；旧代次丢弃；**换代清非空缓冲计数审计**） | dispatch-coordinator.test@溢出+run-open 直交+反例7（clearedEvents=2） | ✅（逻辑面；变异：溢出静默丢不关闭→挂） |
| 迟到 settled 四联丢弃（无开启 run+无在途命令+无未结算记录+缓冲空→丢弃+审计；不满足=保留：在途→buffered/归因，有记录→结算） | dispatch-coordinator.test@四联空丢弃+反例1 尾（结算后）+无 id 归因（有记录→结算）+反例7（换代后） | ✅（逻辑面；三分支均断言） |
| drain 回调隔离（onBufferDrain 同步 throw 捕获不中断结算+审计 drain-callback-failed；async reject 不在隔离范围=宿主回调自证责任；回调可靠性归宿主） | dispatch-coordinator.test@S2-Y4 | ✅（逻辑面；s2b Y4） |
| journal 重放标记（response-timeout 行→responseTimeoutRecorded=true；行在+lastVerdict=null=效果未知呈现；settled 行承载终态） | dispatch-coordinator.test@重放标记（S2-06 最小实做） | ✅（逻辑面；恢复对账消费=对账算法接线验收） |
| 进程换代隔离（onGenerationRetired 清登记+计数审计+opEpoch 失效 pending；旧代次晚到事件全丢弃；新代次轮不受影响；**无关代次退役=no-op 不失效在飞轮（Y1）；失效身份分立（C2）：仅登记匹配才递增 epoch，仅槽位匹配=只清槽不取消当前命令（slot-only 分支公开 API 下不可达=C1 后不变量固化，无行为级测试/无变异杀伤，如实披露）**；屏障解除=宿主换代手续 close+reopen 非协调器自动） | dispatch-coordinator.test@反例7+S2-02+S2-Y1（无关代次 no-op）+S2-B2（槽位释放+旧续体不动新轮） | 🟡（逻辑面；退出确认/换代手续本体=进程面后续切片；「旧 timer/旧 Promise 失效」同归接线验收；变异：M-Y1 去 no-op→挂；M-C2 不可杀伤=分支不可达（披露）） |
| 响应失败（ok=false）与整轮超时分立（response-failure 屏障不动宿主处置；turn-timeout 委托 gate checkTimeout） | dispatch-coordinator.test@ok=false+整轮超时委托 | ✅（逻辑面；§169④ 两类超时分立已落） |

端到端面（真 spawn+真文件系统+乱序压力+连续派发）待 adapter 后续切片，仍 🔴。

### adapter 切片 3（风险序 3 前半：进程代次与交接隔离；TECH §136/§169④/§4；纯逻辑+注入端口；s3b 修复后 27 it；s3 首审 62/100→修复；s3b 86/100→S3B-01/02/03 修复）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| 代次路由（每个进程句柄的事件回调绑定 spawn 代次登记项；退役代次/非当前登记项的事件丢弃+审计；stopping 期仍路由=SIGTERM 宽限内晚到事件是旧轮最后事实不静默丢） | process-supervisor.test@旧代次事件丢弃+stopping 期仍路由（确认前路由/确认后丢弃两段断言） | ✅（逻辑面；变异：M-b 去路由检查→旧代次例挂） |
| 首字节身份复核（launched→stdin 首字节之间：当前代次仍拥有该轮+登记同 key+Gate 许可仍本轮 in-flight 才写；失效=invalidated/first-byte 不写+审计；S3-03：Gate 许可项可经排队微任务到达（协调器登记后/监管器复核前窗口，审读探针复现），非防御深度而是可达路径） | process-supervisor.test@首字节窗口失效（受控替身）+S3-03 Gate 许可复核（wrapCoord 在同一 promise 链登记后关 gate→invalidated 不写+gate=closed 审计） | ✅（逻辑面；变异：M-a 去复核→受控例挂；M-03 去 Gate 许可→S3-03 挂） |
| 背压零串扰（writeStdin await 期间换代/退出：写续体只及旧 handle——安全依据=handle 不重定向+退出确认前不开新写者（stopping 期旧进程可真实执行副作用）；新轮写新 handle；写完成复核仅审计不动作） | process-supervisor.test@背压窗口换代零串扰（双 handle 写序互斥断言+stdin-written-stale 审计） | 🟡（逻辑面；真背压（流控 highWaterMark）归真实现验收） |
| 串行化交接（retireCurrent：SIGTERM→宽限 sleep→SIGKILL→退出确认截止（F1 预算口径=S3-04 绝对截止：自 retire 起算 deadlineEnd，宽限被钳到预算内，每段只睡剩余量，晚醒不重置预算；S3B-01 默认时钟=单调 performance.now；回拨钳到 startMs=每段请求有界、不随回拨幅度扩张（故障时钟下总等待可退化至宽限+总预算，非严格总截止）；非有限按 0 对待不产生 NaN）；retireInFlight 按代次槽位（S3B-02：A 宽限内收口后 B 立即退役不被 A 旧续体挡，A 旧 finally 不清 B 槽位）；退出确认=协调器清登记+gate 三活相态（dispatching/in-flight/settling）之一则 close(generation-retired)→idle→spawnNext 才可用；退役幂等（S3-01）；stopping 期 spawn 拒） | process-supervisor.test@串行化交接+宽限升级 SIGKILL+S3-01+S3-02a/02b+S3-04a/b 预算（先断言 requests 再收口：截断 [1000,1]/晚醒 [2000,1]）+S3B-01×3（默认单调时钟分支/回拨钳位 [2000,5000] 非 65000/NaN 按 0）+S3C-01（默认分支选用 performance.now 且 Date.now 未被读取）+S3B-02×2（B 不被挡+三代次独立） | ✅（逻辑面；变异：M-d→串行化例挂；M-01 去幂等→S3-01+S3B-02 挂；M-02→02a/02b 挂；M-04 未钳版（deadlineMs-graceMs=-1000）→04a/04b+S3B-01 挂；M-04 钳1 版如实仅 04b+S3B-01 挂（04a 数学上必过——s3b 复审判定正确，04a 防护=未钳版+钳位断言）；M-05 去回拨钳位→S3B-01 回拨例挂；M-B2 回退全局布尔→S3B-02 两例挂） |
| 截止失败保守语义（deadline 到={deadline-exceeded} 保持 stopping 不裁决进程死活；晚到 exit 自动收口（同退役手续）→idle→可 spawn；审计 process-retired-late/retire-deadline-exceeded；spawn 内同步退出={spawn-exited} 已收口可重试） | process-supervisor.test@截止失败+晚到收口+spawn 同步退出 | ✅（逻辑面；变异：M-e 截止后假装收口→例挂） |
| 意外退出（running 中 exit→代次退役+gate closed(generation-retired)+协调器登记清+回 idle；屏障解除归宿主 reopen，监管器不自动 reopen；reopen 后新代次新轮可跑） | process-supervisor.test@意外退出+背压例前段 | ✅（逻辑面；变异：M-c 意外退出不退役→4 例挂） |
| retire 前置/重入（idle=no-process；交接中重入=stopping；spawn 失败回滚=回 idle 可重试（代次号已耗）；重复 exit 幂等（第二次只审计不重复退役））；黄项清理（stderr 按代次过滤+审计钩子抛错隔离+写拒绝透传不毁监管器） | process-supervisor.test@retire 前置/重入+spawn 失败回滚+重复 exit 幂等+stderr 过滤+审计隔离+写拒绝 | ✅（逻辑面；重复退役以 generation-retired 审计行恰一次断言） |
| 正常序两轮（防御不误伤：同进程两轮首字节各写各、事件路由带代次、stdin-written 审计） | process-supervisor.test@正常序两轮 | ✅（逻辑面） |

接线面（真 pi 子进程 spawn/真信号/真 waitpid 退出确认/真 stdin 背压/接管恢复流）仍 🔴，归切片 4 接线。

### adapter 切片 4（真进程接线：ProcessHost 适配+组装 RpcSession；4a/4b 两步；受控替身 52 it（process-host 17+rpc-session 26+file-durability 9）+协调器/网关纯逻辑测试不变；s4b 三阻断修复→s4c 93/100 受控面放行→4c E2E+恢复入口）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| 真子进程适配 writeStdin（S4-01 双门：成功=回调无错 cbOk 且背压释放 backlog（write 返 true 或 drain），true≠已写入；EPIPE/带错 destroy/背压中关闭/同步 throw→reject；多源竞态单结算；生命周期级 stdin error 吸收器（结算后迟到流错误不 uncaught）） | process-host.test@真背压（64KB）+S4-01a 短写异步 EPIPE（HoldStdin 受控回调：write true 但回调带错→reject）+S4-01b/c/d 背压中 destroy/close/同步 throw | ✅（变异：M-a 背压门→挂；**M-01 去 cbOk 门→S4-01a 挂**；PassThrough 小写在无可读者时回调立即兑现=测不了「true 但未确认」窗口→改 HoldStdin） |
| 真子进程退出证据（exit=唯一退出证据；S4-02 分立：pid undefined（ENOENT 进程未创建）→折算 onExit(null,null)；pid 在（kill EPERM 运行错误）→仅 stderr+句柄保留等真 exit；句柄级去重；退出后 writeStdin 拒；残尾 flush） | process-host.test@ENOENT 折算+S4-02 pid=4242 运行错误不折算（exits 空+句柄保留 stdin 可用+真 exit 上报一次）+exit 后写拒+残尾 | ✅（变异：M-b/M-02b 一律折算→挂） |
| 行分帧（StringDecoder 跨块多字节+\n 拆行；坏行分流 [stdout-nonjson]（Y2：type 非字符串同坏行）；stderr 透传；大块多行一次解析） | process-host.test@好行/坏行/撕裂+stderr+50 行大块+Y2 | ✅ |
| 回调隔离（S4-07：onEvent 消费者抛错→[handler-error] 诊断+同块后续行继续；onStderr/audit 抛错不阻断 kill/退出登记） | process-host.test@S4-07a 审计抛错不阻断退出登记+stop 仍发+exit 上报；S4-07b 同块 a 抛错 b 仍处理 | ✅（变异：M-07 重抛→挂） |
| stop 信号透传+未知句柄 no-op；closeStdin=stdin.end() 写完成面（finish 事件非 end） | process-host.test@stop+closeStdin | ✅ |
| FileDurability（S4-06+B3+R3：DurabilityFsPort 注入；部分写重试（**Y2：write 尊重 offset，逐字节无重写无丢字**）+零进展保护；**B3：接收判定在 append 入口同步完成，close 只拦之后调用，已接收任务照常执行（执行时仍拒越过 failed 尾）**；close 入队串行不抢先已接收 append；**close 不解锁 failed**，恢复须 markRepaired() 显式授权；closed 同步置位新 append 立拒；**R3：首次成功追加（datasync 后）同步父目录一次（文件名条目耐久）——失败=fail-closed 本次 append 拒；win32 无目录 open 跳过**） | file-durability.test@S4-06a 部分写撕裂尾+close 不解锁+S4-06b markRepaired+S4-06c close 串行+零进展+**S4-B3a 同段 append→close 已接收完成+S4-B3b 挂起中×2→close 两完成+Y2 offset 逐字节+R3a 目录同步恰一次+R3b 同步失败 fail-closed** | ✅（变异：M-c/M-06r→挂；**M-B3 接收回 run→S4-B3a/B3b 挂；M-Y2 offset 恒 0→Y2 例挂；M-d2 目录同步废→R3a/R3b/B3b 挂**；M-241 教训见上） |
| 组装 demux（type:"response"+id 字符串→readiness waiter 或 c<commandId>→onRpcResponse；agent_settled→onSettledEvent；其余→onPiEvent；未知 id response 丢弃；**回执不进事件流有直接观察断言**） | rpc-session.test@两轮正常序+探针回执不进事件流（routed 面直接断言） | ✅（变异：M-d 去归因→挂） |
| readiness（S4-03+**s4b B1**：探针写入/响应/超时/取消=同一有界启动操作；**总截止 timer 约束写+响应整体（响应先到不撤销）**；**取消口独立于响应标记（readinessCancels，响应已到仍可取消）**；finish 幂等单结算；写失败立即退役不等超时；超时自动 retire 返回 readiness-timeout；重试 gen2） | rpc-session.test@S4-03a write fail→800ms 内 SIGTERM+S4-03b write 挂起→超时重试 ready+**S4-B1a 响应先到+写永挂→总截止仍 readiness-timeout（非永久 pending）+S4-B1b 响应已到+写挂起→stop 取消口仍有效** | ✅（变异：M-e/M-03r→挂；**M-B1 去总截止→4 例挂（含 S4-B1a；1e12 版被 Node 鈇到 1ms=无效变异，须 2_147_000_000）；M-B1c 取消口废→S4-B1b/S4-04c 挂**） |
| 代次所有权（S4-04+**s4b B2**：ready 要求当前代匹配**且相态 running**（stopping/已退出不报 ready）；**start 返回 ready 前终窗复核**；探针成功侧 phase 复核；失败侧先复核所有权只退役自己代；启动中 stop→取消探针+旧 start=superseded 不双退；send 须 running） | rpc-session.test@S4-04a/b/c+**S4-B2a 响应后同段 stop 不返回 ready（P4）+S4-B2b 探针成功与返回间退出（P2）+S4-B2c 探针成功路径内同步退出（审计钩子窗口）** | ✅（变异：M-04/M-04b→挂；**M-B2a 删终窗复核→S4-B2c 挂；M-B2b 删探针侧 phase 检查→存活：终窗复核+取消口双层覆盖全部可观测路径=防御层，披露**） |
| 完成通知（S4-05+**s4b Y1/Y3/Y4**：onSettled 只从协调器确认路径发出（settled/accepted-and-settled/recorded-and-settled）；buffered/耐久挂起/**耐久 reject 零通知**；settledNotified 去重恰一次**且有界（插入序淘汏上限 1024）**；回调同步 throw+**异步返回 Promise 拒绝均隔离入审计**） | rpc-session.test@S4-05a 耐久挂起不提前通知+S4-05b 超时记录收口+S4-05c settled 先于 response+**S4-05d settled 先缓冲→超时记录收口（recorded-and-settled）通知恰一次+S4-05e settled 耐久 reject 零通知** | ✅（变异：M-05r→S4-05c 挂；M-05b 去重层存活=防御层披露；Y3/Y4 为边界/隔离加固，与 M-05b 同属防御层口径） |
| 意外退出重组装（exit→gate closed(generation-retired)+supervisor idle；start=reopen+spawn gen2+新探针；新代次整链路跑通） | rpc-session.test@意外退出后重开新轮 | ✅ |
| 双超时驱动（巡检 interval checkResponseTimeout+checkTurnTimeout（同步 void 签名 try/catch）；响应超时后 settled 仍收口；晚到 response=ignored-late 不炸） | rpc-session.test@响应超时不阻断收口 | ✅（变异：M-f 去巡检→挂；dispose() 清 interval） |
| stop（=cancelReadiness+retireCurrent：SIGTERM→退出确认 confirmed；confirmed 后 readyGeneration=null；**Y-C1（4c）：探针失败侧 phase≠running（宿主已 stop/retire）→superseded 不再发 readiness-timeout+retire=stopping——结果分类不依赖 exit 送达时序**） | rpc-session.test@stop confirmed+S4-04c+**S4-YC1（stop 后 exit 延迟不达：superseded+stopSignals 恰 1）** | ✅（变异：M-yc1 去 phase 检查→S4-YC1 挂） |
| 资源收尾（**Y-C2（4c+s4e）：dispose 清巡检+关耐久（可选 close 端口）恰一次；**并发 dispose 复用同一收尾 Promise（第二次 await 不早于第一次——close 挂起时不提前返回）**；进程退役独立走 stop（E2E 异常清理=running 先 stop 再 dispose）**） | rpc-session.test@Y-C2（close 计数恰 1+二次 dispose 幂等+stop 仍 confirmed）+**Y-C2b（close 手动挂起→p2 不提前返回+恰一次 close）**+**F3（close 回调里同步再 dispose→closeCalls 恰 1；对外 Promise 共享操作与结果非引用同一性）** | ✅（变异：M-d1 去 close→挂；M-yc2 复用废→两挂；M-f3 回退旧赋值序→F3 挂） |
| 帧渲染（send→{id:"c<N>",type:"prompt"}JSON 行；matchKey=matchKeyOf(text,[],ordinal)；commandId/intentId 递增） | rpc-session.test@两轮（帧 id 递增，runTurn 帧计数基准） | 🟡（steer/followUp streamingBehavior 归消费接线；attachments 归 UI 层） |
| **真 pi 进程 E2E（4c+s4e 补轮：PI_BIN 绝对路径+**exact 版本锁 0.86.1**；--no-extensions 受控环境（扩展 UI 面归后续 UI 接线）；真管道 readiness 往返/SIGTERM 退出确认；连续两轮+journal 耐久+通知恰一次+真实事件流；SIGKILL 意外退出→同会话重组装（持久 --session）+**会话历史恢复断言（口令化 TOKEN=PENGUIN-42，**限定 assistant 正文**（message_end+role=assistant+content[].type=text 段，谓词受控负例×4 在本文件）：gen1 捕获 assistant 正文答案+gen2 回同一口令=--session 历史恢复直接证据）**+恢复重放（打断轮=效果未知）+撕裂尾识别→截尾修复（**truncate 后 fsync 文件**）→续写；目录耐久 ensureDirDurable=dir+parent 两层 fsync（更深新建祖先条目归宿主部署，非任意递归））** | **tests/integration/pi-e2e.test.ts 7 it（PI_E2E=1 npm run test:e2e 显式跑，不进默认 npm test——防每跑真调 LLM；e2e-4/5/6=受控 node 子进程真管道无 LLM；**e2e-7 已迁入 PI_E2E 守卫组（s5e 意见：默认 npm test 不得真调 LLM——迁移后默认 7 skipped）**） | ✅（六项对照实际证据口径：①exact 版本②真背压（4MB 写挂起到子进程读）+双管道排空（两路各 4×64KB）+readiness 往返③连续两轮+耐久④SIGTERM/SIGKILL+EOF 未接（另明确不假装）⑤恢复重放+历史断言⑥dir+parent 两层目录 fsync+旧代迟到输出不污染新代（e2e-6 强制迟到：SIGTERM handler 写完回调才退，gen1-late 必达 toContain 断言非 best-effort；e2e-5 分通道：stdout 泵恰 4+stderr 泵恰 4+长度恒定；e2e-4/5/6 均补失败清理 stop/retire（e2e-6 清理注册提前到首次 spawn 前，覆盖等首事件超时窗口））；字节陷阱：撕裂尾修复 truncate 须用字节索引；spawn-exited 分支受控已证，真 spawn 失败=运维面；背压实测：128KB 一写即交（内核管道+libuv 队列），不足以证背压，4MB 才成） |

### adapter 切片 5①（闲置回收；idle-reaper.test 11 it+rpc-session 集成 5+5=10 it+e2e-7 真 pi；2026-09-26 GLM 实现；s5 复审四红修复 R1-R4+s5c B1/B2 见下）

| 面 | 覆盖 |
| --- | --- |
| 双条件连续计时 | **F-timer**（settled+登记表空才开始；断开清零；重新满足从新起点）+**F-registry**（活跃阻断/完成恢复；MapRegistry 幂等+未知 complete 无害）+集成「登记表活跃阻断→完成后回收」 |
| **S5-R1 活动吸收（采样间活动不沿用旧起点）** | noteActivity（有限门）+tick 吸收（lastActivity>idleSince→起点后移+idle-timer-reset-by-activity 审计）；活动源=send 受理/onSpawned 换代/notifySettled/**wrapRegistry（register/complete 同步转发后 note；宿主用 session.idleRegistry）**。测试=idle-reaper「S5-R1 吸收」（短登记两 tick 间→retired=0 从活动时刻重计满才回收）+rpc-session 集成「S5-R1 短登记经包装面起点后移」（中段 60ms 处 register/complete→150ms 未触发+吸收审计+重计后触发）+**s5c 三正例（短轮 short-turn/两 tick 间换代 generation/错开 spaced-task——活动后旧期限不沿用、自活动时刻满 100 才回收；complete 的 note 有独立载荷（t=90 register/t=95 complete→194 不回收 195 回收，M-wrapc 击杀）** |
| 优雅回收链 | **retireCurrentGraceful=EOF 优先**（closeStdin→EOF 宽限→自然退出；宽限超时升级 SIGTERM→SIGKILL→总截止，startMs 不重置 EOF 段计入总预算）+**S5-R2：SIGTERM 宽限锚定 TERM 发出时刻（termEnd=min(termSentAt+grace, 总截止)）——EOF 段消耗不再吃掉 TERM 自身宽限**（表驱动 4 行：默认 [3000,2000,5000]/EOF<grace [1000,2000,7000]/EOF>grace [8000,2000,1]/EOF 吃满 [10000,1,1]+信号 [SIGTERM,SIGKILL]；EOF 段内退 confirmed(idle-eof) 无信号+TERM 段内退 confirmed(idle-eof-escalated)）+集成「EOF 优雅回收无信号」「EOF 宽限超时升级 SIGTERM」+**e2e-7 真 pi**（闲置 2.5s→真 EOF 自然退出 idle-reap-done exitCode=0→**第一代唯一标记指令（OK-GEN1 第一代发送）在回收+冷启动后仍完整存在于会话文件=第一代历史保留直接证据（s5d 时序修正：标记不得在后代才发；口径=持久历史保存，不断言第二代内存上下文已加载）**+session 文件两代间 size 增长（辅助）→journal 保留→send 冷启动 gen2 原会话续跑+两组 settled） |
| **S5-R3 持久身份绑定** | 构造校验（piArgs 与 sessionFile 都缺→throw，不默认 --no-session）；默认 piArgs=["--mode","rpc","--session",sessionFile] 两代同文件；测试=构造拒绝 throw+默认绑定两代 spawnArgs 同一 --session 文件+无 --no-session；E2E 显式 piArgs 模式合法（含 --no-extensions） |
| 派发竞争闭合 | **F-recheck**（**S5-R4 重排：reaping 置位+idleSince 清空→audit(idle-reap-start)→最终复核（disposed/eligible+actFresh）→retireCurrentGraceful——取消路径也留 idle-reap-start 审计行（旧例断言已同步）**；**s5c B1：最终复核吸收 audit 回调内公开 wrapper 短活动对（register+complete 后 activeCount/gate/phase 均复原，仅 lastActivity 可辨）→取消+起点回退活动时刻（剩余期限延续；正式例=s5c-B1，M-B1 击杀）**；**s5c B2：到期 tick 的 audit 回调内同步调用公开 dispose（不 await）→急停段（同步清 interval+reaper 置废）取消尚未开始的回收（正式例=s5c-B2，M-B2-estop 击杀；契约=不得新发起，已在途退役不撤回）**；条件翻假→取消不发起；M-b/M-R4 落点）——send 先受理→isSessionIdle 断开不触发；回收先成立→send 撞 idle 分支冷启动或 not-ready（cause 结构化：冷启动失败=start 结果 kind/not-running） |
| 防重入/时钟 | **F-reaping**（挂起期 tick 跳过+idle-timer-start 审计恰一条；M-c 落点）+**S5-R4 三重入**（audit 回调内 register/dispose/isSessionIdle 翻假→均不发起：retired=0）+**F-clock**（非有限不设起点不触发；恢复有限从新起点计；M-a 落点） |
| send 冷启动 | 集成「EOF 回收→send 自动冷启动 gen2（journal 续写证明 durability 未关；回收≠销毁）」（M-d 落点）；查看不拉起（getState 无副作用） |
| 非 running 不回收 | **F-phase**（idle 无进程/stopping 均不触发） |
| 变异注 | M-a（时钟检查废→审计差异杀）/M-b（复核废）/M-c（防重入废→新起点审计杀）/M-d（冷启动分支废）/M-e（EOF 优先废→三集成例挂）全杀；**s5 修复轮：M-R1-absorb（tick 吸收废→idle-reaper 例挂）/M-R2（termEnd 锚回退役起点→表驱动挂）/M-R3（构造校验废→构造拒绝例挂）/M-R4（最终复核只查 disposed→三重入例挂）全杀；s5c 轮：M-B1（actFresh 废→s5c-B1 例挂）/M-B2-estop（急停段删→s5c-B2 例挂）/M-wrapc（complete 分支 note 删→spaced-task 例挂）全杀；M-R1-wrap（register 分支 note 单删）存活=**限定域冗余候选**（纯净 MapRegistry+成对操作下 activeCount 门+complete note 覆盖；不外推自定义 registry/异常时序——s5c 报告 §6.3 口径）** |

### adapter 切片 4c（恢复入口+黄项收口；recover.ts 受控 30 it；E2E 10 it 见上（含谓词负例×4）；s4f/s4g/s4h/s4i 补轮：F1/F2/F3+G1/G2+H1/H2+I1 已修）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| journal 读取分型（readJournalFile：末段无换行=撕裂尾 partialTail；完整行 JSON 损坏/无 t 字段=partialTail=false；**R2：行型必需字段 schema 验证——缺字段/错类型/未知行型拒收进 bad**；**F2：嵌套结构/集合元素校验（matchKey 三字段/ordinal 整数/payload 四字段+kind 枚举/attachments 元素/cleared 元素字符串/intervalEnd 两字段；嵌套非法拒收不进重放）**；空行跳过不判坏；好行保留） | recover.test@完整两轮+撕裂尾+坏行分型+**R2 schema 拒收（七断言：含 0.5/0 非安全正整数 s4g 裁量②）**+**F2 嵌套非法（七断言+bad.every 嵌套非法）** | ✅（变异：M-r1 去撕裂尾→挂；M-r5 schema 废→挂；**M-f2 payload.kind 嵌套检查废→F2 挂**） |
| **R1 损坏阻断（bad 非空→blocked=true+resumable 恒空；sending 残片可靠关联→并入 unknownEffect）** | recover.test@R1/R1b/R1c | ✅（变异：M-r4 blocked 清空废→挂） |
| **F1 不可关联/未裁决残片=恢复范围级阻断（s4g G1：**所有坏行默认未裁决证据**——含更早字节撕裂 { / \"t\":\"s / \"t\":\"sen、双 intentId 异值歧义、归属越出重放范围；修复后续读（RecoverOptions.blocked:false）也不解锁（resumeBlocked 分立呈现）；盘面修复与重发裁决分离；身份提取走**栈状态机受限结构扫描**（对象/数组期待态转移：键闭合冒号未现/字符串在非法位置/括号错配/栈空裸字符全阻断；转义键解码后同等识别 \\u0049d 变体）；**s4g G2 归因规则：raw 精确全等+恰一条匹配+目标在重放范围内**（≥12 前缀已删——唯一性不可证）；无效/歧义/重复裁决→忽略阻断保留，重复幂等）** | recover.test@**F1a（不可关联→resumable 空+呈现+精确归因后解锁）/F1b（转义解码关联）/F1c（不在场→保留）/F1d（更短残片 G1 探针）/F1e（双 id 歧义）/F1f（归属越界保留）/F1g（G2a 目标不存在不解锁）/F1h（G2b 同 raw 双残片歧义+重复裁决幂等）/F1i（H1 身份形态不可完全解释四探针：第二值截断/键转义变体/嵌套身份/无关字符串截断→全阻断）/F1i2（H1 受限结构正常面：截断在身份字段边界外仍唯一归因）/F1j（H2 冲突裁决整批预检两顺序恒阻断+同目标重复幂等合并）/F1k（I1 表驱动 16 截断点：普通键/转义键/嵌套键×键未闭/键闭无冒号/键闭+空白/冒号写值未写/值未闭/完整二次键全阻断）/F1k2（I1 正常面：转义键解码同等识别仍归因）/F1k3（纯嵌套身份键残片阻断——栈长检查定向）/F1l（J1 八负例：多根/member-end 或 key 位置开容器/数组根/尾逗号闭合全阻断）/F1m（Y1 词法：标量垃圾词/非法转义拒绝+数字截断与嵌入身份文本正常面）** | ✅（变异：**M-f1 不可关联不阻断→F1a+F1c 两挂**；s4g 轮 M-g1-short/M-g1-skip/M-g2-amb/M-g2a/M-g2-disk 五杀+M-g1-prefix 保守披露；s4h 轮 M-h1c（未闭合字符串跳余文）→F1i 挂；M-h2（冲突预检废）→F1j 挂；s4i 轮 I1 栈状态机：M-i1（未完成键当普通值跳过）→F1k 挂；M-h1a2（去栈长检查）→F1k3 定向击杀；M-h1c2→F1i+F1k 两挂；s4j 轮 J1/Y1：**M-j1a（容器开符号门废）/M-j1b（根数量门废）/M-j1c（尾逗号门废）→F1l 挂；M-y1a（标量词法废）/M-y1b（转义校验废）→F1m 挂**；s4k 加固：**M-ky1（K-Y1 容器门回退不含 value-required）/M-ky2（K-Y2 裸控制字符检查废）→K-Y1/K-Y2 例挂**；接受语言=JSON 标量前缀（数字字符集宽容+true/false/null 前缀），非身份字符串值/元素过转义校验+裸控制字符拒；数组 value-required 位置允许容器（尾逗号门不撤）） |
| 恢复判据三分档（unknownEffect=sending 无终态/超时未结算/已判 unknown/**sending+cancelled=副作用未知仍呈现**；resumable=非 sending 无终态且非 cancelled（取消是终局）且非残片并入；settled 计数；cancelled/delivered=终局不进两档） | recover.test@三分档+cancelled/delivered 终态+**sending+cancelled 拆例** | ✅（变异：M-r2 判据废→挂；M-r3 去 cancelled 过滤→挂） |
| 会话过滤（他 session 的 enqueue 不进重放；**前提演示：非 enqueue 行无会话身份，同文件跨 session 终态可越界——输入前提=每会话独立 journal 文件由组装层保证**） | recover.test@会话过滤+**前提演示** | ✅（前提由 RpcSession 每会话一 journalPath 结构保证） |
| 恢复不改盘面（只读呈现；撕裂尾修复/换段授权归宿主：截尾+（失败态另须）markRepaired） | E2E e2e-3（截尾修复流程落地+截后 fsync+**口令化两代一致性（TOKEN=PENGUIN-42，gen1 捕获实际答案+gen2 回同一口令）**） | ✅（E2E 接线证据非变异面） |

## adapter 切片②-c4（契约准备包：contracts/sanitizer/read-index/subscription-engine）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| 入站帧校验（判别优先级/写类短路 4405/版本 4403/分支互斥/逐字段） | contracts-validate.test（24 it）；M5/M6 杀 | ✅ |
| 脱敏向量（37 例人工 golden：路径/URL/PEM/凭据/RTL/零宽/NFC/截断） | contracts-sanitizer.test（38 it）；M1/M2/M3 杀；M4（凭据先检）防御冗余披露（白名单拒 [xxx] 语义等价） | ✅ |
| 读索引（append-only/waterMark/read 域/前缀投影/LRU 32） | 随引擎时序间接覆盖（换流判定归接线层测试） | 🟡 |
| 订阅引擎 13 时序（快照三页/幂等 2 页缓存/跳页/末页宽限 60s/缓冲回放/4431 超限/resync 超前/封闭态/交织序） | subscription-engine.test（13 it）；M7（幂等）4 挂/M8（barrier 冻结）6 挂/M9r2（编入序，需 drain(3)——批次满提前 flush 掩盖 maxFrames=2 窗口）杀 | ✅ |
| 快照字节预算（pageFrameBudgetBytes 200k/单事件 32k） | 引擎 PAGE_MAX=条数上限；字节装页归接线层（发送队列） | 🔴 归接线 |
| 连接级发送队列/在途限流/计算并发 | 未实现（归 WS 接线层） | 🔴 归接线 |

## adapter 切片②-c5（B01–B07 修复轮：引擎/索引/恢复/脱敏强化；42+21+18+34+6 it）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **B01 游标/缓存身份**（合法域 [1,H+1]：追平补页空页 done 进 live；空流 H=0 cursor=1 同；缓存匹配含完整游标域（错流同 seq 不命中→4404）；幂等=内容复用+**新 requestId envelope**（不回显旧帧整帧）） | subscription-engine.test ⑬⑭⑮+③⑤（内容幂等+新 requestId）；M-b01-cursor→1 挂/M-b01-cache→4 挂/M-b01-reqid→2 挂 | ✅ |
| **B02 索引不变量**（append 原子赋 seq 覆盖输入携带 seq；isPrefixOf=位置+locator+**内容摘要**（同位改写→换流）；scanDigest 源+定位+事件三要素；注册表 boot 隔离注入 ID；触顶 get 废弃换新流（有限出口）；LRU get 触达刷新；replace 换流） | read-index.test 6 it；M-b02-seq/M-b02-digest/M-b02-evict 各 1 挂 | ✅ |
| **B04 字节装页**（servePageFrom=字节+条数双上限：每事件 estimateHistoryEventBytes，首条必装保前进，超预算即止；done/expectNext 由实装末位决定——引擎状态不超前；live 分批分立常量 maxEventsPerLiveFrame=8） | subscription-engine.test ⑯（estimateEvent 注入 100k→2/2/1 三页）+⑬（8/8/4 三帧 liveSeq=[10,18,22]）；M-b04-bytes→1 挂 | ✅ |
| **B03 恢复证据快照**（captureRecoveryEvidence 修复前捕获（lines+bad+残片+归因修订+repaired+createdAt）；recoverFromSnapshot=快照语义裁决；**修复盘面后同一快照结论不变（防洗白核心）**；冷启动裸读假安全反例固化（宿主规则=unavailable no-evidence-snapshot）；evidenceHash=sha256 hex64 canonical；perIntent 穷尽表（settled/delivered/unknown/cancelled/not-evaluated 优先级）+provisional（unknown 由残片关联或人工裁决派生）） | recover.test 快照 4 fixture（34 it）；M-b03-resume/M-b03-prov/M-b03-cancel 各 2 挂 | ✅ |
| **B05 脱敏链重排**（完整语义单元先行：①PEM 整块（任意大写标签）②截断 PEM ③env 赋值 ④Bearer ⑤AKIA ⑥ssh-rsa ⑦userinfo URL ⑧URL 整体 ⑨POSIX≥2 段 ⑩Windows/UNC——env 值/公钥/带凭据 URL 不被路径规则撕碎；fnv1a64Hex=**UTF-8 全字节折叠**（charCodeAt&0xff 丢高 8 位→\u0100/\u0200 整类碰撞修复）） | sanitizer-vectors 41 例（userinfo 改整 URL 遮蔽/env 含路径/PEM CERTIFICATE/ssh 含斜杠/id 碰撞对 idDistinctWith）；M-b05-order2（env 挪 POSIX 后）→3 挂/M-b05-hash（单字节化复活）→1 挂 | ✅ |
| **B06 归因宿主锚**（assistant/toolResult 归属=consumed 宿主锚（anchorEntryId=consume 时 session 行号）+同 generation 锚窗口——不用跨文件扫描序；锚缺失→intentId:null 不猜；迟到更正不回改已发布） | 契约文档 §3.5 冻结（projection fixture 归接线面） | 📄 文档面 |
| **B07 文档/代码单模型**（RecoveryInfo 扁平单模型+PageOf 五字段+no-evidence-snapshot reason+未知 t 固定消息（不回显）+liveSeq=末项序号首项=liveSeq-events.length+1+live refSeq 显式 null+hello 版本层 4403 口径统一+file 正则精确） | contracts-validate 21 it（回显净化断言）+文档 python 单点对齐 | ✅ |

## adapter 切片②-c6（C5-01..07 修复轮：快照阻断/原始证据/整帧预算/积压门/状态门/归因前向/纯投影；435 it）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **C5-01 快照盘面阻断**（recoverFromSnapshot blocked=!repaired&&bad>0：未修复快照=diskBlocked+resumable 恒空；withRepair 标记后残片裁决；未修复原快照幂等不受修复影响；**recoveryAvailability 纯选择器**=可执行门（null/undefined→unavailable no-evidence-snapshot；有快照→available+evidenceHash hex64）；snapshotEvidenceHash 冻结编码（attributedFragments 排序）） | recover.test 快照①两段化+冷启动例选择器断言（34 it）；M-c01（blocked 恒 false 复活洗白）→1 挂 | ✅ |
| **C5-02 原始行证据+有限重扫**（append(source,locator,raw,event)：digest=fnv1a64Hex([source,locator,raw])——投影抹平型改写（原文改、脱敏后同）也触发换流；ScanRow.raw；同文件至多一次触顶换流，二次→FileOverBudgetError（宿主转 4402）；boot 默认生成器=crypto 16B hex 唯一（s-1 重放不存在）） | read-index.test 7 it（GPT 反例 raw 改写→false/未变→true；二次触顶 throw；默认 id 唯一）；M-c02（digest 退回投影）→1 挂/M-c03（二次门废）→1 挂 | ✅ |
| **C5-03 整帧预算**（servePageFrom bytes 起点=envelopeOverheadBytes(256)+逐事件+1 分隔；首条即超→显式失败 4431+关订阅（不静默大帧）；maxEventsPerLiveFrame 8→7=严格小于+信封余量） | subscription-engine.test ⑲（250k 事件→4431 关闭）+⑯（90k×2/2/1）+⑬（7/7/6）；M-c03r（首条无条件装）→1 挂 | ✅ |
| **C5-04 积压双门+编入序**（pushBacklog：条数>1024 或字节>262144→4431 关订阅（慢客户端显式化）；paging 期 status 帧同入 buffered（enterLive 整项回放——跨队列到达序，不再 status 抢先 history451）；drain 末尾超限帧→显式失败 error+close（不静默丢帧推进 liveSeq）；backlogBytes 队列清空重置） | subscription-engine.test ⑳（1025 status→4431）+㉑（451→status→452 到达序）；M-c04（积压门×100）→2 挂 | ✅ |
| **C5-05 状态门/幂等域/TTL**（追平补页仅 live 幂等——paging 期 H+1 跳页→4409（121..450 不被空页吞）；≠expectNext 未命中缓存→4409 统一（错流仍 4404）；PageCache 含 status 快照（重试不重调 status，statusVersion 冻结）；lastPageAt=页生成时刻锚定（缓存重试不续命）） | subscription-engine.test ⑭b（paging 跳 H+1→4409+仍 paging）+④⑱（4409 统一）+㉒（statusVersion 冻结）+㉓（缓存重试 59s OK/61s→4409 双路）；M-c05（追平限 live 废）→1 挂/M-c06（缓存现调 status）→1 挂/M-c06b（重试续命）→1 挂 | ✅ |
| **C5-06 归因前向区间+序前置条件（c7 收窄）**（session-attribution.ts：区间=[anchorEntryId 身份, intervalEnd{entryId,lengthHash}] 从锚向后含两端；终点哈希不符→null；嵌套内层优先；**多次 consumed=journal 序末项生效**；**序前置条件**：consumed 按 journal 序给定（撤销「任意置换不变」——⑦固化：逆序同锚会选错区间，m2→null 可见后果）；两源扫描调度置换不敏感（结构不变时）；宿主 entryId 唯一化入投影前） | session-attribution.test 9 it（⑦改序前置条件双断言：非重叠逆序恰同+同锚逆序选错）；M-a07（首条生效）→2 挂（⑦⑥） | ✅ |
| **C5-07 纯投影装页+单模型（c7 C6-02/C6-06 改版）**（projection-frames.ts：packPage 双上限+首条必装+单条超限→null+offset 域外→null；**buildRecoveryFrame=单 offset 驱动三视图**——perIntent 装页+整帧实测终判退末条循环，unknownEffect/resumable 从本页行按 verdict 派生（blocked 恒空表），total=全集计数，truncated/next 同步（旧「恒整表」被 3000×128B=488KB 反例证伪）；**buildSessionsFrame=limit 参数（默认 50 钳 200）+dirReliability 目录级输入**（页级=目录与条目保守聚合）+整帧终判） | projection-frames.test 7 it（+C6-02 三视图派生/blocked 空表/3000 意图 6 页每帧<200k 拼回全集+目录级 partial+默认 50+钳位）；M-c02（恒整表）→1 挂/M-c02b（不验预算）→1 挂/M-c06（忽略目录级）→1 挂 | ✅ |

## adapter 切片②-c7（C6-01..07 修复轮：整帧实测装页/恢复派生视图/重扫状态机/积压扣减/空流幂等/目录可靠性/文档单模型；441 it）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **C6-01 整帧实测装页**（servePageFrom：status 冻结先取→贪心粗估（仅快筛，首条必装）→**整帧 estimateFrameBytes 终判**（UTF-8 实测=JSON.stringify 口径）→超限退末条循环重测；退空仍有待发数据（from≤barrier）→显式 4431；expectNext/缓存/相态在核验通过后才提交；maxEventsPerLiveFrame=7（7×32k+信封<262,144） | subscription-engine.test ⑲改（收缩路径退末条成页+续页受页+首条即超 4431）+**C6-01 真实 500 中文×450 条**（每页整帧 ≤200k，450 事件不丢不重序连续，>3 页字节驱动）；M-c01（终判废）→2 挂 | ✅ |
| **C6-02 恢复单 offset 派生三视图**（buildRecoveryFrame：perIntent=recoveryPageSize(500)+整帧终判收缩循环；unknownEffect=本页行 verdict="unknown" 派生；resumable=verdict="not-evaluated" 派生（blocked 恒空表）；total=全集权威计数；truncated/next 与 perIntent 同步——3000×128B=488KB 反例闭合） | projection-frames.test：C6-02 派生视图例（本页含 unknown 行→派生视图含之/blocked 空表/末页 total 保持）+3000 意图 6 页每帧<200k+翻页拼回全集；M-c02（恒整表）→1 挂/M-c02b（不验预算）→1 挂 | ✅ |
| **C6-03 重扫状态机**（registry.get：仅**现流触顶且宽容额度已用**才 FileOverBudgetError；首次触顶→换流（额度消耗）；**新流在预算内 get 恒放行**（不因历史记录误拒空流）；LRU 淘汰重建=新流（再触顶因额度记录仍拒）；append 无硬门=宿主接线验收项（文档声明）） | read-index.test C6-03 例（换流后空流反复 get 同一实例+预算内填充照常+再触顶才拒）；M-c03（旧状态机恢复首查 Set throw）→1 挂 | ✅ |
| **C6-04 积压出队扣减+错误恰一份**（OutboxItem.est 入队固化；drain commit(bytes) 出队扣减（buffered→outbox 搬移不重复计）；稳态队列不误杀；flushLive 构帧先验字节→通过才 liveSeq+=（未交付不推进）；pushBacklog 超限=close(4431,emitError=true) 恰一份错误帧（清队列后唯一待发）；drain overBudget=单一错误出口（close 不另排）；4431 全路径 retryable=false 统一（订阅已亡，恢复=重新订阅） | subscription-engine.test C6-04 稳态例（2000 轮 status+drain(1) 恒 live 每轮恰 1 帧）+⑳（1025 门照旧）+⑲（retryable=false）；M-c04（不扣减）→1 挂 | ✅ |
| **C6-05 空流/尾补页幂等**（handle 顺序：closed→snapshotId→错流 4404→末页宽限→**缓存查找（先于 H+1 分支）**→H+1（仅 live：空补页走 PageCache——status 冻结+rememberPage+整帧预算检查；paging 期=4409 跳页）；startResync H+1 同路径（servePageFrom 空页 done）） | subscription-engine.test C6-05 例（H=0 首页空 done+liveFrom=1；外部 statusV 1→9 重试回冻结 1）；M-c05（缓存现调 status）→2 挂 | ✅ |
| **C6-06 sessions 目录可靠性+limit**（buildSessionsFrame(requestId,sessions,offset,listVersion,**dirReliability**,limit,budget)：limit 默认 50 钳 [1,200]；页级 listReliability=目录级 partial‖任一条目 partial 保守聚合；装页仍完整列表坐标系（total=全集）；整帧终判收缩） | projection-frames.test：limit=3/默认 50/钳 999 三例+目录级 partial 传播例（条目全 full→页级 partial）；M-c06（忽略目录级）→1 挂 | ✅ |
| **C6-07 文档/TEST-MAP 单模型九处**（§1.3 预算=理论估算+触顶状态机新口径+append 无硬门声明；§3.6 H+1 仅 live 受理+补页入缓存；§3.7 3b 三层装页（投影层截断/装页层整帧终判/硬帧层 4431）+7×32k 算式；§4 三视图派生注释+provisional 表对齐实现（耐久 sending/超时=false，残片/裁决=true）；§5.2 sessions 联合加页级字段；§5.6 分层装页规则；§5.7 汇总行同步；§3.5 归因序前置条件（撤销任意置换承诺）） | 文档 python 单点替换九处+session-attribution.test ⑦改序前置条件（M-a07 首条生效→2 挂） | ✅ |

## c8 段（R1/R2/R3——GPT c7 复审 84/100 三红修复）
| 面 | 断言来源 | 变异证据 |
| --- | --- | --- |
| R1 缓存信封预算（worst 克隆+缓存重发防御终判） | 「R1：缓存重发不因合法 requestId 变长击穿页预算」（GPT c9 反例原样固化：assistant role+e1..e120+119×500 中文+末条 325——first 119 事件 ≤200k 且 >190k、firstWorst ≤200k、retry64 仍 snapshot ≤200k、除 requestId 外相等、续页 p2=[120] 拼回全集）+「R1b：缓存重发防御终判（estimateFrame 故障注入）」（缓存生成后对 snapshot 帧返回 200,001→唯一 4431/false/closed/buffered=0/后续 drain 空） | M-r1-noWorst→新 R1 例击杀（旧 660 边界 fixture 下存活是历史事实：粗估在该 fixture 留 ≥144B 余量致变异不可观测；c9 反例几何下粗估 199,435<实测 199,938——粗估非保守上界，不可推广）；M-r1b-noCacheCheck→R1b 例击杀（防御故障注入，非默认估算器自然发生） |
| R2 失败清理不复活（drain 冲批失败丢弃已取出项） | 「R2：live 冲批失败」+「R2：history 冲批失败」（估算器 300k 注入→error 恰一份+phase=closed+二次 drain 空） | M-r2-unshift→2 挂 |
| R3 文档单模型+归因旧锚作废 | session-attribution.test「⑦b 同意图不同锚=最新 consumed 生效（[null,null,I,I]）」 | M-a07 首条生效→⑦⑥ 2 挂（c7 轮已验） |
| 测试精度（GPT c7 三问） | 稳态例改恒留 1 项待发；3000 意图改 128 字符 ID+estimateFrameBytes UTF-8 断言；limit 例改 300 条输入（999→200+续页 100） | — |

## adapter 切片③-3a（WS 网关受控接线：认证/入站管线/队列/订阅/恢复/心跳；w1 48→w1b 66→w1c 78→w1d 85 修复链后 **w1e 93/100 GO=3a 受控接线通过**；521 it）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **认证入站（hello/token/Origin/TLS/窗口/撤销）**（Origin 精确集合缺失默认拒；非 loopback 无 TLS 拒；token timingSafeEqual 摘要；protocolVersion≠1→4403；hello 前窗口可配帧数（默认 3；**w1c 勘正**：validateClientFrame 先行——非法帧即 4404 计数关闭，窗口豁免只对「形状合法但未认证」帧与认证截止分立）；热轮换 revoked 摘要关既有连接 4401） | ws-gateway.test A 组 10 it；ws-support.test token-auth 4 it（fromFile 缺失拒启/reload revoked=旧−新/失败沿用旧+乱序丢弃） | ✅ |
| **入站管线（二进制/262KB/JSON/未知 t/写类冻结）**（二进制→4404；超长→4404；非 JSON/未知 t→4404 计 3→close 1002；写类集 {prompt,send,stop,resume,takeover,write,execute,spawn,kill}→4405） | ws-gateway.test 入站管线例（二进制/非 JSON/未知 t 三连 4404→1002；prompt→4405） | ✅ |
| **requestId 在途门**（缺失/非法/^[-\w]{1,64}$/→4404；在途重复→4404；在途≥4→**4404**〔契约 §369：在途超限=4404 计数关闭，非 4429——w1 修复轮勘定〕；同步占位原子受理） | ws-gateway.test requestId 例（provider 永挂造 4 在途+重复 4404+第 5 个 4404） | ✅ |
| **订阅三分支+限额**（file FILE_RE+双根域→4404；init/resync 同 file 先退旧→4409 stream-replaced+引擎静默关；≥8 file→4429；page 无活动引擎→4404；全部出帧经 ConnectionQueue） | ws-gateway.test C 组 7 it（C13 首页+分页/C14 缺文件 4402/C15 live+status/C16 错流/C17 换流/订阅 8 上限 4429/unsubscribe+page 无引擎 4404；**w1e 勘正**：file 越界/非法名无 golden 输入亦无网关独立例——证据落点=校验器单测（tests/unit/contracts-validate.test.ts:42-44/61-64）+网关共享冻结校验器（接线推论）；golden 仅抽样互馈一致性；GPT w1e P-VALID 探针已在公开入口实测 4404） | ✅ |
| **列表/恢复（semaphore+证据快照）**（list-sessions offset/limit 校验→scanSessions→buildSessionsFrame（semaphore 并发 2 全局）；get-recovery 走证据快照 provider：null→unavailable(no-evidence-snapshot) 禁裸读盘面；有→recoverFromSnapshot→buildRecoveryFrame） | ws-gateway.test D 组 6 it（D18 无快照 unavailable/D19 available+hash 门/D20 阻断理由/D21 真跨页同版本/D22 死连接排队取消/D23 审计隔离；**w1e 勘正**：list offset/limit 无 golden 输入——证据落点=校验器单测+共享校验器接线推论；GPT P-VALID 探针 limit999 实测 4404） | ✅ |
| **心跳/寿命/清理**（idleMs 无帧→4432+close 1000；maxLifetimeMs→close 1000 lifetime-cap；传输关闭幂等清理 connectionCount 归零） | ws-gateway.test 3 it（4432/lifetime-cap/幂等清理）；ping→pong 经队列 | ✅ |
| **连接统一队列（B7-B12）**（1024 帧/1MB 双门拒收→beginTerminate 恰一次 4431 直发不占预算+close(4431)+限时 terminate；drain 批 16 帧/8ms setImmediate 让步；回调错误/同步 throw→终止；迟到回调不复活不重复记账；bufferedAmount 4MB 门；close(1000) 尽力排空） | ws-support.test ConnectionQueue 8 it（边界+1 拒/字节门/回调错误/迟到不复活/同步 throw/背压门/批量轮次/尽力排空/terminate 限时归 8 例内） | ✅ |
| **计算并发（全局 2）**（ComputeSemaphore limit=2 FIFO；排队 5s 超时；cancel 仅未开始生效；幂等 release 不多还槽） | ws-support.test semaphore 3 it | ✅ |
| **会话枚举（scanSessions）**（FILE_RE 过滤+截 1000=partial（**w1c 勘正**：total 为保守值——visitCap 流式截断时 total=已访问计数，非全集精确数）；每文件 openSafeFile O_NOFOLLOW+512KB 预算→partial 占位不吞文件；sanitize 先于截断；稳定排序 lastActiveMs desc+null 最后+file 字典序） | ws-support.test session-scan 5 it | ✅ |
| **安全打开（safe-open）**（O_NOFOLLOW→ELOOP/ENOTDIR=symlink；ENOENT=missing；同 fd fstat 非常规=not-regular；64KB 循环读超限即刻 too-large；resolveWithinRoots 根绝对+sep 整段边界） | ws-support.test safe-open 5 it（兄弟前缀拒/symlink/目录拒/too-large/闭环） | ✅ |
| **变异十二组（M-240 基线 09932d0+6f31a81）** | M-a1 token 门→2 挂/M-a2 Origin→1 挂/M-a3 窗口（首版存活→补 helloMaxFrames=1 例击杀）/M-a4 撤销→1 挂/M-c1 形状门（首版存活→补非法名例击杀）/**M-c1b root 门存活=防御层**（FILE_RE 句法上限定单段名，无路径可越界——真执行面=openSafeFile O_NOFOLLOW，如实披露）/M-c2b 4409 通知→1 挂/M-c3 八限→1 挂/M-d1 no-evidence reason→1 挂/M-d2 idle→1 挂/M-d3 lifetime→1 挂/M-d4 dup→1 挂/M-d5 4429→1 挂 | ✅（11 杀+1 防御层） |
| **w1 修复轮（48/100 十二必修全落；基线 44079a3+de715b3，变异 446af2c）** | W1-01 校验器单入口+错误矩阵（4403→close 1003/4405→1008/4404 计 3→1002；ping 无 requestId；requestId 安全回显仅已验形状；golden 同帧喂校验器与网关）/W1-02 认证截止独立 timer+握手滑窗限速（默认 10/min）+准入 16 连接（超→close 1013）+默认单调时钟/W1-03 在途双计数（send 回调兑现才还帧/字节）+cancelBySubscription/W1-04 HistorySourcePort 数据入口（load+observe→syncIndex 前缀/换流+schedulePump 排空泵；页完成/追平补泵两补强）/W1-05 原子切换（失败不退旧；成功通知 stream-replaced:${oldId} 撤旧帧）/W1-06 evidenceHash= snapshotEvidenceHash(snap) 入 adapter+请求 hash 门（旧 hash→4409 evidence-changed）/W1-07 断开取消排队任务（queued 即归零+grant 后存活复核）/W1-08 审计隔离（gateway safeAudit+token-auth auditFn）/W1-09 O_NONBLOCK（FIFO 立即拒 not-regular 不挂起）/W1-10 opendir 流式枚举+visitCap+保守 total/W1-11 listVersion=目录内容指纹（静态跨请求稳定，新文件才递增）/W1-12 ISO 时间戳+entryCount=header 外全部可解析行 | ws-gateway.test 28 it+ws-support.test 28 it（w1 修复面 3 例：FIFO/ISO/在途双计数+槽归还） | ✅ |
| **w1 修复轮变异（M-240 基线 de715b3）** | M-01 删 4403→close1003→挂/M-02 认证截止停用→挂/M-03 在途不计数→挂（ws-support）/M-04 数据入口空装载→挂/M-05 替换通知去旧 subId→挂/M-06 hash 恒零→挂/M-07b 传输关闭不取消→挂（D22 强化：排队即归零+provider 不被死任务调用；**closeConn 副本同代码为纵深防御，未单独杀**）/M-08 审计不隔离→挂（初版存活因 D23 假绿——重写后杀）/M-09 去 O_NONBLOCK→挂（FIFO 例）/M-11 版本无条件递增→挂/M-12 ISO 分支禁用→挂 | ✅（11 杀，07/08 披露） |
| **w1b 修复轮（66/100 八阻断全落；基线 6fa9875+后续变异强化 commit）** | B1 错流门双层（load 前 currentStreamId 门+syncIndex 后盘面改写二验，双道 4404 不退旧）/B2 换流观察器事件时取现行索引+统一 seq 规范化分发（外部 seq 丢弃）/B3 订阅提交点重验（await 后现查 current；**w1c 勘正**：同 file 并发双 init 后提交者替换前者=stream-replaced 通知恰一次（非 4429——4429 仅限 8-file 配额面）；先提交快照可能被 cancelBySubscription 撤走=观测语义）/B4 closeSubscriptionsFor overBudget 4402 逐连接关停/B5 listFingerprint 含 title.text+lastActiveMs 等全 DTO 面（同长改题→版本递增）/B6 握手滑窗有界（饱和期拒接不存时间戳）/B7 监督 tick 逐 sub engine.purge()/B8 恢复页冻结缓存（hash 门 4409 evidence-changed+LRU 8+连接关闭清理）；可信度修正：D23 权威 fromFile（audit 三参抛错）真认证后断言 welcome/golden 逐帧独立已认证连接/A2 补非白名单 Origin 例/D21 真跨页（55 文件→首页 50+次页 5 同版本） | ws-gateway.test w1b B 系回归 8 it（B2/B3a/B3b/B4/B5/B6/B7/B8；总 36 it）+ws-support 28 it=全套 510 passed+7 skipped | ✅ |
| **w1b 变异（基线 6fa9875+强化 commit；二轮强化后全杀）** | **M-B1 双层门（w1c 勘正限定）**：单拆任一道仅对 foreign 用例存活（另一道兜底）；盘面改写（load 期间 raw 变）时前门可过、后门是唯一防线（本审单拆后门已杀）——不能称两门全域互替；双拆→C16 挂=杀/M-B2a 观察期旧索引缓存（**w1c 勘正**：isPrefixOf 对 [source,locator,raw] 摘要比较——单改 raw 即触发 replace，改 event 不触发；首版测试假换流即因只改了 event 侧理解反了；变异锚点=observe 时预种 __idxCache+onAppend 取缓存）→B2 挂=杀/M-B2b 分发去规范化（直接 {event:row.event}）→B2 挂=杀/M-B3 提交点重验 void→B3 挂=杀/M-B4 overBudget 出口 if(false)→B4 挂=杀/M-B5 指纹回退只含 file\|sizeBytes→B5 挂=杀/M-B6 饱和期也 push→B6 挂=杀/M-B7 去 engine.purge 调用（初版三存活：①clearTimeout 假实现不摘句柄→auth 截止 cb 泄漏→closeConn 消 recentPages 假绿②pump drain() 首行也 purgeExpiredPages 掩盖③ping 帧→drain 同掩盖；修复=clearTimeout 真摘+pingMs=0+快照 [1]=监督 tick 单触发）→B7 挂=杀/M-B8 cached=undefined 禁缓存→B8 挂=杀 | ✅（8 杀+1 双层披露） |
| **w1c 修复轮（78/100 四反例全落；基线 566322d+d265cc1）** | R1 空流身份（registry.peek 纯查看——已装载空流 waterMark=0 同 streamId seq1 按 H+1 追平受理，foreign/未装载仍 4404）/R2 换流退役（syncIndex 非前缀分支：replace+重建后按【新】流身份 retireEnginesForFile——4409 stream-replaced:${旧subId}+engine.close+cancelBySubscription+releaseWatcher；旧引擎不再接收新流坐标事件；触发连接自身旧订阅同经退役）/R3 容量统一出口（三 append 出口 overBudget→closeSubscriptionsFor+INDEX_BUDGET sentinel→4402；registry.get 抛 FileOverBudgetError→sentinel；watchFile touch 改 registry.touch 纯 LRU；onAppend get 包 try/catch 不逸出）/R4 无 hash 读当前（缓存仅携 hash 请求可用；无 hash=现取 provider+覆盖缓存上下文）；测试收紧：golden 去 readyState 逃生逐条断言/B4 续页合法游标（旧 snapshotId 形态被校验器先拒=假绿勘正→4402）/B8 两页拼回 501 intentId 逐条唯一 | ws-gateway.test w1c R 系回归 7 it（R1a/R1b/R2a/R2b/R3a/R4a/R4b；gateway 总 43 it；全套 517 passed+7 skipped） | ✅ |
| **w1c 变异（基线 566322d；M-R3b 需 d265cc1 强化后可杀）** | M-R1 currentStreamId 回退 waterMark>0（空流失身份）→R1a 挂=杀/M-R2b 退役 no-op（const retired=0；首版 void 版残留 retired 引用属破损变异弃用）→R2a+R2b 挂=杀/M-R3 初装分支去 overBudget 门→R3a 挂=杀/M-R3b syncIndex 去 FileOverBudgetError→sentinel（**初版存活**：registry 首次宽容使 throw 路径第三连 init 才可达——R3a 补第三 init 后杀）→R3a 挂=杀/M-R4 缓存条件去 hash 限定→R4a 挂=杀 | ✅（5 杀，M-R3b 强化链如实记录） |
| **w1d 修复轮（85/100 两阻断；基线 766799b）** | D1 流身份静默丢失协调：read-index registry 加 onStreamDropped 钩子（LRU 挤出/宽容换流先通知宿主再移除）+gateway 钩子内 retireEnginesForFile(keep=null) 全退役（4409+撤帧+清 sub+releaseWatcher）+syncIndex 空索引装载与 onAppend 分发前身份防线（兜底协调漏网，幂等 no-op）+registryMaxStreams 可注入（受控替 33 活动流）；D2 4402 retryable=true（errFrame 按码判定；closeSubscriptionsFor 内联帧本就 true）；注释勘正（B1 门 R1 语义/listFingerprint 头注全字段/B2 用例 isPrefixOf 原理） | D 系回归 4 it（D1a 挤出协调/D1c+Q6 宽容换流钩子+迟到回调吸收/D2 改写重建出口【w1e 强化：逐请求 requestId 关联断言 w2/内联帧分立】/D2b 前缀增量出口【w1e 补——原 B4 例经 observe 触顶+重订阅走宽容换流，不能独证前缀增量分支】）；Q6 真观察面（成功订阅保留 sinks→触顶→保存的迟到 onAppend→FileOverBudgetError 吸收不逸出）；B8 改 perIntent.items 直拼两页 501 条+末页 next=null；R3a 删空观测尾段+补 retryable 断言；R4b 改名如实（offset0 现算，不证跨页拼回） | ✅ |
| **w1d 变异（基线 766799b）** | M-D1r registry 不发 lru 钩子→D1a 挂；M-D1s 不发 budget-swap 钩子→D1c 挂；M-D1g gateway 钩子不退役（const retired=0 干净 no-op）→D1a 挂；M-D2 errFrame 4402 回 retryable:false→D1c 挂（cap 断言打在 errFrame 出口帧；D2 改写重建例经 closeSubscriptionsFor 内联 true 帧仍过=独立出口语义一致，不误报）。**M-240 二踩事故（w1e 披露补记）**：首轮 M-D1r 在 commit 基线前跑，restore（git checkout）抹掉 read-index.ts 未提交改动——grep onStreamDropped=0 发现后原样重放补丁，先 commit 766799b 再重跑全部变异 | ✅（四杀） |
| **w1e 复审 93/100 GO（3a 受控 WS 接线通过；报告=audits/gpt-adapter-w1e-review-2026-09-28.md）+黄项清理** | GPT 独立验证：默认 32 流第 33 流挤出真反例复现+全量重扫/容量矩阵（初装三连/前缀增量/raw 改写/observe 触顶+宽容重建+迟到回调）/非容量构建失败（newId 抛错→4402 retryable=true 请求关联）/P-VALID 非法 file+limit999 公开入口 4404/四变异同型全杀/两道身份防线单拆存活=与纵深披露一致。黄项清理：R3a 改名（observe 面归 Q6）/D2 逐请求关联断言（w2 出口帧+内联帧分立）/D2b 前缀增量例补真/B8 全集对照（i-1..i-501 逐条删空）/MAP golden 归属勘正（校验器单测非 golden）/M-240 二踩事故补记 | gateway 47 it；全套 521 passed+7 skipped | ✅ |
| **真网络传输（ws 库 socket/真实 backpressure/Origin header/TLS）** | 归 3b 真网络分片（w0 对齐：3a 通过措辞=「受控 WS 接线通过」） | 归 3b-1 ✅（下段） |

## adapter 切片③-3b1（真 WS 传输适配层：WsServerAdapter/WsConnectionPort/WsTransportPort；3b-0 对齐 §IV.A/B/C 冻结签名；首提交 72/100 NO-GO→修复轮；tests/integration/ws-transport.net.test.ts 24 it + ws-gateway A5/A6 重写；repo 2a234ce+0ce90a6）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **①Origin 门+无 deflate（upgrade 前 HTTP 403）** | Origin 缺失/null/子串伪造（evil.example/localhost:3000 与 localhost:3000.evil.example）→裸 socket 探测 HTTP 403+审计 rule=origin；精确匹配→101；ws 客户端主动提 perMessageDeflate→响应头无扩展（未协商） | ①组 2 it | ✅ |
| **②TLS+代理头三分** | wss 正例：openssl 现场自签 CA（SAN=localhost+127.0.0.1）→客户端 ca=[cert] 信任→连接成功+meta.tls=true；XFP/XFF 伪造拒（trustedProxies=[]→头不生效 clientIp=socket+proxied=false）；可信代理正例（trustedProxies=[loopback]+XFF 203.0.113.7+XFP https→clientIp=203.0.113.7+proxied=true）；deriveConnMeta 头缺失保守回退 | ②组 4 it | ✅ |
| **③continuation+多字节 UTF-8 分界+控制帧** | 手造掩码客户端帧：text fin=0 碎在 😀（4B 码点）中间+插入 ping 控制帧+continuation×2（第二切点在「中」第 1B，非 𝄞）fin=1→服务端恰一条完整消息"前😀中𝄞后"；服务端 conn.ping()→ws 客户端自动 pong→onPong 触发 | ③组 2 it | ✅ |
| **④双门尺寸（真网关组合）** | 262,144B（padTo 恰满字节）合法放行；262,145B→网关 4404（传输 1MiB 内放行）；1MiB+1B 单帧→传输接收器 close 1009 先于应用层 | ④组 2 it | ✅ |
| **⑤真 send 回调+清理** | send done 回调真实交付后兑现一次（got=["hello-net"]）；关闭后 send 即拒（err）；客户端暂停读→串行 256KB×≤64 或本地 bufferedAmount>4MiB 即停→存在 pending done（doneCount<sentCount——证明本地发送回调未完成；不证明对端消费或生产侧 4MiB 门）→恢复读→兑现；64KB×32 持续读取全 ok（仅证批量 send 正常完成） | ⑤组 3 it | ✅ |
| **⑥token 三态（真 TokenAuthority 组合）** | fromFile 缺失文件→构造抛错（fail-closed 拒启动）；version:1 令牌文件→hello（含 protocolVersion）→welcome；错令牌→4401→close 1008 | ⑥组 2 it | ✅ |
| **⑦关闭竞态+句柄释放** | dispose→存量连接收 1001；同端口立即可再监听（句柄真释放）；dispose 幂等；upgrade 握手中途裸断→无崩溃+适配器仍可用 | ⑦组 2 it | ✅ |
| **变异六组（M-240 基线 2a05321+强化 commit）** | M-a 代理头无条件采信（trusted=true）→伪造拒挂；M-b Origin 前缀包含匹配（allowed.some(a=>origin.includes(a))）→子串伪造挂（**首版「allowed 子串包含 origin」方向存活=该方向不弱于已测输入的防御，如实披露**）；M-c 传输门放宽 4MiB→1009 例挂；M-d send 立即兑现（done(null) 脱绑 ws 回调）→暂停读例挂；M-e dispose 不收口存量→1001 例挂；M-f 403 静默不写响应→裸探测挂 | 六杀（M-b 两方向披露） | ✅ |
| **修复轮（72/100 六阻断 R01-R06）** | R01 回调隔离：message/pong/error/send-done 抛错→审计+连接存活（R01×2 真网络）+超限 error 隔离→1009 终局；R02 dispose 整体有界：GET→404+Connection:close、裸 socket 挂着→dispose<3s+**截止后强制销毁断言**（M-R02c 强化）、dispose 后 listen rejects、接收器 closeTimeout=closeHandshakeMs 统一（非响应客户端 1MiB+1→400ms 内 terminate）；R03 接收门冻结：maxPayload 选项删除（TS 面无绕过）；R04 binary→4403+close 1003（A5 重写+真网络）；R06 clientIp 接线 per-IP 限速（A6 受控+真网络 limit3/backoff260ms 恢复+serverBuildId 断言） | 修复轮新增 9 it+A5/A6 重写 | ✅ |
| **R05 假绿三修** | deflate：客户端 extensions==="" **且**裸握手带 Sec-WebSocket-Extensions: permessage-deflate→101 响应无该头（双证据）；双门：262,143/144B 合法 ping→pong 按 nonce 关联+errBefore 基线计数（262,145→恰一条**新** 4404）；token 真轮换：A/B 双连接在线→撤 A→applyTokenReload→A 4401+1008+B ping 存活→写损坏文件→reload **resolves** {changed:false}+审计 token-reload-failed keep=old→B 仍认证 A 仍拒；错令牌独立例（固定消息不回显） | R05 三测重写+2 新例 | ✅ |
| **3b1c 修复轮（84/100 两阻断+截止假绿）** | B1 封锁期不记账不延长（跨窗正确/错误令牌均不改 blockedUntil/strikes，到期恢复；A6 受控 now 注入）；B2 满表硬上界（1024/1025 全封锁→按最早到期显式淘汰+审计 auth-rate-table-evict-blocked，部分过期走非封锁淘汰分支）；B3 同轮 listen/dispose 交错→启动 Promise 显式拒绝「监听启动中止」+终态不复活+撞端口后 dispose 幂等；B4 截止测试重写=真 ws 客户端暂停底层读（close 握手永完不成）→观测服务端终局（close 1006+时延 300<elapsed<2400ms，closeHandshakeMs=400；30s 回归变异被杀）；夹具计时器清理（rawUpgrade/rawHandshake 成功路径 clear+unref，race 超时 unref——旧 rawHandshake 5s 后会销毁已返回 socket）；binary 真网络回归（真 adapter+真 gateway：已认证连接发二进制→4403+close 1003）；R01 error 例补 error-cb-error 审计+触发计数断言 | 修复轮净新增 5 it（unit +2=50/integration +3=27；GPT 3b1c 勘正：原记「+7」有夸大）；四变异 M-B1/M-B2/M-B3/M-B4(=close-slow 30000) 全杀（**M-B4 实际失败方式=4s 有界等待/vitest 5s 超时，非 2400ms 断言**——3b1c 勘正口径） |
| **3b1d 修复轮（88/100 C1/C2/C3）** | C1 listen 单槽所有权：启动中/已监听重复调用显式拒绝；成功/异步 error/同步 throw/dispose 取消四路恰一次结算+临时监听器摘除（listening 改显式监听器可被取消路径 off）；C2 A6-B2 重写=白盒真实容量断言（fill 后 size=1024；1025 后仍 1024）+淘汰对象=最早到期（t=1→until=600001）+部分过期与活动封锁共存（淘汰审计数不增+晚封锁 IP 正确令牌仍 4401）；C3 B4 补 try/finally（失败/超时路径恢复读+terminate 客户端）+显式 4s 有界等待；契约 §5.5 缺头回退分立（缺 XFF→socket 对端；缺 XFP→tls=false 不回退 socket TLS）+源码注释补代理覆盖/清洗条款；continuation 切点注释勘正（第二切点=「中」第 1B 非 𝄞）+64KB×32 例名改「持续读取」 | +3 it（integration 30）=554 总；变异 M-C1a（取消不摘监听器）/M-C1b（重复启动不拒）/M-B2-delete（去实际 delete 只留审计）全杀 | ✅ |
| **修复轮变异十二组（基线 2a234ce，全部 KILLED）** | M-R01a message-cb-rethrow→进程崩挂；M-R01b send-done 去隔离→挂；M-R02a listen 复活→挂；M-R02b GET 无处理器→挂；M-R02c guard 只 finish 不销毁→**首跑存活**→强化「截止后强制销毁」断言→杀；M-R03 maxPayload 4MiB→1009 例挂；M-R04 binary 4404→A5 挂；M-R06a 封锁检查禁用→A6+真网络挂；M-R06b 阈值+1000→同挂；M-deflate 启用压缩→双证据挂；M-bytegate 应用门禁用→B8+双门挂；M-rotation 撤销不关连接→D23+真轮换挂 | 十二杀（M-R02c 经强化） | ✅ |
| **遗留（3b-1 边界）** | clientError 吸收无专测；403 XFF 混合回程归 3b-2 复核；真进程/真源接线归 3b-2~3b-5 | 如实披露 | 🟡 |

## adapter 切片③-3b2a（真源 HistorySource：journal 投影+FileHistorySource+网关源事件接线+clientIp 映射；3b-0 §V 验收前四组+第五组盘面分；基线 9eb0bb4）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **投影器（journalToScanRows）** | enqueue→turn-enqueued{preview:SanitizedText{text,truncated},ordinal}；九 kind 全映射；response-timeout/clear 缺省 0；撕裂尾不发布/补全成行；坏行四型（解析失败/非对象/null/缺 t/未知 t）→journal-corrupt；preview 200 限+truncated 标；坏行占行号；100 行单调；同文本两行=两行；控制字符剥后进 preview；baseEvent 跨行不串扰 | history-projection.test 12 it | ✅ |
| **真源基线+四窗口（§V①）** | load=快照+observe 绑定+前缀追加逐行 onAppend；窗口①读取期通知→装载后 dirty 激活补扫（监视先于读取=窗口无漏）；窗口②激活前多次通知=一次重扫合并（reader 恰 2 调）；窗口③退役重挂=重扫后旧句柄关+恰一活跃（多轮无泄漏）；窗口④换代（stop+重 load）后旧句柄迟到通知不进新流 | history-source.test §V① 5 it | ✅ |
| **盘面分型（§V②）** | 同位置 raw 变（投影不变）→invalidate(rewrite) 非续读；变短→truncate+旧代已停（后续通知零事件）；同尺寸 replace（dev:ino 变）→replace；重复通知无变化→幂等零事件；同文本不同两行→两行各自 onAppend（去重键=locator+digest 非文本） | §V② 5 it | ✅ |
| **新旧流隔离（§V③）** | 读挂起期间换代：旧读恢复后丢弃（skA/skB 零 append+superseded 审计）；onAppend 回调抛错不逸出（源存活续推进+append-cb-error 审计） | §V③ 2 it | ✅ |
| **不可用分型+fail-closed（§V④）** | missing→deleted+观察全收口；too-large→scan-over-budget/open-denied+symlink+泛错→unreadable；watch 建立失败→load=null 不降快照；装载期早期 watch 错误→load=null（watch-error-early）；重挂失败→watch-failed+旧观察关；越界→outside-roots 拒 | §V④ 6 it | ✅ |
| **真盘集成（§V①⑤真 fs）** | 真装载/追加/截短/rename 替换重装载/删除 fail-closed；半行跨块（无换行不发布+补全发布）；UTF-8 字节级撕裂分两写（先半行不发布+补全成 sending 行）；坏完整行→corrupt 占位；maxScanBytes 读中硬限→null | 真盘 2 it | ✅ |
| **网关源事件接线** | onInvalidate(rewrite)→该文件订阅 4409 stream-replaced:{subId}+撤观察（sinks 删）+不自动重装载（loadCalls 不增）；重订阅→新 subId+~~内容寻址同 streamId~~（**3b2a 修复轮勘正：R4/P8 击穿——invalidate 即 registry.replace 废弃旧流身份，同内容重订阅 streamId 必变**）+load+1+观察重建；onUnavailable(deleted)→4402「历史源不可用（deleted）」retryable=true+撤观察+邻文件订阅不受波及（b 追加照常投递） | ws-gateway.test 3b-2 组 2 it | ✅ |
| **clientIp 映射（gatewayMetaFrom）** | 直连全链映射；可信代理派生 IP 透传（不退 unknown）；origin 缺失→undefined（网关默认拒路径） | ws-support.test 3 it | ✅ |
| **变异十组（基线 9eb0bb4 全杀）** | M-A1 去改写检测→rewrite 例挂；M-A2 去截短→2 挂；M-B 去身份→replace 挂；M-C missing 误映射→挂；M-D watch 失败降空快照（语义版 return []）→挂；M-E 追加全量重放（i=0 起）→8 挂；M-F 激活不收敛 dirty→2 挂；M-G 关观察跳过→2 挂；M-H 网关失效误走 4402→4409 例挂；M-I 撕裂尾发布→8 挂 | 十杀 | ✅ |
| **边界披露（3b-2a→2b/3）** | session 投影+双源合序未冻结=3b-2b；组装层 onConnection 实际接线（gatewayMetaFrom 唯一映射点已备）+慢客户端=3b-3；RecoveryEvidenceProvider typed=3b-4/5；真 fs.watch 时序稳定性以 FakeWatcher 替身驱动+真盘读路径全覆盖（真 watcher 端到端=组装后 E2E） | 如实披露 | 🟡 |

## adapter 切片③-3b2a 修复轮（GPT 首审 60/100 七必修；基线 6763d4f/B07+d11fa59/R1-R7）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **R1 扫描所有权（P3/P4/P9）** | load=活跃代 join（baselineRows 副本+增量由 append 补齐+load-joined-after-scan 审计）；双订阅共享初扫（双 sink 各自收同批追加）；release 配对（released-unobserved 审计）；初扫在飞 release→装载即弃 fail-closed（槽关+无孤儿句柄）；unobserve 后待配对引用保留；observe 无活跃代→null；网关级：load 挂起期间 transport 关闭→release 配对+observeCalls 无该文件；observe-missed→4409 显式退订（快照撤回不投死流）+observe-missed 审计+sinks 撤+release | history-source R1 组 7 it+ws-gateway +2 it | ✅ |
| **R2 单飞+折叠（P2）** | 重扫挂起期间通知折 dirtyPending（单飞串行——不并发第二扫）；挂起重扫返回旧前缀→不误判 truncate（identity+前缀双核对）+恰一次跟进补齐（reader 共 3 调=初扫+挂起重扫+跟进，3b2c-B7 勘正：原文「恰 2 调」不符）；读挂起期间换代旧读丢弃（await 后复核）；onAppend 抛错隔离（append-cb-error 审计+源续推进） | R2 组 4 it | ✅ |
| **R3 网关身份门（P5）** | 旧代三型闭包（onAppend seq99/onInvalidate/onUnavailable）全被身份门丢弃+新代 onAppend 照常收；retired 旧闭包迟到 onAppend→零新帧+连接存活（FileOverBudgetError 路径对退役回调结构性不可达=语义改进，D1c 尾段重写） | ws-gateway +2 it（R3 组+D1c 重标） | ✅ |
| **R4 失效废弃索引（P8）** | invalidate→registry.replace（旧流身份作废，同内容重订阅 streamId 必变——失效事件=权威信号，非内容寻址） | invalidate 例断言改 NOT toBe | ✅ |
| **R5 投影防御（P1/P1b/P6）** | 共享校验器 journal-schema.ts（recover.ts 逐字迁移+index 导出）；projectLine 接入——rawText:123/sending intentId:{} 等 14 型坏行→journal-corrupt 不抛；投影夹具合法化（sentAt 字符串/consumedLine 带 intervalEnd/clear 带 sessionId+cleared）；同权威对照（journalLineSchemaError 直测） | history-projection 重写 15 it | ✅ |
| **R6 watch 建立/重挂失败（P7）** | 初扫建立失败→load=null 不读盘；活跃期 error→先 rearm 再补扫；重扫后 rearm 失败→unavailable(watch-failed)；邻文件隔离（3b2c-B7 勘正：本组实 5 it） | R6 组 5 it | ✅ |
| **B07 脱敏二次方回溯（性能）** | 65KiB 无分隔符 9.3s→37ms；性能门 <500ms（text+machineId）；超长 env 键名前缀透出+值恒遮/深路径分段遮全跨度/scheme 界两侧/超长单段不遮/超长凭据 ID 哈希映射=6 新 golden 向量（47→53 总）。（**3b2c-B6 勘正：「全量词有界→总线性」不成立——PEM ①重复 BEGIN 仍二次方+替换缩短回拉界外尾；已改 maskPem 线性扫描器+尾随 \S* 整体消费，见 3b2c 段**） | contracts-sanitizer +7 it（49） | ✅ |
| **实现期自抓三 bug** | ①scanInFlight 注册晚于同步前缀→读取期通知丢失（窗口①抓到）→微任务化注册先于执行；②初扫 onError 绑早期路径→提交后活跃期错误走不到 rearm→slotError 阶段感知；③GenEntry.sinks 单值→P4 双订阅互吞→Set 扇出 | 修复轮内嵌（无独立 it，行为被 R1/R2 组覆盖） | ✅ |
| **变异七组（基线 d11fa59 全杀）** | M-R1 初扫去微任务化（注册窗口重开）→窗口①挂；M-R2b 在飞通知不折叠+无跟进→2 挂（**首版 M-R2 双 queueRescan 存活=被 rescanQueued 幂等性自然消解，非测试缺——如实披露**）；M-R3 onAppend 身份门移除→R3 例挂；M-R4 invalidate 去 registry.replace→断言挂；M-R5 投影去 schema 守卫→坏行例挂；M-R6 watch 建立失败静默降级→3 挂；M-B07 env 去界→性能门+超长键向量挂 | 七杀（M-R2 首版披露） | ✅ |
| **证据升级（R7）** | 首审探针 12/13 挂→修复后除 P10 外由真实测试复现；**P10 原夹具不真（首非 ASCII 实落 65650，非 65535 切点）——3b2c-B7 已按精确切点重写固化**；真盘组补 UTF-8 跨 64KiB 撕裂+maxScanBytes 硬限+初扫挂起 release；四窗口主证据仍 FakeReader/FakeWatcher 受控调度（真 watcher E2E=组装后） | 31+15 it 重写 | ✅ |

## adapter 切片③-3b2c 修复轮（GPT 3b2b 复审 70/100 七必修 B1-B7；基线 c436814）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **B5 投影额外字段（N7）** | baseEvent 不再 `in` 盲取——按行型传参只投影 schema 已验证字段；sending+generation 对象/数组/字符串/负数/非安全整数→event.generation=null；engaged/delivered/settled/cancelled 额外 generation→null；clear 额外 intentId 对象→null；enqueue/response-timeout 正控制照常投影 | history-projection +5 it | ✅ |
| **B6 sanitizer 补全（N8/N9）** | maskPem 线性扫描器（indexOf 单调推进：重复 BEGIN 无 END 512KiB 5.7s→27ms）；env/ssh/userinfo/URL/Windows+UNC 六规则尾随 \\S* 整体消费（已识别单元整体遮——替换缩短不再把界外敏感尾拉回预览）；golden 47→57（N8 两条/N9/超长 UNC/env 冒号续值/limit 恰含整替换/limit 截断/PEM 标签不匹配最近 END 胜/小写标签非 PEM/重复 BEGIN 无 END）；多规模阶梯性能门（32K→512K 各 <500ms+伸缩比 <64+成对 PEM 190KiB <500ms） | contracts-sanitizer +2 it | ✅ |
| **B1 槽位代次隔离（N1/N2/N6）** | LoadTicket 票据（release 先撤票→该 load 返 null）；pendingEntry 身份票据；releaseCarry 结转+下一代成功 load 吸收（网关每 load 恰一次结算⇒总量守恒）；earlyWatchErrors 每代清零；无主槽 maybeReapSlot 有界回收。反例：N1 失败后 release 不再永真拒装；N2 新初扫不带旧错误；N6 旧 release 不取消新在飞装载 | history-source +7 it | ✅ |
| **B2 源层回调身份门（N3/N4）** | watch/rearm 回调捕获 entry 本体（非 slot），不匹配即丢弃；FakeWatchHandle.rawNotice/rawError 直调**原始回调闭包**（绕过替身 closed 门——B7 ②「旧通知假打进」证据升级入仓）。反例：N3 旧代 rawError 不杀新代初扫（watch-error-stale-dropped 审计）；N4 旧代 rawNotice 不驱动新代重读（reader 调用数不变） | history-source +7 it（同上组分列） | ✅ |
| **B3 网关恰一次结算（N11）** | watchFile 返 consumedRef（本流 observe 是否消费 load 引用）；settleLoadRef 恰一次——已消费不 release（旧「observe 后又 release」=对本流双结算，多扣他方匿名计数→关流后 watcher 误归零）；rows===null 先于 st.closed 判（不释放未取得引用）；真源组合例：他方裸 load+网关订阅+关流→真观察句柄不归零，他方结算后才收 | ws-gateway +2 it（B3 双订阅恰一次+真源 N11） | ✅ |
| **B4 observe 同步终止（N12）** | unobserve 先赋值再复核 rec 在位；同步终止（onUnavailable/onInvalidate 摘 rec）→立即停孤儿 stop+observe-sync-terminated 审计；handleSubscribe 复核 st.subs→不发死快照不排泵。反例：无 snapshot 帧+4402+stop 恰 1 次 | ws-gateway +1 it | ✅ |
| **B7 证据真实化** | ①UTF-8 精确切点：中文首字节=绝对 65535、切 65536=半字符悬挂文件尾（构造自证 expect=65535；补全后逐字核 rawText 无损无 U+FFFD）——替换原不真夹具；②原始闭包直调入仓（B2 轮 rawNotice/rawError）；③TEST-MAP 行文勘正（R2 行串行语义+reader 3 调、R6 组 5 it、R7 行 P10 表述、B07 行线性声明）；④N13 真工厂：默认 RealWatcher（不注替身）对不存在路径 fs.watch 同步 throw→load=null+reader 零调用（杀窄 M-R6 静默降级变异）；⑤M6-oldread 存活披露：旧读结果替换新读计算在网关面无可观察消费者（同型风险由 superseded 丢弃+槽代次隔离覆盖），存活=证据边界非语义缺口；⑥B07 声明按 B6 勘正 | history-source 真盘组重写+N13 新 it | ✅ |
| **3b2d 复审结果** | 82/100 BLOCK（B4/B5 closed；B1/B2/B3/B6/B7 partial→C1-C5 再修复；五变异全杀；15 新探针 9 绿 6 红） | gpt-adapter-3b2d-review-2026-09-28.md | ✅ 已收 |
| **再送审最低条件对照（3b2b 报告原文）** | B1-B7 反例（N1-N4/N4b/N6-N9/N11-N13）固化转绿 ✅；原 615 及类型/lint 过（现 644+7，tsc/lint 0）✅；旧变异继续被杀（M-B07 复核 2 挂、M-R6 复核 1 挂）✅；M6 边界披露 ✅；真 N13 入仓杀窄 M-R6 ✅；精确 UTF-8 ✅；真实旧闭包入仓 ✅；B07 尾部不泄漏（N8/N9 向量）✅；多规模重复 PEM 测试 ✅ | 待 GPT 复审 | 🟡 |
| **变异八组（基线 fc4ab4f）** | M-B2a genNotice 身份门失效（取槽现态当本代）→**N4b 挂**（carry=2 同槽换代：旧闭包落在活槽上，身份门是唯一防线；N4 原 stopA 后 slot-reaped=死槽双重保护，杀不到）【3b2d 勘正：N4b 两笔 release=超额释放压力例，非合法两他方 load——合法路径同槽换代已由 D4（3b2e C2 组）独立固化并杀变异】；M-B2b genError 身份门失效→N3 审计断言挂；M-B3 settleLoadRef 去恰一次守卫→2 挂；M-B4 watchFile 去 rec 复核→1 挂；M-B5 投影回退盲取→5 挂；M-B6a ⑧规则去尾随 \S*→3 挂；M-B6b maskPem 无 END 不收口（break 跳内层）→重复 BEGIN 向量挂；**M-B1 存活（3b2d D1 反证后已撤结论）：原「同槽再起结构性不可达」披露被推翻——合法旧 held 引用（他方 load 加入活代→awaitingBind 跨代续存）使失败初扫后同槽再起真实可达，earlyWatchErrors 清零是必要防线而非纵深防御；D1 已入仓（3b2e C1 组）杀 M-C1a**；变异踩坑两记：continue 打在内层 for 上=死循环假杀伤（改 break）；vitest -t 过滤下替身空读队列让重扫挂起=假绿（N4 补 4 条备用读后暴露真根因） | 七杀一披露 | ✅ |

## adapter 切片③-3b2e 修复轮（GPT 3b2d 复审 82/100 五必修 C1-C5；基线 b892d0a）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **C1 生命周期收口（D1/D2/D14）** | 合法旧 held 引用（他方 load→awaitingBind 跨代续存）保槽——同槽再起真实可达：earlyWatchErrors+dirtyPending 两行初扫清零为必要防线（D1：B 失败初扫后同槽 D 代靠清零存活；D14：旧 dirty 不继承——新代 observe 激活无补扫、loaded 审计 dirty=false）；runRescan finally 补 maybeReapSlot（D2：挂起重扫终了收尾回收无主槽——句柄全关后 slot 不滞留 Map，slot-reaped 审计可达） | history-source +2 it（D1+D14 合并/D2） | ✅ |
| **C2 watcher 注册身份（D3/D4/D15）** | registerWatch：每次注册独立 reg（entry.regCounter 递增+activeReg 先于 watch() 生效）；genNotice/genError 提交期加 reg 门——同代退役句柄（rearm 后旧 handle）rawNotice/rawError 拒收（notice-stale-reg-dropped/watch-error-stale-reg-dropped 审计）。反例：D15 旧句柄 rawNotice→reader 调用数不变+无换身份误判；D3 旧句柄 rawError+新 watch 建立失败→当前观察不收 watch-failed+活句柄 1；D4 合法路径同槽换代（他方 load 保槽→A invalidate 关代→B 同槽）旧闭包双直调不扰新代 | history-source +3 it | ✅ |
| **C3 observe null≠已消费（D8/D9）** | watchFile 同步终止分支 return stop!==null——null=从未取得观察绑定→consumedRef=false→settleLoadRef 必走未消费 release（旧代码反推已消费=泄漏）。反例：D8 同步 onUnavailable+null→无死快照+4402+stop 零调用+release 恰 1（旧=0）；变体同步 onInvalidate+null→4409+release 恰 1；D9 load 本就 null（文件缺失）→不取引用零释放+observe 零调用 | ws-gateway +3 it | ✅ |
| **C4 POSIX 多段整体消费（D12）** | 规则⑨双分支：{2,32}段+尾随余段整体消费（尾类含 /——深路径>32 段一并吃尽）｜首段>255+≥1 后继段整遮（旧规则从后继段起匹配→前缀透出）；单段>255 仍不遮（声明语义保持）。golden 57→63（D12/末段254/255/256/首段超长+后继段/单段>255 截断）；类路径垫 300KB 4ms+单段长垫线性（50K→31ms/100K→64/200K→120/300K→185） | contracts-sanitizer +6 向量 | ✅ |
| **C5 核销表改写** | ①撤 M-B1「结构性不可达」结论（见 3b2c 变异行勘正）；②N4b 超额释放压力例如实标注+合法路径 D4 固化；③「无主槽有界回收」按 3b2f R1/R2 收窄：D2 只证在飞重扫终了收尾回收成立；Map 按文件名盲删可被审计回调重入 load 删新槽（GPT F10）——3b2g R1 身份门后重新成立（F10 固化+M-R1 杀）；④已认可项不重开（UTF-8 65535/R2 串行/R6 五例/D5 emoji）；⑤M4≠M-B07/M-R6 术语分立（M4-retire=observe unbind 闭包 no-op 变异） | TEST-MAP 本节+3b2c 行勘正 | ✅ |
| **变异七组（基线 b892d0a）** | M-C1a 去 earlyWatchErrors 清零→D1 挂；M-C1b 去 finally maybeReapSlot→D2 挂；M-C1c 去 dirtyPending 清零→D14 挂；M-C2a 去 genNotice reg 门→D15 挂；M-C2b 去 genError reg 门→D3 挂；M-C3 同步终止回 return true→3 挂【3b2f 归属勘正：3 挂=既有 R1 observe-missed（缺 4409）+D8 unavailable+D8 invalidate 变体（release 0 应 1）；D9 仍通过——ws-gateway watchFile 的 observe 分支统一返回值（return stop !== null；符号锚，行号随代码漂移）是整个分支的返回，非仅同步终止内支】；M-C4 规则⑨回旧形→向量 5 挂。七杀零存活 | 七杀 | ✅ |

## adapter 切片③-3b2g 修复轮（GPT 3b2f 复审 89/100 三必修 R1/R2/R3；基线 0b62eff）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **R1 槽回收 Map 身份门（F10）** | maybeReapSlot 删除前验 `slots.get(file)===slot`——审计回调（公开面）在两次回收间重入 load 建新槽 B 时，旧回收按文件名盲删会删 B（B load 成功却 observe=null、句柄无法配对释放）；身份不匹配=幂等 no-op 不审计。反例 F10：首 reap 审计回调内同步 load(B)→旧 release 第二次回收不动 B→B load 非 null+observe 绑定成功+句柄全关 | history-source +1 it（R1/F10；harness 加 onAuditLine 重入口） | ✅ |
| **R2 注册返回后身份复核（F4/F5）** | registerWatch 在 watch() 返回后复核（reg===activeReg 且 entry=提交/在飞现役且未死）——不匹配即关返回句柄返 null，调用方不推送不 splice：嵌套建立失败（F4）旧句柄推入已关代=孤儿；嵌套建立成功（F5）外层 splice 关掉真正的新注册+唯一开放句柄通知被 reg 门误拒。反例 F4：watch-rearm-superseded+无孤儿（activeHandles=0）；F5：closed=[T,T,F]+superseded+#2 闭包直调拒+跟进重扫交付追加（append 送达 sinks 证明 #3 链活）。替身=FakeWatcher.errorOnRegBeforeReturn（句柄建立后返回前同步 onError；failNestedSetup 由探针现场置位驱动嵌套建立失败） | history-source +2 it（R2/F4、R2/F5） | ✅ |
| **R3 披露同步** | ①N4b 测试源码注释勘正（「他方两笔未配对引用」→「超额释放压力例——单次 load 已被 observe 消费后再放两笔；合法路径由 D4 固化」）；②M-C3 三挂归属勘正（见 3b2e 变异行）；③无主槽回收行按 R1/R2 收窄后本节重新核销；④D14 审计断言定位恢复代（auditsBeforeB 锚+切片——全量扫描可被首代 loaded 满足）；⑤sanitizer 顶部注释对齐整体消费语义（去「链式匹配分段遮」旧词） | TEST-MAP+测试源码+sanitizer 注释 | ✅ |
| **变异两组（基线 0b62eff）** | M-R1 去 Map 身份门→F10 挂（1 failed）；M-R2 去返回后复核块→F4+F5 挂（2 failed）。还原后 48/48（全套 661+7） | 两杀 | ✅ |

## adapter 切片③-3b2b①（session-projection 纯函数：session JSONL→ScanRow[]；基线 c5b65b7）

| 断言面 | 用例 | 状态 |
| --- | --- | --- |
| 行分类三分（message/corrupt/unknown）+空行=corrupt+final 基础映射 | session-projection.test.ts 基础/缺 id 角色非法/空文本 | 🟢 |
| locator=字节偏移（多字节行 UTF-8 推进）+同行多事件有序 | session-projection.test.ts locator | 🟢 |
| 撕裂尾不发布（末段无 \n）；补全后自然编入 | session-projection.test.ts 撕裂尾 | 🟢 |
| user 三元组匹配：ordinal 按序消费（第 n 同键↔第 n enqueue）+generation 携带+附件身份不误配 | session-projection.test.ts 三元组/附件 | 🟢 |
| 区间归因：正确哈希成区（含锚 user 回退）/伪终点不采信/孤儿 toolResult=null | session-projection.test.ts 区间三用例 | 🟢 |
| toolCall 块分立：块键 entryId:blockIndex 0 基+本体先行 | session-projection.test.ts 块分立 | 🟢 |
| final 全表（length/aborted→true；无 stopReason assistant→false；toolResult/system 补全角色） | session-projection.test.ts final 全表 | 🟢 |
| 预览脱敏（[env] 遮蔽）+200 截断 | session-projection.test.ts 预览 | 🟢 |

- 变异七杀（基线 c5b65b7）：M1 撕裂尾边界/M2 ordinal 不递增/M3 孤儿规则删/M4 final 反转/M5 blockIndex 不增/M6 locator 行号化/M7 lengthHash 空——全部 KILLED（python 锚点替换+count 断言+git checkout 还原；还原后 13/13 绿）。

## adapter 切片③-3b2i 修复轮（GPT 3b2h 复审 95/100：R1/R2 closed，唯一阻断=H-C5-01 N4b 披露小补；基线 847aa84）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **H-C5-01 N4b 定点修** | 撤 3b2g 误增的第三笔 release，回原两笔超额释放；注释同步「carry=2，B 的成功 load 只吸收一（剩 1 保槽）」。计数证据：测试尾探针笔后审计序列恰 [carry=1, carry=2, carry=2]（endsWith 匹配——审计行带时间戳+history-source 前缀）；三笔超额版会现 carry=3 即挂——只改文字不改计数必被抓住 | history-source N4b it 内（carry 计数三断言） | ✅ |
| **H-C2-02 建议：H5 入仓（生命周期半边独立杀伤）** | 注册#2 建立并留档后、返回前最后订阅 stop（entry 关闭）——无嵌套注册 reg===activeReg 恒成立，唯一防线=复核块生命周期半边。断言：regCount=2（无嵌套，区别于 F4/F5）+activeHandles=0（仅留 reg 门的窄变异下=#2 追加进已关代=孤儿 1）+无 watch-failed+watch-rearm-superseded+slot-reaped。替身=FakeWatcher.callOnRegBeforeReturn（{atReg,fn} 一次性同步钩） | history-source +1 it（R2/H5） | ✅ |
| **变异复杀（基线 847aa84，独立 git archive 副本）** | M-life-only（3b2h H-C2-02 原网存活者）：复核块仅留 reg 门、去生命周期半边（entry 归属+disposed/state）→文件域 1 failed（H5）+全仓 661 passed+1 failed（H5）——原网三杀一存活→补杀闭环；与 M-reg-only（GPT 3b2h：仅留 reg 门对侧，F5 杀）合成「两半边各有独立入仓证据」 | 一杀（存活者补杀） | ✅ |
| **锚点清理** | TEST-MAP 3b2e 变异行「:740」陈旧裸行号→符号锚「ws-gateway watchFile 的 observe 分支统一返回值（return stop !== null）」 | TEST-MAP | ✅ |


## adapter 切片③-3b2b②+③（read-index 分流前缀/continueFrom+DualHistorySource 组合器+网关接线；基线 1855268+7c5d1ba）

| 断言面 | 用例 | 状态 |
| --- | --- | --- |
| 分流前缀：交错编入（journal/session 到达序交错）后固定源序重扫=前缀成立（旧逐位比对误判换流）；同源改写→非前缀（两源各杀）；单源截断→非前缀 | read-index-dual.test.ts ×3 | 🟢 |
| continueFrom：journal 余量先 session 余量后确定性续编；续编后与全量重扫互为前缀（幂等）；违约调用（未过前缀）不抛不崩 | read-index-dual.test.ts ×2 | 🟢 |
| DualHistorySource：load 合并序 journal 先 session 后+归因端到端（session user 事件带 intentId/generation）；撕裂尾 enqueue 不参与匹配 | dual-history-source.test.ts 合并/撕裂尾 | 🟢 |
| journal 子源失败→整体 null fail-closed；session 缺失→journal-only 降级（审计 session-missing）；无 sessionFor→journal-only（no-session-mapping）；session 越界→降级 | dual-history-source.test.ts ×4 | 🟢 |
| 归因读通道：reader 注入失败→缺证+attribution-unreadable 审计；无注入→真盘 RealReader 兜底（冒烟） | dual-history-source.test.ts ×2 | 🟢 |
| observe 双子源：journal 追加→onAppend(journal 行)；session 追加→onAppend(session 行)；盘面换代（identity 变）→invalidate("replace") 转发（watch 瞬错=重挂自愈不产失效——设计面）；release→双源 watcher 全关 | dual-history-source.test.ts ×3 | 🟢 |
| 网关接线 D1：双源快照 barrier=两源合计+journal 前 session 后+归因 intentId 直达客户端 | ws-gateway 3b-2b③ D1 | 🟢 |
| 网关接线 D2：live 追加双源各自到货→history 帧续投+不换流（无 4404/4409） | ws-gateway 3b-2b③ D2 | 🟢 |
| 网关接线 D3：session 盘面换代→4409 退役旧订阅+新订阅新 streamId（换流） | ws-gateway 3b-2b③ D3 | 🟢 |
| 网关接线 D4：session 缺失→journal-only 快照（非 4402，审计 session-missing） | ws-gateway 3b-2b③ D4 | 🟢 |
| 网关接线 D5：journal 读失败→4402 retryable（session 在也不能洗白——事实源 fail-closed） | ws-gateway 3b-2b③ D5 | 🟢 |
| 网关接线 D6：交错 live 追加后退订→二次装载余量（两源各+1）→分流前缀成立不换流+continueFrom 余量无重无漏（位置续编会把 s2 重复编入+漏 j3→seqs/dup 断言挂） | ws-gateway 3b-2b③ D6 | 🟢 |

### 3b-2b 修复轮（GPT 65/100→；repo 1684b89+70e5b7c）

| 断言面 | 用例 | 状态 |
| --- | --- | --- |
| R1a 装载等待窗 journal 追加→吸收增长返 [J1,J2,S1]（无 load-revalidate 审计；去复核门则返旧快照漏 J2 挂） | dual 3b2b-R1/R2 R1a | 🟢 |
| R1b 等待窗 journal 换代（identity 变）→重试环重装新代内容+审计 journal-generation-lost | dual 3b2b-R1/R2 R1b | 🟢 |
| R1c sessionFor 同步抛错→journal 引用精确回滚（watcher 句柄 0，无孤儿）+审计 session-load-threw | dual 3b2b-R1/R2 R1c | 🟢 |
| R1b 观察面：journal 活跃代已失效→新 observe=null（session 绑定成功不得掩盖事实源失效；旧代码联合 stop 非 null） | dual 3b2b-R1/R2 R1b-观察面 | 🟢 |
| R2 journal-only 降级→双源恢复：load 后补接 session 观察（同 sinks，session-attached-late 审计）+后续 notice 直达 | dual 3b2b-R1/R2 R2 | 🟢 |
| R2 网关协同：journal-only 订阅期 session 恢复+二次装载——续编行恰一次达活跃订阅 A（load 分发）；B 走快照不重发；后续 watcher 通知不重复 | ws-gateway D7 | 🟢 |
| R3 journalAttributionOf：坏 enqueue/consumed 行（缺字段/非法 generation/坏嵌套）不采信+rejected 计数；非 JSON/其他行型不计；撕裂尾不参与 | session-projection R3 | 🟢 |
| R3 dual 面：journal 坏行→attribution-schema-rejected 审计+session 投影 intentId=null（不拿 BAD 归因） | dual R3 | 🟢 |
| R4 真实图片块（data 字段）身份=sha256 前 12hex：同图同 id 按序消费；异图不误配（旧代码无 id/url 全塌缩同 id） | session-projection R4 | 🟢 |
| R4 多重集换序等价（AB=BA 同组按序）；未知块 u: 前缀不可匹配写侧 12hex 面；键序规范化确定性 | session-projection R4 | 🟢 |
| R6 stopReason=length→textPreview.truncated=true（短正文也置位）；非 length 对照 false；空正文占位 {text:"",truncated:true} | session-projection R6 | 🟢 |
| R5 完整行含非法 UTF-8（字节 0xff）→read-failed fail-closed（有损解码等价类假前缀封死）；撕裂尾非法容忍可读 | history-source RealReader R5 ×2 | 🟢 |

- 变异七杀（基线 70e5b7c；/tmp/mut-3b2b-fix.py python 锚点+count 断言+git checkout 还原）：M-R1 去装载复核→1 挂；M-R2a 去续编分发→1 挂（D7）；M-R2b attachSessionIfObserved 去 session 绑定→1 挂；M-R3 归因去 schema 门→2 挂；M-R4 附件去 data 分支→2 挂；M-R5 去 U+FFFD fail-closed→1 挂；M-R6 去 length 合并→1 挂。还原后 709+7 全绿。
- 设计披露：R5 修复选「fail-closed」而非整文件双指纹接线（journalFingerprint/sessionFingerprint 字段仍预留未接线）——接受面上行字符串与字节序列一一对应，digest 字符串比对获得字节级判等力；双指纹身份面延后 3b-3 生产组装再定（已在 PROJECT 登记）。

- 变异九杀（基线 1855268/7c5d1ba；python 锚点替换+count 断言+git checkout 还原）：
  - ②：M1 分流前缀（M1 首版「journal 侧换键」变异体语义等价 SURVIVED——sourceIsPrefixOf 内部本就按源过滤，已披露；重设计 M1b=退回旧逐位比对）→2 挂 KILLED；M2 去 digest→2 挂；M3 续编序反→1 挂；M4 撕裂尾参与归因→1 挂；M5 合并序反→1 挂；M6 journal 不 fail-closed→1 挂；M7 归因键路径错（session 子源 journalFor 误用 opts.journalFor）→5 挂；M8 归因 reader 无注入返回空（丢归因）→1 挂。
  - ③：M-G1 syncIndex 前缀分支退回位置续编→D6 挂 KILLED。还原后 696+7 全绿。
  - 踩坑（流程）：syncIndex continueFrom 编辑未随 1855268 提交（提交在前编辑在后）→变异后 git checkout 还原到无修复 HEAD→D6 在旧代码上跑「假挂/假绿」——修复重应用+先提交基线再变异（M-240 同型：变异前必须有干净基线 commit）。

## 3b2c-fix1 修复轮（GPT 72→修复；基线 9d7e378；721+7+tsc0+lint0）

| 断言面 | 测试锚点 | 状态 |
|---|---|---|
| F1-01 session 缺失等待窗内 journal 合法追加→降级出口也复核：返回吸收增长的 cur=[J1,J2]（不透旧快照 [J1]→假 4409+J2 丢）；session-missing 审计；合法增长不触发 load-revalidate | dual 3b2c-fix1 F1-01 | 🟢 |
| F1-02 late-attach 引用 credit：attach 消耗 B 的 session 装载引用记账（credits=1）；B release 走 release-session-credit 跳过 session 侧一次（不双扣→无 carry 误关新 watcher）；C 装载+观察后 session 事件仍直达；收尾双源句柄全关+无 released-unobserved-carry 审计 | dual 3b2c-fix1 F1-02 | 🟢 |
| F1-04/F2-02 同 sinks 合法重绑（各自有 load 配对）：包装身份隔离（FH sinks 集按 wrap 对象增删，共享 watcher 引用计数下 1 句柄 2 ref）；重叠期追加=两注册各交付一次（多注册语义，fix2 版补断言）；旧 stop 迟到只关旧注册（句柄仍活，新注册续收恰一次）；全解绑后需新装载引用再绑（引用纪律） | dual 3b2b-fix2 F1-04/F2-02 | 🟢 |
| R1 耗尽：三窗口全换代（每轮窗口内换代+重绑当前活跃代+通知失效）→有界重试耗尽→load=null+load-revalidate-exhausted 审计 | dual 3b2c-fix1 R1-耗尽 | 🟢 |
| F1-05 完整行含**合法** U+FFFD 字符（EF BF BD）→可读不拒（字节级判据只拒非法编码，不误杀合法字符值→不 4402 整文件） | history-source RealReader 3b2c-F1-05 | 🟢 |
| F1-03 网关：journal 空文件（H=0）A 先订阅（barrier=0）；session 出现后 B 装载→空索引分支也分发既有引擎→A 恰一次收到首批行；B 走快照；无 4404/4409 | ws-gateway D8 | 🟢 |
| §8-D9 恢复后新追加（notice 路径 u3 恰一次 seq 不重）+B 退订再开（B 退订重订快照 barrier=4 全量、A 不变——共享观察未归零，**非真全退**；真全退=3b2b-fix2 节 D10）+重复装载（第二次订阅前缀成立不换流无重复） | ws-gateway D9 | 🟢 |
| Y2 归因匹配域=进入和解的意图：abort/takeover 合法行不消费 ordinal（rejected=0 但不入 enqueues）；端到端 user 仍归因真 prompt 意图 | session-projection 3b2c-Y2 | 🟢 |
| Y3 SHA-256 golden 入仓：NIST 三向量+前 12hex；边界长度 0..72+119/120/1000 与 node:crypto 对拍；多字节 UTF-8；64KiB 块循环 | sha256.test.ts ×4 | 🟢 |
| Y5 drain 批量上限测试改条件等待（有截止），不再固定 5ms 定时假设 | ws-support drain 批量上限 | 🟢 |
| Y1 obs Map 状态壳不滞留：stop 后身份门摘除（功能面=解绑后可再绑、句柄零残留） | dual 3b2c-fix1 F1-04 内 | 🟢 |

- 变异七杀（基线 9d7e378；/tmp/mut-3b2c-fix1.py python 锚点+count 断言+git checkout 还原）：M-F1-01 降级出口退返旧快照 jrows→1 挂；M-F1-02 credit 恒 0（release 双扣）→1 挂；M-F1-03 空索引分发块禁用→1 挂（D8）；M-F1-04 包装退直传 sinks→1 挂；M-F1-05 去 fatal 解码→5 挂（含既有非法字节组）；M-Y2 kind 过滤禁用→1 挂；M-R1 复核门禁用→2 挂。还原后 721+7 全绿。
- 措辞勘正（Y4）：上轮 M-R1 变异实际由 R1b（换代丢代）路径挂——「R1a 返旧快照」当时无独立杀伤（本轮 F1-01 补上：M-F1-01 专杀降级出口返旧快照）；M-R5 的「U+FFFD fail-closed」措辞收窄为「完整行非法 UTF-8 字节 fail-closed」（合法 U+FFFD 字符放行是 F1-05 语义）。

## 3b2b-fix2 修复轮（GPT 74→修复；基线 c50f323；729+7+tsc0+lint0）

| 断言面 | 用例 | 状态 |
|---|---|---|
| F2-01 observe 出口对称消费 credit：B 走 observe 配对→observe-session-credit credits=0 审计；A/B 全退双源句柄归零；后继 C load/release 正常释放 session 侧（零孤儿+零 release-session-credit+无 carry） | dual 3b2b-fix2 F2-01 | 🟢 |
| F2-02 多注册登记：新注册先停、旧注册仍活→session 恢复晚附补接旧注册（regs=1 审计；session 追加直达旧注册 A——旧单条 Map 会丢恢复入口）；收尾零句柄 | dual 3b2b-fix2 F2-02 | 🟢 |
| F1-02 重设计（合法配对版）：A 先退出（旧 session 槽真回收后的重开场景）再 C load+observe 续流；C 配对完成后**不再额外 release**（旧版多一笔无配对 release——GPT §5.1 盲区①修正） | dual 3b2b-fix2 F1-02 | 🟢 |
| F2-03 BOM 保留三例：①开头 BOM 保留→第二行 locator=真字节偏移（BOM 3B+行1+\n）；②有/无 BOM 两输入文本不同（不折叠同 text）；③撕裂尾=未完成多字节序列容忍可读 | history-source F2-03 组 | 🟢 |
| currentRows 无副作用固化（§7.5）：load→currentRows×3 恒等快照副本+reader.calls 仍=1（不重扫）+未装载文件→null；observe→stop 零句柄收尾（引用账不被扰动） | history-source F2 组 | 🟢 |
| D10 真全退再开（§7.5）：A+B 都退订→双源句柄归零→无人观察期盘面增长→C 再开快照含全部 4 行（无 live 补发）→新行 u5 notice 恰一次 live 直达（seq=5） | ws-gateway D10 | 🟢 |
| D11 双引擎逐条身份（§7.5）：A/B 在线 session 恢复+后续追加→双引擎 seq 序列一致且严格递增 [2,3,4]、entryId [u1,u2,u3]、归因一致 [i-1,null,null]、streamId 同流不换 | ws-gateway D11 | 🟢 |
| F2-04 调试文件清理：tests/dbg/ 删除→lint 恢复 0 | lint | 🟢 |

- 变异四杀（基线 c50f323；脚本 /tmp/mut-3b2c-fix2.py；**patch 存档=tests/fixtures/mutation-records/3b2b-fix2.md**——GPT F 面证据完备要求）：M-F2-01 observe credit 块禁用→1 挂；M-F2-02 observe 登记退单条覆盖→1 挂；M-F2-02b closeObsState 清整列表不按身份→1 挂；M-F2-03 去前缀 ignoreBOM→2 挂。还原后全仓 729+7 复验绿。
- 措辞纠偏（fix2 §6/Y4）：D9 标题与 TEST-MAP 行去「全退再开」表述（B 退订≠真全退，真全退=D10）；session-projection.ts 头注释去「插入行不漂移」（改「同位改写/中插会移动后续偏移→前缀校验检出→换流」）；history-source RealReader 注释改「fatal+ignoreBOM 下完整前缀字节序列→字符串为单射」（不再笼统称「一一对应」）。


## 3b2b-fix3 修复轮（GPT 76→修复；基线 ce50b50；734+7+tsc0+lint0）

**模型变更**：引用守恒从「credit 补记账双账本」改为**单账本免扣模型**——FH.observe 增 `consumeLoadRef:false` 免扣绑定（只绑 sinks 不动 awaitingBind）；晚附统一免扣；DH credit 账整个删除。「谁的 load 谁结算」：每次成功 load 的引用只由装载方自己的 observe/release 结算，晚附永不消耗他人引用（F3-01 双扣与 F3-02 carry 两条路径从根上消失）。

| 断言面 | 用例 | 状态 |
|---|---|---|
| F3-01 交错结算守恒：晚附后 B observe + C release 交错（两笔 load 两笔结算）→无 release-carry；A/B 全退零句柄；后继 D 双源观察建立+session 新行直达 | dual 3b2c-fix3 F3-01 | 🟢 |
| F3-02 多注册×多 load：A/B 两注册+C/D 两装载→晚附免扣双绑定（regs=2）→C/D release 各结算（无 carry）→当前交付 A/B 双达→后继 E 周期双源 | dual 3b2c-fix3 F3-02 | 🟢 |
| F3-02b 多注册×单 load：晚附双绑定免扣；C observe 结算唯一引用；无任何 carry | dual 3b2c-fix3 F3-02b | 🟢 |
| F1-02/F2-01 重写（免扣模型）：晚附 regs=1 无 credits 字段；B release 结算自己的债（session 句柄仍活）；B observe 消耗自己那份；后继周期零 carry 零孤儿 | dual 3b2c-fix1 F1-02/F2-01（重写） | 🟢 |
| F3-03 D10 类型收窄：unsub helper find 回调类型谓词（unknown→typed）——typecheck 三段真实全绿 | ws-gateway D10 + tsc | 🟢 |
| Y3-02 F1-04 尾部去无配对 release（载入已由 observe 配对）+断言无 release-carry | dual 3b2c-fix1 F1-04（尾） | 🟢 |
| Y3-03 D10 快照逐条：page seqs [1,2,3,4]+kinds 到达序 [turn-enqueued,message,turn-enqueued,message]+intentId [i-1,i-2]+entryId [u1,u4] | ws-gateway D10（强化） | 🟢 |
| Y3-03 D11 帧级订阅身份：A/B 后续 events 帧 subscriptionId 各自匹配本连接快照（events 帧不携 streamId；帧不串连接=同流同序直接证据） | ws-gateway D11（强化） | 🟢 |
| Y3-03 currentRows 副本语义+合法周期：两次返回引用不等+改返回数组不污染内部；load→currentRows×3→release→重开装载/观察无 carry | history-source F2 组（强化） | 🟢 |
| Y3-03 撕裂尾补全对照：撕裂态 u2 不发布→补全第三字节+换行后发布+u1 locator 不漂移+u2 locator=真字节偏移 | history-source RealReader（强化） | 🟢 |

- 变异三杀（基线 ce50b50；/tmp/mut-3b2c-fix3.py；**真实 unified diff+失败测试名存档=tests/fixtures/mutation-records/3b2b-fix3.md**）：M-F3-01 免扣门失效（free 绑定也扣）→3 挂（F1-02/F3-01/F3-02）；M-F3-02 晚附退消费模式→3 挂（同三用例）；M-F3-03 晚附只绑首个注册→2 挂（F3-02/F3-02b）。还原后全仓 734+7 复验绿。
- 上轮证据档勘误（Y3-01）：mutation-records/3b2b-fix2.md 非可应用 unified diff（M-F2-02 文字替换若逐字执行会被下一行 obs.set 覆盖）——本轮起存 `git diff` 原文+失败测试名清单。
