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
| 屏障硬序（enqueue→sending 两 fsync 完成→才发 send 许可；stdin 首字节不早于 sending fsync） | turn-gate.test@硬序（行序断言+resolve 后才许可） | ✅（逻辑面；受控 FakeDurability 端口） |
| 屏障占用/释放（in-flight 中 submit=busy；settled 行 fsync 成功才 idle 放下一意图） | turn-gate.test@占用/释放 | ✅（逻辑面） |
| 耐久 fail-closed（enqueue/sending/settled 任一 fsync 失败→closed 保持；journal 态=崩溃矩阵行；reopen 由宿主裁决） | turn-gate.test@三处 fsync 失败 | ✅（逻辑面；变异：去屏障→3 挂、settled fail-open→1 挂） |
| success 仅受理（onAccepted 不释放屏障；settled 先于 success 可收口；晚到回执 no-op 不开新轮） | turn-gate.test@仅受理+乱序基础+晚到 | ✅（逻辑面） |
| 轮超时中断呈现（超窗→closed(turn-timeout) 不自动重发；窗口内不裁决；reopen 解锁） | turn-gate.test@轮超时 | ✅（逻辑面；进程级处置+对账归后续切片） |
| 通用命令占位先行（placeholder fsync→send→result fsync→settle；占位失败不发送+回滚；send 失败=效果未知留置；结果耐久失败=内存占位态；cached 不重发；同键不同参拒+审计） | command-channel.test@7（含同通道重试重新受理断言） | ✅（逻辑面；变异：占位序倒置→3 挂、去回滚→1 挂） |

端到端面（真 spawn+真文件系统+乱序压力+连续派发）待 adapter 后续切片，仍 🔴。
