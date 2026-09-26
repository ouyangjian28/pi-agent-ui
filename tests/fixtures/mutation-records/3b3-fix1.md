# 3b3 修复轮变异记录（R-01/R-02/Y-01/Y-04）

- 日期：2026-09-29；基线=519d620（Y 项提交）+RW7/d2Early 追加（同轮内）；脚本=/tmp/mut-3b3b.py（python 锚点+count 断言+还原）。
- 纪律：变异前基线已 commit；每变异只改一处锚点串；跑指定测试文件后立即 git checkout 还原；「挂」=该文件出现 failed 且失败用例即目标杀手。

## 变异与杀伤

| 变异 | 锚点（apps/server/src/…） | 改法 | 杀手 | 结果 |
|---|---|---|---|---|
| M-R1a | ws-gateway.ts `const yieldBatch = fresh.length > 256;` | →`const yieldBatch = false;`（syncIndex 批量续编退同步） | real-ws RW7（真传输 8000 行恢复续编≈1143 帧>1024 队列上限→无让出自溢出） | KILLED（1 failed：RW7） |
| M-R1b | history-source.ts `const yieldBatch = appended > 256;` | →`const yieldBatch = false;`（rescan 追加分发退同步） | real-ws RW2+RW6（P-FAST 负载队列饥饿） | KILLED（2 failed） |
| M-R2a | history-source.ts skip-identity-change 分支 `this.queueRescan(slot, "identity-handoff-verify");` | 删该行（核对读不再排队） | history-source N4b+同字节换 inode+W2（交接窗口漏读） | KILLED（5 failed） |
| M-R2b | history-source.ts `const inodeChanged = read.identity !== entry.identity;` | →`const inodeChanged = false;`+恢复「identity 变即 replace」旧门 | history-source 真盘全分型（rename 纯追加=交接）+W1 | KILLED（2 failed） |
| M-Y1 | composition.ts `if (disposeP !== null) return disposeP;` | →`return Promise.resolve();`（布尔早退回归） | composition Y-01（d2Early 窗口观察：第二方在收尾审计前 resolve） | KILLED（1 failed） |
| M-Y4 | ws-gateway.ts onAppend 路 `this.recordFingerprints(file, index);`（Y-04 注释行） | →`void 0;`（live 追加不更指纹） | real-fs RF12（追加态指纹≠源 SHA-256） | KILLED（1 failed） |

## 披露

- M-R1a 首轮 SURVIVED：原杀手集（real-fs 全部 FakeConn）不暴露连接队列排水饥饿——补 RW7（真传输+8000 行走 syncIndex 批量续编路）后 KILLED。
- M-Y1 首轮 SURVIVED：原断言在 Promise.all 后统一验收，早退窗口不可见——补 d2Early（resolve 时审计已落盘=否）窗口断言后 KILLED。
- 还原后终态：781 passed+7 skipped+tsc0+lint0。
