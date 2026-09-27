# P0-1b 裁决持久化设计（v1；GLM 面，2026-10-06）

依据：PROJECT.md P0 冻结序②；GPT r6 排序建议（裁决=可重启耐久事实，绑定文件/会话+证据身份；失败次序；崩溃矩阵先行）；P0-1a 收口低项同批吸收。

## 0. 现状缺口（勘察 2026-10-06，repo 3619b53 基线）

- attributedFragments=调用方内存参数（buildRecoverReport opts），快照捕获恒空数组（recover.ts:481）→重启丢裁决、每次重问。
- repairShadow 三链（repairLog>0 || pendingRepair || repairUndecided，:409）恒阻断，无解锁面——「待 adjudicate 显式裁决」的承诺未兑现。
- withRepair 只清 pending 置 undecided（:526），语义正确但无出口。

## 1. 决策：adjudicate 行落 journal（选项 A）

裁决=宿主侧受信动作（人工归因），与 repair 行同机制：
- **adjudicate 行型**（journal 行，t:"adjudicate"）：`{t, at, buildId, contractV, subject:{kind:"fragment"|"repair", ref}, verdict:{outcome:"resend"|"abandon", attributedTo?}, operator}`。
  - subject.ref=fragment：目标残片身份=`sha256(残片原文)+byteRange`（与快照 bad 集合身份同构）。
  - subject.ref=repair：目标修复事务身份=`{removedSha256, byteStart, byteEnd, at}`（与 repairLog 条目/repair 行原文身份同构）。
- 走 repair-tail 同款安全追加（openSafeReadWrite+write+datasync；行小，撕裂=坏行→下轮修复，fail-closed 可接受——裁决丢失只多阻断不漏授权）。
- 读面：provider 捕获已读全量 lines→快照 lines 含 adjudicate 行；canonical hash 自然覆盖（身份自增）。
- **派生**：recoverFromSnapshot 从 lines 派生 attributedFragments+repair 裁决配对（不再信任调用方内存参数——attributedFragments 保留为 opts 但生产路径恒走派生；测试可注入）。

## 2. 解锁语义（配对制）

- fragments：bad 中每个未归因残片阻断；lines 中 adjudicate(ref=fragment 身份) 且该身份仍存在于当前 bad 集合→计入归因（unattributed 减）。
- repairShadow 三链改判：
  - repairLog 中**每条** repair 事务须有对应 adjudicate(ref=repair 身份匹配 removedSha256+byteStart+byteEnd) 才解锁；任一无配对→阻断。
  - pendingRepair 仍恒阻断（事务未完，裁决不可先于事实）。
  - repairUndecided：withRepair 置位后，若快照 lines 中该 undecided 事实对应的 repair 事务已有 adjudicate 配对→不再阻断（undecided 解除=裁决在场证明）；否则维持粘滞。
- **旧裁决不作用于新证据**：adjudicate ref 身份与当前 bad/repairLog 逐字段匹配才生效；不匹配（盘面已变/新事务）→裁决在场但不计解锁（不报错，审计行提示 stale-adjudication）。

## 3. 失败次序（宿主工具 adjudicateJournal）

1. 构造 adjudicate 行→校验 subject 身份在当前快照事实中存在（防对空裁决）。
2. 安全追加落盘+datasync 成功→才回成功（宿主确认=落盘后）。
3. 断在落盘中=撕裂→下轮修复，无裁决（幂等重试安全：重试=同 ref 再落一行，配对去重按 ref 身份）。
4. 断在落盘后确认前=裁决已在盘（重读快照可见）——宿主重试同 ref 行=幂等（重复裁决行去重）。

## 4. 崩溃/重启矩阵（验收先行，R 系测试）

R1 裁决写失败（openHandle 注入崩溃）→无裁决+盘面可修复+重试幂等收敛。
R2 已落盘未确认→重读快照裁决在场+配对解锁生效。
R3 重复裁决（同 ref 两行）→去重配对，单次解锁。
R4 证据已变化（adjudicate ref 指向旧残片/旧 repair 事务，盘面已新）→裁决不计解锁+stale 审计。
R5 裁决文件损坏（journal 撕裂含 adjudicate 行）→坏行阻断+修复工具处理（复用 repair-tail）。
R6 repairUndecided 跨重启保留（无 adjudicate）→恒阻断；adjudicate(ref=repair) 后→解除。
R7 合法裁决后只解锁对应意图正对照：fragment 归因 resume 意图精确匹配（matchKey），他意图不受影响。
R8 pendingRepair 期间 adjudicate(ref=repair 指向进行中事务)→仍阻断（事务优先）。
R9 verdict=abandon→resumable 不含该意图（放弃=不重发）。
R10 派生面回归：attributedFragments 不再依赖调用方内存（生产路径）。

## 5. 同批吸收（P0-1a 收口低项）

- L1-r6：TEST-MAP r3/r4 勘误章节错位修正（r4 节 865 行 tsc exit0 原句勘误落位）。
- L2-r6：RT43 ENOENT 专断言（code==='ENOENT'）+目录快照措辞按断言精度收敛（toString utf8→文件名+length+内容哈希）。

## 6. 非目标

- 多操作者/审计链签名（单机单宿主信任域，operator 记名即可）。
- 裁决 UI（前端面等 Kimi 线恢复后另批）。
- extension_ui_request 透传（P0-4）。
