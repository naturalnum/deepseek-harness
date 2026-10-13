# 原生 turn continuation v2

[English](native-turn-continuation-v2.md) | 中文

`NativeTurnContinuationV2.transition()` 在当前 Session Writer 和原 operation attempt 下结算准确闭合的原生 turn。必需的 frame provider 为 `(client, request) => frames.verifyInTransaction(client, request)`。没有永久 owner claim 的 prepared frame 不能推进。prompt assembly 在 `step/start` 或 `user/message` 前失败时，不可变 claimed cohort 仍保持已消费状态。

对于 `kind: 'reconcile'`，实际 consumed-recovery provider 在另行发放的当前 storage attempt 下读取原始 claimed frame。`from.frame` 保留原始消费 epoch 和 Writer；`from.operationToken` 验证当前 storage 权限，`storageOperationEpoch` 必须等于这个后续的当前 epoch。原始 worker、Writer epoch 和存储的 operation digest 证明历史 command receipts。当前 storage epoch 保护 publisher seal、attempt closure、lease transfer 和最终时钟检查。此路径不创建当前 claimed execution frame，也不能授权另一次模型或业务工具调用。

事务逐一对照官方 removal 前的 inbox projection、不可变 origin/revision/claim 记录、原 command receipt、存在实际 step 时的准确绑定、原接受 operation 元数据、冻结 execution snapshot 和实际 publisher ordinal/revision/event watermark，核查 turn 中所有 cohort。它结算 A 及本 turn 真实消费的所有 origin operations，不为这些 origins 发放 attempt。较早已尝试执行的 non-owner input 必须另行证明有界的 prepared-only history，以及在这个完整 cohort 中的独占消费。原生 pending origins 在选中的 successor 发放前保持原样。

successor 选择真实 `next-turn` head；没有 turn head 时选择第一个 `next-step` input。它的 Grant 保留自己的原 model settings、selected skill versions、tool selections、source references、native content 和有序附件。实际 TaskStore restore 提供部署和运行字段，其更宽的 Session 附件列表不会替代原 origin audit。历史 prepared successor 保留完整的原始 frozen snapshot，包括有界 non-user text，只替换 epoch 和 bearer；较早的 attempts 与 frames 继续留存。successor 以 prepared v2 frame 开始，完整 claim 并绑定实际 step 后，才经安装的原生 execution authority 获得执行许可。输入为空或容量不足时停放 Session，不 mint bearer，也不延长 Writer occupancy。

Host 在响应不确定期间保留完整 strict v2 intent、transition identity 和 candidate token。唯一 durable receipt 存储摘要和 tokenless 元数据。准确重试返回原 receipt，仅当原 successor 仍有效时返回同一 candidate bearer；不会延长到期时间、重新 mint 或执行其他 origin。转移时，封存的 A publisher 和旧 operation bearer 失去授权。settlement、publisher seal、successor attempt/frame 和 receipt 在同一 PG 事务中提交，提交前核查原 operation、presentation 和 Writer 时钟。

服务要求实际 v2 frame、input-ledger 表及相邻的 `pe_native_turn_transitions_v2`。该行的 Writer epoch 始终通过现有四列外键引用原始 source frame 的 Writer；receipt JSON 记录当前 Writer，完整 intent digest 绑定当前 storage 权限。准确重试同时核查这两种身份。产品初始化和 transport 安装负责 schema migration 与 endpoint 注册。私有 diagnostic SQL 和源码测试不构成正式 schema5、Host/browser 验收或 coverage 证据。
