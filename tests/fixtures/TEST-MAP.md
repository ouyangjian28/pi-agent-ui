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

### adapter 切片 4（真进程接线：ProcessHost 适配+组装 RpcSession；4a/4b 两步；受控替身 47 it（process-host 17+rpc-session 23+file-durability 7）+协调器/网关纯逻辑测试不变；s4b 三阻断修复→s4c 93/100 受控面放行→4c E2E+恢复入口）

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
| 资源收尾（**Y-C2（4c+s4e）：dispose 清巡检+关耐久（可选 close 端口）恰一次；**并发 dispose 复用同一收尾 Promise（第二次 await 不早于第一次——close 挂起时不提前返回）**；进程退役独立走 stop（E2E 异常清理=running 先 stop 再 dispose）**） | rpc-session.test@Y-C2（close 计数恰 1+二次 dispose 幂等+stop 仍 confirmed）+**Y-C2b（close 手动挂起→p2 不提前返回+恰一次 close）** | ✅（变异：M-d1 去 close→挂；**M-yc2 复用废→Y-C2b+Y-C2 挂**） |
| 帧渲染（send→{id:"c<N>",type:"prompt"}JSON 行；matchKey=matchKeyOf(text,[],ordinal)；commandId/intentId 递增） | rpc-session.test@两轮（帧 id 递增，runTurn 帧计数基准） | 🟡（steer/followUp streamingBehavior 归消费接线；attachments 归 UI 层） |
| **真 pi 进程 E2E（4c+s4e 补轮：PI_BIN 绝对路径+**exact 版本锁 0.86.1**；--no-extensions 受控环境（扩展 UI 面归后续 UI 接线）；真管道 readiness 往返/SIGTERM 退出确认；连续两轮+journal 耐久+通知恰一次+真实事件流；SIGKILL 意外退出→同会话重组装（持久 --session）+**会话历史恢复断言（口令化 TOKEN=PENGUIN-42：gen1 捕获 assistant 实际答案+gen2 回同一口令=--session 历史恢复直接证据）**+恢复重放（打断轮=效果未知）+撕裂尾识别→截尾修复（**truncate 后 fsync 文件**）→续写；目录耐久 ensureDirDurable=dir+parent 两层 fsync（更深新建祖先条目归宿主部署，非任意递归））** | **tests/integration/pi-e2e.test.ts 6 it（PI_E2E=1 npm run test:e2e 显式跑，不进默认 npm test——防每跑真调 LLM；e2e-4/5/6=受控 node 子进程真管道无 LLM）** | ✅（六项对照实际证据口径：①exact 版本②真背压（4MB 写挂起到子进程读）+双管道排空（两路各 4×64KB）+readiness 往返③连续两轮+耐久④SIGTERM/SIGKILL+EOF 未接（另明确不假装）⑤恢复重放+历史断言⑥逐层目录 fsync+旧代迟到输出不污染新代（e2e-6 强制迟到：SIGTERM handler 写完回调才退，gen1-late 必达 toContain 断言非 best-effort；e2e-5 分通道：stdout 泵恰 4+stderr 泵恰 4+长度恒定；e2e-4/5/6 均补失败清理 stop/retire）；字节陷阱：撕裂尾修复 truncate 须用字节索引；spawn-exited 分支受控已证，真 spawn 失败=运维面；背压实测：128KB 一写即交（内核管道+libuv 队列），不足以证背压，4MB 才成） |

### adapter 切片 4c（恢复入口+黄项收口；recover.ts 受控 16 it；E2E 6 it 见上；s4f 补轮：F1/F2 已修）

| 编号 | 断言落点 | 状态 |
| --- | --- | --- |
| journal 读取分型（readJournalFile：末段无换行=撕裂尾 partialTail；完整行 JSON 损坏/无 t 字段=partialTail=false；**R2：行型必需字段 schema 验证——缺字段/错类型/未知行型拒收进 bad**；**F2：嵌套结构/集合元素校验（matchKey 三字段/ordinal 整数/payload 四字段+kind 枚举/attachments 元素/cleared 元素字符串/intervalEnd 两字段；嵌套非法拒收不进重放）**；空行跳过不判坏；好行保留） | recover.test@完整两轮+撕裂尾+坏行分型+**R2 schema 拒收（五断言）**+**F2 嵌套非法（七断言+bad.every 嵌套非法）** | ✅（变异：M-r1 去撕裂尾→挂；M-r5 schema 废→挂；**M-f2 payload.kind 嵌套检查废→F2 挂**） |
| **R1 损坏阻断（bad 非空→blocked=true+resumable 恒空；sending 残片可靠关联→并入 unknownEffect）** | recover.test@R1/R1b/R1c | ✅（变异：M-r4 blocked 清空废→挂） |
| **F1 不可关联残片=恢复范围级阻断（含前缀撕裂 \"{\"t\":\"send 不含完整 sending 字面量；修复后续读 blocked:false 也不解锁；盘面修复与重发裁决分离；intentId 提取走 JSON.parse 解码（\\u0069-1 转义不漏）；宿主显式归因（attributedFragments：raw 全等或≥12 前缀）后解锁+并入 unknown；归因不在场→忽略阻断保留）** | recover.test@**F1a（不可关联→resumable 空+unattributableFragments 呈现+归因后解锁）/F1b（转义解码关联）/F1c（不在场→保留阻断）** | ✅（变异：**M-f1 不可关联不阻断→F1a+F1c 两挂**） |
| 恢复判据三分档（unknownEffect=sending 无终态/超时未结算/已判 unknown/**sending+cancelled=副作用未知仍呈现**；resumable=非 sending 无终态且非 cancelled（取消是终局）且非残片并入；settled 计数；cancelled/delivered=终局不进两档） | recover.test@三分档+cancelled/delivered 终态+**sending+cancelled 拆例** | ✅（变异：M-r2 判据废→挂；M-r3 去 cancelled 过滤→挂） |
| 会话过滤（他 session 的 enqueue 不进重放；**前提演示：非 enqueue 行无会话身份，同文件跨 session 终态可越界——输入前提=每会话独立 journal 文件由组装层保证**） | recover.test@会话过滤+**前提演示** | ✅（前提由 RpcSession 每会话一 journalPath 结构保证） |
| 恢复不改盘面（只读呈现；撕裂尾修复/换段授权归宿主：截尾+（失败态另须）markRepaired） | E2E e2e-3（截尾修复流程落地+截后 fsync+**口令化两代一致性（TOKEN=PENGUIN-42，gen1 捕获实际答案+gen2 回同一口令）**） | ✅（E2E 接线证据非变异面） |
