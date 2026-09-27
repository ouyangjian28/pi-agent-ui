# 3c1 patches 来源说明（诚实档）

三份 patch 为**按描述重建**（2026-10-03，第 18 轮 GPT 审后补档），非历史原件——原始变异只改未存 diff。
重建方法=对 54daf4b 版 ws-gateway.ts 按档内改法逐字重放→git diff 落盘→还原（hash 复核）。
重建后复跑验证（tests/unit/server/ws-gateway-write.test.ts）：
- mut1-writebranch：8 failed | 4 passed（与 3c1-mut1-writebranch.log 历史记录一致）
- mut2-inflight：1 failed | 11 passed（与历史一致）
- mut3-absresolve：1 failed | 11 passed（与历史一致）
