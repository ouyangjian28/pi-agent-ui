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

## 3b-3⑤ 整文件指纹（2026-09-29；repo f6c7912/84e9bc0）
- 断言面：①sha256HexBytes 对拍 node:crypto（空/随机 1·55·56·119·120·1000/撕裂多字节尾/64KiB+与字符串入口一致）②同内容同身份 notice→fingerprint-skip 无 append 无 invalidate（幂等静默）③同字节换 inode→skip-identity-change 不失效+后续新 inode 真追加仍达（rearm 后用最新活句柄）④内容增长→正常 append+指纹跟进→再同内容→skip ⑤真盘 rename 覆盖同字节（真新 inode）无 invalidate+后续真追加（RealReader+RealWatcher 冒烟）⑥Dual.fingerprints（未装载 null/双源两指纹/journal-only session=""——session 子源槽以逻辑 file 键控）⑦网关 index-fingerprint 审计（journal/session 12hex；session=- 面=删文件+notice 代退役后再装载）
- 语义变更披露：**同字节换 inode 从「invalidate(replace)」改为「短路不换流」**（契约 §1.3 指纹=变更检测触发器；观察一致面）。两处旧测试随之更新：hs「replace（身份变化）」改 identity 变+内容变；dual「observe 双子源」换代步加 u3 行。
- 变异四杀：M-FP-1 短路门 if(false)→4 挂；M-FP-2 跳过不跟进 identity→2 挂（短路自陷：后续新 inode 追加误判 replace）；M-FP-3 追加后指纹不更新→1 挂；M-FP-4 网关不记指纹→1 挂。全部 KILLED（tests/fixtures/mutation-records/3b3-fingerprint.md，真实 diff+失败用例名+还原后 747+7 复验）。
- 踩坑：①tests 直接跑 tsc 严格面下 ReadResult 可选 fingerprint 的收窄要显式展开（in 收窄不动）②python 追加测试后搬移进 describe 时吞了前一 it 的闭合括号（suite-in-test+EOF 缺括号——vitest 部分收集假象 673/680，tsc 才是真相）③网关审计与双源审计是两条线（dualRig 的 audits 原只接双源——makeRig 透传 audit 并入）④session 子源槽键=逻辑 file 非 session 路径（journalFor 是映射器）。

## 3b-3② real-fs E2E（2026-09-29；repo ed7e22b）
- 场景=真实 OS 时序（mkdtemp 真目录+真 fs.watch+RealReader），网关面走 FakeConn 内存传输（无网络无 LLM）。rig=dual 默认装配（roots=[jr], sessionRoots=[sr], sessionFor）+WsGateway{roots,scanDir}；WARM=150ms 稳态+until(3000ms)。
- 断言面：RF1 同 tick 双源追加各恰一次+归因直达；RF2 撕裂尾跨写补全（半行不发布→补全后发布）；RF3 rename-over 同字节→fingerprint-skip-identity-change 短路+新 inode 追加仍达；RF4 rename-over 改写→4409+重订新 streamId；RF5 delete→4402 retryable=true；RF6 recreate 成流；RF7 缺源恢复晚附（journal-only 订阅→session 落盘→B 装载→A 恰一次+直达）；RF8 旧 cursor 续读（契约 §3.7 第4项 含起始 seq 重发）；RF9 全退静默+再订恢复；RF10 从未装载 cursor→4404。
- **RF8 契约三步勘正**：快照单页完读 historyNext=null（非 {seq}）；cursor.seq 首事件=1（seq:0 是非法 cursor）；补齐=含起始 seq 重发（期望 [h..h+2] 非 [h+1..h+2]）。
- 变异二杀（tests/fixtures/mutation-records/3b3b-real-fs.md）：M-RF-a syncIndex 前缀分发 if(appended>0)→if(false)（RF7 挂）；M-RF-b RealReader fingerprint 恒空（6 挂）。还原 756+7。

## 3b-3③ real-ws E2E+同步排水修复（3b3c；2026-09-29；repo 7bfcde2）
- 场景=组合根 startServer 真监听 127.0.0.1:0+真 ws 客户端（WsClient：waitOpen 必备——readyState 0 时 send 静默丢）。
- **同步排水缺陷（RW1 实测真 bug，单测不可见）**：1100 行同 tick 追加→onAppend 同步分发循环内 schedulePump 是 tmr(0) 定时器永不到期→live 引擎 outbox 堆过 1024 积压门→快客户端被慢客户端门误杀。修复三件套：①schedulePump 抽 pumpFile(file)（逐连接 drain+emit+仍积压续泵）②pumpIfBacklogged（判据=**engine.outboxDepth**（新增只读口，仅可排水面）≥maxEventsPerLiveFrame=7——首版用 state.buffered（含 paging 滞留）致每事件排水→1025 单事件帧→连接队列超限二次误杀）③dispatchHistoryBatch（syncIndex 首装/续编两路共用，每 16 条分块排水）。
- **两级 4431 语义（Y-02 勘正版；3b3-fix2 再勘正 retryable 口径）**：订阅级 4431 触发面=①paging 滞留破 subscriptionBacklogMax（「订阅积压超限（慢客户端）」）②单帧组装超 frameMaxBytes（「帧超预算」，subscription-engine.ts:296）——**两者帧内 retryable 恒 false**（引擎 close 第三参=是否发错帧，帧语义固定；契约 §5.3；RW1 断 false）——「订阅级仅=paging」不是全域真命题；连接级 4431「连接发送队列超限（queue-overflow）」retryable=true=connQueueFrames/Bytes 破限或 bufferedAmount≥4MiB 背压门（**正例由单元面覆盖**=ws-support.test.ts:263；真回环内核缓冲吸收 MB 级，集成面正例不稳定不设门）——同步排水+有界让出后 live outbox 有界，持续传输堆积走连接队列，两级各管一面。RW2 的验收目标=同负载零 4431 误杀（pause+7000 突发→零 4431+resume 全量恰一次），**不是**断言连接级 4431 正例。
- 断言面：RW1 快/慢并存（250>200 分页+1100 突发：slow 订阅级 4431 只关订阅+连接不断+cursor seq=200 分页循环续读到 1350；fast 恰 1100 零错）；RW2 pauseSocket+7000 突发→零 4431 误杀+resume 全量恰一次（对照面：R-01 修复前为连接级 4431 误杀）；RW3 262,145B→4404 不断链+>1MiB 单帧→close 1009；RW4 Origin 外→HTTP 403+坏 token→4401/1008；RW5 A 硬断→B 共享观察 30 事件全量（审计名=conn-transport-closed）；RF11 恢复期 1100 行批量续编→A 恰 1100 零错（M-P2 杀）。
- 变异三杀（tests/fixtures/mutation-records/3b3c-sync-pump.md，真实 diff+失败名）：M-P1 onAppend 去同步排水→2 挂；M-P2 dispatchHistoryBatch 去分块→1 挂；M-P3 判据退混合 buffered→1 挂。还原 762+7。
- 踩坑：vitest 看 console 须 --disable-console-intercept；RW1 尾放宽 20s；慢端续读须快照翻页循环（hasMore→续送 snapshotId+historyNext，单订一次只到 399）。

## 3b-3④ 预算容量+内存采样（2026-09-29；repo 40aee70）
- 断言面：BG1 双源同池 20k 触顶状态机（19,998+3=20,001 越界→订阅 4402 retryable=true+不发快照；宽容换流后再触顶仍 4402；额度用尽第三订→registry 拒建，审计 index-over-budget-get——**该审计为本轮补齐**：syncIndex 的 FileOverBudgetError 原为静默 4402，与 onAppend 路径观察面不一致）；BG2 恰 20,000 恰在池内放行（barrier=20,000 零错）；BG3 每文件 8MiB 扫描预算（9MiB journal→4402 会话不可读 retryable=true+源侧审计 load-read-failed kind=too-large——网关订阅口 load=null 统一通用文案，reason 只落审计线）；BG4 流池 LRU 32（33 文件顺序订/退→registry.size≤32；**3b3 修复轮 Y-03 后断言触达重排**：f1 触达保留/f2 挤出，非首轮简单淘汰）；BG5 内存披露（20k 满载下 vitest 进程 heapUsed **单次瞬时采样**快照+384MiB 宽松护栏；口径=含测试运行时本体，非生产 RSS，非持续峰值监控——披露非承诺）。
- 组合层无合计门（冻结裁决）：合计口径归 3b-4 恢复面。
- 变异三杀（tests/fixtures/mutation-records/3b3d-budget.md）：M-B1 触顶边界 > → >=（BG2 恰 20k 误判）；M-B2 LRU while(false)（BG4 无界）；M-B3 readBounded 上限 MAX_SAFE_INTEGER（BG3 绕过）。全部 KILLED；还原 767+7。
- 踩坑：requestId 模式 \w- 不含句点（s-f1.jsonl→4404 requestId 非法）；订阅口 load=null 的 reason 只在源侧审计（history-source load-read-failed kind=…），网关层无 reason 审计——断言走源侧线。

## 3b3 修复轮（GPT 3b-3 首审 69→修复；2026-09-29；repo 63bce74+519d620）
- R-01 同步排水只转移饥饿点（P-FAST：正常读+6750 单突发→events=0+连接级 4431，connQueue drain=setImmediate 在同步循环内饥饿）：①dispatchHistoryBatch（syncIndex 首装/续编两路）+rescanOnce 追加分发均改「>256 行批次每 16 条 setImmediate 让出」（≤256 保持同步语义，既有单测时序不变）；②让出窗口复核（失效/换代丢弃；并发重扫推进水位跳过不重发）；③RW2 重写=同负载对照（pause+1.2MB 突发→零 4431 误杀+resume 全量恰一次）；RW6=P-FAST 复现锁死；RW7=syncIndex 批量续编路（8000 行真传输，M-R1a 杀手）。
- R-02 同字节换 inode 漏读窗口（读后重挂前新 inode 追加无人观察）：①skip-identity-change 后强制核对读（identity-handoff-verify；无追加=纯 skip 收敛无环）；②identity 变不再单独 replace——前缀判据先行：纯追加+换 inode=同流交接（inode-handoff-append 身份跟进+前缀补发）；前缀破才 replace（改写）。
- R-03 生产流 ID：GW 默认改 defaultStreamId（crypto 16B→32 位十六进制 `s-`+hex，read-index.ts 导出；3b3-fix2 勘正：原记 base64url 有误）；composition 两实例首流互异+跨实例 cursor 4404。
- R-04 配置门：requireFinitePosInt（maxScanBytes 1..1GiB/tokenPollMs）+requireAbsPaths（roots/sessionRoots/scanDir）+Origin 正则；NaN/Infinity 绕过 readBounded 封死。
- R-05 RW4 403 拒握手 CONNECTING 态 terminate→unhandled：error 过滤+close 收敛；三 unused import 清。
- Y-01 并发 dispose 共享收尾 Promise（d2Early 窗口断言）；Y-02 两级 4431 语义勘正（订阅级=paging 滞留**或**帧超预算）+§3.7 第4项锚点+inode 例外原位；Y-03 RW1 续读全序列 200..1350 对拍+RF11 逐 seq（2..1101）+RF9 unobserved 正面证据+BG4 LRU 触达重排（f1 触达保留/f2 挤出）+BG5 口径改「单 20k 流满载」；Y-04 指纹三路统一（首装/续编/重建+onAppend）+rescanOnce 指纹移分发循环前（循环内链路即时可得+并发窗口不回退）+RF12 三态对拍源 SHA-256 全 64hex；Y-05 tokenPollMs 轮询真实生效（token-reloaded+旧 token 4401）+头注释口径勘正。
- 断言面：R-02/W1-W3+收敛性（history-source 66 it）；真盘全分型补 rename 纯追加=交接+改写 rename=replace；RF12（real-fs 11 it）；RW7（real-ws 7 it）；composition 13 it（R-04 门×4+R-03+Y-01+Y-05）。
- 变异六杀（tests/fixtures/mutation-records/3b3-fix1.md）：M-R1a/M-R1b/M-R2a/M-R2b/M-Y1/M-Y4 全 KILLED；两首轮 SURVIVED 均为杀手集缺口（补 RW7/d2Early 后杀）——已披露。
- 终态：781+7+tsc0+lint0，npm test exit0 无 unhandled。

## 3b3-fix2 修复轮（GPT 复审 74→修复；2026-09-29）
- F1 分发乱序（publishStates 单飞发布循环）：syncIndex 三路（首装/续编/非前缀重建）+onAppend 统一 claimPublish→publishLoop 按 nextSeq 账本逐条有序投递（读批 16、backlog>256 让出、让出后索引身份复核）；引擎增 historyBarrier（快照/页已含 seq 跳过，恰一次）；publishLoop 异常退位 stopped 标志不补启（防同步重入环——实测栈爆反例自捕自修）；删 dispatchHistoryBatch。
- F2 await 后不复检（**部分闭合，勘误披露**）：syncIndex 函数体去 await，但声明仍 async+调用方仍 await——**等已履约 Promise 也让微任务，未提交窗口未消失**（GPT fix2 复审双微任务探针 P-CLOSE-MICRO/P-REPLACE-MICRO 2/2 复现；fix2 宣称「窗口从根消失」错误，撤回）。真闭合=3b3-fix3 同步化（见下节）。发布让出窗口的关流/换流由循环身份复核+retire 兜底不变。测试：F2/P-CLOSE（发布中段双闭→stopped+release 恰一次+关后零帧）、F2/P-REPLACE（中段 invalidate→双 4409+旧流发布中止+新订阅新流快照）——两者测的是**发布窗**，fix3 补提交窗探针。
- F3 inode 前缀追加交接漏读：rescanOnce inodeChanged→handoffVerify 标志→重挂后 queueRescan('inode-handoff-verify')；followUpReason 字段穿透在飞折叠（审计可辨）；W5 杀手（读后重挂前追加+读前追加→appends 恰 2）。
- F4 根 typecheck：composition.test.ts:172 显式 undefined 违 exactOptionalPropertyTypes→省略键。
- Y-04 残余：指纹语义钉死（read-index 字段+recordFingerprints 注释：最后事件编入/装载时点摘要，非实时版本，恢复面禁用）；RF13 撕裂尾（不编入→指纹停旧值≠盘字节；补全→跟进全量 SHA-256）；RF14 直驱 syncIndex 非前缀分支→重建路指纹=新源字节（三路统一之重建路真指纹）；RF9 unobserved 两源分开（journal+session 槽各一条）。
- 文档勘误：TEST-MAP 两级 4431 retryable 口径（订阅级两触发面帧内恒 false；RW2=零误杀目标非连接级正例）+R-03 base64url→hex+BG4 触达重排+BG5 单次瞬时采样；契约换流全集 inode 例外原位；composition.ts reload 假描述（changed:true 无条件）；read-index 注释 hex。
- 变异两杀（新标准档 tests/fixtures/mutation-records/3b3-fix2.md）：M-F1 屏障判定移除→P-ORDER 翻页不收敛 exit1；M-F3 核对读移除→W5 until 超时 exit1。fix1 档补勘误头（旧标准说明+GPT 独立复演依据）。
- 终态：44 files 787+7+tsc0（根）+lint0，无 RangeError/unhandled。披露：全套首跑曾 1 例失败（tail 截断未捕获用例名，其后 5 连跑全绿不可复现——按抖动记录，不掩饰）。

## 3b3-fix3 修复轮（GPT fix2 复审 81→修复；2026-09-30）
- F2 真同步化（**唯一🔴闭合**）：syncIndex 去 async 声明+调用方去 await（等已履约 Promise 也让微任务——GPT 双微任务探针 P-CLOSE-MICRO/P-REPLACE-MICRO 2/2 复现的根因）；提交段（load 复核→syncIndex→引擎→绑定→快照）无任何让出点，未提交窗口不存在（fix5 勘正：本宣称限 syncIndex 让出面——门后到快照发出前仍有同步宿主回调点（退旧入队溢出/撤帧审计/statusFor），由 F4-1+fix5 recheck2 门覆盖，非「全称无窗口」）。发布让出窗口（publishLoop yield）的关流/换流仍由循环身份复核+retire 兜底（fix2 已有）。
- 探针固化（公开端口双微任务排程=load() 调用点 queueMicrotask×2 后动作；fix6 勘正：仅 P-CLOSE-MICRO/P-REPLACE-MICRO 两例真双微任务嵌套，NEWGEN 自始=闸门覆盖（p.then 自管+人为旧盘面），见 fix4 节 F4-3 与用例头注）：F2/P-CLOSE-MICRO（双微任务关→关前拦截零绑定或关后收口，恒零残留+引用恰一次；单微任务变体=关前窗口 st.closed 拦截+release 恰 2）；F2/P-REPLACE-MICRO（双微任务 invalidate→旧流必退 4409，任何时序不复活退役流坐标）；F2/P-REPLACE-NEWGEN（换流窗内新代已建+旧盘面 load 返回→非前缀再 replace，s0/s1/s2 三流互异、最终归属唯一、收口每绑定恰一次 stop）。
- Y-F2-LEDGER 发布账本回收：recyclePublishState（身份安全——仅 ps.streamId===被废流才删；在飞循环闭包持引用不受影响）挂三面=registry onStreamDropped（LRU 挤出/触顶宽容换流）+onInvalidate+onUnavailable。测试：PUBLISH-STATES-CHURN（registryMaxStreams=4×6 文件→ledger≤4 与 registry 同步；invalidate 后该文件项即回收；dispose 后清空）、PUBLISH-IN-FLIGHT-RECYCLE（在飞循环遇换流→账本即删+循环身份门自止无 publish-seq-mismatch+新流新账本可续编）。
- 黄项清理：claimPublish 注释勘正（min=取更低待发点防跳发，非「防回退重发」——三路入口均给新编入区间起点）；read-index.ts:11 头注释 base64url→hex；TEST-MAP 3b3③ 断言面 RW2 残句「连接级 4431 retryable=true」删（与 RW2 零误杀目标矛盾）；3b-3④ 标题「内存峰值」→「内存采样」（历史命名，实为单次瞬时 heapUsed 采样）；fix2 节 F2 行撤回「结构性闭合」宣称（改为部分闭合+勘误披露，真闭合=本轮）；变异档 3b3-fix2.md 补强（基线 commit f870b40d7c3dfd23b10704a469818ab230b7a0f4+还原哈希（fix4 勘正：原记 ws-gateway 5cc104978586ec6f… 系 ce527e4 世代内容张冠李戴，f870b40 真值=ed18e6e4e8053c0b…/history-source 56ed402211afc392…全值见档）+785 vs 787 阶段说明（fix4 勘正归因：+2=real-fs RF13/RF14 新增 it，非 F4 补测））；P-CLOSE release 断言改精确计数（**fix5 原位标错：本句时序描述有误——b 实际已提交（共享 a 的 observe 未消费 load→订阅完成即 release），非「关在提交前未消费」；精确断言本身正确**）。
- RF14 夹具卫生：Rig 接口补 dual 声明；RF14 裸 dual.load 配对 release（try/finally）；rig.dispose 加 dual.dispose()——**为此补 FileHistorySource.dispose()（全代失效+关 watcher+清槽，幂等）+DualHistorySource.dispose() 透传**（生产不依赖，测试/嵌入宿主收尾面）。
- 终态：44 files 792+7+tsc0（根）+lint0。

## 3b3-fix4 修复轮（GPT fix3 复审 80→修复；2026-09-30）
- **F4-1 同步可重入提交资格复核（F3R-COMMIT）**：handleSubscribe 在 B3 配额重验前加同步门 `st.closed || registry.peek(file)!==index`→engine.close(4431,`commit-race:${why}`,false)+审计 subscribe-commit-recheck-fail+release+return（statusFor=startSnapshot/startResync 冻结 status 时的宿主回调，回调内可同步关连接/触发换流；await 消除后同步回调=提交资格的最初窗口（fix6 勘正：非「最后」——fix5 recheck2 门加入后退旧入队/撤帧审计等后续同步宿主回调点另有设防，本门与 recheck2 构成提交段双层门））。探针：F4/P-SYNC-CLOSE（statusFor 注入 closedByTransport→零快照/零观察绑定/release 恰 1/审计 why=closed）、F4/P-SYNC-REPLACE（B 的 statusFor 回调内 invalidate（A 已绑观察）→B 无快照/release 恰 1/why=identity/A 收 4409/B 续订得新 streamId）。
- **F4-2 dispose 三漏封堵（F3R-DISPOSE）**：FileHistorySource 加 srcDisposed 终态位——load()/observe() 入口返 null、initialScan() 返 false、runRescan() 入口返、dispose() 先幂等检查+置位+撤 pendingTickets（t.released=true；在飞读结算 fail-closed=load 返 null，不建代不开 watcher）；DualHistorySource 加 disposed——load 入口+重试循环 attempt 顶返 null（审计 load-aborted-disposed，不重开子源）、observe 入口返 null、dispose=标终态→**先收 ObsState 全账**（closeObsState→sinks 置空→obs.clear）→再透传子源 dispose。探针：F4/P-DISPOSE-PRE-SCAN（load 后同步 dispose→排队初扫微任务被入口门拦截：不建代/零 watcher/槽不复活）、F4/P-DISPOSE-IN-FLIGHT（挂起读窗内 dispose→撤票+已建句柄全关+通知静默）、F4/P-DUAL-RETRY-DISPOSE（在飞 load 等待窗内 dispose→重试循环不重开子源/零新 watcher）、F4/P-DUAL-OBS-COLLECT（dispose 收口全部 ObsState：sinks 置空/通知静默/账本清空/入口拒绝）。
- **F4-3 假嵌套修复（F3R-TEST）**：原 afterMicrotasks(depth,action)=「depth 个空微任务+action」→action 恒在 load 续体前=假嵌套（只测 st.closed 前置门，恢复 async 后 SURVIVED）。重写真嵌套助手=load 包装 `const p=orig(f); queueMicrotask(()=>queueMicrotask(action)); return p`（同步履约→L 先排，M1 排 M2，动作恒落提交后）+release/stop 闩锁精确计数+断言时序化（关前拦截/关后收口二选一都合法，不机械要求 observeCalls 空）。F2/P-CLOSE-MICRO、F2/P-REPLACE-MICRO、F2/P-REPLACE-NEWGEN 三例重写（**fix5 勘正：仅前两例用真嵌套助手；NEWGEN 实物一直是 p.then 自管闸门+人为旧盘面=闸门覆盖，非真嵌套——杀伤面由 P-REPLACE-MICRO 双出口+复合变异 M-F2c 承担，fix5 已在用例头注标明**）；P-CLOSE 注释勘正（b 实际已提交——共享 a 的 observe 未消费 load→订阅完成即 release）。
- **F4-4 发布账本第四出口（F3R-LEDGER）**：syncIndex 非前缀分支 registry.replace 前捕旧流 id→recyclePublishState（registry.replace 不触发 onStreamDropped 钩子——GPT 复现 registryMaxStreams=1 时 ledger 滞留旧流 5 项；overBudget 早退在 claimPublish 前，不回收则永不释放）。探针：F4/P-PS-REWRITE-RECYCLE（非前缀改写订阅触发换流→旧流账本项即刻回收+新流新坐标起步零 mismatch；变异下存活=如实入档（fix6 勘正：存活真因=claimPublish 流身份不同直接覆盖旧 Map 项，非 onInvalidate 钩子双防线——与 fix4 档勘正一致））、F4/P-PS-OVERBUDGET-CHURN（非前缀+超预算→4402 拒绝路仍先回收——同步回收唯一防线，M-F4-RECYCLE 杀手）。
- **F4-5 证据面七件（F3R 披露 60 分主因）**：①TEST-MAP 3b3③ RW2 残句真删（改「零 4431 误杀+resume 全量恰一次」+对照面标注）；②3b-3④ 标题「内存采样」实物落地；③fix2.md 还原哈希张冠李戴勘正（5cc104…=ce527e4 世代内容；f870b40 真值=ws-gateway ed18e6e4e8053c0bfb3951e35447638cf84f760ad55a66b72b54c058169a7c5e/history-source 56ed402211afc392ea15540a7c6a106c4dff24ff78276a1cd48d6c56ffe85325）；④785→787 归因勘正（+2=real-fs RF13/RF14 新增 it，非 F4 补测——F4=composition 类型修正不新增用例）；⑤fix1.md/fix2.md 六杀复演引用勘正（fix1 复审报告 commit 9af578f，非 fix2 复审 §5=文档勘误清单）；⑥TEST-MAP fix3 节哈希引用同步勘正；⑦PROJECT.md fix2「结构性闭合」旧宣称原位标错（主仓面）。**本轮铁律：每条「已修」宣称必须 grep 实物验证后才准写档。**
- 变异二杀（tests/fixtures/mutation-records/3b3-fix4.md，真实 diff+退出码+还原哈希）：M-F2 恢复 syncIndex async+await→F2/P-REPLACE-MICRO 挂（identity 路守卫=同步化；fix6 勘正：现守卫=F4-1 门+recheck2 双层+同步化三重，非唯同步化——窄 M-F2 合法存活佐证）；M-F4-RECYCLE 去 syncIndex 换路回收→F4/P-PS-OVERBUDGET-CHURN 挂（还原 sha256 同值校验）。
- 终态：44 files **800 passed+7 skipped**+tsc0（根）+lint0（较 fix3 +8：F4-1×2+F4-2×4+F4-4×2；F4-3 重写不增数）。首跑 1 挂未捕获用例名，随后两轮全绿不可复现（同 fix2 抖动按实录入档）。

## 3b3-fix5 修复轮（GPT fix4 复审 81→修复；2026-10-01）
- **F5-1 门后重入提交资格复核（F4R-COMMIT P3/P4）**：退旧块（enqueue 4409→engine.close→cancelBySubscription）后加 recheck2 门 `st.closed || registry.peek(file)!==index`→engine.close(4431,`commit-race2:${why}`,false)+审计 subscribe-commit-recheck2-fail+release+return（退旧入队溢出=同步 closeConn；撤帧审计=宿主回调重入面）；B4 复核按引擎身份（committed.engine!==engine→结算）。探针：F5/P-RETIRE-OVERFLOW（同步 ping 突发填满 1024→第二订阅退旧 4409=第 1025 帧→rejected-overflow→同步 closeConn→recheck2 拦：审计双证+观察恰 1+release 恰 1+stopped+零复活帧）、F5/P-RETIRE-AUDIT-REENTRY（同 tick 双订阅→sub2 退旧撤帧审计注入关连接→recheck2 拦同型）。
- **F5-2 dispose 通知/注册窗（F4R-DISPOSE-NOTIFY P10/P11+P7）**：①rescanOnce 分发循环逐 sink 双门（代死 `entry.disposed||entry.sinks===null`→整批停；成员摘除 `!has(sk)`→跳过）——快照迭代不得向死代/已退订者投递；②Dual.observe 子 observe 返回后终态二验（迟到 stop 就地回收+审计 observe-aborted-disposed）；③attachSessionIfObserved 快照迭代（活注册表 splice 跳项——探针自捕真 bug）+晚附迟到绑定回收；④journal-only 已履约返回语义注释钉死。探针 5：F5/P-BATCH-DISPOSE（B 先注册（同行先行投递）+A 首行回调 dispose→双 sink 恰首行+句柄全关+终态拒 load）、F5/P-BATCH-UNBIND（A 首行回调退订自己→A 恰首行/B 双行照收）、F5/P-OBSERVE-AUDIT-REENTRY（journal observed 审计注入 dispose→observe 返 null+obs 清零+幂等）、F5/P-JOURNAL-RESOLVED（dispose 后 load 返已履约 jrows+后续拒）、F5/P-LATE-ATTACH-REENTRY（晚附补接期 stopA→B 照附收追加+A 零收+孤儿 stop 回收）。
- **F5-3 探针语义修正（F4R-TEST P12）**：F2/P-REPLACE-MICRO 双合法出口——until 条件容纳身份门拒绝信号（拒绝口零帧，旧条件超时抛错=错杀合法拒绝）；出口一（拒绝）断言审计 why=identity+release 恰 1+零新绑定；出口二（提交）断言快照流=old+4409 退役必达（复合变异 M-F2c 在此被杀）；F2/P-CLOSE-MICRO 补精确 stop 计数（恰 1 无双重收口）；F2/P-REPLACE-NEWGEN 头注标明闸门覆盖（非真嵌套，杀伤面归 P-REPLACE-MICRO+M-F2c）。
- **F5-4 证据面勘正（F4R-EVIDENCE）**：3b3-fix4.md 两处归因勘正（M-F2 杀伤真因=until 超时非帧序断言、窄变异新语义下合法 SURVIVED；REWRITE 存活真因=claimPublish 流身份覆盖非 onAppend 双防线）+CHURN 命名标注；TEST-MAP fix3 节标注（fix6 勘正：P-CLOSE 时序句与「未提交窗口不存在」为原位标注；NEWGEN 标注当时落在 fix4 节 F4-3 行而非 fix3 节原位，fix6 已在 fix3 节探针固化行补齐原位）。
- 变异五组杀（7 次失败用例；fix6 勘正计数：原记「六杀」有误）+一合法存活（tests/fixtures/mutation-records/3b3-fix5.md，真实 diff+退出码+还原哈希）：M-F5-GATE（双杀）/M-F5-2a（双杀）/M-F5-2b/M-F5-2c/M-F2c 复合（P-REPLACE-MICRO）；窄 M-F2=合法 SURVIVED（出口一）。
- 终态：44 files **807 passed+7 skipped**+tsc0（根）+lint0（较 fix4 +7：F5-1×2+F5-2×5；F5-3 双出口重写不增数）。

## 3b3-fix6 修复轮（GPT fix5 复审 83→修复；2026-10-01）
- **F6-1 终止通知成员资格可撤销（P11/P12 阻断）**：①HS 面（history-source.ts）——closeEntry 不再清 sinks（保留作成员资格面）；新增 deliverTerminal(entry,sinks,kind,reason)：循环内 srcDisposed→return（dispose 后不开始后继宿主回调）+entry.sinks===null||!has(sk)→continue（回调内退订他人=跳过该注册）+try/catch 逐 sink；投递毕 entry.sinks=null（迟到成员核对判据）。deliverInvalidate/deliverUnavailable 改调 closeEntry+audit+deliverTerminal。unbind 重排：entry.disposed 先行→终态窗内退订=entry.sinks?.delete 后返（不重开代）。②DUAL 面（dual-history-source.ts）——wrapSinks(st,alive) 注册资格门（ok()=!st.closed&&st.sinks!==null&&alive()，五方法转发前全过门）；observe() 重构先立 st 再 wrap 再子 observe 再终态二验落账（wrap 需引用注册身份）。探针 5：F6/P-TERM-DISPOSE（B→A→C 注册序，A 回调内 src.dispose()→C 零终止通知+终态拒 load）、F6/P-TERM-UNBIND（A 回调内 stopC()→C 零）、F6/P-TERM-DISPOSE-UNAVAIL（watch 失败/读错 unavailable 面同型）、F6/P-DUAL-TERM-DISPOSE（journal-only 非前缀重写→A 回调内 made.dispose()→C 零+obs.size=0+句柄全关）、F6/P-DUAL-TERM-UNBIND（A 回调内 stopC→C 零）。自捕缺陷：alive 闭包首版语义反转（`()=>this.disposed` 应为 `()=>!this.disposed`）→五探针全 0 回调，DBG 三层定位修复。
- **F6-3 资格门前纯数据化（P6 序列化重入边界）**：subscription-engine.ts servePageFrom 加 freezeStatus(this.d.status())=JSON.parse(JSON.stringify(s))——宿主 status 可能携带 getter/toJSON（合法 JS），JSON 往返一次性求值全部宿主行为，后续任何序列化（页预算实测/入队序列化/缓存重发）不再触宿主代码——宿主行为在入队段重入（toJSON 内 invalidate→撤帧找不到未入队快照→退役旧快照排 4409 后）不可能发生。探针：F6/P-SERIAL-REENTRY（status 带 getter+toJSON 双计数→恰一次求值（toJSON×1，getter 不再被求值）+下游再序列化计数不增+帧内纯数据断言）。
- **F6-2 证据面原位闭合（披露 76 分主因）**：①TEST-MAP fix3 节探针固化行原位勘正（仅前两例真双微任务嵌套，NEWGEN=闸门覆盖）；②「最后窗口」句两处原位改（WS-GW:559 注释+F4-1 行：recheck2 门加入后本门为提交段第一道门非最后窗口）；③REWRITE 存活真因原位勘正（claimPublish 覆盖非双防线）；④identity 守卫原位勘正（三重：F4-1 门+recheck2+同步化）；⑤F5-4 行位置表述如实（NEWGEN 标注当时落 fix4 节，fix6 补齐原位）；⑥「六杀」计数勘正（实=5 组 KILLED/7 次失败用例+1 SURVIVED）；⑦fix5 档 M-F5-GATE 归因勘正（去门后推导值=observe 2/stop 1/release 0+孤儿观察+审计断言先失败）+M-F5-2c 标注合并变异不证各自必要。
- 变异三路（tests/fixtures/mutation-records/3b3-fix6.md，真实 diff+退出码+还原哈希）：M-F6-TERM KILLED（P-TERM-UNBIND）；M-F6-FREEZE KILLED（P-SERIAL-REENTRY）；M-F6-WRAP=当时 SURVIVED——原归因「纵深防御层无独占杀伤面」已**fix7 勘正推翻**：晚附 observe 未返回窗内收口+watcher 重挂失败时 wrap ok() 为唯一拦截者（GPT fix6 P7），专杀=F7/P-LATE-WATCH-FAIL+窄变异 M-F7-WRAP（见 3b3-fix7 节/档）。
- 终态：44 files **813 passed+7 skipped**+tsc0（根）+lint0（较 fix5 +6：F6-1×5+F6-3×1）。全套五跑中一次单例挂（未捕获用例名，紧接 JSON reporter 复跑 0 failed+后续三连跑全绿不可复现——同 fix2/fix4 抖动按实录入档）。

## 3b3-fix7 修复轮（GPT fix6 复审 84→修复；2026-10-01）
- **F7-1 终止分发全出口释放注册面（P6）**：deliverTerminal 收尾挪 try/finally——源级提前 return（srcDisposed）/回调异常等所有出口统一 entry.sinks=null。根因：dispose 只遍历当前 slot.entry/pendingEntry，已摘下的旧 entry 无人清；宿主长持 stop 闭包经 entry→Set 间接保留整套旧 sinks 链。探针 F7/P-TERM-RETAIN（TERM-DISPOSE 同场景+事前捕获 entry 引用→断言 sinks===null）。
- **F7-2 晚附窗 wrap 门独占杀伤面（P7；fix6 档「全域无独占面」归因勘正）**：晚附 session-sub observe 未返回（unS 尚 null、session wrap 已在子源 entry.sinks）时同步收口该注册+紧接 session watcher 错误→重挂失败→deliverUnavailable("watch-failed")——HS 成员资格门全过，唯一拦截者=wrap ok()（st.closed）。探针 F7/P-LATE-WATCH-FAIL（B 先注册正常晚附，A 第 2 次 observed 审计点注入 stopA+failPaths+watcher.error→活 B 照收 watch-failed 恰 1、已收口 A 零终止、obs 摘 A、journal 面未楔死）。窄变异 M-F7-WRAP 转 KILLED；三处全域宣称撤回（本档 fix6 行+3b3-fix6.md+PROJECT）；F6/P-TERM-DISPOSE-UNAVAIL 措辞勘正（读失败面，watch-failed 面由本探针覆盖）。
- **F7-3 续页/H+1 冻结窗重入资格复核（P9/P10）**：servePageFrom freezeStatus 后 + H+1 补页 freeze 后各加 phase==="closed" 复核（按入口同语义 err4404；H+1 处 `as string` cast——freeze 窗内宿主可关引擎，类型不可见）+enterLive 加 closed 幂等门。旧病：freeze stringify 求值 toJSON 期间宿主 invalidate→引擎 close+撤帧→旧坐标快照排 4409 后漏出+done=true enterLive 复活 closed 引擎（H+1 路根本没走 freezeStatus 原样重演）。探针 3：F7/P-PAGE-REENTRY（201 行第 2 次冻结窗注入 invalidate→4409 后 4404 恰 1、快照恒 1 帧、新订阅新流）、F7/P-H1-FREEZE（3 行 live→H+1 冻结窗注入→无空页快照）、F7/P-SERIAL-GETTER（getter-only 无 toJSON：冻结恰一次求值+帧内纯数据——GPT P6「至少有 getter-only 或 proxy 直接例」）。
- 变异三路（tests/fixtures/mutation-records/3b3-fix7.md，真实 diff+退出码+还原哈希）：M-F7-1 KILLED（P-TERM-RETAIN）；M-F7-PAGE 双杀 KILLED（P-PAGE-REENTRY+P-H1-FREEZE；cast 落地后终态代码原样复跑）；M-F7-WRAP KILLED（P-LATE-WATCH-FAIL）。
- 终态：44 files **818 passed+7 skipped**+tsc0（根）+lint0（较 fix6 +5：F7-1×1+F7-2×1+F7-3×3）。

## 3b3-fix8 修复轮（GPT fix7 复审 84→修复；2026-10-02）

- **F8-1 页最终提交/返回资格覆盖宿主回调后的统一终检（GPT fix7 P8/P9/P10/P11）**：subscription-engine.ts 四处补 `(this.phase as string)==="closed"`→err4404——①handle 入口末页宽限窗（now=宿主回调，GPT P10 同型）；②缓存重发分支（此前完全无检查，P11）；③H+1 分支 estimateFrame 终判后（P8）；④servePageFrom 提交尾（est 填装/measure 终判/now 全部完成后、expectNext/lastPageAt/rememberPage/enterLive/phase 写入前——终检后到返回零宿主调用=等效原子提交，P9/P10）。旧病：冻结复核之后仍调宿主回调→closed 后照写页缓存/expectNext/phase、返回退役快照；非末页 else 直接赋 paging 复活；401 宽限 now 同型。
- 探针 8（引擎直测 7+网关整合 1）：P-PAGE-EST-EVENT（estEvent 关）/P-PAGE-EST-FRAME（分立端口）/P-PAGE-NONFINAL（401 条 done-else 不复活）/P-H1-EST（H+1 estFrame 关，空页不入缓存）/P-CACHED-EST（缓存重发）/P-GRACE-NOW（宽限窗）/P-PAGE-NOW-ENGINE（提交尾 lastPageAt=now() 关——GPT P10 引擎序列直测）/P-PAGE-NOW（网关整合：now→invalidate→4409 先于 4404、快照恒 1、新订阅新流；注=arm 实际在网关分发层 now() 早触发，该例证真实系统防线，引擎提交点杀伤=P-PAGE-NOW-ENGINE）。
- **F8-2 披露强度落到实物**：fix8 变异档全真实 unified diff+失败断言原文+退出码+还原哈希（tests/fixtures/mutation-records/3b3-fix8.md）；fix6 档 M-F6-WRAP 原结果段原位加撤回声明（仅解释当时两例）；fix7 档原自然语言摘要=不重建当时记录，加「fix8 重演勘正」节指向新复跑证据；F7/P-H1-FREEZE 测试注释勘正（H+1 分支不调 enterLive，旧病=退役空页漏出）。
- **F8-3 终态回归产物绑定基线**：全套机器 JSON=tests/fixtures/run-records/3b3-fix8-vitest.json（833 total/passed 826/skipped 7/failed 0/success true，干净基线 c25d0815 生成——变异态下曾生成一次，发现后重生成覆盖，事故如实入变异档）；tsc0（根）+lint0；新增用例清单=上列 8 探针（818→826）。
- 变异（3b3-fix8.md）：M-F8-COMMIT 三杀（P-PAGE-NOW 网关例合法存活=分发层防线，如实标注）；M-F8-H1/CACHED/GRACE 联合跑各杀各口；跨轮重演 M-F7-1/M-F7-WRAP KILLED、**M-F7-PAGE 窄变异 fix8 基线合法 SURVIVED（F8-1 纵深覆盖，杀伤归因移交 M-F8-COMMIT/H1；复合四口同删 KILLED 双探针）**。
- 终态：44 files **826 passed+7 skipped**+tsc0（根）+lint0（较 fix7 +8=上列探针）。

## 3b3-fix9 修复轮（GPT fix8 复审 84→修复；2026-10-03）（GPT fix8 复审 84→修复；2026-10-03）

- **F9-1 预算失败出口先验 closed（GPT fix8 B9-1 P8/P9/P10）**：subscription-engine.ts 四口——①缓存重发估帧；②H+1 估帧；③servePageFrom 终判循环（measure 返回后）；④退空判定口——全部改为「宿主回调求值与预算结果解读分离：先验 closed→err4404，再消费超限判定（真超限仍 4431）」。旧病：回调内宿主关引擎后返回超限→旧序立即 close+4431 抢盖既成关闭事实、绕过 F8-1 终检。对照（未关闭真超限→4431）=既有⑲+F9/P-BUDGET-NOCLOSE。
- **F9-2 真网关提交点整合例+注释勘正（GPT fix8 Y9-1/Y9-2）**：新增 F9/P-PAGE-NOW-COMMIT（freeze 内 arm、pageAt=now() 触发 invalidate→4409 先于 4404、快照恒 1、观察收口、新订阅新流；双条件等待使变异首败落在快照计数断言非 until 超时）；P-PAGE-NOW 注释勘正（arm 实际=入站帧时钟 ws-gateway.ts:321，非 :408；该例=网关级防线例，engine.handle 未及调用）；P-H1-EST 加缓存长度直证（recentPages.length===0，重发 4404 属入口拒不能独立证缓存空）；P-GRACE-NOW 旧注勘正（删门后落状态门 4409，非「退役首页」）。
- **F9-3 变异实物入仓+归因勘正（GPT fix8 D9-1/P16/P17）**：新增 tests/fixtures/mutation-records/patches/{fix8,fix9}/ 共 9 个入仓 unified diff（含重建带文件头的 m-f8-commit.diff）；fix8 档 P16 归因勘正（复合杀伤首败断言=**快照计数** expected 2 to be 1 @ws-gateway.test.ts:2880/:2920，非 4404 计数；六口复合重验实证）；fix7 档全称勘正（M-F7-WRAP 门属 fix6 已有，非 fix7 新增）。
- 变异（3b3-fix9.md）：M-F9-BUDGET 四口先验删除→4 定向探针 KILLED（断言=4431≠4404）；NOCLOSE 对照存活（4431 语义保留）；M-F8-COMMIT 重演双杀（引擎序列+新真提交点网关例，后者=expected [snapshot…] to have length 1 but got 2）；**复合四口在 fix9 基线 SURVIVED（F9-1 先验与 F7-3 冻结复核同窗纵深叠加，如实记录）→六口同删才 KILLED（快照计数首败）**。
- 终态：44 files **832 passed+7 skipped**（JSON=tests/fixtures/run-records/3b3-fix9-vitest.json）+tsc0（根）+lint0；运行清单（前后哈希+命令+退出码+事故节）=tests/fixtures/run-records/3b3-fix9-run-manifest.md（fix9 增量 +6=引擎 5+网关 1）。

- fix10（Y10 窄清，随 3b-4 开工清偿）：NaN 谓词回旧形 measured<=B（F10/P-BUDGET-NAN 探针+M-F10-NAN 杀，patches/fix10/）；fix8/fix9 档文案勘正（:321/估算窗/六口标题/SHRINK-EMPTY 注释）；manifest 命令补全+诚实边界。终态 833+7。

## 3b-4 恢复证据面（typed 真读源；2026-10-03）
- **真源 provider**：apps/server/src/runtime/recovery-evidence-source.ts——createRecoveryEvidenceProvider({roots,sessionRoots?,sessionFor?,maxCombinedBytes?=8MiB,sessionIdFor?=去.jsonl,statLike?,readLike?})→(file,signal?)=>RecoveryEvidenceResult：snapshot|unavailable{read-failed|concurrent-modification|oversized|no-evidence-snapshot}|file-unreadable{path,detail?}。合计预算=journal stat+session stat（session ENOENT 降级=0，其余 stat 错=file-unreadable）→超=oversized 早拒（不读才拒，审计带三元组）→有界读（maxBytes−sSize，+1 探增长）→**读后取消检查+字节纵深复核（raw 非 null 也验长：注入/演进防护）**→parseJournalText→快照。resolveWithin（无分隔符+resolve 幂等）。R1-R10 单测：预算边界−1/=/+1、合计口径、UTF-8 字节、检查后增长、ENOENT/权限、读前/读中取消、撕裂尾入 bad、真 8MiB 档。
- **网关 typed 映射+连接级取消**：ws-gateway opts.recoveryEvidence 放宽为 (file,signal)=>Result|null|Promise；unavailable→帧 reason 原样+审计 recovery-unavailable；file-unreadable→帧 read-failed（契约冻结集归并）+审计 recovery-unreadable(path,detail)；ConnState.abortCtl：两路 close（closeConn/传输关）均 abort→provider 停读。T1-T4 探针（typed 映射×2+挂起传输关 abort+应用关 abort；closeConn 私有→测试经 cast）。
- **组合根接线**：composition.ts 建 provider（roots/sessionRoots/sessionFor/maxRecoveryCombinedBytes 配置门 1..1GiB）传 WsGateway；「不在本层」注释移除。
- **真集成**（tests/integration/recovery-real.test.ts，真 startServer+真 ws+真文件）：I1 501 意图多页完整 ID 集无重不含缓存后追加+同 hash 续页冻结+无 hash 新快照 total 502；I2 真路径注入预算合计超→oversized 帧+审计；I3 journal 缺失→read-failed；I4 撕裂尾真源→blockedReasons 含 torn-tail+resumable 空。坑：replayIntents 按 sessionId 过滤（journal.ts:68）——sessionIdFor 默认=文件名 stem（生产不变量：journal 文件名=会话 id，异映射宿主注入）。
- 变异（3b4.md+patches/3b4/）：M-3B4-BUDGET（stat 层删→R2 审计断言杀；结果断言不杀=读窗纵深兜底，独占面=早拒审计行）/M-3B4-GREW（复核删→R4 注入杀）/M-3B4-ABORT（读后取消删→R10 读中取消杀；R6 读前取消只命中入口检查，初跑 SURVIVED→补 R10 转杀）。全部真实 diff+退出码+首败断言+还原哈希同值。
- 终态：46 files **851 passed+7 skipped**（JSON=tests/fixtures/run-records/3b4-vitest.json）+tsc0（根）+lint0。

## 3b-4 fix12（GPT 第 12 轮三阻断修复：冷启动权威门 v3；2026-10-03）

- 源码面（recovery-evidence-source.ts v3 / composition.ts / ws-gateway.ts 注释勘正）：
  - B12-1/Q02/Q03：锚点缺失≠首捕授权。seen.json 登记仓（{version:1,files:[]}，损坏/不可读=
    read-failed fail-closed）；已登记 file 锚丢失→concurrent-modification（bless 不可越，审计
    recovery-evidence-lost）；未登记默认 no-evidence-snapshot（审计 recovery-no-first-authority）；
    仅宿主 trustFirstCapture（composition 配置 trustFirstRecoveryCapture，默认关）建首锚。
  - B12-2/Q05：session 首开 missing 保留映射（s1=0），读后二开复核新建尺寸；仍 missing=journal-only。
  - Q17：零长锚也验 sha==H(empty)（去 len===0 直通特判，64×0 伪锚必拒）。
  - Q20：toUnreadable 非 SafeOpenError→detail=errno code/构造名（不透传 message，防绝对路径入审计）。
  - Q14：serialize 链尾所有权条件清理（Map 不永久留键）。
  - 工厂补面：roots 空/相对 sessionRoots 拒（纵深于 composition 三态矩阵之外）。
  - readBounded 接缝化：BoundedReadHandle 结构接口（内层单测可注入）。
- 测试面（基线 886=879 passed+7 skipped，fix11 基线 868 之上 +18）：
  - R20-R27（recovery-evidence-source.test.ts）：默认拒/bless 正例+锚形状+seen/锚丢失不可越/
    missing→新建复核（sessionOpens==2）/持续 missing=journal-only/零长伪锚+合法空首捕/工厂补面
    （含 1GiB 放 1GiB+1 拒）/detail 脱敏。
  - S1-S5（safe-open.test.ts 新档）：readBounded 分次循环/EOF/读中硬限/恰等上限/异常归类。
  - T5b+T6（ws-gateway.test.ts）：迟到 resolve+reject 双面零帧+信号量归零；LRU 驱逐实证
    （9 条驱逐最旧→旧 hash 续页=miss 重调 4409；幸存条目零重调）。
  - composition.test.ts：maxRecoveryCombinedBytes 三态矩阵（非法五态拒/省略+1GiB+有限值接受）+
    trustFirstRecoveryCapture boolean 接受。
  - I5（recovery-real.test.ts）：真实 sessionFor→session 文件计入合计预算（超→oversized
    session=400；宽→available）。
  - T2 补锁 message 字面量「恢复读取失败」。
- 变异八连（patches/3b4-fix12/）：NOAUTHORITY/SEENLOST/MISSINGRECHECK/ZEROLEN/FACTORY2/DETAIL/
  LRU/BLESSWIRE 全杀（R20/R22/R23+R24/R25/R26/R27/R4b+T6/I1+I4+I5）。
- run-record：run-records/3b4-fix12-vitest.json（886/879/7/0）。

## 3b-4 fix13（GPT 第 13 轮 B13-1/B13-2：仓级串行+登记不变量；2026-10-03）

- 源：recovery-evidence-source.ts v4——①serialize 仓级单链（同实例全 file 串行，seen 读改写事务化，跨 file 并行首捕不丢登记；O(1) 单链尾，Q14 随之消解）②seen 恒读（有锚也读；损坏/不可读→read-failed fail-closed）③登记不变量：成功返回快照前 seen 登记已建立——有锚未登记（B13-2 残局/fix11 旧锚迁移）验证纯追加后补登记再返回 ④tmp 名加 randomBytes(6) 独占量。
- 测试：R28（双首捕并发→登记并集+丢锚拒）/R29（残局补登记全链+占位目录 fail-closed+零 tmp 残留）/R30（损坏仓恒读拒）/R31（bless 抛错→read-failed+锚/登记零落盘）；composition 轮询×预算笛卡尔（tokenPollMs 省略/0/50 × 非法七态拒/合法三态收——B13-3① 补 0 与 1）；T5c（迟到成功快照：零帧+死连接 recoveryPages 空+槽归零）/T4b（公开关闭入口 r.dispose 也触发 abort，dispose 幂等）/T6 补帧增量断言（e9 续页=第二帧）。
- 变异三连（3b4-fix13.md+patches/3b4-fix13/）：SERIAL→R28 / BACKFILL→fix14 重跑勘正=五杀 R21+R22+R28+R29+R32（裸跑 EXIT=1；R28 实际首败=:593 读 seen ENOENT 而非并集断言）/ SEENALWAYS→R29+R30；还原 sha b5304a6324e6c245；tmp 独占名无变异（如实记卫生面观察）。
- 披露就地收口（B13-4）：集成文件头 4402 勘正/3b4-fix11.md「三态矩阵既有例」勘正/TEST-MAP fix11 节 sha 字段名+退出码口径勘正/T5、T5b 标题限定（成功面=T5c）/3b4-fix12.md LRU 首败顺序勘正/provider 头 v4 部署前提（evidenceDir 可信目录+Q12 提交时点）。
- 终态：tsc 0/lint 0/vitest 47 files 885 passed+7 skipped=892（基线 886，+6）。（fix14 勘正原位指针：本行「tsc 0」不实——composition 轮询矩阵 delete-readonly 两错被管线口径吞，fix14 已修复并立规裸跑直录；原始输出自 fix14b 起入 run-records）


## 3b-4 fix14（GPT 第 14 轮 88/100 GO 后 Y14 非阻断收尾；2026-10-03）

- 源（v4.1）：persistSeenLike 接缝（默认=tmp+rename+失败清 tmp；测试注入端口拒绝）+锚/seen 写失败 tmp 尽力清理（Y14-1「源码 catch 没有 unlink」收口；fix14b 勘正：清理=实现成立、测试证明不足——仅覆盖 rename 前抛错，崩溃窗不承诺）。
- 测试：R32=persistSeenLike 端口拒绝全链（首调抛错→read-failed detail=seen-store+锚已留+登记缺→清障重试→补登记→快照；calls [1,2]；fix14b 勘正：非默认 write/rename 的 OS 级故障实证）；Y14-2 fixture 去强转×6——`repaired:[]`→`false`、弃双重强转，揪出并修复两类潜伏假 fixture（snapOf 的 {raw,parsed} 假 JournalLine→真字面量；lines 数组 widening→`JournalLine[]` 直约束）；composition 轮询矩阵 readonly 面走可变别名。
- 变异二连（3b4-fix14.md+patches/3b4-fix14/，全裸跑直录退出码）：BACKFILL-RERUN 全禁登记→五杀 R21+R22+R28+R29+R32（EXIT=1；证实第 14 轮静态推演+R32 增杀）；NARROWBACKFILL 只删有锚补登记→双杀 R29+R32（首捕登记不受累——补登记分支独占杀伤窄面证明）。
- 披露就地勘正×4（Y14-3）：TEST-MAP:620 锚 schema 实字段 sha；fix11 退出码仅 ANCHOR 裸码实证；fix12 LRU「次败」=推演非实录；fix13 BACKFILL 三杀→五杀（R28 首败实为 :593 读 seen ENOENT 非并集断言）。
- fix13「tsc 0」断言不实勘正（composition delete-readonly 两错被管线吞）——fix14 起 tsc 一律裸跑直录 TSC_EXIT。
- 过程失误实录：BACKFILL 首次重放在未提交态上做，checkout 还原吞掉 v4.1 源改动——重放+先提交再变异（M-240 同型教训再确认：变异前基线必须已提交）。
- 终态：tsc 0（裸码）/lint 0/vitest 47 files 886 passed+7 skipped=893（基线 892，+1=R32）。
## 3b5-3（PROJECT 3b-5：迁移执行面——宿主显式初始化路径旧锚/旧仓迁移工具；2026-10-03）
- 源=apps/server/src/runtime/evidence-migration.ts（新）：migrateLegacyEvidence(opts)——roots 递归枚举 *.jsonl，显式迁移窗口（trustFirstCapture 恒 true，仅限本工具创建的 provider 实例生命周期）内逐文件经 createRecoveryEvidenceProvider 权威化，全部语义（纯追加前缀拒/首锚/补登记/串行）复用 provider 接缝不复制：bless 包装=fresh 形态计数（legacy-anchor 不询及→source 判定）；fsx.rename 包装=fs 直通+seen.json 归位观测（migrated/noop 幂等判据）；audit=逐文件行收集。拒绝 fail-closed 直传：不补登记不动锚（provider R38 既有语义），工具只如实记录。返回迁移验收记录（每文件 outcome/source/锚 len+sha/registered/拒绝原因/审计行；整体 evidenceDir+roots+起止+计数+拒绝清单），不落盘。
- 测试 MG1-MG11（tests/unit/server/evidence-migration.test.ts，11 it；设计先写文件头注释≤90 行）：MG1 正常迁移（含空仓先行+时钟注入断言）/MG2 旧锚补登记 legacy-anchor/MG3 幂等重跑 noop（seen 原字节）/MG4 截断拒（锚+seen 原字节、审计行唯一原文）/MG5 同长改写拒（oldLen==newLen）/MG6 越根拒 symlink（POSIX-only，R16 先例）/MG7 混合四文件审计行逐条+字典序+计数/MG8 session 映射越界拒（透传中文 detail）/MG9 seen 仓损坏→registered=unknown/MG10 嵌套枚举（锚名 encodeURIComponent）/MG11 超预算拒（maxCombinedBytes=10 小预算例）。
- 变异三连（3b5-3-migration.md+patches/3b5-3/，全裸跑直录退出码，还原后 sha256=提交版复核）：M-3B5-BLESSWIN（bless 恒 false）→ 4 杀 MG1/MG3/MG7/MG10，首败 MG1，MG2 仍绿=旧锚路径不询 bless（B15④佐证）；M-3B5-PUREAPPEND（provider:388 纯追加验删，临时未提交 patch，变异态 tsc 0）→ 双面杀：工具 MG4/MG5/MG7（首败 MG4：截断被放行且补登记）+provider R11/R12/R25/R38——接缝真实委托无工具层旁路；M-3B5-IDEMPOT（seen.json 归位观测删）→ 5 杀 MG1/MG2/MG3/MG7/MG10，首败 MG1（迁移误报 noop；MG3 首跑即需 migrated=1，双向锁定）。
- 证据：run-records/3b5-3-vitest.json=913/906/7/0（基线 902=895+7，+11）+3b5-3-vitest.log（默认报告器+裸退出码 0）；3b5-3-tsc.log=TSC_EXIT=0；3b5-3-lint.log=改动两文件 LINT_EXIT=0；三变异完整输出=3b5-3-{blesswin,pureappend,idempot}-mutation-full.log（首败均从 FAIL 块归属，未跨块摘句）+3b5-3-pureappend-mutation-tsc.log。
- 已知限制（如实）：多 root 同名相对路径先根先读（provider resolveWithinRoots 既有，记录按逻辑名去重）；枚举含 symlink/FIFO 名交 provider 拒；registered/anchor=盘面只读报告非证据链判定；工具不覆盖 B15⑥ 四接缝的自定义实现注入面（provider 侧 R32/R39/R40 已覆盖）。
## 3b5-2b（第17轮 92/100 GO 收口批：证据与措辞收口；2026-10-03）
- 第17轮（审报=~/ai audits/gpt-adapter-3b5-2-review-2026-10-03.md）：92/100 GO——**不认可「尾项全清」**；未清项=证据（SERIAL 首败归属矛盾+变异完整输出缺）与措辞（旧档未原位撤回、注释未同步）。
- R39b 默认持久化路径首杀配套（只拒首次 fsx.writeFile 且**不注入 persistSeenLike**）：吞锚错变异下默认 seen 算法照走（fsx 第 2+ 次写健康）→seen.json 落成→快照洗白→R39b 杀（首败 `expected { version: 1, file: 's.jsonl', …(6) } to deeply equal { kind: 'unavailable', …(1) }`）——堵「默认 persist 分支错误」盲区。
- R40 加固：残留身份断言（唯一 tmp 以 `seen.json.tmp-` 开头，路径级不再靠序号推演）+重试成功不追溯清理孤儿（旧 tmp 仍在=无静默删除）。
- SERIAL 完整输出复跑+首败归属勘正（R37=bOpens 侵入；并集断言属 R28；教训=首败必须从 FAIL 块归属，不得跨块摘句）。
- provider 接口注释 B15⑥ 分拆同步（:26-29 接缝契约注释+FsLike JSDoc；异步拒绝契约特化=仅 Promise 型原语，trustFirstCapture 允许同步 boolean）。注释级改动，逻辑未动。

## 3c-3（composition 写侧接线：session-registry+statusFor 真源+统一销毁；19d 轮 92 GO 放行；r20 修复批 2026-10-04）

### r21 修复批（20b 裁决 83 NO-GO：B1 dispose 同步重入窗口+B2 E4 身份反推/在飞不成立；基线 6125e52→b416997）
- B1（中）：session-registry dispose 收尾体压微任务（`disposeP = Promise.resolve().then(async () => {…})`——先发布后执行，IIFE 同步段先跑会把 disposeP=null 暴露给 host.stop 同步重入→空表捷径提前完成）。SR13=受控信号下 host.stop 同步重入（发布已先于外部回调，重入共享同收尾不提前完成/不提前 disposed 审计）；SR14=审计回调同步重入（含空表，恰一次 disposed 不无限递归）。M10 变异（恢复直接 IIFE）双杀 SR13+SR14。
- B2①观测面：SessionRegistryOpts.onSpawned?(file,handle,generation)（file=journal 绝对路径闭包包装）→RpcSession opts 透传；composition WriteWiringOpts.onSpawned 透传。CW11=CAT_WRITE+onSpawned 收 spawns[]，断言 {file:join(dir,"s1.jsonl"), id 非空, generation:1}。M11 变异（透传短路）单杀 CW11。
- B2②E2E 重写：E4=LONG 提示词拉长在飞窗→launched→等 onSpawned 身份（findSpawnFor，不事后反推）→snapshot 判活 inFlightAt（sending 已现且 settled 未现；false=continue 换文件重试）→dispose<30s→窗口处理（post 出现 settled=窗口内收口 continue；server 已 dispose 下轮循环顶部重启）→exit handle=rec.id→disposeChain(audits,rec.id,a0) 全序断言；E2=审计边界 a0+assertExitShape（{}/[]/缺字段/双空拒）+绑定 handle 索引比较+no-process 分支零 stop 行；E3=新 intentId 显式+三索引含 sending≥before.length+Number.isSafeInteger(generation)。
- **r21 批内根因修（E2E 首败）**：真实审计行带模块前缀（`process-host stop handle=proc-1 signal=SIGTERM`），旧 startsWith 匹配漏前缀行致 E2/E4 假败两轮；e2e-evidence.ts 改 token 级正则 stopLineFor/exitLineFor/stopHandleOf（前缀无关+token 边界 proc-1≠proc-11），E2/E4 失败自带审计尾部诊断，H15-N5 锁根因（带前缀链命中+边界诱饵）。E2E 三跑：两败（根因）→修后 4/4 双档。
- 证据（r21 档）：全量 verbose=1010 passed+11 skipped（1034 行 3c3-r21-full-vitest.log；r20=970+11，增量 40=A1a 前端 31+SR13/14 2+CW11 1+H15-N1..N4 5+N5 1）；tsc 全仓 exit 0+eslint 全仓 exit 0（含 E2E 档）；E2E 双档 4/4（3c3-r21-e2e-vitest-{1,2}.log）；六变异全杀（3c3.md r21 段+run-records/3c3-mut-*.log r21 复跑覆盖）。
- mutate 脚本升级：HEAD 实时 rev-parse（弃硬编码）；每变 git status 原始输出入档；M10 两锚点成对替换结构（MUTS 改替换对列表）。

### r20 修复批（20 轮 79 NO-GO 三阻断+尾项；基线 beede1f）
- F3（registry 并发 dispose 第二等待者提前 resolve）：session-registry.ts 增 `disposeP` 共享收尾 Promise——首调用者起异步收尾，并发第二等待者复用同一 Promise；SR12=受控挂起 close gate→p1/p2 均未决→release→均完成+closes==1+完成后重复 dispose 仍成功+拒建 throw"已销毁"；M9 对应变异单杀 SR12。
- stats 活动窗口旧值：idle-reaper stats() origin=Math.max(idleSince, lastActivity??idleSince)（吸收 noteActivity 后 lastActivity；S5-R2=900 活动 950 读=elapsed 50 非 950；isFinite 非 narrow 须显式判 null）。
- E2E 全重写硬化（见上 E2E 行）；SR8 拆分（在飞面/idle 面）；CW6 补审计读断言（M8 由 CW6+CW9 双杀）；CW8 标题缩词（允许 idle/running/stopping 任意，去「退 idle」强断言口径）；tsc 修补三处（release8!/release14! 非空断言、DTO 联合窄化 cast、Frame[k:string]:unknown 窄化）。
- 尾项勘正汇总：writeHost 措辞/六超时参含 eofGraceMs/statusVersion=非 liveSeq/全量档 993 行/E1-E4 与 SR8/CW6/CW8 标题与断言对齐/版本全等/E2E 进 eslint 面+双档。
- 注册表（apps/server/src/runtime/session-registry.ts）：createSessionRegistry{host,sessionFor,durabilityFor?,超时参,now?,audit?}→sessionFor(file) 同步幂等缓存+零 IO（失败面只剩映射校验抛描述性 Error，失败不留缓存可重试）/files() 排序快照/statusFor(file) SessionStatus 真源/dispose() 全量串行 stop→dispose+幂等+销毁后拒建。sessionId=sess-sha256Hex12(file) 确定性跨注册表。增补观测（additive）：idle-reaper stats() 纯读三值+rpc-session getState() 增 readyGeneration+reap。
- statusFor 真源映射：turnOf(gate) 穷尽（closed reason 白名单外回 idle）；process.ready=getState().readyGeneration===supervisor.generation；bg={availability:known,activeCount:idleRegistry.activeCount()}；reap=st.reap??占位；recovery 恒 UNKNOWN_RECOVERY（读侧异步面不在此重复声称）；statusVersion 恒 0 披露（r20 勘正：递增的是订阅引擎 liveSeq（subscription-engine.ts:363），statusVersion 非其计数——旧文「订阅引擎自有递增」所指为 liveSeq，勿混）；serverTimeMs=Date.now()。
- 接线（composition.ts）：ServerConfig.write{sessionFor 必填,piBin,六超时参（response/turn/readiness/timeoutPoll/idleMs/eofGraceMs——r20 勘正：旧文「五超时参」漏 eofGraceMs）}（writeHost 与 write 同供→拒启；都不供=合法只读部署；write.sessionFor 非函数拒启。r20 勘正：旧文「同供或都不供→拒启」把合法只读也写成了拒启）；write→PiProcessHost+createSessionRegistry；gateway statusFor=registry.statusFor(**resolveWithinRoots(file,config.roots)??file——订阅面客户端裸名与写面 abs 两形态归一，CW8 暴露后修复**）；writeHost=createRpcWriteHost({sessionFor:registry.sessionFor,audit})；dispose 序=gateway→adapter→await registry.dispose()→tokens（网关先告别再杀进程）。
- 测试 SR1-SR11（tests/unit/server/session-registry.test.ts）：同 file 同实例/映射非法三态拒绝可重试/未构造 baseStatus 语义/已构造 idle bg known/透传对照 sessionId 一致性/dispose 全量串行幂等销毁后拒建/SR8 在飞（start 等待窗）dispose 先 stop 真调宿主+SR8b idle 零 stop 原断言（r20 拆分：旧 SR8 标题称在飞却从未 send）/耐久 close 拒被 RpcSession 层隔离（registry 自层 catch=纵深防御无注入口不假测，SR9 勘正：RpcSession.runDispose 内层 .catch 已隔离，audit rpc-session durability-close-failed 可见）/durabilityFor 恰调一次/audit 抛错不影响。
- 测试 CW1-CW10（tests/unit/server/composition-write.test.ts，真链=/bin/cat 回声不答探针→确定性 readiness-timeout，无 LLM）：CW1/2 拒启两案/CW3 prompt→not-ready(readiness-timeout)+审计 created+readiness+**process-host exit（退役链真进程退出证据，改原无意义断言）**/CW4 两 prompt 恰建一次/CW5 stop idle→no-process/CW6 readiness 等待期 dispose 15s 内/CW7 订阅快照 sess- 派生+phase idle/CW8 构造后快照 bg known 0（**靠 resolveWithinRoots 归一修复——两面 file 形态不同则 key 不命中**）/CW9 审计序 session-registry disposed 先于 composition disposed/CW10 越界 4404 不放宽。
- E2E（tests/integration/ws-write-e2e.test.ts，PI_E2E=1 门控默认 skip）：E1 prompt→launched→journal 意图+settled（真 pi 0.86.1 锁死，升级须显式改）/E2 stop 暖进程驻留→retire→confirmed{exit}+process-host exit 证据（已回收则 no-process，exit 证据仍须在场）——**首跑败因=错误假设 settled 后进程即退（实际暖进程驻留等闲置回收），修为 stop 驱动退役链**/E3 退役后冷启动新代次同会话文件（恢复验证）/E4 在飞轮次 dispose→30s 内+审计序。r20 硬化：版本=stdout.trim() 全等 0.86.1（旧 includes 弱断言弃）；journal=逐行 JSON.parse 结构化断言（非 substring）；E3=新 intentId 三行均落 before.length 边界后+enqueue.generation 严格递增（E1 gen1<E3 gen2，E2 已退役=冷启动代次证据；恢复面口径=同文件追加+代次连续，回答文本不在本仓 journal——诚实断言）；E4=只认 launched+s2 journal 出现该轮 sending 行（在飞检查点）后 dispose，审计序四点 stop handle=X<exit handle=X<session-registry disposed<composition disposed（X=最后一条 stop 的句柄）；E2=confirmed.exit={code,signal} 形状断言（code/signal 至一非空）。**已跑两轮双档 4/4（3c3-r20-e2e-vitest-{1,2}.log）**。
- 证据（r20 复跑档）：全套 verbose vitest=970 passed+11 skipped（993 行全档 3c3-r20-full-vitest.log，非旧摘要档）；tsc 全仓 exit 0（3c3-r20-tsc.log 空档）；eslint 全仓 0 含 E2E 档（3c3-r20-eslint.log 空档；npm 前置 export PATH=/home/yyj/.nvm/versions/node/v24.18.0/bin:$PATH）。E2E 两轮各自成档=3c3-r20-e2e-vitest-1.log+2.log（旧 3c3-e2e-vitest.log=单档双跑说明，r20 起双档）。
- r20 勘正：旧文全量日志标 969 行，实档初版 3c3-full-vitest.log=994 行（全档非摘要；r20 复核）；r20 重跑档 3c3-r20-full-vitest.log=993 行（970 passed+11 skipped）。旧勘正句「旧档=仅摘要的 27 行版本已弃用」作废——初版全量档实存且为完整档。
- 变异四连（3c3.md+patches/3c3/，r20 基线 beede1f；logs=run-records/3c3-mut-*.log 含 stderr+FAIL 块）：M6 REGISTRY-CACHE-BYPASS→2 败 SR1+SR10（**CW4 不杀：rpc-write-host 自带上层缓存把 sessionFor 调用收敛，registry 内层被绕过时组合面无感——两层独立缓存互为纵深，各自直测面正杀**）；M7 STATUSFOR-BASE-ONLY→2 败 SR5+CW8；M8 COMPOSE-DISPOSE-SKIP→2 败 CW6+CW9（r20 起 CW6 读审计；SR7 不在场：变异在 composition 层不触 registry.dispose 本体——旧文误写 SR10，勘正）；M9 DISPOSE-SHARE-DELETE→1 败 SR12（20轮F3 对应变异）。还原 hash 复核 OK×4，脚本=tools/mutate-3c3.py（try/finally 保还原）。

## 3c-2（RpcSession→WriteHostPort 适配首片：编码器收窄+注册表+W13-W17 加固；第19轮 78 NO-GO→r19 修复批；2026-10-04）
- 编码器（apps/server/src/ws/rpc-write-host.ts）：encodeSendOutcome 穷尽映射 SessionSendResult→WriteSendOutcomeDTO——launched.key{intentId,commandId,generation} 扁平化（**generation 不跨面**）；gate-failed.error:unknown 截断（细节留宿主审计）；not-ready.cause 可选透传；encodeStopOutcome 四分支同构（confirmed 复制 exit 不携引用）。
- DTO 收窄（contracts.ts，第18轮 GPT 勘正落定）：not-ready.cause 改可选（同源 SessionSendResult.cause?）；**rejected 分支删除**——send() 路径无此来源（启动失败一律 not-ready{cause:start失败kind}），无源不设枝。
- 宿主适配：createRpcWriteHost{sessionFor,audit?}——同 file 缓存=注册表语义（工厂只调一次）；内部异常=审计留细节+**剥离重抛** stripped Error（"write-host-internal: prompt|stop"）→网关 4402 retryable 通道（W9 已锁）；不吞错不造 kind；审计回调自身抛错被隔离。
- 测试 E1-E8+H1-H8（tests/unit/server/rpc-write-host.test.ts）：E=编码矩阵全分支；H=注册表缓存/分桶/工厂抛错/会话抛错/审计隔离/异步工厂。
- W13-W17（ws-gateway-write.test.ts，第18轮对抗推演四案）：W13=W5 分连接版（四坏帧各自 4404，空 text 第 4 案首次可观测+宿主零调用）；W14=容量门独立（4 不同 rid 在途→第 5 个 4404"在途请求超限"，非重复门）；W15=失败路径槽归还（prompt 4402 后同 rid 复用 stop/prompt 均成功）；W16=ack.file 显式回显裸名（与宿主面 abs 成对照）；W17=UTF-8 字节边界（恰 65536B 含多字节过；"你"×21846=65538B 拒且未达宿主）。
- 变异三连（3c2.md+patches/3c2/，基线先提交=752aed6 后变异；logs=run-records/3c2-mut-*.log）：ENCODER-FLATTEN（commandId+1）→2 败首败 E1；REGISTRY-BYPASS（缓存删）→1 败首败 H3；STRIP-RETHROW（剥离删，原错直抛）→3 败首败 H5。还原 hash 复核 OK×3。
- 证据：run-records/3c2-full-vitest.log=939 passed+7 skipped（~~925+16 新增~~ **历史错句：实为 +21（16 H/E+5 W），见下方 r19 段勘正与 19b 轮 GPT 核对（it( 计数：H/E 无文件→16→22（19c 勘正：原写 12→ 误）/ W 12→17→18）**）；tsc 两包 0+lint 0（当轮终端实录——**lint 无档，19b 轮确认提交档为 0 字节空件，补跑见 3c2-19b-lint.log**）。
- 诚实披露：①strip-rethrow 只变异了 prompt 通道（stop 通道同型代码，H5 的 stop 断言覆盖同路径）；②编码器对 error:unknown 的截断是设计而非缺陷（E3 断言 stage 保留+error 字段缺失）；③createRpcWriteHost 的 sessionFor 接缝=结构化依赖（RpcLikeSession 两方法最小面），真实 RpcSession 实例构造与 composition 接线（writeHost=createRpcWriteHost(...)+sessionFor 闭包）属下一片（3c-3），本片不含真进程 E2E。

### 3c-2 r19 修复批（第19轮 78 NO-GO 三阻断+异常边界；基线 6e5f12c；953 绿）
- **F1 注册表 single-flight**：sessionOf 双 Map（settled+pending）——首次并发（含同步工厂重入）共享同一次创建；工厂调用压微任务后执行（pending.set 必先于工厂——同步 throw 也正确走身份删除，防 TDZ/陈旧占位）；失败清占位带 slot.p 身份校验→健康重试。新增 H9（同步并发 prompt+stop 恰建一次+同实例+后续缓存）/H10（异步工厂并发 deferred 共享）/H11（失败共享+重试恰再建一次）。槽对象持引用绕开 tsc 赋前使用与 eslint prefer-const 两难。
- **F2 证据**：全量 run-records/3c2-r19-full-vitest.log=946 passed+7 skipped（953；r1 批 +21=16 H/E+5 W，r19 批 +7=6 H+1 W15b，两批共 +28）；tsc 两包 0（3c2-r19-tsc.log）~~；lint 0 有原始输出与裸退出码（3c2-r19-lint.log）~~ **（19c 原位勘正：r19 时 lint 档为 0 字节空件，本句过称作废；补跑档=3c2-19b-lint.log，已由 19c 轮 GPT 采纳）**；时钟漂移注记（宿主 date=2026-09-27 与档名 10-04 序列不一致，git 提交时间随宿主钟）；M1 次败勘正 E8→H1（3c2.md 原位注记）；增量口径勘正 +16→+21。
- **异常边界**：auditSafe 收 thunk（格式化纳入隔离域——恶意 toString/message getter 再抛不逃逸，H12 三例：恶意对象/恶意 message getter/附带字段零断言）；gateFailedDetail()=gate-failed 细节**截断前**落宿主审计（H14：audit 行含 stage+detail，DTO 仍无 error）；H13=会话 stop 自身拒绝剥离面；W15b=stop 失败槽归还复用（FakeWriteHost.throwStop）；W8/W14 死门改可释放 deferred+收束断言（释放后 write-ack 到齐+rid 复用）；E7 补 out.exit!==exit 引用独立；E8 定位勘正为 kind 集合冒烟（值断言在 E1/H1）；W5 头注勘正（空 text 案本连接曾被遮蔽，W13 分连接补齐）。
- **F3 契约文档统一**（两层契约三处同口径）：可预期业务结果→DTO kind；内部意外异常→剥离重抛固定 Error（无 cause 无内部字段）→网关 4402 retryable。write-host.ts:3-4 端口注/contracts.ts DTO 注/rpc-write-host.ts 头注。TECH B16 同步见 ~/ai 档。
- **变异 M4/M5/M5b**（3c2.md r19 段+patches/3c2/）：PENDING-SHARE-DELETE→3 败 H9/H10/H11（single-flight 三案正杀）；AUDIT-ESCAPE（thunk 原样传）→4 败 H5/H6/H13/H14（审计观察面）；AUDIT-FORMAT-ESCAPE（急切格式化）→3 败 H5/H6/**H12**（恶意逃逸面正杀）。双面锁死：不求值→观察案杀；求值越域→逃逸案杀。
- **披露**：①失败占位身份删除分支未单独变异（H11 间接覆盖）；②stop 通道格式化未单独变异（同构代码，H13/H12-stop 断言覆盖）；③composition 接线+真 RpcSession+统一销毁=3c-3（GPT 裁决：恰建一次是本片承诺，无失效 API 首片可接受，寿命绑定 3c-3 定清）。
- **19b 轮（84 NO-GO，仅 F2 证据门阻断）修复批**：①H12 getter 空覆盖修复——host2 补 audit 回调+getter 触发计数断言（getterReads>0 证格式化确实读取；audits2.length=0 证中途抛错整行隔离不半写入；旧断言方向写反已勘正）；②W8/W14 释放兜底挪 finally（幂等二放无害）+W14 补 rid 复用断言（errsBefore 计数法——旧 4404 帧仍在连接，按新增计数非存在性）；③W5 头注遗留错句勘正（本连接只证前三案，空 text 在 W13 分连接）；④M5c AUDIT-ESCAPE-VALID 类型合法变异（隔离域外急切求值+thunk 传已求值串，只改求值位置）——杀 H12 定向逃逸面，替代原 M5/M5b 的类型不合法混杂；⑤全量 vitest/lint 补跑落档（--reporter=verbose 完整输出+命令头+裸退出码+精确 SHA 标注，补跑不冒充历史实录）；⑥TEST-MAP 647 历史错句指针化。

## 3c-1（写侧帧接线：契约扩展+网关派发面+WriteHostPort；2026-10-03）
- 契约面（packages/protocol/src/contracts.ts）：WRITE_OPEN_FRAME_TYPES=["prompt","stop"]（冻结写集 9-t 中仅开放此二；其余仍 4405）；WRITE_TEXT_MAX_BYTES=65_536；WriteClientFrame=prompt{requestId,file,text}/stop{requestId,file}；validateWriteFrame（exactWrite 字段集全等+ridWrite /^[-\w]{1,64}$/+fileWrite=LIMITS.filePattern 裸名+text 非空+字节上限；不侵冻结校验器）；WriteSendOutcomeDTO（launched{intentId,commandId}/busy/gate-rejected/gate-failed/invalidated{stage}/no-process/not-ready{cause}/rejected{reason}——SessionSendResult 契约化映射，error:unknown 不跨面）；WriteStopOutcomeDTO（confirmed{exit}/deadline-exceeded/no-process/stopping）；ServerFrame 增 write-ack/write-stop-ack（回显原 file 裸名+requestId）。
- 网关面（ws-gateway.ts）：入站管线认证门后写类层分支（t∈WRITE_FRAME_TYPES&&writeHost!==undefined→validateWriteFrame→在途门→派发；未接线→原路径 4405+close1008 字节级不变）；handleWritePrompt/handleWriteStop：resolveWithinRoots 解析→宿主收绝对路径（宿主不重做根数学）→ack 回显裸名；宿主抛错→4402 retryable=true+审计 write-frame-error；rid 槽 finally 归还。审计行 write-frame conn=… t=… file=… outcome=…。
- 端口面：apps/server/src/ws/write-host.ts=WriteHostPort{sendPrompt(file,text)/stop(file)}（两方法不得抛错——抛错即 4402；映射归宿主 3c-2）。composition.ts ServerConfig.writeHost? 透传。
- 测试 W1-W12（tests/unit/server/ws-gateway-write.test.ts；12 例全绿）：W1 未接线 4405+1008（冻结不变）/W2 合法 prompt→ack+宿主收 abs+审计/W3 stop→stop-ack/W4 越界形 4404/W5 形状×4→4404（第 3 个即 close1002）/W6 未开放 t(send)→4405/W7 未认证→4401/W8 在途重复→4404 宿主一次/W9 宿主抛错→4402 retryable/W10 text>64KiB→4404/W11 槽归还同 rid 复用/W12 接线态读路径回归。
- 变异三连（3c1.md+patches/3c1/，基线先提交=6a3a124 后变异；完整输出 run-records/3c1-mut{1,2,3}-*.log）：WRITEBRANCH（写分支恒 false）→8 败首败=W2（write-ack undefined）；INFLIGHT（写在途门删）→1 败=W8；ABSRESOLVE（越根门+解析删，宿主收裸名）→1 败=W2（host 收 s1.jsonl 而非 abs）。还原=git hash-object 复核 HEAD tree（RESTORE_OK×3）。
- **诚实披露**：filePattern 限裸名（^[\w.-]{1,114}\.jsonl$）⇒裸名必在任一根内解析成功⇒handleWrite* 的"file 越界"分支在当前契约下不可达=纵深防御（防未来 filePattern 放宽）；W4 的 4404 实由 validateWriteFrame 格式层出（"/etc/passwd" 不过裸名正则）——越界门无独立杀面，非缺口而是死分支披露。
- 证据：run-records/3c1-full-vitest.log=907 passed+7 skipped（902+12 新增）；tsc/lint 裸码 0（当轮终端实录）；基线提交 6a3a124。
- **首跑时间线（第 18 轮披露补档）**：W 矩阵首跑 12 案 5 败（W2/W3/W8/W9/W11=全部合法派发案；错误路径 7 案全过）——根因=测试发绝对路径 file 违反 filePattern 裸名契约（LIMITS.filePattern 拒收→4404"file 非法"）；修正=宿主收解析后绝对路径+ack 回显裸名（生产语义不变），测试改发裸名后 12/12 绿。非生产码缺陷，生产分支逻辑首跑即正确。
- tsc/lint 可复现实录（第 18 轮补档）：run-records/3c1-tsc.log、run-records/3c1-lint.log（三包/两文件裸码退出码 0）。

## 3b5-2（第16轮 92/100 GO 尾项：R36 独立首杀+seen 门残留面+R37/R38 加固；2026-10-03）
- 测试 R39-R40（40 例文件）：R39 锚首写仅一次失败（后续原语健康）→read-failed+writes==1+seenPersists==0+零落盘——吞锚错变异独占首杀面（3b5-2 实证 R39 杀）；R40 seen 门 rename+清理 rm 双拒（锚已提交）→read-failed（detail=seen-store）+残留=seen tmp（锚在场区别于 R35 锚门残留）+默认重试收敛。
- 加固：R37 entered 屏障（persist 入口即 resolve，await 5s 超时竞速，弃 50-tick 猜测）+finally 无条件放闸+allSettled 收束再删目录；R38 逐字节原文比对（seen/锚全文件内容，弃字段抽查——第16轮「原文不动」措辞兑现）。
- 变异二连（3b5-2.md+patches/3b5-2/）：ANCHORSWALLOW2 复放→R39+R35+R39b 三杀（完整输出=run-records/3b5-2-anchorswallow2-mutation-full.log）；SERIAL（chain→per-file Map）→R28+R37 双杀（完整输出=run-records/3b5-2-serial-mutation-full.log；**第17轮勘正：R37 真实首败=`expected 1 to be +0`（bOpens 侵入），并集断言属 R28**——初版摘句误挂 R37，已原位勘正）。
- 证据：run-records/3b5-2-vitest.json=901/894/7/0；3b5-2-tsc.log/-lint.log 裸码 0；3b5-1-lint-firstfail-repro.log=首次 lint 失败诊断复现（6c320ba 版原文重跑，诊断文本原样保留）。
## 3b5-1（第15轮 §六②③④：确定性故障回归+受控并发+接缝契约；2026-10-03）
- 源（v4.2）：fsLike 低层原语接缝（writeFile/rename/rm）贯穿锚点写+默认 seen 持久化（默认=真 fs/promises；生产 composition 不注入——受信任宿主边界契约随 persistSeenLike 文档同步收口：resolve=完整提交）。语义无变化（默认路径与 v4.1 逐操作一致）。
- 测试 R33-R38（38 例文件）：R33 seen tmp 写拒→read-failed+锚留+tmp 尽力清+重试收敛；R34 rename 拒（tmp 已建）同面；R35 清理 rm 自身失败→仍 read-failed 不洗白+残留=披露边界+成功不受阻；R36 锚写拒（首写）→read-failed+零落盘+bless 已消耗；R37 受控并发闸门（A 持链阻塞于 seen 提交时 B 连 journal 都未开——bOpens==0+persists==[1]；释放后双快照+seen 并集 [a,b]）；R38 有锚无登记+非法前缀（截断/同长改写）→concurrent-modification+不补登记+bless 不耗+锚原文不动。
- 变异二连（3b5-1.md+patches/3b5-1/）：M-3B5-CLEANUP（清理行移除）→R33+R34 双杀（BARE_EXIT=1）；M-3B5-ANCHORSWALLOW（锚吞错）→R35 杀。（第16轮勘正+3b5-2 实证：「R36 未杀=非缺口/第二道门独立闭合」撤回——那=失败注入耦合掩蔽（R36 恒拒所有写使 seen 门必然兜住）的纵深效果；独立首杀由 3b5-2 的 R39 承担：只拒首写后续健康，吞锚错变异 R39 独杀实证）
- 还原 sha=26086490878e1c96；run-record 3b5-1-vitest.json=899/892/7/0；tsc/lint 裸码 0（3b5-1-tsc.log/-lint.log 原始输出附档；lint 首跑抓 R35 未用参自纠实录）。
- **fix14b（第 15 轮 90/100 确认 GO 后尾项窄清）**：D20 补 diskBlocked=true 断言（repaired []→false 翻转=正确性修正非等价）；tsc/lint 原始输出入仓（run-records/3b4-fix14b-tsc.log/-lint.log，TSC_EXIT=0/LINT_EXIT=0）；变异档补可复制命令实录；上述四处措辞收窄原位落档；PROJECT 补真实 fix14/fix14b 段（第 15 轮指出的过称项）。


## 3b-4 fix11（GPT 第 11 轮五阻断修复：安全读 v2+证据链；2026-10-03）
- **v2 重构**：recovery-evidence-source.ts 接缝改 openLike（OpenLike=(abs)=>{size,read(maxBytes),close}；默认=safe-open 真路径：openSafeFile=O_NOFOLLOW|O_NONBLOCK+同 fd fstat isFile；readBounded=64KB 流式循环，n===0 EOF 止、累计超限即抛 too-large）——journal+session 双源全走安全打开。旧 statLike/readLike 删除。
- **证据链 sidecar（B11-2）**：evidenceDir 锚点 <encodeURIComponent(file)>.evidence.json={version:1,file,len,sha}（fix14 勘正：实字段名 sha，旧句写 sha256 不实）；纯追加扩展才过（新 raw 前 len 字节 sha 相符+新长≥旧长）；缩/重写→unavailable(concurrent-modification)；锚点损坏→concurrent-modification；锚点不可写→read-failed；同 file 捕获 serialize 串行化；原子 tmp+rename 写穿。跨实例（重启/驱逐）续链。
- **读窗双复核（B11-3）**：stat 层合计早拒（零读独占面）→读后字节复核 raw.byteLength>allowed→oversized-grew→读后 session 复核（二次 open size s2，raw+s2>max→oversized-grew）；缩/消失=已披露残余不回退（P06）。R19 补 P07 session 复核独占杀（seam 定序开：预检 400/复核 500）。
- **工厂自防御（B11-4）**：composition 预算校验移出 tokenPollMs 分支+provider 工厂自验（非法/超 1GiB/相对 evidenceDir/相对 roots 即抛）；R18 六非法值矩阵。sessionFor 映射非法（绝对/越界）→file-unreadable 响亮失败不静默 journal-only（P10；R13，嵌套合法）。
- **4402 映射（B11-5）**：ws-gateway file-unreadable→{t:error,code:4402,message:恢复读取失败,retryable:true,requestId}；审计带逻辑 file/detail 不带绝对 path（P12）。T2 改标；I3 真集成同断。
- 测试面：R1-R19（18→19 it）+T1-T5+I1-I4；变异五连（3b4-fix11.md+patches/3b4-fix11/）：ANCHOR→R11+R12 / SESRECHECK→R19 / SAFEFLAGS→R5+R16 / FACTORY→R18 / 4402→T2，退出码=1（fix13 勘正披露口径：当时的管道捕获曾混入 grep 码，事后 ANCHOR 裸跑实证 VITEST_EXIT=1；fix14 勘正：仅 ANCHOR 裸码实证，其余四例=约定推断非逐例实录）+首败断言+还原 sha 27632e0d…（fix13 勘正：字段名实为 sha，原记 sha256）。
- 终态：46 files **861 passed+7 skipped**（JSON=tests/fixtures/run-records/3b4-fix11-vitest.json）+tsc0+lint0（fix14 勘正：本轮 tsc/lint 为摘要口径无原始输出附件，fix13 已实证管线吞码一例；fix14b 起一律裸跑+原始输出入 run-records）；基线提交 132ee3f。

## 3c-4 B1 后端批（K3-B1 信封修正：流终局帧结构化身份+cancel-then-notify；2026-10-04）
- **信封规则**（契约档 §3.6「错误帧路由语义（K3-B1 修订）」=权威）：流终局通知帧——4409 stream-replaced（同连接退旧 ws-gateway.ts:650/observe-missed:697/磁盘换流 retireEnginesForFile:814）、4431 订阅积压超限（subscription-engine close emitError）、4402 流终局容量出口（closeSubscriptionsFor:926）——统一带 `subscriptionId`=所停旧流+`requestId` 恒空串；请求级错误照旧只带 requestId。旧实现两病灶：同 file 退旧误携新 requestId（前端把流终局当新请求失败→合法新 snapshot 被丢，K3 P1）；磁盘换流 id 只埋 message 文本不可靠解析。
- **cancel-then-notify（次序不变量）**：connection-queue.cancelBySubscription 对队列项做 `"subscriptionId":"<id>"` 文本标记扫描撤帧——终局帧自带该标记→「先 enqueue 后 cancel」会把刚入队的终局帧一并撤走（自杀，C16 实证 4409 消失）。四处发帧点统一先 close→cancel→再 enqueue 终局帧；同一同步 tick 无 flush，先后对客户端不可见。
- 测试面：C16 补结构化身份断言（4409: requestId==""+subscriptionId==subId1）；B4 补流终局型 4402 断言（subscriptionId==snap.subscriptionId+requestId==""）；引擎⑳补 4431 断言（subscriptionId==eng.subscriptionId+requestId==""）。
- 变异三连（手动 python 替换+git checkout 还原，树净核验）：MB1 引擎终局帧去 subscriptionId→引擎⑳杀（断言 382 失败）；MB2 退旧帧回误携新 requestId+无身份→C16 杀；MB3 退旧恢复先发后撤自杀序→C16+B3a 双杀（B3a 同 file 并发双 init 同面）。
- 终态：1010 passed+11 skipped（55 文件）+tsc 0+eslint 0；基线/交付提交 df0e576（含契约档增补）。

- **K4 后续批（发现1 收口，repo 本提交）**：drain 出口整帧超预算 4431（subscription-engine.ts overBudget）补 subscriptionId（与 close() 终局信封统一；servePage :244/:256 请求级出口携页 requestId=既有正确语义不改）。⑲b 新例专测 drain 出口信封；⑲ 原例头注指明其帧出自 servePage 请求级出口（非 drain）。变异 MB4（drain 出口去 subscriptionId）→⑲b 单杀。1087 passed+11 skipped。

## 3c-5 ⑤B（静态托管+生产 CLI：static-serve/composition staticDir/main.ts；2026-10-05）

- 目标：自举里程碑第一块——同端口 HTTP 静态托管（web 构建产物）+零依赖 CLI 入口（参数/信号/优雅退出）。
- **r1（GPT 74 NO-GO 四阻断修复，2026-10-05，含四清理项）**：B1 symlink 穿越→handler 层 realpath 真实包含门（realRoot 构造期一次+每请求 realpath(target)；real 非 realRoot 且不以前缀含于 realRoot+sep→404 symlink-escape）+终分量 open(O_RDONLY|O_NOFOLLOW) 换链 fail-closed+residual 注释入文件头（中间目录换链竞态不承诺，威胁模型内）；B2 点段归一化绕过→resolveStaticPath 输入改原始 request-target（?分手 query/#拒/非/拒），逐段 decodeURIComponent 后拒空段/./../点开头/含 /、\\、NUL（%2f 解码后不得变分隔符），fetch 预归一化不可用→rawReq 原始探针（http.request 直发）；B3 Origin 白名单热变更→transport+gateway 各存构造期 Object.freeze([...]) 快照，两处 includes 改用快照；B4 关闭边界证据错→ST6 新增半截请求头可区分杀点（拔 closeAllConnections 落 5s 守卫，基线即时）+ST4 标题/注释纠偏不再声称守卫被验证；清理：main assertDir 原始输入先查绝对再 resolve（原顺序恒真）。
- 生产文件：apps/server/src/ws/static-serve.ts（resolveStaticPath：解码失败/NUL/根外/点段/点文件/段内分隔符→null；createStaticHandler：GET/HEAD only+405/`/`→index.html/fstat 目录→404/MIME 表/no-store+Connection:close/审计 static-hit|miss|reject+realpath 门+O_NOFOLLOW fd 绑定）；apps/server/src/main.ts（parseArgs 重复 --root/--origin、assertDir（原始输入先查绝对）、origins 默认推导 127.0.0.1+localhost:P、SIGHUP 热轮换、SIGINT/SIGTERM 优雅 dispose）；composition.ts 增 ServerConfig.staticDir→外部 http server 模式（adapter 挂 upgrade；listen 固定 port 校验+address 解构；dispose 补 httpServer.close+closeAllConnections+5s 守卫）；ws-transport.ts/ws-gateway.ts originSnapshot 构造期冻结。
- 运行方式拍板：`node --experimental-transform-types apps/server/src/main.ts …`（仓内 ws-transport 等 17 处参数属性=非纯 erasable，strip-only 拒跑；transform-types 承担）。为此把 4 文件 7 处 `.js` 导入符归一 `.ts`（process-host/pi-child/rpc-session/session-registry），server 树自此原生可直跑。零新依赖。
- 测试面 SS/ST/SM 20 例（tests/unit/server/static-serve.test.ts）：SS1-SS9 纯函数+真 http server（MIME/HEAD/405/穿越/点文件/审计行/rawReq 点段族/SS9 symlink 真实边界：文件链+目录链→404，根自身 symlink→根内可服务+边界不放松）；ST1-ST6 composition 集成（port 0 拒启/fetch 200+404+审计/WS 同端口 hello→welcome→list-sessions(requestId)→sessions/ST4 正常路径 dispose 有界（半截头证据在 ST6，不据本例声称守卫被验证）/ST5 origin 快照：startServer 后对原数组 push 后推 origin→403 不握手+白名单内对照/ST6 半截请求头连接：基线 dispose<4.5s，拔 closeAllConnections 落 5s 守卫=可区分变异点）；SM1-SM5 CLI 子进程冒烟（--help/缺 token/非法 port 真钉端口门/root 不存在/全参数起服→ready→SIGTERM→exit 0+端口释放）。
- 变异六连（tools/mutate-3c5.py，try/finally 保还原+树净断言，基线先提交，杀点判据=exit≠0 且 n_fail>0）：S1 DOT-GATES-OFF 点段+点文件两门同拔（合并理由=单向吸收：单拔点段门留点文件门不可杀，"."/".." 均以点开头被吸收；反向单拔点文件门留点段门可杀——旧 S2-DOTFILE 日志@103e726 有 SS2/SS7 两杀，/.hidden 放行；故两门须组合探针覆盖两向；GPT r2 N3 纠偏）→SS2/SS7/SS8 三杀（不含 SS1，旧句四杀有误）；S3 composition 固定端口门关→ST1 杀；S4 CLI 端口门关→SM3 杀（真 token+stderr 断言防 token 门偷杀）；S5 closeAllConnections 拔除→ST6 杀（半截头连接落 5s 守卫，基线即时=可区分）；S6 realpath 真实边界门关→SS9 杀（O_NOFOLLOW 不拦已解析路径，symlink 门必须独立成杀点）；S7 origin 快照关（opts.allowedOrigins 直通）→ST5 杀。全杀全还原，日志=tests/fixtures/run-records/3c5-mut-*.log。
- 诚实披露：⓪N1 口径：裸 # 仅拒路径部分；query 内 # 不拒（/package.json?x=#fragment=200，query 不参与磁盘解析；SS8 补对照断言锁定，GPT r2 N1）；①旧 S3'=拔 closeAllConnections 曾判"设计上不可杀"有误（GPT E2 证实半截请求头场景可区分）→r1 落 ST6 成杀点；②SM3 两轮强化过程（root 门/ token 门先后偷换杀点）见提交链 4de316a→e1a3f15；③ST4=正常快速路径断言，不依赖 5s 守卫存在性（删守卫仍过），半截头证据在 ST6（旧句"依赖守卫存在性"有误已删，GPT r2 N2）；④S7 变异只杀 transport 层快照，gateway 层快照（hello 后检查）无独立变异覆盖——⑤C/写侧收线批补 gateway 直连用例（GPT r2 B3 附带建议）；⑤/proc/self 类根（realpath 根即特殊文件系统）不在支持面：realRoot 构造期 realpath 若失败=拒启，服务方自担。
- 终态（r1）：1158 passed+11 skipped+tsc 三档+web tsc+eslint 全 0；提交链 af119ea→4de316a→e1a3f15→f928f59→42d666d（r1 主体）→103e726（变异 v2）→e21a569（S1/S2 合并）。

## ⑤C 真组合根 E2E（2026-10-05；repo fe0bc07；GPT r2 88 GO 放行后落）

- 范围与分工：**生产形态单端口共存面**——staticDir 静态+同源 WS+token 门+write 接线+真 pi 0.86.1 全组合。与 ws-write-e2e 分工明确：深写链路（退役/在飞销毁/代次）归 E1-E4 已证；本批只证**组合根共存与联动**：公开静态资源与受 token 认证的 WS 订阅/写面同端口共存（静态 GET 不携 token；GPT 5C r1 N1 口径）、订阅投影与写 journal 同组合联动、资源收口PI_E2E=1 门控（默认 skip；真调一轮 LLM=一次小 prompt+一次 stop，成本面显式声明）。
- C-1 同端口静态+WS+token（无 LLM）：GET /index.html 200+MARKER+GET /app.js 200+GET /nope.html 404；审计行 static-hit/static-miss 前缀断言（⑤B 面在组合根真实接线证据）；坏 token→**4401 错误帧先行+close 1008**（契约 §5.6 口径——首版断言 close=4401 写反已修，e2e 级契约再校验）；好 token→welcome。
- C-2 订阅+写全链（真 pi 一轮）：预置空 s1.jsonl→subscribe→snapshot（subscriptionId）→prompt（"只回复两个字：收到"）→write-ack launched→journal 三行（enqueue<sending<settled 同 intentId 索引递增+generation≥1）→订阅面 events 帧投影（同 subscriptionId、events[].seq 帧内单调递增≥1 帧）——**watch→投影→推送在组合根内的真链路证据**。
- C-3 stop+dispose 收口：write-stop-ack confirmed+assertExitShape 严格形状；stop→exit 同 handle 审计索引硬序（e2e-evidence 助手复用）；dispose<30s。
- 运行证据：PI_E2E=1 3 passed（13.86s）；默认面 60 文件 1158 passed+2 skipped（integration 3 skipped 在内）；tsc 三档+eslint 0。固定端口=COMPOSED_E2E_PORT 默认 4319（staticDir 模式要求固定 port，同源 origin 预知）。
- 残余披露：①订阅面 events 断言只锁「有投影且 seq 单调」，不断言 evidence 事件与 journal 行一一对应（投影语义归 3b-2 单测面）；②真浏览器面（fetch+WS 来自页面脚本）未起 Playwright——前端联调批（⑤D/UI 接线）归口；③gateway 层 origin 快照独立变异（N3-④）挂写侧收线批。

### ⑤C r1 后追加批：顶层 sessionFor 双源 E2E（⑤D 前置，GPT 5C r1 N2 落实）

- 改动：composed-e2e.test.ts beforeAll 增顶层 `sessionFor`（与 write.sessionFor 同映射）——composition.ts:180-188 走 DualHistorySource 双源分叉（此前 C-2 为 journal-only）。
- 新增 C-3 双源读面：口令轮（PENGUIN-43）→settled 后轮询重订阅→快照页须含 `kind:"message" role:"assistant" textPreview.text` 含口令（assistant 正文只存在于 pi 转录，journal 无正文=TECH B17——出现即双源接线真证据）+同页并存 journal 源 turn-enqueued 行（双源合序）。旧 C-3 stop+dispose 顺延为 C-4。
- 断言类型注意：textPreview 是 SanitizedText 对象（{text,truncated}），非字符串（调试时误判过一次）。
- 运行证据：tests/fixtures/run-records/5c-composed-e2e-dualsource.log（PI_E2E=1 4 passed 24.65s，两次真实 LLM 轮）；全仓 1158 passed。

### ⑤C r1 后清理批（2026-10-05；GPT 89 GO 后 N1-N5 落地）

- N1：口径改「公开静态资源与受 token 认证的 WS 订阅/写面同端口共存」（静态 GET 不携 token）；运行统计单位改准=60 文件 passed/2 skipped+1158 用例 passed/14 skipped（跳过含本组 3 it）。
- N2：C-2 强化=初始 snapshot.page 空+hasMore=false+streamId string；prompt 前帧边界（events 只数边界后新到帧）；intentId 非空字符串运行时检查；generation 正安全整数（拒字符串数字）；events 谓词 seq=正安全整数。
- N3：坏 token 负向=零 welcome 断言+10s 有界关闭等待（超时报已收帧类型）+finally terminate 兜底。
- N4：write.idleMs 显式 1_800_000（30min 固定）；C-3 until 降 20s（<用例 60s 预算）；dispose 计时改 performance.now 单调钟。
- N5：真跑记录=tests/fixtures/run-records/5c-composed-e2e.log；类型检查边界披露：npm run typecheck=根/protocol/server 三档，不含 tests/integration 与 unit/web（integration 类型面由 vitest transform 兜底，lint 覆盖之）。
- N6（不销案）：gateway 层 origin 快照独立变异仍挂**写侧收线批（⑤D 后）**；⑤D 须接顶层 sessionFor（读侧双源：write.sessionFor 不自动配置读面——C-2 实为 journal-only 投影，assistant 正文双源显示未证，GPT r1 N2 明示）。

### 写侧收线 N6 销案：gateway origin 快照独立变异（2026-10-05；GPT r2 N3-④ 收口）

- 回归例：ws-gateway.test.ts「B3 快照①」——构造后向调用方 allowedOrigins 热插 `http://evil.example`→hello 仍 4401+close1008+审计 hello-origin-rejected；热删原白名单→原 origin 仍 welcome（双向）。
- 变异：M1 NOSNAPSHOT（`Object.freeze([...opts.allowedOrigins])`→直绑调用方数组）→定向 1 failed（首败 :252 expected false to be true，热插端被放行）；还原 RESTORE_OK（hash 复核）；还绿 103/103+全仓 1159 passed。档=mutation-records/n6-gateway-origin-snapshot.md+run-records 同名 log。
- 诚实披露：只去 freeze 不去复制=无行为差异不可观测，单变异单杀面；history-source.test.ts 偶发首败（21 轮审⑦）与本档无关（两轮复跑全绿）。
- N6 自此销案；「写侧收线批」其余=⑤D 前端联调（等 A1c 重写）。

### N4-v2 登录面批（2026-10-05 用户拍板 HttpOnly cookie；基线 dde79f6）

- 需求：刷新/重开标签免重输令牌+XSS 偷不走（REQ 2026-10-05 N4 v2；v1 sessionStorage 拍板作废）。
- 面与链路：`POST /login`（JSON {token}→TokenAuthority 恒定时间校验）→`Set-Cookie: pi-agent-ui-session=<sid>`（HttpOnly; SameSite=Strict; Path=/; [Secure 按 TLS 事实]）；sid=HMAC-SHA256(per-boot 32B random secret, tokenDigestHex)——cookie 无令牌原文、服务重启全会话失效（fail-closed）、令牌热轮换旧 sid 自动失效（同基派生）。`POST /logout`=Max-Age=0。登录面 per-IP 失败滑窗限速（默认 10 失败/60s→429；成功清户；封锁期正确令牌同拒=与 R6 同口径）。WS 升级面带有效 cookie→meta.sessionAuthed→hello 免令牌通道（v1.1 token 可选；**呈令牌必真——错令牌不静默降级**；tokenDigest=真实摘要进撤销链——旧版固定 "session-cookie" 已失效，审计不输出摘要，r3 勘误）。仅 staticDir 部署叠加；非浏览器/纯 WS 部署令牌通道不变。
- 文件：apps/server/src/http/login-route.ts（新）+ws-transport.ts（sessionCookie 注入+meta.sessionAuthed+parseSessionCookie）+ws-gateway.ts（hello 双通道）+token-auth.ts（currentDigests 只读访问器）+packages/protocol/src/contracts.ts（hello.token 可选）+composition.ts（staticDir 模式叠加登录面）+docs/ws-ui-contracts-v1.md §5.1/§5.5。
- 测试：login-route.test.ts 11 例（L1 旗标逐项/L2 Secure 事实/L3 限速滑窗+窗口滑过恢复/L4 登出/L5 非面让路/L6 坏体/L7 篡改+形态+轮换失效/L8 异钥隔离/L9 弱钥拒启/L10 解析器/L11 审计零令牌原文）；ws-gateway S1-S3（会话 hello/错令牌不降级/无会话拒）；login-e2e E1-E4（真 HTTP 登录→真 WS 免令牌 welcome/反例矩阵 4 路/登出/静态共存）。
- 运行证据：全仓 62 文件 passed+2 skipped=**1177 passed**+15 skipped；tsc 三包 0 错；eslint 0。变异五连全杀（M1 旗标剥除/M2 会话通道忽略/M3 限速失效/M4 升级面校验短路/M5 sid 形态门拆除——各自对应测试变红，还原后 121 例复绿+树净）。
- 残余披露：①服务端会话撤销表未做（首版登出=清浏览器侧 cookie；sid 失效统治=重启/令牌轮换；撤销表挂后续增强）；②Secure 旗标在无 TLS 部署（http loopback）不置——契约语义即如此，反代 TLS 场景由部署方保证 XFP 采信；③前端登录框+自动重连（Kimi 线 A 系接线批）未落——服务端面已可独立验证；④登录面无 CSRF token（POST only+SameSite=Strict+JSON 体=现实防护面；非浏览器 CORS 由 Origin 白名单统治）。

### N4 r1 修复批（GPT r1 NO-GO 70/100→五阻断+探针实证；基线 062a301；审报 projects/pi-agent-ui/audits/gpt-n4-login-r1-review-2026-10-05.md）

- B1 代理接线（高）：login-route `connSecurityOf` 复用 WS 升级面同源 `deriveConnMeta`——Secure 按有效传输 TLS（trustedProxies+XFP 派生）、clientIp 按同链派生（反代部署不再共桶）；非 loopback 且有效传输非 TLS→403 login-tls-required（明文门）。B2 会话身份与撤销（高）：sid 校验同时派生 sessionDigest（token 摘要 hex）经 TransportConnMeta→gatewayMetaFrom→ConnMeta 贯通；hello 免令牌通道复核 `tokens.hasDigestHex(sessionDigest)`（**upgrade→reload→hello 竞态闭合**：轮换后旧 sid hello→4401 hello-session-missing）；st.tokenDigest=真实摘要→**热轮换即刻撤既有 cookie 连接**（4401+close 1008，与令牌通道同治）；token-auth 新增 hasDigestHex（形态门+timingSafeEqual）+C1 currentDigests 返回副本。B3 Cookie 歧义拒（中）：ws-transport handleUpgrade rawHeaders 计数 Cookie 头（>1→会话作废+审计 upgrade-cookie-ambiguous）；parseSessionCookie 同名恰一次（早退 hits>1+终值 hits===1 双道）；单头内同名重复只令 sid 为空不审计；login 面不解析 Cookie（“login 侧→400”为旧描述勘误：400 属 body 解析/形态路径）。B4 限速 R6 口径（高）：失败滑窗时间戳队列（60s 窗默认 10 失败→429）+strikes 指数退避 blockedUntil（成功清户）+**双门复核**（读前门 1+body 读完同步复核门 2，无 await 间隙）+per-IP 在途 body 预算（默认 2→429）+bodyTimeoutMs 10s→408+有界表淘汰（满表先逐非封锁户；全表封锁时逐最早到期封锁户+审计——有非封锁项时不丢活动封锁，r3 勘误条件化）。B5 来源门+媒体门（中）：Origin 异源 403（不记账）+无 Origin 仅 loopback+Content-Type 非 application/json→415+logout 同治。C2 null/非对象→400；C3 审计 try/catch 隔离。
- 文件：login-route.ts 全重写（接口+allowedOrigins/trustedProxies/rateBaseBlockMs/rateMaxBlockMs/rateMapMax/inflightBodies/bodyTimeoutMs）+ws-transport.ts（meta 扩展+rawHeaders 计数）+ws-gateway.ts（hello 复核+真实摘要）+token-auth.ts+composition.ts（login 注入 allowedOrigins+trustedProxies；sessionCookie.validate=sessionIdentityOf）。
- 测试：login-route.test.ts 全重写（L1-L11+B1a-f+B4a-c+B5a-e；C4 逐题改断言）；ws-gateway S1-S6（S4 upgrade→reload→hello 竞态闭合 4401；S5 cookie 通道轮换撤销 4401+close 1008；S6 不误杀——未撤连接存活）；ws-transport.net.test.ts r1-B3 组（两条原始 Cookie 头→101 但会话作废+审计 ambiguous count=2；单头同名重复→4401；恰一次有效 sid→welcome；DIGEST=sha256(harness TOKEN)）；login-e2e E4 改实（200+含 ok）+E5（组合根 B1：127.0.0.1 可信代理+XFF 203.0.113.9+XFP=https→200+Secure+审计 clientIp）+E6（异源 403/text/plain 415/异源 logout 403）+E7（单头同名重复 4401；无关 cookie+真 sid welcome）。
- 运行证据：全仓 **1201 passed**|15 skipped；tsc 三包 0 错；eslint 0。变异六连全杀：Mu-B1（sec=旧 socket 派生）/Mu-B2a（hello 不复核）/Mu-B2b（tokenDigest="session-cookie"）/Mu-B4（body 后不复核）/Mu-B5（来源门拆除）单变异即杀；**Mu-B3 双道冗余防线需成对变异**（早退+终值计数单拆任一道另一道仍拦——变异纪律新例：冗余防线成对拆）。
- 残余披露：①sid 同 boot 同令牌=可重放 bearer（r1-C5 勘定口径：重放面≈令牌通道，HttpOnly+SameSite=Strict+来源门收窄，契约 §5.5 已列）；②服务端会话撤销表未做（登出仅清浏览器侧；sid 失效统治=重启/令牌轮换——与 GPT r1 B2 修法对应的轻量子集已落：真实摘要进撤销链+hello 复核）；③前端登录框未落（Kimi 线）。

### N4 r2 修复批（GPT r2 NO-GO 79.05/100→三 open；基线 b18610a+变异杀点补充批；审报 projects/pi-agent-ui/audits/gpt-n4-login-r2-review-2026-10-05.md）

- R2-B1 Origin 三态门（中）：真缺失（无头）才可走 loopback 豁免；显式异常值（"null" 字串/空串/数组）一律 403 不折叠成"缺失"蹭豁免（opaque/sandbox 来源即此形态）；审计 origin 截断 64（r3 勘误：仅显式非法值 rejectOrigin 实参截 64；普通非白名单 string 原样入日志）。R2-B2 构造期快照冻结（中）：login-route `allowedOrigins=Object.freeze([...])`+ws-transport `trustedProxies=Object.freeze([...])`（热插原数组不生效——授权面构造期定死）。R2-B3 体流错误先写后关（中）：readBody 超时/超体改 `req.pause()`（不 destroy——r2 前先 destroy 后写=真网 0 字节断连）；jsonReply 第 5 参 close:true（Connection:close 头）；closeAfterReply=写完即销毁（25ms 后）+1s 封顶强制。
- 测试补强（r2 审报逐点核销）：L3c 成功清户区分例（阈 2：错/对/错/错/对→401,200,401,401,429；清户失效变体第 4 次即 429 被杀）/L3d 滑窗残留区分例（阈 3：t=0/999/1000/1000/1000→401×4+429；固定窗翻转变体第 5 次仍 401 被杀）/B4c 真淘汰重写（双封锁户满表→第三户失败插入→evict-blocked 审计+B 幸存）+B4c2（优先逐非封锁：无 evict 审计+C 达阈当次 401 记账后封锁→下次 429）/B5c 改题（Origin:null loopback 也 403——r2 前旧代码 200 真组合根复现点）+B5c2（空串/logout Origin:null/对照正例）+B5f（白名单热插 evil 仍 403）+B5g（trustedProxies 热插不采信）；S4 补 close 1008 断言/S6 补 pong 交互断言；net 执行门独立例（rawWsHello 裸 Socket 手写 WS 握手+掩码 hello 帧：两条 Cookie 原始头仅第一头含唯一有效 sid→免令牌 hello 4401——**Mu-B3-raw-enforcement-only r2 窄变异杀点**，ws 库数组头值会被合并成单头故必须裸 Socket）+双 Origin 头数组形态→非 101 拒；E8（组合根真例：Origin:null login/logout→403 不 Set-Cookie）；login-body-flow.test.ts BF1-BF3（真网体流：慢 body→408 字节在网可解析/超体→413/BF3 错误面后新连接正常 200——FakeReq.destroy 只置标记遮不住的真行为）。
- 运行证据：全仓 **1213 passed**|15 skipped；tsc 0；eslint 0。变异五连全杀：Mu-R2B1（null 折叠成缺失）/Mu-R2B2a（白名单直绑）/Mu-R2B2b（trustedProxies 直绑——ws-support R2-B2 快照冻结断言杀）/Mu-R2B3（先 destroy 后写→BF1 真网 0 字节被杀）/Mu-B3raw（不问 Cookie 头数→执行门例杀）。
- r2 补证勘误核销：raw-header 执行门独立断言已落（上）；B4c 真触淘汰已重写；成功清户/滑窗残留区分例已落；E2E 文件头第 4 行措辞已改（登出=清浏览器侧，服务端撤销表=披露）；L7 题勘正（换令牌集非"热轮换"）；网络首例题勘正（只证 101+审计，hello 证据归执行门例）。

### N4 登录面 r3 修复批（2026-10-05；对应审报 gpt-n4-login-r3-review-2026-10-05.md 91.43 NO-GO）

- 范围：R3-B1（放行阻断）+R3-Y1/Y2/Y3（低项一并收口）。生产改动仅 login-route.ts closeAfterReply 一处；其余为测试替身升级、行为例补强、契约/档勘误。
- **R3-B1 测试替身跟随流接口（中）**：FakeReq 补 `pause()/resume()`（生产读体面 408/413 调 `req.pause()`，替身缺方法→2 unhandled TypeError+全仓 exit1）+destroy 时发 close；FakeRes 改 EventEmitter 且 end() 后异步发 finish（生产 closeAfterReply 监听 finish/close）。修复后定向 5 文件 110 绿+全仓 1217 绿（r4 勘误：同 HEAD 复测=定向 113 绿/login-route 33 例；当时根 typecheck 实为 exit2（四条 r1 遗留测试类型错，非本批新增）——r5 已闭合），**exit0 零 unhandled**（GPT /tmp 诊断补丁同结论：纯替身即可，产线无需动）。
- **R3-Y1 有界关停统一幂等清理**：closeAfterReply 重写——killed 旗标+kill 时 clearTimeout 全部兜底 timer；新增 res close（对端 RST）、req aborted（B4a 未完成请求主动清理）、req error 三路收口。finish→25ms 软关停+1s 硬封顶保留（受控探针口径：finish 后 1s 不再二次 destroy）。
- **R3-Y2 行为例补强（两存活变异锁死）**：
  - B4c 增被逐户 A 断言（t=2_200 好令牌→200——封锁史确已删除；**Mu-eviction-no-delete r3 存活变异杀点**：只审计不删则 A 仍 429）；B4c3 新增混合表例（A 封锁+B 未封锁满表→插 C 逐 B；A 仍 429、B 史清 200——非封锁优先路径行为锁）。
  - net 新增 r3-Y2 升级面真用快照例（构造后热插 trustedProxies→XFF/XFP 不被采信，upgrade-accepted 审计 proxied=false+不含外部 IP；**Mu-WS-live-options-bypass r3 存活变异杀点**：改读 opts 原数组则 proxied=true）。
  - B5c2 补真数组形态（origin:[ORIGIN]→403）；E8 补 logout 不 Set-Cookie 断言；BF4 新增（slowBodyFullClose：精确 Content-Length 字节到齐+**等服务端 FIN** 才结算——证 408 错误面完整交付与服务端主动关，不靠客户端先断）。
  - L7 题收窄（"另一 authority 使用新令牌集"非"旧 authority 失效"；同 authority 真实轮换证据归 S4/S5）。
- **R3-Y3 契约/档原位勘误**：contracts §5.5+TEST-MAP 旧段六处——Cookie 歧义"login 侧→400"改 login 面不解析 Cookie（400 属 body 解析路径）+"均审计 ambiguous"收窄为仅原始头数>1；"不丢活动封锁"条件化（有非封锁项时；全封锁逐最早到期）；"审计标记=真实摘要"改撤销链内部身份（审计不输出摘要）；bearer 残余风险口径收窄（登出只清浏览器侧/HttpOnly 不防本站 XSS 借权/SameSite 站点级）；"origin 截断 64"改仅显式非法值。旧段保留历史+括注 r3 勘误，不整段重写。
- 变异验证（/tmp/mut-n4r3.py）：Mu-eviction-no-delete（B4c 杀）/Mu-WS-live-options-bypass（net r3-Y2 杀）双红，还原后基线 69 绿；Y1 timer 清理无仓内杀点（幂等 kill 下二次 destroy 不可观测），以 GPT 受控探针+代码审查收口。
- 运行证据：全仓 **1217 passed**|15 skipped（exit0 零 unhandled——R3-B1 关闭口径）；定向 login-route 36 例+body-flow 4 例+net 36 例；tsc apps/server 0 错；eslint server/src+unit+integration 0。（r4 勘误：定向 login-route 实为 33 例；apps/server tsc 单包绿≠根 typecheck 绿——当时根 exit2，r5 闭合；「无仓内 timer 杀点」判断已由 r5 fake-timer 生命周期例取代）

### N4 登录面 r5 修复批（2026-10-05；对应审报 gpt-n4-login-r4-review-2026-10-05.md 88.57 NO-GO）

- 范围：R4-B1（TDZ 放行阻断）+R4-B2（根 typecheck 四错）+R4-Y1/Y2/Y3 一并收口。生产改动=login-route.ts 关停器安装序一处+两行守卫；其余=测试面（生命周期四例+B4c3 延伸+BF4 收紧+类型补全）+档勘误。
- **R4-B1 关停器 TDZ（中）**：r3 修复批为顺 eslint prefer-const 将 `const hard=setTimeout(kill,1s)` 前移到 `const kill` 声明前——`setTimeout(kill)` 传参即读 kill（TDZ 同步抛 ReferenceError），外层 catch 吞错→25ms/1s 兜底全部未建立且表面全绿。修复=声明序恢复先 kill 后 timer（kill 体内引用 hard 属运行时读值，无 TDZ）+迟 finish 守卫。**新测试族 R4-B1 生命周期四例（vi.useFakeTimers）**：L1 finish→25ms 软关停恰一次+hard 撤销（vi.getTimerCount()=0）+1s 后不二次销毁；L2 无 finish（压掉 res.end 自动 finish）→1s 硬封顶恰一次销毁+迟到 finish 不新建 timer（R4-Y1）；L3 res close 同步收口+重入（close/aborted/error 连发）恰一次；L4 req aborted/error 独立收口。走 408 超时路径（closeAfterReply 唯一调用面），arm 内微任务泵 20 跳冲刷全链+408 前置断言；destroys 用 getter（闭包计数不快照）。
- **R4-B2 根 typecheck 四错（中）**：①login-route.test.ts FakeReq.socket 类型改 `{remoteAddress?: string|undefined}`（exactOptionalPropertyTypes 下显式含 undefined；真 Socket remoteAddress 可 undefined，生产面 deriveConnMeta 读时自碰 "unknown" 回退）②ws-support.test.ts 三处 gatewayMetaFrom 输入补 `sessionAuthed:false, sessionDigest:null`（r1-B2 扩字段后测试输入未跟）③直连例 toEqual 期望补同两字段。根/protocol/server 三包 typecheck 逐项 exit0。
- **R4-Y2 行为盲区收口**：①B4c3 延伸两步（t=5 B 再错→401 未封锁+史清证明；t=6 B 好令牌→200）——**Mu-nonblocked-eviction-no-delete（只删封锁 victim）杀点**；②BF4 收紧：bodyComplete 判据 `>=`→`===`（声明与实收严格一致）+返回 declared/bodyBytes 双值+断言 declared===bodyBytes>0+content-type application/json+JSON.parse 语义（ok=false+error 文案）——**Mu-BF4-payload-gutted/Mu-CL-off-by-one 杀点**；③Mu-close-noop/Mu-tdz-regression 由 R4-B1 生命周期例覆盖（关停器拆除或 TDZ 重演→L1-L4 全红）。
- **R4-Y3 档勘误**：r3 节三处数字原位勘误（定向 113/login-route 33 例/根 typecheck 当时 exit2——旧文以单包绿冒称全绿，r5 闭合）。
- 变异验证（/tmp/mut-n4r5.py）：Mu-nonblocked-eviction-no-delete（B4c3 1红）/Mu-close-noop（L1-L4 4红）/Mu-tdz-regression（L1-L4 4红）/Mu-BF4-payload-gutted（BF4 1红）/Mu-CL-off-by-one（BF4 1红）五连全杀，还原后基线 41 绿。
- 运行证据：全仓 **1221 passed**|15 skipped exit0（两次连跑均绿）；根/protocol/server typecheck 三包 exit0；eslint server/src+unit+integration 0。
- 错题落账方向：修 lint 后只跑 eslint+定向测试不重跑 tsc（TDZ 漏网根因）——改动后验证面必须覆盖被改面的全部门（tsc 属编译面门）。

## P0-1a 修复留痕（PROJECT P0 冻结序①：repair 行型+宿主撕裂尾修复工具+锚点合法转移；2026-10-06）

- 背景（勘察结论）：仓内此前无任何生产 truncate/修复代码路径——撕裂尾修复纯靠宿主手工，修复事实只在内存快照（withRepair）里活一次重启即灭，且截尾后证据链锚点（len+sha）判 concurrent-modification → 文件永久不可再捕获=链路死结。本批把修复变成显式宿主事务（受信面，与 migrateLegacyEvidence 同类）。
- 生产改动五文件：①`packages/protocol/src/journal.ts`：JOURNAL_CONTRACT_VERSION=2+RepairLine 行型（t:"repair"|reason:"torn-tail" 白名单|byteStart/byteEnd 安全整数 0≤s<e|removedSha256 64hex|buildId 非空|contractVersion≥1|at）+replayIntents 显式跳过；②`journal-schema.ts` repair 行 schema 校验；③`contracts.ts`+`history-projection.ts`：HistoryEventKind 加 journal-repair（三字段透传，撕裂行不发布）；④`apps/server/src/ws/safe-open.ts`：openSafeReadWrite（O_RDWR|O_NOFOLLOW|O_NONBLOCK+同 fd fstat 常规验证，错误分类同 openSafeFile）；⑤`apps/server/src/runtime/repair-tail.ts`（新）：repairJournalTail 主流程=根内解析→有界读→byteStart=lastIndexOf(\n)+1→载锚（corrupt→aborted anchor-corrupt）→无尾三分支（前缀不可复验→永拒 anchor-stale；未完成修复事务+授权+对界→reconciled 补完锚；其余纯扩展→no-torn-tail）→有尾（锚不匹配→拒动手）→removedSha256+afterRead 接缝→同 fd 复核（尺寸+尾段哈希双查→file-changed）→ftruncate+datasync+原位追加 repair 行+datasync→有锚才重写锚（tmp 独占名+rename，失败 tmp 卫生后抛）。web 面 session-detail.tsx KIND_LABELS 加 journal-repair 中文标签。
- **判定序重排（测试抓出的真设计缺陷）**：首版把 reconciled 写成不可达死码——残局判定 groundable 含前缀哈希吻合，但健康分支（前缀吻合即返回 no-torn-tail）先短路，导致「崩溃窗口 B（行已落盘锚未转移）」永远走不到 reconcile。重排：先判前缀不可复验（永拒），再判未完成事务（unfinished=末行 repair 行 byteStart===行首偏移+其为末行+锚未覆盖被移除字节）+授权→补完锚转移；纯扩展正常增长 fallthrough no-torn-tail。锚曾覆盖被移除字节（RT8 形态）=前缀不可复验=永拒（需重走迁移）。
- 信任边界：工具=宿主受信；无锚不建锚（首捕授权面不在此，防洗白）；journal 写者无权触 evidenceDir（B14 边界不变）；授权面 authorizeStaleAnchorRepair 默认拒绝。披露残余：truncate↔行写回崩溃微窗（无行可对账→锚死结需重走迁移）；跨进程无锁=Q16 部署前提（修复期禁写）。
- 测试 tests/unit/server/repair-tail.test.ts RT1-RT18（16 例，真 fs mkdtemp+真 provider 建锚+fsLike/afterRead 结构化接缝）：RT1 happy 全链（截尾+补行+锚转移+provider 再捕获成功=死结闭合+recoverFromJournal bad 空+repairLog 1 条+diskBlocked false）/RT2 幂等（二次 no-torn-tail 锚不动）/RT3 无锚照修不建锚/RT4 锚不匹配拒动手文件原样/RT5 afterRead 注入一字节→file-changed 且文件=原+注/RT6 崩溃残局无授权→anchor-stale fail-closed/RT7 授权+可验→reconciled+锚=新盘哈希+再捕获成功/RT8 锚覆盖被移除字节→授权也永拒/RT9-10 干净+空文件 no-op/RT11 超预算 oversized/RT12 根外 unreadable/RT13 schema 七例（含 RT13 计 8 断言组）/RT14 replay 忽略/RT15 投影+撕裂行不发布/RT16 repairLog 派生/RT17 修复后再撕裂只新尾阻断/RT18 错界伪行不触发 reconcile 锚不搬动。
- 运行证据：定向 16/16 绿；tsc 三包（server/web/protocol）exit0；全仓回归+变异验证=基线提交后跑（见 git log 本批提交信息与下批补充）。

### P0-1a r1 修复批（GPT r1 64 NO-GO 六阻断→marker 协议+realpath 门+写循环；2026-10-06）

- 阻断修复面：**B1** 修复解锁重发（repairLog 只展示不参与授权）→ buildRecoverReport 加 repairShadow：repairLog>0 → resumable 恒空+resumeBlocked=true（物理修复≠裁决，解锁面留 P0-1b adjudicate）；**B2** 残局凭证不过 schema → lastRepairRowFact 逐行 journalLineSchemaError 校验；**B3** 词法落根可被祖先 symlink 逃逸 → realpath 实根包含门（aborted reason=path-escape，根内 symlink 放行）；**B4** 单次 write 短写 → writeFull 循环（零进展抛 write-stall）+补行后同 fd 回读验证+锚从回读盘面算；**B5/P5** 截断后补行前崩溃无痕回退 → repair-pending marker（evidenceDir/<file>.repair-pending.json，tmp+rename 原子，truncate 前落盘，锚转移后清除）：残局两形态（截断形 byteEnd==marker.byteStart / 已补行形 last row at marker bounds）均可经 marker 补完（via=marker-complete/marker-reconcile），不经授权门（marker=宿主意图持久记录）但锚转移仍要求旧锚前缀可复验（前缀伪造不可排除→anchor-stale 永拒）；**B6** RT14 测试用真 repair 行深度相等断言重写；**L1** journal.ts replay 显式 case "repair": break；**L5** maxBytes 非有限正数拒绝服务。
- marker 语义要点：marker 只在 afterRead 复核通过后落盘（竞态注入不产生 marker）；marker 冲突（bounds 与盘面不吻合）→ aborted repair-marker-conflict+marker 保留（fail-closed 证据留给宿主）；无 marker 残局面保留为纵深防御（RT6/RT7 用「真修复成功后手工回退锚+删 marker」构造）。
- 测试扩展 RT19-RT26（8 例）：RT19-B1 修复前 unknown=[i1]→修复后再捕获 resumable 恒空+resumeBlocked=true（快照 sessionId 从文件名派生→env() 用 q.jsonl 对齐 jl() 的 sessionId）；RT20-B2 缺字段行 auth=true 也不 reconcile+锚不动；RT21-B3 根外 symlink 拒（path-escape+根外文件原样）+根内 symlink 放行；RT22-B4 短写 8 字节循环补全+锚=回读盘面；停滞 write-stall 锚不动+marker 留→重试 marker-complete；RT23-P5 截断后崩溃→重试 marker 补完+removedSha256 来自 marker；RT24-P6 空行跳过扫描（off+=1）不截断残局识别；RT25-L5 maxBytes NaN/0/Infinity 拒；RT26 marker 冲突 fail-closed 保留。RT6/RT7/RT8 构造随 marker 语义改造（RT8=选择性 fsLike：marker 写放行锚写抛）。
- 接缝：openHandle 返回 openSafeReadWrite 形状 {fh,size}（repair-tail 解包）；FsLike（marker/锚原子写）；afterRead 竞态注入。

### P0-1a r2 修复批（GPT r2 68 NO-GO 六阻断→marker 进恢复链+回读事务后像+冲突门+幂等清理；2026-10-06，基线 6b5c70d，送 r3 复审）

- 阻断修复面：**B1/P4**（marker 不进恢复链）→ recovery-evidence-source.ts 捕获流程 parse 前真 readFile 检测 marker（markerPathOf=evidenceDir/<encodeURIComponent(file)>.repair-pending.json）：在场（哪怕形状非法）→pendingRepair=true 进快照（canonical hash 含之）；非 ENOENT 读失败→unavailable read-failed fail-closed；recover.ts RecoverOptions.pendingRepair→repairShadow（与 repairLog 同列）→resumeBlocked 恒阻断+resumable 恒空；withRepair 置 false（宿主声明修复完成=pending 事务完结，避免与 repairLog 重复阻断）；captureRecoveryEvidence（宿主工具入口）恒 false+JSDoc 披露（无 evidenceDir 视角）。**B2/P7/P8**（回读非事务后像）→ repair-tail.ts readBack 严格等长（提前 EOF 抛 read-back-short，杜绝短 Buffer 静默=虚构锚）；fresh+marker 补完两路均验回读后像：保留前缀逐字节全等（prefix-mismatch-after-repair）+行段逐字节全等（row-mismatch-after-repair；marker 补完路 rowAtBounds 用盘面行段原文而非重构造行——marker 不存 buildId，跨 build 部署重试不得因 buildId 差异误判）。**B3/P5/P10**（有尾冲突 marker 被覆盖）→ 有尾时在场 marker 先判：吻合形（bounds 全等+尾哈希相等；哈希不等→file-changed）复用原 marker 续 fresh（startedAt 保留原始时间戳，不重写）；部分补行形（byteStart 相等+byteEnd<marker.byteEnd+当前尾段=marker 构造行严格前缀）→ftruncate 回截断形+completeMarkerResidue 补行（原始删除事实不被二次修复覆盖）；其余→aborted repair-marker-conflict+marker 保留+盘面一字不动；writeMarker 仅 marker===null 时执行。**B4/P6**（转锚后 marker 未清=重试永久 anchor-stale）→ completeMarkerResidue 首判幂等清理形（rowAtBounds+anchor.len===byteEnd+sha 全等→清 marker 返 reconciled via=marker-cleanup，不经授权门——新锚本身即完成证据）；clearMarker 不再 .catch(()=>{}) 吞错——rm 故障上浮抛（物理修复已完成，重试走 marker-cleanup 幂等补完；force:true 下 ENOENT 不抛）。**B5**（marker 无独立认证）→ repair-tail.ts 头注释披露：marker 权威性完全依赖 evidenceDir 目录访问隔离（越权者本可直改锚点，非新增攻击面；越权伪造 marker 须 bounds+哈希与盘面密码学吻合才生效）。**B6**（覆盖声明失实）→ RT29 行段专杀例+变异 Mu-r2B2b/c 实证。
- 结构重构：原无尾 marker 块抽独立函数 completeMarkerResidue(fh, raw, anchor, marker, opts, audit)（readBack 前置）：四形分派=①幂等清理形②截断形补行③已补行形转锚④其余 conflict 拒。
- 关键接缝教训：主函数 try/finally 内 `return completeMarkerResidue(...)` 未 await→finally 的 fh.close() 先跑→函数内 writeFull/datasync 用已关 fd 报 EBADF file closed（两处调用点均须 `return await`）；recovery-evidence-source.ts 的 sha256Hex 是同步 function 非 async（python 锚点替换 assert 抓错避免半成品）。
- 测试扩展 RT27-RT34（8 例；B1 面两例落 recovery-evidence-source.test.ts，余落 repair-tail.test.ts）：RT27-B1 marker 在场（含形状非法）→捕获 pendingRepair=true→recoverFromSnapshot diskBlocked=false 但 resumeBlocked=true+resumable 空（正对照：无 marker 时 resumable 含 i1 自证判别力；marker 清除后恢复常态=收敛出口）；RT28-B1 marker 路径成目录（EISDIR 非 ENOENT）→unavailable read-failed+清障重试收敛；RT29-B2/P7 双注入（前缀等长篡改→prefix-mismatch-after-repair+锚不搬+marker 留+盘面含行+重试 anchor-mismatch 拒；行段等长篡改→row-mismatch-after-repair=B6 专杀面）——注入点=行校验读之后 readBack 首块（syncs≥2 && pos===0 的 read 拦截；datasync 时注入会在行校验先炸）；RT30-B2/P8 校验后截短→read-back-short 抛+锚不动+marker 留（同注入模式）；RT31-B3/P5 有尾+伪 marker bounds 不吻合→repair-marker-conflict+盘面一字不动+marker 原文保留（旧代码在此覆盖真 marker）；RT32-B3/P10 部分补行形三阶段构造（throwHandle 截断后崩溃→手工 append marker 构造行 30 字节严格前缀（buildId=重试同参+at=marker.startedAt）→重试 ftruncate 回截断+marker-complete+removedSha256/at 来自 marker 原始事实）——构造要点：seedAnchor 必须在撕裂尾 append 之前（锚=干净前缀；若锚覆盖被移除字节→有尾分支 anchor-mismatch 先拒）；RT33-B3 吻合形（truncate 抛制造盘面尾仍在+marker 在场）→重试 fresh 完成+at=marker.startedAt 保留；RT34-B4/P6 双段（rmBoom fsLike→marker-rm-boom 上浮+物理修复已完成（行+锚）+marker 残留；重试无授权→marker-cleanup 幂等补完+锚不重写）。
- 变异六连全杀（基线 6b5c70d 提交后逐支注入→红→checkout 还原→复绿）：Mu-r2B1（marker 检测删→pendingRepair 恒 false；RT27 杀）/Mu-r2B2a（readBack 短读静默 break；RT30 杀）/Mu-r2B2b（fresh 行段验证删；RT29 杀）/Mu-r2B2c（fresh 前缀验证删；RT29 杀）/Mu-r2B3（有尾冲突门整块删；RT31 杀）/Mu-r2B4（幂等清理形删→重试 anchor-stale 误拒；RT34 杀）。
- 运行证据：repair-tail+recovery-evidence-source 73 绿（新增 8 例）；全仓 1253 绿（64 文件+2 skipped）；apps/server tsc --noEmit exit0；eslint 0。

## P0-1a r3 修复批（GPT r3 审 76 NO-GO 四阻断修复：B1 阴影保留/B3a 判据上界/B3b 捕获序/B6 专杀；2026-10-06；基线 5d6b311）

- r3 四阻断修法（审报=audits/gpt-p01a-r3-review-2026-10-06.md）：
  - B1-r3【高】withRepair 清 pending=丢唯一修复阴影（P1：旧快照补完后 resumable=[i1] 洗白）→快照加 repairUndecided?: boolean（曾见 pending 事务且裁决事实从未进入 lines）；withRepair 在 pending/已 undecided 时置位；repairShadow 三链=repairLog>0 || pendingRepair || repairUndecided；canonical hash 数组加两字段。语义分层披露：物理修复完成≠裁决授权；repairUndecided 待 P0-1b adjudicate 显式解锁；无 pending 历史+无 repair 行+无残片的快照 withRepair 后仍正当解锁（RT40 对照二）。
  - B3a-r3【中】部分补行判据上界误用被删尾长度（P3：5/14/40/100 字节合法崩溃前缀，14=恰等原尾长误入 file-changed、40/100=超原尾长误入 conflict）→判定重排：①bounds 全等+尾哈希等=吻合形复用 fresh（startedAt 保留）②byteStart 对齐且 tail 为 mrow 严格前缀（tail.byteLength<mrow.byteLength——上界=修复行全长，与原尾长度无关）=部分补行形（回截+marker 补完）③bounds 全等但哈希不等且非前缀=file-changed ④其余=repair-marker-conflict。跨 build 部分行：前缀落在 buildId 字段之前（两 build 共同前缀）可收敛；已含不同 buildId（前缀不匹配）→保守冲突拒（挂账披露：部分行跨 build 收敛性以 buildId 边界为界，不整体外推）。
  - B3b-r3【中】pending 捕获写穿锚+回截前不查锚=串行死结（P4：锚 213→写穿 233→重试先 truncate 后 anchor-stale 拒→盘面已被改+锚指已删字节→复捕获 concurrent-modification）→双侧修：provider marker 检测提前到锚验证/写穿之前，pending 态不写穿锚（保留事务前锚界）不判 concurrent-modification（盘面变化=事务中间态；marker 信任域同 evidenceDir 隔离前提）；repair-tail 部分行分支锚可转移性检查前置到 ftruncate 之前（anchor.len>marker.byteStart=旧版写穿脏态→aborted anchor-stale 且盘面一字不动，兑现「aborted 不动盘面」契约）。
  - B6-r3【中】三支非等价变异存活（M-H canonical 删 pendingRepair/M-R expectedRow=builtRow 重构造/M-P 删前缀 equals）→仓内专杀：RT41 hash 身份（仅 pendingRepair 或 repairUndecided 不同即 hash 不同）/RT38 跨 build 已补行（reconciled via marker-reconcile+盘面 b1 行原文逐字节保留）/RT37 非匹配前缀（「NOT…」短尾→conflict 拒+盘面不动）。
- 测试扩展 RT35-RT41（7 例）+RT39b：RT35-B3a 四态循环（5/14/40/100 前缀全收敛 marker-complete+removedSha256/at=marker 事实）；RT36-B3b 锚写穿脏态（手工重写锚文件 len=233 模拟旧版 provider）→aborted anchor-stale+盘面 equals 原文+marker 保留；RT37/RT38（B6 专杀，见上）；RT39-B3b 死结解全链（部分补行 20 字节→pending 捕获锚保持 213/旧 sha→重试 repaired→复捕获锚推进到新长度+pending=false+repairLog 阴影阻断）；RT39b 截断形含尾锚（含尾首捕→crash 截断→pending 捕获不判 concurrent-modification+锚不动→带授权重试仍 aborted anchor-stale=保守面守护：授权出口只领回「行已落盘锚未转移」形，锚覆盖被移除字节不可证删除面只在尾段→宿主走迁移面）；RT40-B1 组合（pending 快照→withRepair→repairUndecided=true→仍阻断；修复后新捕获 repairLog 阻断；二次 withRepair 幂等保留；对照二正当解锁）；RT41-B6 哈希身份。
- 变异八连全杀（基线 5d6b311 提交后逐支 python 注入→定向红→git checkout 还原→复绿）：Mu-r3B1（withRepair undecided 置位删；RT40 杀）/Mu-r3B3a（前缀 equals 删=M-P 同型；RT37 杀）/Mu-r3B3b（回截前锚检查删；RT36 杀）/Mu-r3BH（canonical 删 pendingRepair=M-H 同型；RT41 杀）/Mu-r3BR（expectedRow=builtRow=M-R 同型；RT38 杀）/Mu-r3B3b2（provider pending 写穿条件删；RT39 杀）/Mu-r2B3-replay（冲突门恒假——判定重排后的新块；RT31 杀）/Mu-r2B1-replay（marker 检测删——检测块移位后的新位置；RT27 杀）。r2 六连中 Mu-r2B2a/B2b/B2c/B4 注入点未动，上批结论保留。
- 运行证据（r5 勘误，本句为指向注：完整勘误在「P0-1a GPT r5 修复批」节）：当时宣称 tsc exit0 失实——GPT r5 实跑 exit 2/TS2345（新 reason 未进类型联合，见 B1-r5），由 r5 修复批（0db291e）闭合；其余数字（三文件 115 绿/全仓 1261 绿/eslint 0）属实。
- 遗留披露：①rt38-debug 构造教训=测试 helper legalRepairRow 不带换行，已补行形 append 必须拼 "\n"（否则成撕裂尾落有尾分支）；②r3 审低项 L1（readBack 后仍有锚 tmp 写入窗=Q16 修复期禁写前提内）/L2（marker 哈希披露措辞限缩——removedSha256 无独立认证，截断形原尾已消失只能信任宿主 marker）/L4（无真实断电实测）——不阻断，下批吸收或部署前兑现。


## P0-1a r4 修复批（2026-10-06；基线 32bb5a7）

**审报**：projects/pi-agent-ui/audits/gpt-p01a-r4-review-2026-10-06.md（82 NO-GO：B1-r4 无锚 pending 首捕 seen 污染死锁/B6-r4 起点对齐条件无仓内杀手；零 open 高）。

- **B1-r4【中】修法**：recovery-evidence-source.ts 捕获流程 marker 检测后新增门——pendingRepair 且 anchor===null（修复事务进行中且权威锚从未建立）→`unavailable("repair-pending-first-capture")` 零副作用拒绝（不建锚、不登记 seen、不写任何证据文件），杜绝「无锚+已登记」矛盾态：后续捕获必判 concurrent-modification 死锁、修复工具按无锚不建锚契约不补锚、迁移面误报 migrated 而无锚。事务完结（marker 清除）后首捕正常建锚。trustFirstCapture 授权不豁免此门（首捕权威=锚落地时点，pending 态无权威可建）。RT43=P8 三路对照全链（路一 pending 首捕拒绝+seen/锚双零文件实证；路二迁移面 rejected 不误报 migrated；路三修复完成后首捕正常建锚+repair 行进 lines+resumable 阻断）。
- **B6-r4【中】修法**：repair-tail.test.ts RT42 交叉起点杀手——截断处先插完整 i2 行（当前撕裂尾起点≠marker.byteStart）再拼 repair 行严格前缀 11B→断言 aborted/repair-marker-conflict+盘面逐字节不变（i2 行保留）+marker 原文保留。守 `marker.byteStart === byteStart` 起点对齐条件（删则误判部分补行形→ftruncate 回截删掉 i2 整行=GPT 实证 455→448B 数据丢失）。
- **L3** RT39b 标题改为「带授权仍保守拒绝（anchor-stale 不改盘）」如实语义；**L4** r3 节小计口径修正（新增 8 例/64+2 文件）；**L2** 跨 build 措辞按 buildId 边界精确化（共同前缀可收敛/已含不同 buildId 保守拒）。
- 变异双连全杀：Mu-r4B1（无锚 pending 门删→RT43 红）+Mu-r4B6（byteStart 对齐删→RT42 红）；还原复绿。
- 运行证据：三文件 117 绿（35+36+46）；全仓 1263 绿；eslint 0 属实；tsc exit0 宣称失实（r6 勘误——r4 批引入 recovery-pending-first-capture reason 未进类型联合，当时实跑应 exit 2/TS2345；r5 审实证，0db291e 闭合）。
- 遗留挂账（沿承）：L1 信任域前提（resumeBlocked=授权门）/L5 marker 无独立认证+无真实断电实测/L7 repairUndecided 保守粘滞语义（P0-1b 统一术语）。
## 视觉基建批（I8 明暗双主题+Codex 风基调 / I7 动效基线；纯视觉层零行为改动；分支 wt/kimi-web-1）
- **范围**：design tokens 全量入 CSS custom properties（色彩 --c-bg/-panel/-fg/-muted/-accent/-accent-bg/-border/-ok/-warn/-err 及 -bg 变体+-neutral 族；--r-sm/md/lg；--sp-1..6；--shadow-sm/md；--t-fast/base/slow；--ease-out/--ease-spring；--font-mono），亮（:root 默认）/暗（:root[data-theme="dark"] + prefers-color-scheme 媒体查询兜底「跟随系统」）双值域；apps/web/src/theme.ts（ThemeName=light|dark|system 联合型+令牌常量族+读写面：html[data-theme]+localStorage 键 pi-agent-ui.theme，非法值回退 system）；ThemeToggle 组件（三段 segmented 开关：亮/暗/跟随系统，aria-pressed 标记，挂载即应用持久化选择）；五处组件面（token-gate/connbar/session-list/session-detail/write-composer）全量改用令牌变量，令牌块（:root 族）之外零硬编码色值；I7 四类动效（列表选中 transition+list-select-in 关键帧 / 详情切换 detail-enter 淡入 / 发送按钮按压 spring / composer 聚焦光晕 composer-glow），时长一律引用 --t-* 令牌，@media (prefers-reduced-motion: reduce) 段四类全关停；Codex 风基调=中性灰阶+accent 单色克制（仅品牌符/选中态/焦点环）+会话正文等宽栈（.message p/.history-list/.live-list/.write-composer textarea）。
- **测试面**（tests/unit/web/theme.test.ts，18 例，jsdom）：①令牌静态面×8——CSS 经 node:fs 直读原文件（vitest 将 CSS 导入 stub 为空串、jsdom 下 import.meta.url 非 file scheme，两处坑已在头注标明），极简规则解析器（去注释+花括号配对+@规则递归展平）断言：亮/暗/系统兜底三值域色彩令牌齐全、:root 圆角/间距/动效/字体令牌齐全、令牌块外零十六进制色值、令牌块外零字面毫秒（时长全走 --t-*）、reduced-motion 段 animation/transition 双 none 且覆盖四类动效宿主选择器、会话正文三处 var(--font-mono)；②theme.ts 读写面×6——缺省/非法值回退 system、writeTheme→readTheme 三态 roundtrip、applyTheme dark/light 写属性、system 移除属性、setTheme 一步持久化+应用；③ThemeToggle×4——三选项渲染+默认 system pressed、点击暗色切换生效+持久化+pressed 翻转、亮→跟随系统属性移除、挂载即应用预置 dark 存储。
- **终态**：tests/unit/web/ 208 passed（190 基线+18 新增，≥202 验收口径）；全仓 1180 passed+11 skipped；tsc -p apps/web --noEmit 净；eslint 净。
- **自曝残余**：①动效断言为静态层（选择器+令牌引用+reduced-motion 段存在性），运行时帧级表现（spring 曲线体感、闪烁）未做浏览器实测，需人工过一遍亮/暗两主题目检；②detail-enter 挂在 .session-detail 的 empty/header/history-list 与 .conversation .welcome 上，靠元素重挂触发，同视图内数据追加不重放（符合预期但属设计取舍）；③阴影令牌暗色=none（暗主题无投影，Codex 风惯例），若后续要暗态投影需加值而非改结构；④App.tsx 两处虚拟化内联 style（高度/translateY）为 react-virtual 机制必需，非色值，不在本批剔除范围；⑤旧变量名（--bg/--panel/--accent 等）已全量删除无兼容别名，仓外若有引用旧变量的片段需同步迁移（仓内已 rg 核实零残留）。

## A1d+视觉 r1 修复批（GPT 审 78 NO-GO 两阻断闭合：B1 认证目的地绑定+B2 减动效全关停，+N1/N2/N5；分支 wt/kimi-web-1）
- **B1 根因**（审报三节）：`?server=` 覆盖无运行/构建层限制，已存 localStorage 令牌随三客户端 hello 自动外带至任意跨源目的地（GPT P1 假 socket 亲证 3/3 外送）。修法=双层：①`resolveWsUrl` 的 `?server=` 覆盖仅 `import.meta.env.DEV` 为真生效，生产一律忽略回退同源（凭据目的地绑定，非通用参数校验；dev 判定可注入桩 `{dev:false}` 测试生产语义）；②新增 `isSameOriginWsTarget`（https 页面只认 wss、host:port 全等才同源，不同端口即跨源），组合根 RealApp 对跨源目的地 hello 令牌置空串（零携密，服务端按未认证拒）+connbar 提示「跨源目标不支持凭据」。已存令牌绝不出本源。
- **B2 根因**（审报三节优先级对照表）：启用侧 `.session-list button[aria-current]`(0,2,1)、`.write-composer:focus-within textarea`(0,2,1) 压过媒体查询内 `.session-list button`/`.write-composer textarea`(0,1,1)——媒体查询靠后不自动赢优先级；Chromium 实测 list-select-in/composer-glow 仍跑。修法=reduce 块逐项对齐启用侧完整状态选择器（同优先级+源码序级联取胜，不用 !important 避免军备）。
- **N1**：`readUrlToken` 拆「读有效 token」（首个非空值）与「删全部 token 键」（含空值/重复键，URLSearchParams.delete 语义；新增 hadTokenParam 标记，空值键也触发清参）；`clearUrlToken` 保留 hash 与 history.state（旧实现二者皆丢，GPT P4/P5 反例）。
- **N2**：`resolveWsUrl` 拒带 fragment 的 ws(s) URL（hash 非空=畸形回退同源）。
- **N5 措辞收窄**：token-gate 测试注释/例名「全程 token 值不进 DOM」→「连接与错误面不回显令牌」（textContent 断言不支撑「DOM 任何位置」，手输期 password value 本就可被脚本读）；「全量令牌化」限定为本批迁移范围——styles.css 仍存 9px/18px/19px/20px 等固定尺寸（:124/:146/:167/:211/:280/:285/:297/:320 等），如实记录不扩称。
- **测试面**（tests/unit/web/ 12 文件 230 例，+22）：app-clients.test.ts +8（生产 dev=false 忽略 ?server=×1 三断言/fragment 拒绝×2 值/isSameOriginWsTarget×6/空 token hello 零携密×1；既有 dev 覆盖例改显式 `{dev:true}`）；token-gate.test.ts +13（N1 纯面×6+RealApp 全链清参×2；B1 全链×4：a) 预存 token+跨源不同端口→三 socket 首帧 token=""且全文不含已存令牌+UI 提示，b) 同源覆盖正常携令牌无提示，c) 生产忽略语义接线说明例（dev 下生效+单元层锁定生产），d) 手输 token 同源不受影响）；theme.test.ts 静态断言补两状态选择器（回归下限）；reduced-motion.browser.test.ts 新增（+1，有效性上限）：真实 Chromium headless shell `--force-prefers-reduced-motion --dump-dom`，亮/暗两组×四元素（选中列表钮/聚焦 textarea/写按钮/详情 header）共 8 态断言 animationName=none+transitionDuration=0s，浏览器不存在 skipIf 优雅跳过。**变异实证**：临时还原 styles.css 修复（git stash），浏览器测试即红（selected animationName=list-select-in 复现 GPT 反例），恢复后绿。
- **教训落档**（GPT N3）：静态字符串断言不足——CSS 级联/优先级只有真实引擎计算样式能证；静态断言保留为回归下限，浏览器实测为有效性上限。
- **运行证据**（本机亲跑，cwd=仓根，PATH=node v24.18.0）：`npx vitest run tests/unit/web/`=12 files/230 passed；`npx tsc -p apps/web --noEmit`=exit 0；`npx eslint apps/web/src tests/unit/web`=exit 0 零输出；`npx vitest run` 全仓=64 files passed+1 skipped，1202 passed+11 skipped。
- **自曝残余**：①B1 生产忽略语义只能在 resolveWsUrl 单元层（注入桩 dev=false）锁定——RealApp 走 import.meta.env.DEV，jsdom/vitest 下恒 true 无法翻转到生产构建值，接线正确性靠「组合根只经 resolveWsUrl 取 URL」代码事实+dev 下全链例；②跨源 dev 目标下用户手输令牌同样被绑定剥除（hello 恒空串）——即跨源开发服务器无法经本 UI 完成认证，这是「未受信目的地零携密」的刻意收紧，如需合法跨源开发须另设显式可信配置（本批未做）；③浏览器实测为最小 DOM 探针（非整页体感/逐帧验收），手机视口/键盘遍历/对比度仍属 N6 挂起面；④430px 以下等固定尺寸与 accent 族使用面（running badge/用户消息背景/welcome 标志）未在本批改动，N3 指出的机械断言面（rgb/hsl/命名色、秒单位）未升级为 CSS AST 检查。

### r1 后拍板落地：跨源=不拨线+明白提示（选项 A；GLM 执行，2026-10-05 用户 ask_user_question 拍板）
- **拍板**：开发模式遇跨源 `?server=` 目标时，上段「零携密 hello+connbar 提示」改为**选项 A：一根线都不接**（三件套不建、hello 永不发出），拒绝面 role=alert 明示「已拒绝连接：目标不是本站」+目标 URL+两出口：「改连本站默认」（清 ?server= 保留其余参数/hash/state 后重试同源建连）/「重新输入令牌」（清 localStorage 回输入面）。生产忽略 ?server= 与 isSameOriginWsTarget 判据不变。
- **落点**：real-app.tsx（untrustedTarget/untrustedUrl 状态+拒绝面分支+connectDefaultTarget/restartWithFreshToken；ConnectedApp 去掉不可达的 untrustedTarget 提示行）；token-gate.test.ts B1 块改写：a) 零 socket+拒绝面+令牌零外带，a2) 改连本站默认（URL 清参+hash/state 保留+同源三件套+拒绝面退出），a3) 重新输入令牌（清存+回输入面+零 socket），c) dev 语义=拒绝面（生产语义仍在 app-clients 单元层锁定）；app-clients.test.ts 空 token 例改为「API 层防御能力」定位（组合根不再这样调用）。
- **运行证据**（GLM 亲跑）：`npx vitest run tests/unit/web/`=12 files/232 passed；`npx tsc -p apps/web --noEmit`+eslint=exit 0；全仓 `npx vitest run`=1204 passed+11 skipped。提交在 afd18bd 之上（见 git log）。


#### r2 后修复批（B3+N2/N7/N8，GLM）

- **B3（中，GPT r2 抓出）**：`改连本站默认`在 URL 仅剩 server 一参时失效——旧实现 replaceState 传空串/纯 hash=相对引用，原样保留 query，server 清不掉、永远出不了拒绝面。修法=目标 URL 显式带 `window.location.pathname`（`real-app.tsx` connectDefaultTarget）。回归=token-gate `a2-matrix` 四例（仅 server/仅 server+hash/重复 server 无余参/重复非 server 参数保留）：server 键全清+path/hash/state 保留+同源三件套+3 hello 携令牌+拒绝面退出+按钮前零连接。
- **N2 空串 fragment 补拒**：`resolveWsUrl` 判据从 `parsed.hash === ""` 改为原始字符串 `!override.includes("#")`（URL.hash 区分不了尾随空 `#`，真实 Chromium 会抛 SyntaxError）。回归=app-clients 空 fragment 两例。
- **N7 暗主题夹具修正**：`reduced-motion.browser.test.ts` 重构——亮/暗分两份独立文档，data-theme 挂 `<html>`（与生产行为一致；旧版挂普通 div 从未激活级联），并断言根 `--c-bg` 双主题不同值防同色假覆盖。
- **N8 注释同步**：app-clients.ts 两处「组合根置空串 hello」旧语义注释改为「选项 A 不拨线」。
- 运行证据：web 237 passed（含真实 Chromium reduce 实测）/全仓 1209 passed+11 skipped/tsc+eslint 净。
## A1b 复审修复批（GPT 复审 84/100 NO-GO 收口：B1/B2/B3+N1/N2；分支 wt/kimi-web-1，在 e27bac3 之上单提交、不 amend）

### 前批节（A1b 重写批，提交 e27bac3；本节为修正后的映射，替换前批同名字段中被审报收窄的表述）

- **范围**（六文件）：apps/web/src/ws/subscribe-client.ts+use-session-detail.ts+components/session-detail.tsx+tests/unit/web/subscribe-client.test.ts+use-session-detail.test.ts+本 MAP。禁改面零触碰（use-sessions/ws-client/write-*/app-clients/real-app/styles.css/契约文档/协议与 server 面/package.json/锁文件）；零新依赖；无 innerHTML。外部消费面签名不变（app-clients/real-app/use-write.test 零改动编译通过）。
- **保真清单对照**（委托规格 1-7 逐条落点）：
  1. **三分支流语义**：正常终局=快照末页（historyNext=null+liveFrom 转 live；本协议无 `t:"end"` 消费分支，前批「end 帧」表述收窄于此）/流错误=error 帧带 code/连接级=onerror+onclose：落 handleSnapshot/handleError（handleStreamTerminal+failSubscription）/handleClose；终局后旧流帧零受理=retiredSubs 退役集+activeSub 门+close() 停止屏障（已验面=本片枚举帧面；retiredSubs 为只增留痕集合非路由判据，未证明所有内存结构有上界）。测试：「分页聚合到末页」「onerror 后必跟 onclose」「4409/4431/4402 终局族」。
  2. **终局信封结构化身份路由**（K3-B1/K4）：handleError 内 subscriptionId 在场即流终局路由（先于一切请求级匹配），不解析 message 文本；requestId 恒空串口径。测试：「K3 P1 回归」「message 文本不参与路由（诱饵）」「A→B→A 新信封换流」+12 组合矩阵新信封列。
  3. **drain 出口 4431 带 subscriptionId**（K4 发现1，d0de86b）：客户端消费侧认结构化身份即覆盖；专测「K4 发现1 drain 出口形态（4431+subscriptionId+requestId 空串）」+真实链「4431 终局链（drain 出口形态信封）」（服务端侧 ⑲b=subscription-engine.test，不在本片）。
  4. **空串 requestId 口径**（C5）：handleError 连接级码（4403/4405/4432）关联判定认 undefined|""；parseError 对 requestId 空串验形通过。测试：C5 块「空串口径」+「无 requestId」两例（注：空串专测直接覆盖 4403/4432；4405 仅有无关 requestId 忽略例，未有空串专测）。
  5. **首包前/切换期泄漏防护**（K3-B2/B3）：cancelledBuilds 留痕（FIFO 32，既有有限留痕策略）+迟到首页只识别+补退订（绝不写快照/绝不清当前 file 订阅）；failSubscription 对活动订阅补发退订帧。测试：B2 块四例（首包前退订/A→B→A 往返/failSubscription 残留/畸形迟到首页不发退订）+K3-B1「B2 兼容」例。
  6. **提交期身份门**（K3-C/B3）：sessionDetailViewOf(snap, targetFile) 在快照 file≠目标时返回零内容门控视图（连接级状态如实呈现）；hook 返回值经门复核。测试：纯函数「B3 身份门」例+CommitLog 三例（A→B 切换/file=null/client 实例替换，layout effect 记录每次提交）。
  7. **详情组件**：session-detail.tsx 只读渲染；根恒 section.session-detail+两槽位稳定挂载（composer key=file）；视觉令牌类名与结构逐项保留；减动效行为归 styles.css（本批未触碰）。
- **测试数对照**：subscribe-client.test 51→67（静态 55 it+12 组合矩阵循环展开）；use-session-detail.test 25→30；合计 76→97。本修复批 +2（观察者清理锁死×2）→ **99**；「12 组合等价或更强」表述收回——GPT 复审以窄变异证明父版 4404 隔离回归分支曾被删（B1），本批恢复前不构成等价。
- **自曝残余**：①「12 组合」出处按「3 码×新/旧信封×活动/非活动」理解落成矩阵 describe。②快照续页 60s 宽限真实轨迹无前端公共入口可验（沿用旧口径）。③status 帧无 statusVersion 回退门（有序传输前提，沿用旧口径）。④形状门传输 ID 上限 128（与 LIMITS.idPattern 同源），契约 64 域收紧由服务端 4404 把关（沿用旧口径）。⑤组件 DOM/文案逐字保留。

### 本批修复清单（对应审报 gpt-a1b-rewrite-review-2026-10-05.md 第五段）

- **B1（阻断，覆盖缩水）**：恢复父版 :895–920 被删分支②——「同 file 重订阅时旧 init 的 4404（requestId=旧）不误伤新 init，新 snapshot 随后落地」，与①无关 requestId 忽略合并为 subscribe-client.test.ts「请求级 error（requestId 无 subscriptionId）」一例两段。变异自验（实现源码临时改 `frame.requestId === pending.requestId` → `pending 在场且 requestId 非空即命中`）：基线两目标文件 **99 绿**→变异后 **1 红 98 绿**（红例=B1 新例）→还原后 **99 绿**。实现源码 subscribe-client.ts 本批零改动（git diff 为证）。
- **B2（阻断，文档越界）**：TEST-MAP 以父版 cdf3d94 全文逐字恢复为前缀（旧文零改动，diff 仅末尾追加；分隔换行单独处理），本节为唯一新节；未运行任何全文件格式化。
- **B3（阻断，记录纠偏）**：前批验收补记「c2cc285 之后才写入最后三例（4431 终局/空串/K3 P1）并 amend 到 993761c」与 Git 证据矛盾，纠正为可证明事实——该三例在 c2cc285 原提交已完整存在（复审对 c2cc285→993761c 两版测试的 TypeScript AST 比对完全相同）；reflog 确认 c2cc285→993761c→e27bac3 两次 amend，收入的是测试/表格格式变化与补记追加。「提交后树何时非净、谁于何时执行检查」无独立时点记录→**未核实**。
- **N1（建议转必做，观察者清理锁死）**：固化复审探针两例——subscribe-client.test.ts「观察者清理锁死」describe（退订闭包后状态推进零触达被移除者+在册者正对照）；use-session-detail.test.ts 真实链「观察者清理锁死」（hook 卸载即移除 store listener、卸载后推进零触达、重挂后一次推进恰一份通知）。两者均可被「删 `listeners.delete(listener)`」窄变异击红。
- **N2（过称收窄五处）**：①工厂抛错例补 subscribe 拒绝断言（标题「connect/subscribe 全拒绝」现有据）；②live 追加例补「空帧后重发同号带事件仍吸收」+形状合法回退序号例（水位推进现有据，原 seq=0 形状门先挡例移除）；③12 矩阵「旧信封×无活动流」补已退订分支（标题「首包前/已退订」现双覆盖）；④C4 例补 streamNote 与 errorMessage 同场断言（优先级锁定现有据）；⑤全链例补中间态断言（subscribing→loading 面、页1 后分页提示在场），不再只在末页后断言。另收窄：两测试文件头注「断言等价或更强」删除、「正常终局=end 帧路径」标题改为快照末页口径。
- **验证数字**（本机亲跑，cwd=仓根，PATH=node v24.18.0；vitest 均带 `--no-cache --configLoader runner`）：两目标文件 `npx vitest run tests/unit/web/subscribe-client.test.ts tests/unit/web/use-session-detail.test.ts`=**2 files/99 passed**；web 全集 `npx vitest run tests/unit/web`=**12 files/260 passed**；`npx tsc -p apps/web --noEmit`=exit 0；`npx eslint apps/web/src tests/unit/web`=exit 0 零输出。提交后 `git status` 净。

### P0-1a GPT r5 修复批（B1-r5+L1，0db291e，2026-10-06）

- **B1-r5【中】新 reason 未进类型/冻结协议**（r5 审 T3/P6 实证：tsc exit2 TS2345+真网关 get-recovery 出帧 reason=repair-pending-first-capture 越出协议 v1 四值）→修法=对外映射进冻结契约既有值 `no-evidence-snapshot`（协议四值零新增；与「盘面曾修复且无权威快照不得裸读出结论」的 B03 语义同构）；具体成因留审计行 `recovery-pending-no-anchor`（recovery-evidence-source.ts:409-413 注释披露映射语义）。未动 contracts.ts/docs（对外契约面零变化）。
- **L1 RT43 零副作用断言虚空通过**（查错文件名 evidence-seen.json；生产 seenPath()=seen.json；GPT 变异实证：门内插 persistSeenLike 写 seen.json 原 RT43 不红）→修法=断言改正确路径 seen.json ENOENT+目录级强断言（拒绝前后 evidenceDir 全量文件名+逐文件字节快照全等——覆盖「不建、不重写、不留 tmp」三态）；审计行断言 recovery-pending-no-anchor 在场（区分普通 no-evidence-snapshot 拒绝）。
- 变异实证：Mu-r5L1（GPT 原 seen 副作用变异重放：门内拒绝前插 persistSeenLike 写 seen.json）→RT43 红（目录快照杀点）→还原绿。
- 事故披露：M-245 第三次同型（checkout 还原变异吞未提交修复块）→重打后立即提交再跑全门；教训已入 MISTAKES。
- 运行证据：recovery-evidence-source 46 绿；全仓 1370 绿（69 文件 passed+2 skipped+15 skipped）；apps/server tsc --noEmit exit0（亲证）；eslint 0。

## P0-1b 裁决持久化实现批（PROJECT P0 冻结序②；设计=docs/p0-1b-adjudicate-design.md 58c5348；2026-10-06）

**范围**：adjudicate 行型入 journal 联合+schema 校验；adjudicateJournal 写工具（三道门+锚转移）；读面配对解锁+派生归因。**实现期关键语义勘定（设计稿遗漏面，比设计稿更强）**：两种 subject（fragment={raw,intentId}/repair=四元组）身份统一锚在**修复事务**——fragment 在场校验=sha256(raw) 与某 repair 行 removedSha256 全等+intentId 在重放范围（enqueue 集）；裁决**必须在物理修复后落盘**（修复前追加补换行会把撕裂尾变中间断行，repair-tail 从此不修→永久 diskBlocked；且裁决不可先于事实——R8：pending 期 repair 行未落盘，天然 subject-absent）。

- **protocol**（packages/protocol/src/journal.ts+journal-schema.ts）：AdjudicateLine 接口（subject 判别联合+verdict=resend|abandon+operator+buildId+contractVersion+at）入 JournalLine 联合；schema 校验（fragment raw/intentId 非空/repair 区间非负安全整数 byteEnd>byteStart+removedSha256 64hex/verdict 双值/operator/buildId 非空/contractVersion≥1）；replayIntents adjudicate case 聚合面无操作。
- **写工具**（apps/server/src/runtime/adjudicate-journal.ts 新文件）：adjudicateJournal(opts)——resolveWithinRoots 越界门→openSafeReadWrite→parseJournalText→①身份在场（上述统一锚）②幂等/冲突终局（同 subject 同 verdict=idempotent 返回原 at；反 verdict=conflicting-verdict 不可翻转）③撕裂尾补换行+appendFile+sync（失败=write-failed 零裁决）④锚点转移（前缀复验 sha256(raw[0:anchor.len])===anchor.sha 防追加窗篡改→writeAnchor len/sha 前移到新内容；失败不回滚只记审计，下轮捕获 concurrent-modification 拒快照=保守阻断方向正确）。测试接缝 openHandle→{fh,size}。
- **读面**（apps/server/src/runtime/recover.ts buildRecoverReport）：adjudications 派生（fragAdj/repairAdj 类型守卫）；derivedVerdicts 并入 verdicts（raw|intentId 去重——R3 幂等）；abandonedIds（abandon 的 intentId）/resendIds（resend 的 intentId——**授权重发，覆盖 unknown 排除进 resumable**）；adjudicatedRepairs=四元组集∪fragment sha 配对（sha256Hex(raw)===removedSha256，与写入侧同一等式）；repairShadow 改判=unadjudicatedRepairs>0||pendingRepair||repairUndecided；resumable 排除 abandonedIds+sending/超时/cancelled（resend 裁决覆盖 unknown 不覆盖在途——完整 sending 行在=在途不可重发，与重发并发风险隔离）。顶部 sha256Hex helper（node:crypto）。
- **测试**（tests/unit/server/adjudicate.test.ts，10 例，真实 fs）：R1 写失败重试收敛（crash 句柄注入 appendFile 抛→write-failed 零落行+锚不动+盘面权威验证+真句柄重试收敛）/R2 已落盘未确认重启重读（修复后未裁决阻断→裁决→recapture 配对解锁+撕裂 sending 恒 unknown+resumable 空）/R3 幂等+冲突拒（保留原裁决时点+单行+不可翻转）/R4 身份三态拒（四元组错/fragment sha 错/intentId 越界全 subject-absent 零落行；读面 stale 裁决不解锁三态对照）/R5 裁决行撕裂=中间断行 bad 阻断（fail-closed 只多阻断不漏授权）/R6 repairUndecided 旧快照粘滞 vs 新快照配对解锁/R7 事务间互不串扰（双 repair 事务：裁决其一仍阻断；fragment+repair 两种 subject 混合全配对解锁+resend 进 resumable）/R8 pending 期裁决不可先于事实（无 repair 行→双 subject 均 subject-absent）/R9 abandon 解锁但 resumable 排除（终局放弃）/R10 生产路径派生（快照 attributedFragments 恒空+journal 行自派生+resend 覆盖 unknown+报告呈现）。
- **r6 低项吸收**（挂 P0-1b 批内）：L1-r6=TEST-MAP 两处勘误（r3 节运行证据改指向注+完整勘误在 r5 节；r4 节 865 行 tsc exit0 宣称勘误——r4 批引入 reason 未进类型联合当时实跑应 exit2，r5 审实证 0db291e 闭合）；L2-r6=RT43 两断言改强（readFile 拒绝改 rejects.toMatchObject({code:"ENOENT"}) 精确断言；目录快照 Buffer 对比改 base64 无损编码，弃 utf8 拼接）。
- 变异四连全杀（基线 d264b6e 提交后注入→定向红→checkout 还原→复绿，五步单链纪律）：Mu-b1（adjudicatedRepairs 置空→R2/R4/R6/R7 4 红）/Mu-b2（fragAdjudicatedShas 置空→R7/R9/R10 3 红）/Mu-b3（resend 覆盖反转→R10 1 红）/Mu-b4（写工具 shaMatch 恒真→R4 1 红）；还原后定向复绿 10/10。
- 运行证据：adjudicate 10 绿；recovery-evidence-source 46 绿（改后）；全仓 1380 绿（1395-15 skipped）；apps/server tsc --noEmit exit0；eslint 0。

## P0-1b r2 身份模型重构批（GPT r1 审 66 NO-GO 修复；报告=worktrees/gpt-p01b-r1-review/p01b-r1-review.md；2026-10-07）

**范围**：B1-B5 五高+L1-L4 四低全闭合——裁决身份从「raw 内容/词法包含」重构为**修复事务四元组**（removedSha256/byteStart/byteEnd/at）+追加前置盘面门。r1 版判废语义（B 系全部）：fragment 按 sha256(raw) 匹配=同内容新事务误解锁（P3）；同 raw 换 intentId=假幂等（P2）；UTF-8 撕裂字节重编码 SHA 失配=fragment 永久 subject-absent（P7）；resolveWithinRoots 词法包含=祖先 symlink 越界（P11）；历史 repair 行在场≠盘面可追加——撕裂尾补换行毁修复资格（P4）+marker 残局裁决致 marker-conflict 死（P10）。

- **protocol v2**：AdjudicateLine subject 两分支均=四元组（fragment 另携 intentId 归因目标）；raw 全文不入裁决行（P3/P2/P7/L2 一并消除——原字节证据由 repair 行 removedSha256 持有）；schema 同构收严。
- **写工具 v2 四道门**（adjudicate-journal.ts 全重写）：①realpath 实根包含门（与 repair-tail :229-248 同界）②盘面门=marker 在场→aborted repair-pending（P10）/bad 行含撕裂尾非空→aborted bad-tail（P4），均零改盘 ③身份门=四元组与恰一条 repair 行唯一匹配（多条=歧义拒）+fragment 另验 intentId∈enqueue∪sending 集 ④幂等/冲突终局=同 kind 同四元组已裁决→同 verdict 且同归因目标=idempotent 原 at；反 verdict 或换目标=conflicting-verdict。落盘 append+sync（失败=write-failed **提交结果不确定**——R1b 实证 append 已落+sync 抛形裁决已在盘，幂等重试收敛非零裁决）；锚转移失败不回滚不阻断（P1 证明：provider 验锚只查旧前缀不变→纯扩展允许→捕获自动收敛无死锁，工具注释已弃「拒快照」措辞）；锚 sha=Buffer 字节哈希（sha256HexBuf 局部定义，与 repair-tail 同源；recover.ts 顶部 string 版 sha256Hex 已无人引用删除）。
- **读面 v2**（recover.ts）：有效裁决=四元组在场当前 repairLog（stale 淘汰 P9）；同四元组多 intentId=冲突组整组无效（阴影保留不派生，写面已拒换目标+读面防御手写盘面 P8）；abandonedIds/resendIds 只从有效非冲突 fragment 裁决派生；adjudicatedRepairs=repair 裁决四元组∪有效 fragment 裁决四元组；**derivedAdjudications 新报告字段**（kind/repairKey/intentId/verdict/at；无 raw 呈现）——journal 派生裁决不再并入 G2 raw 匹配（效果走 abandoned/resend 通道）；attributedFragments（快照人工裁决）维持原 G2 语义不变。
- **测试 v2**（12 例）：R1a/R1b 写前/写后失败分离（crashAppend/crashSync 句柄；R1b 断言裁决已在盘+重试 idempotent 单行）/R2 转锚崩溃窗收敛正例（writeAnchorImpl 注入抛→anchorMoved:false+锚前缀复验成立（纯扩展实证）+重试幂等+重读解锁）/R3 幂等/冲突终局三态（含 B3 换目标拒）/R4 四元组字段独立负例（sha/byteStart/byteEnd/at 任一错+歧义两行+目标越界；读面 stale 对照）/R5 真跑 repairJournalTail（bad-tail 拒零改盘→修复→重试成功）/R6 undecided 粘滞 vs 新快照解锁/R7 同内容双事务不串扰（同 sha 不同 at——P3 杀点正例：裁决其一另一仍阻断）/R8 marker 生命周期（在场拒零改盘+残局形+清除后成功）/R9 abandon（残片归因 unknown 真源——sending 撕裂 `{\'t\':\'sending\',\'intentId\':\'i1\'` 形态，scanTopLevelIntentId 可提取）/R10 生产综合（resend 覆盖真源 unknown+derivedAdjudications 呈现+stale/冲突组不呈现不派生）/R11 祖先 symlink 越界（B4/P11 杀点：gate 根词法内+实路径根外→path-escape 拒零改盘+真实根对照通过）。
- 变异五连全杀（基线 b605571 提交后注入→定向红→checkout 还原）：Mu-r2-1 盘面门反转 if(false)→R5 杀/Mu-r2-2 realpath 门失效→R11 杀/Mu-r2-3 身份门歧义放宽 length<1→R4 杀/Mu-r2-4 幂等换目标放宽→R3 杀/Mu-r2-5 冲突终局恒幂等→R3 杀；还原后定向复绿 12/12。
- 运行证据：adjudicate 12 绿；全仓 1381 绿×2（1396-15 skipped；首跑 1 failed 为计时类 flaky，json reporter numFailed=0+复跑两次全绿证实）；apps/server tsc --noEmit exit0；eslint 0。

## P0-1b r3 授权作用域化+四门补强批（GPT r2 审 77 NO-GO 修复；报告=worktrees/gpt-p01b-r2-review/p01b-r2-review.md；2026-10-07）

**范围**：B1-B4 四必修+L1-L4 四低全闭合。r2 版效果面缺口（B 系）：resendIds/abandonedIds 折成裸 intentId 集使旧 fragment 裁决越事务覆盖新事务残片 unknown（授权串扰）；marker 读错误无条件当缺失（EACCES/EISDIR 放行追加）；同四元组多目标的冲突组仅 fragment 侧失效，repair 裁决可解除冲突阴影；schema 未拒 raw（手写盘面带 raw 收为合法行）。**权威语义=设计稿 §8**。

- **读面 B1（授权作用域）**（recover.ts 裁决派生段重写）：resendKeys/abandonKeys 改 `Map<IntentId, Set<repairKey>>`（授权锢在其四元组来源）；unknownShas=`Map<IntentId,Set<sha>>` 由 attributed 残片 sha256HexBuf(Buffer.from(raw)) 构建；shasToTxKeys=repairLog 同 sha 事务集。scopeCovers(id,grants)：残片源的每 sha×每同 sha 事务全须有该 id 的授权（同 sha 双事务只裁其一→不覆盖；撕裂字节失配→无事务可授权→不覆盖）；resendCovers=无残片源 false（裁决只能授权其证据链内残片，不覆盖终裁 unknown 行）；abandonExcludes=无源 true（终局放弃）。G2 快照归因维持 raw 全等（新 raw 同 intentId 不消耗，R12 负例）。
- **读面 B3（冲突组整组失效）**：effectiveRepairAdj 同样过滤 conflictKeys；conflictKeys 非空并入 repairShadow（两顺序 frag-first/repair-first 同拒——repair 裁决不消冲突阴影）；derivedAdjudications 只呈现有效集。
- **写面 B2**（adjudicate-journal.ts）：marker 门 catch 仅 ENOENT 视缺失，其余（EACCES/EISDIR/EIO…）=aborted marker-unreadable 零改盘；**B3'**：矛盾集检测=收集同四元组全部既有裁决，多 verdict/多归因目标/kind 混合均 conflicting-verdict（不信任首行）；**B4**：minimalSubject 白名单拷贝（fragment/repair 两分支），opts.subject 额外属性不落盘；**L1**：FileHandle 全程 try/finally 确定性 close（close 失败仅审计）；**L4**：锚预检=loadAnchor 返回 corrupt/unreadable→aborted anchor-corrupt 写前拒（证据链已坏需人工）；前缀漂移不拒但跳过转移、audit 不承诺「自动收敛」（provider 对漂移锚保守拒 concurrent-modification）。
- **protocol**（journal-schema.ts）：adjudicate case 显式拒 subject.raw 与顶层 raw（运行时兑底；写面白名单是第二道）。
- **测试 v3**（17 例）：R1-R11 语义不变，新增/改造：R1b crashSync 改真形（append 真落+仅 sync 抛，旧形 append 内抛使 sync 断言不可达）/R9 补杀点对照（无门 baseline=buildRecoverReport(lines,q,{fragments:[],blocked:false})→无残片源时 unknownEffect 空且 resumable 不含 i1，证明排除力唯一来自 abandon 门）/R11 改目录链 symlink（gate/sub→outside，最终文件非 symlink，O_NOFOLLOW 不挡目录链=realpath 门独立杀点）/**R12 授权作用域**（主负例：同 sha 双事务只 tx1 有 fragment resend→resumable 不含 i1；对照组 tx2 也裁→含 i1；G2 负例旧 raw 不消耗。**教训：不能放完整 send 行——sending 在场即排除 resumable，杀点被污染；撕裂证据只走 fragments**）/**R13 marker-unreadable**（真 EISDIR：mkdir marker 路径；注入 EACCES；ENOENT 对照通过）/**R14 冲突组**（读面两顺序+写面矛盾集拒零落行）/**R15 raw 禁入**（schema 拒 subject.raw/顶层 raw；dirty subject 白名单不透传）/**R16 锚预检+句柄关闭**（锚非法 JSON=anchor-corrupt 零改盘；漂移锚 adjudicated+anchorMoved:false；openCounting 接缝计数四路径 close===opened）。
- 变异五连全杀（基线 e9c464f 提交后注入→定向红→checkout 还原→复绿）：Mu-r3-1 marker 门 catch 一律缺失（if(false)）→R13 杀/**首注错改了 loadAnchor 的 catch 同形代码未杀，改到真实 marker catch 才杀**（变异必须点验杀点真正经过被改行）/Mu-r3-2 scopeCovers 恒真→R12 杀/Mu-r3-3 conflictKeys 置空→R14 杀/Mu-r3-4 schema raw 拒两行删→R15 杀/Mu-r3-5 minimalSubject 直传原对象→R15 杀（工具面）；还原后定向复绿 17/17。
- 运行证据：adjudicate 17 绿；全仓 1387 绿（1402-15 skipped）；apps/server tsc --noEmit exit0；eslint 0。

## P0-1b r4 双证模型批（GPT r3 审 74 NO-GO 修复；报告=worktrees/gpt-p01b-r3-review/p01b-r3-review.md；2026-10-08）

**范围**：B-r3-1..4 四阻断+L-r3-1..4 四低全闭合。核心=B-r3-2 **双证模型**：repair 裁决=对账（修复事实确认），fragment 裁决=归因（唯一效果授权面）——修补冷捕获缝（真实修复后新快照残片丢失，repair-only 配对曾放行 enqueue 重发=重启反而更宽）。**权威语义=设计稿 §9**。

- **读面 B-r3-2**（recover.ts）：attributedTxKeys=effectiveFragAdj 四元组集；unattributedRepairs=repairLog 中无归因裁决的事务→入 repairShadow（对账≠授权）；resendCovers 无残片源改授权链自证（热路径修复后残片已移除——恒不覆盖=热路径裁决失效=裁决持久化失义；冷路径 fragments 在场时仍走 sha×事务全覆盖判定）；resumable 放宽在途 sending 意图：同向 resend 授权链成立时可重发（`!r.sending || resendCovers(r.id)`）。
- **读面 B-r3-1**：scopeCovers 残片 sha 无事务映射 `return false`（原空循环直达 return true=放行）。
- **读面 B-r3-4**：conflictKeys 组级判定改**效果语义二维**（verdicts>1 含跨 kind 矛盾‖targets>1 fragment 内多目标）→整组失效；kind 维不判矛盾（同 verdict 的 repair+fragment 双行=双证合法共存）。
- **写面 B-r3-3**（adjudicate-journal.ts loadAnchor）：严格锚 schema 对齐 repair-tail parseAnchor（version===1+file 绑定+len 非负安全整数+sha 64 位小写 hex），非法=anchor-corrupt（旧只验 len/sha 类型，`{version:99,file:"wrong",len:0,sha:H(empty)}` 可洗白）；**B-r3-2'**：幂等/冲突终局按 kind 分域（sameKind 子集内同 verdict 同目标=idempotent/反 verdict 或换目标=conflicting；跨 kind 同 verdict=双证合法追加，verdicts>1 或 targets>1 跨 kind 仍拒）；**L-r3-1**：openHandle 成功后 readFile 失败路径确定性 close（fh=null 初始化+catch 内 close）。
- **测试 v4**（21 例）：R2/R4/R6/R7 解锁断言改 fragment 裁决归因（R4 加 repair-only 仍阻断对照）；R6 改写真字段 repairUndecided 进快照对象（L-r3-2：旧第二参数被单参 recoverFromSnapshot 忽略=假杀点）；R12 主负例重构=tx2 落 i2 归因（归因面全满足，scopeCovers 独立杀点，不再被归因门遮蔽=L-r3-3）；R16 五路径全接计数句柄+逐次增量断言（写失败面 crashCounting 同计数=L-r3-4）；新增 **R17**（残片无事务映射不覆盖，B-r3-1 红例：同意图不同字节残片 `{"t":"sending","intentId":"i1","x":"y"` 归因成功但 sha 无事务→保守排除；**教训：残片尾巴必须完整闭合值——未闭合字符串被 scanTopLevelIntentId 判 conflict 走 unattributable 面，杀点漂移**）/**R18**（锚严格六形负例：version=99/file 错绑/len 负/len 1.5/sha 大写/sha 短→anchor-corrupt 零改盘+合法锚对照）/**R19**（组一致性二维：verdict 混合跨 kind/verdict 混合同 kind/多目标→整组失效+双证合法共存对照 repair+fragment 同 verdict 解锁）/**R20**（冷捕获真实链回归：真撕裂→真 repairJournalTail→repair-only 裁决仍阻断（B-r3-2 负例）→fragment 归因→双证齐解锁+resumable 含 i1；四元组取自 rep 返回值不硬编码）。
- 运行证据：adjudicate 21 绿；全仓门见 PROJECT r4 节。
- 变异五连全杀（基线 3d974d2；五步单链=注入→定向红→checkout 还原→复绿）：Mu-r4-1 scopeCovers 保守排除改 continue 放行→R17 杀；Mu-r4-2 repairShadow 删 unattributedRepairs 条件→R20+R4 双杀（repair-only 对照面+冷捕获负例）；Mu-r4-3 loadAnchor 删 version===1→R18 杀；Mu-r4-4 conflictKeys 删 verdicts 维→R19 杀；Mu-r4-5 写面幂等 kind 分域废（sameKind 改 priors 全集）→R20 杀（fragment 追加被误拒 conflicting）。
- 运行证据：变异前基线 3d974d2（apps/server tsc exit0+eslint 0+adjudicate 21 绿+全仓 1391 绿）；五连还原后 21/21 复绿。注：根 tsc 对 tests/ 的既有类型错（adjudicate:20 未导出 import/recovery-evidence-source FileHandle 接缝/ws-gateway pendingRepair 缺字段）经 stash 对照=d020a66 基线同错=既有技术债非本批引入；权威门=apps/server 范围 tsc。

## P0-1b r5 冷热一致+授权执行分层批（GPT r4 审 71 NO-GO 修复；报告=worktrees/gpt-p01b-r4-review/p01b-r4-review.md；2026-10-08）

**范围**：P1-r4-1..3 三红+P2-r4-1..2 两黄全闭合。权威语义=设计稿 §10。核心=冷热一致性（无源分支保守化+G2 补源）与授权/执行分层（resendAuthorized 面）。

- **读面 P1-r4-1**（recover.ts）：scopeCovers 加 kind 参数；无源分支（need 空）改保守=`repairLog.every(rf => effectiveFragAdj.some(l => repairKey(l.subject)===repairKey(rf) && l.subject.kind==="fragment" && l.subject.intentId===id && l.verdict===kind))`（归因裁决对全事务全覆盖才放行——双事务各归因一意图时冷捕获不再宽于热路径）；G2 消耗时残片 sha 补入 unknownShas（`g2Set.add(sha256HexBuf(Buffer.from(matches[0].raw,"utf8")))`——新残片 sha 无事务映射→旧 tx fragment 授权不越新来源）。
- **写面 P1-r4-2**（adjudicate-journal.ts）：候选加入后组一致性前移——candVerdicts=priors 全部 verdict+本次 >1→conflicting-verdict；candTargets=fragment 目标集（priors+本次）>1→conflicting-verdict，**不限定请求 kind**（旧形 repair abandon+fragment resend 落行→读面整组剔除→写工具自造矛盾组锁死恢复）；kind 内幂等面保留作分域判定。
- **读面 P1-r4-3**：resumable 回退删 `|| resendCovers(r.id)` 放宽（在途 sending 恒不自动重发——执行静止未证）；新增 `resendAuthorized: readonly IntentId[]`（resumeBlocked?[]:resendKeys 中 resendCovers 且非 abandonExcludes 的意图——**授权证明面≠执行资格面**，宿主 P0-3 接线消费）。
- **P2-r4-1**：isSafeInteger 六处（repair-tail.ts:117/138/139+adjudicate-journal.ts:95+evidence-migration.ts:112+recovery-evidence-source.ts:209/342）。
- **测试 v5**（25 例）：既有断言面改授权面——R2/R6/R19/R20 resumable→resendAuthorized（i1 sending 在途）；R10/R12 resumable 仍含（enqueue-only 非在途，授权后重发幂等安全）；R6 加 undecided 干净盘面成对断言（cleanBase 无修复事务，repairUndecided true/false 独立杀点）；R12-G2 加真杀点段（OLD 残片+adjRepair+adjFrag 齐——**教训：夹具必须双证齐，仅 adjRepair 时 unattributedRepairs 非空→repairShadow 阻断，归因门被遮蔽**）；R16 改写失败/读失败真形（事务二 repairRow(at2) 过盘面/身份门→crashCounting append 抛=write-failed；readFailCounting readFile 抛 EIO=file-absent——旧形 at=1999 在盘面门就拒，写失败面从未到达）；**R21 新**冷热差分（同 sha 双事务各归因一意图：热=sha×事务全覆盖阻断/冷=归因全覆盖阻断，两态一致不放大；i2 enqueue-only 合法对照）；**R22 新** G2 补源（旧 tx fragment resend+G2 归因新残片→新 sha 无事务映射→旧授权不越新来源）；**R23 新**写面交叉矩阵四形（repair abandon×fragment resend 拒/fragment abandon×repair resend 拒/多目标组×repair resend 拒零追加/双证合法追加对照）；**R24 新**锚安全整数边界（len=2^53→anchor-corrupt 零追加；MAX_SAFE_INTEGER→adjudicated anchorMoved:false 对照）。
- 变异六连全杀（基线 41eaadc；五步单链）：Mu-r5-1 scopeCovers 无源 every→true→**R21 杀**（cold.resendAuthorized 含 i1）；Mu-r5-2 g2Set.add 行删→**R22 杀**；Mu-r5-3 candVerdicts+candTargets 检查删→**R23 杀**；Mu-r5-4 isSafeInteger 回退→**R24 杀**；Mu-r5-5 `!r.sending` 删→**R20 杀**；Mu-r5-6 resendAuthorized 去 resendCovers 过滤→**R21+R22 双杀**。
- 运行证据：adjudicate 25/25 绿；apps/server tsc exit0；eslint 0；全仓门见 PROJECT r5 节。注：Mu-r5-1 首跑输出歧义（rg 抓到 Failed Tests 摘要头+复绿行交错），完整 tail 复跑点验杀点真经过被改行（641 行 resendAuthorized 断言红）——变异点验纪律再现。

## P0-1b r6 执行面影响域+abandon 方向分离批（GPT r5 审 76 NO-GO 修复；报告=worktrees/gpt-p01b-r5-review/p01b-r5-review.md；2026-10-08）

**范围**：P1-r5-1/2 两必修+P2-r5-1/2 两黄全闭合。核心=正向授权与负向排除的安全方向分离+执行面影响域门。权威语义=设计稿 §11。

- **P1-r5-1**（recover.ts）：resumable 执行面加**事务归因影响域**——`txImpacted=effectiveFragAdj 中 fragment resend 裁决的归因意图集`；filter 门 `!((unknown.has(id) || txImpacted.has(id)) && !resendCovers(id))`。冷捕获丢残片后 enqueue-only 盘面（无完整 sending/unknown 证据）不再因 unknown 短路免检——凡有事务归因到本意图，执行资格须 resendCovers（其尾段可能含本意图的 sending，「证据缺失」≠「效果安全」）。事务无关的 enqueue（无任何归因）不受影响=不无差别阻断。**R25 新**：审人反例真形态（无 send 行双事务各归因一意图）——热/冷两态 resumable 均 []（r5 缺陷形态=冷态 [i1,i2] 双进=冷比热宽）；R21 冷态 i2 断言同步改（i2 在 tx2 影响域→同样排除）。
- **P1-r5-2**（recover.ts scopeCovers）：abandon 分支改 `if (kind === "abandon") return true;`（have 在场即排除）——**方向分离**：正向授权（resend）无法证明=保守拒（无源须全事务归因覆盖）；负向排除（abandon）是终局证据，任一在场即排除（保守=多排除不重发），无关事务加入不得撤销已证排除。**R26 新**：txA abandon(i1)+无关 txB(resend i2)→i1 保持排除（r5 缺陷形态=i1 复活 resumable）+i2 在 txB 影响域被排除。
- **P2-r5-1**：R17 末尾补 `resendAuthorized not.toContain("i1")`（!r.sending 门下 resumable 断言阻力漂移，无映射门须在授权面独立可杀——r5 审附加变异「false→continue 存活」现已闭合）；R12-G2 补 g2wrong 段（OLD≠NEW 错 raw 归因：raw 非全等→不消耗→unattributable=1 阻断——r5 审附加变异「忽略 raw 全等存活」闭合）。
- **P2-r5-2 注释债**：adjudicate-journal.ts 头注④改「候选加入后统一二维判定+kind 混合=双证合法共存」（原 kind 混合=冲突与 r4/r5 语义矛盾）；R20 注释「解锁+可重发」改「授权/执行分层」表述。文档计数勘误：isSafeInteger 实为七落点（repair-tail 117/138/139+adjudicate-journal 95+evidence-migration 112+recovery-evidence-source 209/342）。
- 测试 v6=27 例（+R25/R26；R21 两断言改）。变异四连全杀（基线 3b682f0；五步单链）：Mu-r6-1 撤 txImpacted 门→**R25 杀**；Mu-r6-2 abandon 删 have 即排除→**R26 杀**；Mu-r6-3 G2 raw 全等过滤删→**R12 杀**（g2wrong）；Mu-r6-4 无映射 false→continue→**R17 杀**（resendAuthorized 面）。
- 悬置（非本批）：L-r5-1 resendAuthorized 孤儿 ID 限定+投影消费契约=P0-3 接线面；S-r3-1 漂移锚人工解困流程仍 open。

## P0-1b r7 结构归因留痕批（GPT r6 审 83 NO-GO 修复；报告=audits/gpt-p01b-r6-review-2026-10-08.md；2026-10-08）

**范围**：P1-r6-1（热态结构归因到持久裁决目标集外，冷捕获绕覆盖判定）+P2-r6-1（注释债/§11 边界勘误）。权威语义=设计稿 §12。

- **schema**（packages/protocol/src/journal.ts+journal-schema.ts）：repair 行可选字段 `fragIntentId?: IntentId | null`（字段序最尾=旧行为新行前缀，崩溃部分行残局前缀判定跨版本兼容）；缺省（存量）/null（不可归因/补完）/非空 string 合法，其余拒。
- **生成面**（repair-tail.ts）：`structuralIntentId(tail)`=scanTopLevelIntentId（从 recover.ts 导出）——顶层唯一身份可证记 id，none/conflict 显式 null；fresh 修复+marker 吻合形+345 比对行（与将来落盘行同形态）均算；marker 补完路径（尾段物理消失）诚实 null。
- **写面一致门**（adjudicate-journal.ts 身份门后）：fragment 裁决归因 vs matches[0].fragIntentId 不一致→`inconsistent-attribution` 拒零追加（S5 矛盾裁决自此不可持久化）；缺省/null 无结构证据不强一致（人工归因自由，未归因事务阻断门兜底）。
- **读面影响域并入**（recover.ts）：txImpacted 并入 repair 行 fragIntentId 有效值——存量 S5 形冷态不再失忆（i1 并入影响域→须覆盖→排除）；存量行缺省不并入（归因缺失=未归因事务阻断兜底；归因在场=行为不变）。
- **RepairFact**：读面呈现加 fragIntentId（exactOptionalPropertyTypes 条件展开拷贝）。
- **测试**（adjudicate.test.ts 29 例+repair-tail.test.ts 38 例；全仓 1402 绿）：**R27** 写面一致门四形（不一致拒+盘面逐字节不变/一致落行/null 放行/存量放行）；**R28** 读面并入三态（S5 冷态 i1 排除+i2 授权重发合法+i3 无关正对照/热态对照/一致归因补正=resendAuthorized+resumable 双含 i1——缝的修复=证据完备而非阻断重发）；**RT-r7-1/2/3** 生成面（可归因=i1/不可归因=conflict 显式 null/存量无字段 schema 照认+类型 42 拒）。教训：可归因撕裂尾须完整闭合值（`"x":"y"` 形）——未闭合键被判 conflict（RT-r7-1 首版串 `"x"` 未闭合红）。
- **变异三连全杀**（基线 7f39170 附近提交后注入；五步单链）：Mu-r7-1 一致门 `if (false)`→R27 杀；Mu-r7-2 txImpacted 并入项删→R28 杀（冷态 i1 失忆复活=S5 缺陷形）；Mu-r7-3 structuralIntentId 恒 null→RT-r7-1 杀（unique 面；RT-r7-2 本断 null 故不杀，杀点单一预期）。三连 checkout 还原后定向复绿+全仓复绿。
- **注释债**（P2-r6-1）：测试头注 R1-R10→R1-R28 全谱、describe 标题对齐、设计稿 §11 第 1 条边界勘误+§12 新节。

## P0-1b r8 崩溃窗结构身份持久化批（GPT r7 审 82 NO-GO 修复；报告=audits/gpt-p01b-r7-review-2026-10-08.md；2026-10-08）

**范围**：P1-r7-1（marker 不含结构身份→截断后写行前崩溃补完行无条件 null→i2 归因落盘后 i1 越权重启）+P2-r7-1（文档闭合过称三处勘误+N-abandon-official 转正）。权威语义=设计稿 §13。

- **marker 携带身份**（repair-tail.ts）：RepairMarker 加 `fragIntentId?: string | null` 三态（缺省=旧版/null=扫描即不可归因/string=留痕）；fresh 写 marker 与 bounds/哈希同批持久化（破坏前取证，与 fresh 行同源扫描值 sid）。
- **补完行恢复身份**：completeMarkerResidue builtRow `fragIntentId: marker.fragIntentId ?? null`——尾段物理消失但身份随 marker 存活。
- **旧版 marker 保守拒（双层门）**：主函数入口门（有尾+旧 marker+非吻合形）+补全面顶部门（防御深度）——一律 repair-marker-conflict/detail=legacy-marker-no-structural-evidence，盘面零动零截回；开发期无存量，宿主清 marker 后 fresh 重做取证。
- **部分行判据放宽**：isPartialRow 从逐字节前缀比对改为「起点吻合+尾长<构造行全长」——值写入中形（行尾字段值写一半，非行前缀）与旧行 `}` 无换形合法收敛；信任域=marker 信封+pendingRepair 挡 journal 写者。
- **测试**（adjudicate 30+repair-tail 42；全仓 1407 绿）：**RT-r8-1** marker 携身份两形（可归因 i1/不可归因 null）；**RT-r8-2** resend 真窗全链（崩溃→重试行带 id→i2 归因被一致门零落盘拦→一致归因 i1 授权=resendAuthorized+resumable 双含）；**RT-r8-3** abandon 真窗（i1 永不可重发）；**RT-r8-4** 旧 marker 双形保守拒（无尾走顶部门/有尾走入口门）；**R31** abandon verdict 一致门负例（N-abandon-official 转正：不一致 abandon 同拒+一致放行）；**RT37** 更新双形（界内任意尾收敛重写+超界长尾仍拒）。
- **变异五点全杀**（基线 6eb761f/后补杀点提交后注入；五步单链）：Mu-r8-1 顶部门删→RT-r8-4 无尾形杀；Mu-r8-1b 入口门删→RT-r8-4 有尾形杀；Mu-r8-2 fresh marker 去字段→RT-r8-1/2/3 杀；Mu-r8-3 补完恒 null→RT-r8-2 杀；Mu-r8-4 上界删→RT37 超界形杀。全部 checkout 还原复绿。
- **文档勘误**（P2-r7-1）：§12 三处（严格前缀说法→部分行限定；「矛盾裁决自此不可持久化」→加 r7 崩溃窗例外；未归因门兜底→收窄为「事务至少被看过」不保证归因正确）；scopeCovers 头注分向澄清（resend 全覆盖/abandon 任一在场即排除）；§13 新节。

## P0-1b r9 缺证据残局留置+cleanup 分级批（GPT r8 审 84 NO-GO 修复；报告=audits/gpt-p01b-r8-review-2026-10-08.md；2026-10-08）

**范围**：P1-r8-1（缺证据残局「清 marker 后 fresh」指引=N2 洗白路径）+P2-r8-1（isPartialRow 内容证据恢复+停写前提勘误）+P3-r8-1（加载器非空校验）+P2-r8-2（文档四勘误）。权威语义=设计稿 §13 r9 修订段。

- **cleanup-only 分级前置**（repair-tail.ts）：行已落盘+事务事实匹配+全文件锚匹配→幂等清冗余 marker（含旧版形）——「物理健康≠已授权重发」：未裁决事务仍由读面 repairShadow 阻断。缺身份形（截断/部分行）继续留置拒。
- **禁删指引**：两处门 detail 撤「宿主清 marker 后 fresh 重做取证」→「留置调查——禁止仅删除 marker（尾已消失，marker 是唯一修复事实；删除后冷捕获将以无裁决恢复全部意图重启）；需以原始证据独立处置」。
- **判据收窄**：isPartialRow=起点吻合+（新行严格前缀 ‖ 旧行形枚举 legacyMrow 严格前缀）——内容证据恢复；信任前提勘误=修复期外部停写为必要部署条件（pendingRepair 只是恢复阻断状态非文件锁，FileDurability.append 不检查 marker，evidenceDir 隔离不保护 journal 尾）。
- **加载器**：fragIntentId 非空校验（对齐行 schema）——空串 corrupt 拒（防空串补完写 schema 非法行）。
- **测试**（repair-tail 45+adjudicate 30；全仓 1410 绿）：**RT37 三形重写**（真短写=新行前缀收敛/旧行 `}` 无换形=legacy 前缀收敛/非前缀垃圾短尾+超界长尾拒——N1 转正）；**RT-r9-1** cleanup 分级（N5 转正：旧版 marker 幂等清+盘面零动+resumable=[]）；**RT-r9-2** 缺证据留置（N2 转正：幂等拒+detail 禁删+违规清 marker 洗白后果红线演示）；**RT-r9-3** 空串 marker corrupt 拒零改盘。
- **变异四连全杀**（基线 01ab0ec 后注入；五步单链）：Mu-r9-1 cleanup 前置块删→RT-r9-1 杀；Mu-r9-2 detail 回退→RT-r9-2 杀；Mu-r9-3 legacy 枚举删→RT37 形二杀；Mu-r9-4 非空校验删→RT-r9-3 杀。全部 checkout 还原复绿。
- **文档**（P2-r8-2）：§13 不变式限定（「默认可重启」仅限无修复阴影的普通 enqueue；repairShadow 形=阻断）+r9 修订段；buildRepairRow 头注（旧完整行非新行前缀，部分行判定=前缀+枚举）；RT-r8-2 标题+注释改实际执行路径（错误归因被拦→一致归因授权）；RT-r8-3/R31 分工表述（组合覆盖两 verdict，非各自双形）。
