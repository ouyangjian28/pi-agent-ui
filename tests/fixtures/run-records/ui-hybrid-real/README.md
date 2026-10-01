# UI-HYBRID 正式接线前证据

## 初始失败与替身修正

- 初始提交见 `baseline-initial-commit.txt`（3cb2ec8）；任务 b98baa9d6 失败，1875 pass/1 fail/24 原有 opt-in skip。当时正式 UI 未改。
- `baseline-initial-failed.log` 保留 CW3 expected readiness-timeout / received spawn-exited；同代码单例又通过，见 `cw3-original-isolated-pass.log`。单例按名称筛选产生的 10 个未选用例，不是产品新增 skip，也不计全套结果。
- 旧直接 `/bin/cat` 不支持 pi 的 --mode 等参数，会早退，不能确定模拟存活不答探针；225d5f5 仅修测试替身：临时 launcher 忽略参数后 exec cat，真实子进程保持存活；精确超时 cause 不放宽，固定 stderr 诊断必匹配。
- CW6 同用真实存活替身，等 onSpawned 观测且断言无 exit 后再 dispose，避免将早退后的 idle 销毁算成在途销毁。
- 可读 `.log` 仅移除多余空白 EOF；同名 `.log.gz` 保存复制时原始字节，未删错误、断言或跳过信息。
- 后续任务 b0085de5f 进行 8 次完整 composition-write 文件 + 原全套、构建、包级类型、隔离实际 pi 探针及服务端/协议/冻结 docs 零差分复验。本档写入时仍待结果，不声明通过。

## 基线复验闭环（2026-10-01）

- `b0085de5f` 最终 exit 0。源基线 `225d5f5dc4fd2adb1a94c27c3af358b84376e597`，见 `verified-baseline-commit.txt`；8 次完整 composition-write 文件均为 11/11，通过记录 `composition-repeat-1.log` 至 `composition-repeat-8.log`。
- `verified-baseline-tests.log`：1876 pass / 24 既有 opt-in skip；`verified-baseline-build.log`：web 构建和 server 类型构建 exit 0；三包类型、实际候选 RPC、服务器/协议/冻结文档零差分在同任务通过（RPC 日志 `verified-baseline-rpc.log`）。这才解除此前正式接线前阻塞，不删除或改写前次红灯。
- 后续正式界面从 `40841ee` 开始；搜索与真实视口驱动 `2618498`，字体断言 `d582902`，视觉收口 `8c30ff4`。本小节是 UI 开工前基线，不把它冒充上述正式界面的复验结果。

这些均为本地合成测试，不使用生产认证、生产会话或付费提供商；不是正式 UI/真机/独立验收。
