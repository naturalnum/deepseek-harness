# 不确定执行结案实施约定

本文固定[交付计划](DELIVERY-PLAN.md)中不确定执行闭环的接口及文件归属，是实施计划，不是已交付记录。先形成 Cloud 纵切面，再扩展 Device 与 SSH；三种执行目标都须保留真实停止证据及结果不明语义。原报告试用保留固定镜像与数据，开发验收不直接升级其数据库。

## Cloud 用户流程

原生执行位置插件展示本人不确定执行及已有结案回执。用户打开独立可信审批入口，检查原命令和执行身份，提交“停止旧执行者并对账”。刷新或响应丢失后，以同一请求 ID 查询进度。Host 和 Agent 只能读取状态；它们不能确认结案、上传停止证明或提交替代命令。

平台先保存意图并排除旧执行 worker，再有界查询原 Runner。确切身份及请求摘要匹配的真实终态予以保留；没有可核验终态时，确切停止后才写 `closed_unknown`。该状态表示旧写入者已停止但副作用结果仍不明，不表示成功或失败，也不允许重放原命令。平台将结案、执行槽释放及至多一次原会话续接放在同一事务内；账号已停用时完成清理但不续接模型。

## 协议与持久化

浏览器安全定义在 [`execution-resolution.ts`](../contracts/src/execution-resolution.ts)。请求携带稳定 requestId、原 executionId、Cloud 目标、平台生成的 fingerprint 及有界备注。指纹固定用户、Session、原请求摘要、Workspace、Pod UID、Runner ID、挂载代次与完整 binding snapshot。客户端不能提供或替换这些身份。本人资源核验在平台事务内执行，解析本身不授权。

| 入口 | 所需身份 | 能力 |
| --- | --- | --- |
| `executionResolutionsList/Inspect/Status` | 用户凭据，经原生 Host | 只读列表、身份检查及持久进度 |
| `/approvals/executions/list/inspect/status` | 独立审批凭据，可信 Origin | 同样的只读事实 |
| `/approvals/executions/resolve` | 独立审批凭据，可信 Origin | 持久受理停止与对账意图 |

相邻 V28 迁移添加 `pe_cloud_execution_resolutions`，保持原 `uncertain` 记录不变。意图按用户及 requestId 去重，每个 execution 仅一个意图，重复请求内容不同拒绝；组合外键固定原用户与 Session。冻结的挂载身份、独立 owner/epoch/expiry 租约、原始观察 JSON、停止证据及回执持久保存。JSON 保留输出中的 NUL，不降为 JSONB。原执行仍保持 `uncertain`，直到最终事务完成；`closed_unknown` 不进入普通 claim 或 live index。

首次派发前持久保存完整 Runner request，恢复不使用新的配置重新拼装 timeout 或命令。历史执行的该字段为 NULL；只有重建请求摘要与已保存的原请求摘要完全一致时，才允许核验历史 Runner 结果。不能验证请求摘要的观察不能变成成功或失败，仍须确切停止后保留 `closed_unknown`。

## 并发与停止规则

1. 受理使用当前账号权限、Workspace、user mount slot 和执行行的锁；真实终态先提交时不能覆盖。意图先提交时，普通 claim、renew、assertLease、defer、settle 均不能继续操作原执行。
2. 结案 worker 使用独立租约和 epoch。完整身份的 ready/unknown 槽才能转为 stopping；缺 UID、绑定变化或同名新 Pod 一律阻塞。不能将 Workspace 伪造为 recovering 以调用绑定恢复。
3. 普通 ensureReady、idle recycler 和绑定恢复，必须在同一 user 锁内拒绝已有结案意图对其捕获槽的清理所有权；它们不能先释放槽。停用账号不取消已受理清理的归属。
4. 复用现有 finalizer 与 kubelet 停止检查。确切 Pod UID、Session、Runner、代次和 binding 的双份证明先持久化，再移除 finalizer，最后确认旧资源消失。Pod 404、DELETE 已受理、节点失联及用户确认均不是停止证明。
5. `persistProof` 的事务检查使用纯 lease/epoch guard；最终事务另外调用 finalize。回调使用传入的 PG client，不另开事务或重新等待自身账号锁。任一检查失败，结案、续接与槽释放全部回滚。
6. creating 且未记录完整派发身份的执行不走人工释放，保留现有 cancelCreation 及保守阻塞语义。永久阻塞显示具体原因；基础设施短暂失联保留原意图等待同身份对账。

## 文件归属与集成次序

| 所有者 | 文件与职责 |
| --- | --- |
| Root | contracts、schema、database、Host/Platform 路由、Profile、目录生成物、备份工具及发行集成；当前试用与最终验收 |
| Cloud 实现者 | `platform/executions.ts`、`sandbox.ts`、新增 Cloud 对账实现、必要 storage-bindings 清理互斥及聚焦后端测试 |
| 客户端实现者 | 既有 client-execution-target 的只读状态、可信入口链接及其 locale/测试；不得新增产品页面 |
| 可信入口实现者 | 既有 `application/web/approval.html/js` 的结案区域、具体动作确认与状态轮询；只消费独立审批路由 |

先固定共同定义及真实 PG 迁移测试，再使用隔离工作树并行实现。候选提交串行审核集成，随后完成原生两用户、真实 k3s 与 PG 纵切面验收并冻结版本。单独的 DTO、页面或停止单测通过不算交付。Device 和 SSH 在此片封口前可只读设计，不提前合入新执行协议。

## 本片验收出口

- 两个用户从原生入口各自查看执行；另一个用户、错误审批 audience/Origin 和篡改指纹不能结案。
- 两个 Platform 竞争旧 lease、结案意图和真实终态；重复请求、晚到结果均保持唯一终态及至多一次原会话续接，原命令不重放。
- 删除响应丢失、证明前后重启和过期 epoch；缺失、单侧或错误 UID 的证明均不释放槽。另一 Session、idle recycler 和绑定恢复不能抢先清理。
- 意图前、停止中及最终提交时停用账号；新意图拒绝，既有清理完成且不启动模型。
- 真实 unknown Pod 完成确切停止、工作区保留及后续新任务；备份恢复保留意图、停止证据和回执。替身回归与真实模型／k3s 证据分别记录。
