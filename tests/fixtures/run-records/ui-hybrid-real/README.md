# UI-HYBRID 正式接线前证据

## 初始失败与替身修正

- 初始提交见 `baseline-initial-commit.txt`（3cb2ec8）；任务 b98baa9d6 失败，1875 pass/1 fail/24 原有 opt-in skip。当时正式 UI 未改。
- `baseline-initial-failed.log` 保留 CW3 expected readiness-timeout / received spawn-exited；同代码单例又通过，见 `cw3-original-isolated-pass.log`。单例按名称筛选产生的 10 个未选用例，不是产品新增 skip，也不计全套结果。
- 旧直接 `/bin/cat` 不支持 pi 的 --mode 等参数，会早退，不能确定模拟存活不答探针；225d5f5 仅修测试替身：临时 launcher 忽略参数后 exec cat，真实子进程保持存活；精确超时 cause 不放宽，固定 stderr 诊断必匹配。
- CW6 同用真实存活替身，等 onSpawned 观测且断言无 exit 后再 dispose，避免将早退后的 idle 销毁算成在途销毁。
- 可读 `.log` 仅移除多余空白 EOF；同名 `.log.gz` 保存复制时原始字节，未删错误、断言或跳过信息。
- 后续任务 b0085de5f 进行 8 次完整 composition-write 文件 + 原全套、构建、包级类型、隔离实际 pi 探针及服务端/协议/冻结 docs 零差分复验。本档写入时仍待结果，不声明通过。

这些均为本地合成测试，不使用生产认证、生产会话或付费提供商；不是正式 UI/真机/独立验收。
