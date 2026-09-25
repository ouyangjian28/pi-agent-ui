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

## adapter 切片③-3a（WS 网关受控接线：认证/入站管线/队列/订阅/恢复/心跳；w1 48→w1b 66→w1c 78→w1d 85 修复链后 520 it）
| 面 | 断言落点 | 状态 |
| --- | --- | --- |
| **认证入站（hello/token/Origin/TLS/窗口/撤销）**（Origin 精确集合缺失默认拒；非 loopback 无 TLS 拒；token timingSafeEqual 摘要；protocolVersion≠1→4403；hello 前窗口可配帧数（默认 3；**w1c 勘正**：validateClientFrame 先行——非法帧即 4404 计数关闭，窗口豁免只对「形状合法但未认证」帧与认证截止分立）；热轮换 revoked 摘要关既有连接 4401） | ws-gateway.test A 组 10 it；ws-support.test token-auth 4 it（fromFile 缺失拒启/reload revoked=旧−新/失败沿用旧+乱序丢弃） | ✅ |
| **入站管线（二进制/262KB/JSON/未知 t/写类冻结）**（二进制→4404；超长→4404；非 JSON/未知 t→4404 计 3→close 1002；写类集 {prompt,send,stop,resume,takeover,write,execute,spawn,kill}→4405） | ws-gateway.test 入站管线例（二进制/非 JSON/未知 t 三连 4404→1002；prompt→4405） | ✅ |
| **requestId 在途门**（缺失/非法/^[-\w]{1,64}$/→4404；在途重复→4404；在途≥4→**4404**〔契约 §369：在途超限=4404 计数关闭，非 4429——w1 修复轮勘定〕；同步占位原子受理） | ws-gateway.test requestId 例（provider 永挂造 4 在途+重复 4404+第 5 个 4404） | ✅ |
| **订阅三分支+限额**（file FILE_RE+双根域→4404；init/resync 同 file 先退旧→4409 stream-replaced+引擎静默关；≥8 file→4429；page 无活动引擎→4404；全部出帧经 ConnectionQueue） | ws-gateway.test C 组 7 it（越界/非法名/重订阅 4409/第 9 file 4429/page 无引擎 4404/空会话 snapshot/C16 错流+C17 换流） | ✅ |
| **列表/恢复（semaphore+证据快照）**（list-sessions offset/limit 校验→scanSessions→buildSessionsFrame（semaphore 并发 2 全局）；get-recovery 走证据快照 provider：null→unavailable(no-evidence-snapshot) 禁裸读盘面；有→recoverFromSnapshot→buildRecoveryFrame） | ws-gateway.test D 组 6 it（list 帧+limit 999→4404；无快照 unavailable/有快照 available/D21 真跨页 55 文件同版本/D23 审计抛错不阻断撤销） | ✅ |
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
| **w1d 修复轮（85/100 两阻断；基线 766799b）** | D1 流身份静默丢失协调：read-index registry 加 onStreamDropped 钩子（LRU 挤出/宽容换流先通知宿主再移除）+gateway 钩子内 retireEnginesForFile(keep=null) 全退役（4409+撤帧+清 sub+releaseWatcher）+syncIndex 空索引装载与 onAppend 分发前身份防线（兜底协调漏网，幂等 no-op）+registryMaxStreams 可注入（受控替 33 活动流）；D2 4402 retryable=true（errFrame 按码判定；closeSubscriptionsFor 内联帧本就 true）；注释勘正（B1 门 R1 语义/listFingerprint 头注全字段/B2 用例 isPrefixOf 原理） | D 系回归 3 it（D1a 挤出协调/D1c+Q6 宽容换流钩子+迟到回调吸收/D2 改写重建出口）；Q6 真观察面（成功订阅保留 sinks→触顶→保存的迟到 onAppend→FileOverBudgetError 吸收不逸出）；B8 改 perIntent.items 直拼两页 501 条+末页 next=null；R3a 删空观测尾段+补 retryable 断言；R4b 改名如实（offset0 现算，不证跨页拼回） | ✅ |
| **w1d 变异（基线 766799b）** | M-D1r registry 不发 lru 钩子→D1a 挂；M-D1s 不发 budget-swap 钩子→D1c 挂；M-D1g gateway 钩子不退役（const retired=0 干净 no-op）→D1a 挂；M-D2 errFrame 4402 回 retryable:false→D1c 挂（cap 断言打在 errFrame 出口帧；D2 改写重建例经 closeSubscriptionsFor 内联 true 帧仍过=独立出口语义一致，不误报） | ✅（四杀） |
| **真网络传输（ws 库 socket/真实 backpressure/Origin header/TLS）** | 归 3b 真网络分片（w0 对齐：3a 通过措辞=「受控 WS 接线通过」） | 🔴 3b |
