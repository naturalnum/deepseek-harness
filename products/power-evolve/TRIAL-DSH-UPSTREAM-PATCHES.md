# DSH 上游修订索引（当前候选）

适用官方 `dsh-v0.2.1-alpha.1`／`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。21 份接口和行为 source delta 按 7 组登记，另有两份生成接口目录同步，合计 23 份 source 文件，文件按去重计。各组交付核对与例外登记负责人均为 Root，索引为员工1，已有独审为员工2；原实现作者未逐项登记。各组均无已登记上游 issue／PR，不提供虚构链接。

2026-10-11，Root依据用户授权登记与原方案“不修改 Agent loop”要求的明确差异：本轮保留 `agent.ts`、`inbox.ts`、`index.ts` 和新增 `inbox-plan.ts` 四份的必要公开接线、完整 claim 结算、原生活动占用及显式 keepInbox 生命周期修订，详见 U1—U3。它们仍复用官方 Inbox／Session 算法；PG、Writer／receipt／grant、云权限和业务编排由产品适配层负责。此登记只适用于列明的修订，不授权替换模型／工具循环或继续向 SDK 加入云端业务。[当前验收记录](TRIAL-CLOUD-MIGRATION-ACCEPTANCE.md)拥有后续 M5、工程检查、镜像及最终交付状态。

## 源码和符号

| 编号 | 准确 source 文件 | 对应符号与组 |
| --- | --- | --- |
| F01 | [packages/api/gateway/src/index.ts](../../packages/api/gateway/src/index.ts) | `RemoteStreamMuxServer/rejectRemoteStreamUpgrade exports`、`Config.streamSendTimeoutMs`、`TypertGatewayService.Config`（U5） |
| F02 | [packages/api/gateway/src/stream-server.ts](../../packages/api/gateway/src/stream-server.ts) | `RemoteStreamMuxServer constructor/close`、`RemoteStreamMuxConnection.send/sendFailure/run`、`rejectRemoteStreamUpgrade(401|403|503)`（U5） |
| F03 | [packages/api/session-controller/src/commands.ts](../../packages/api/session-controller/src/commands.ts) | `SessionCommandController.updateQueue -> shared updatePendingInput`、`referencedSessionImage(events,attachmentId,matches?)`（U1,U4） |
| F04 | [packages/api/session-controller/src/index.ts](../../packages/api/session-controller/src/index.ts) | `modelSelectionProjection/referencedSessionImage exports`（U4） |
| F05 | [packages/api/session-controller/src/model-selection-projection.ts](../../packages/api/session-controller/src/model-selection-projection.ts) | `export modelSelectionProjection`（U4） |
| F06 | [packages/attachment/attachment-local/src/index.ts](../../packages/attachment/attachment-local/src/index.ts) | `fileLeafName`、`readFileStreamVerbatim`、`saveFileStreamVerbatim`、`storedFilePath re-exports`（U4） |
| F07 | [packages/boot/plugin-manager/src/types.ts](../../packages/boot/plugin-manager/src/types.ts) | `ReadOnlyReason.permission-required`（U6） |
| F08 | [packages/client/connection/src/client/index.ts](../../packages/client/connection/src/client/index.ts) | `ConnectionHandle.stop`、`installConnection.stop -> releaseOwner`（U7） |
| F09 | [packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) | `AddPluginMenu disabled`（U6） |
| F10 | [packages/client/ui-plugin-manager/src/client/locales.ts](../../packages/client/ui-plugin-manager/src/client/locales.ts) | `reasonPermissionRequired zh/en`（U6） |
| F11 | [packages/client/ui-plugin-manager/src/client/manager-store.ts](../../packages/client/ui-plugin-manager/src/client/manager-store.ts) | `PluginManagerState.managementWritable?`、`PluginManagerController.read`（U6） |
| F12 | [packages/client/ui-plugin-manager/src/client/presentation.ts](../../packages/client/ui-plugin-manager/src/client/presentation.ts) | `CODE_KEYS permission-required`（U6） |
| F13 | [packages/core/agent-loop/src/agent.ts](../../packages/core/agent-loop/src/agent.ts) | `ReactLoopAgent.onBeforeTurn`、`prepareTurn`、`wakePending`、`onAfterClaim`、`preStep claim settlement`、`canMaintainInbox`、`runMaintenance({scope:inbox})`、`reserveInbox`、`captureInboxActivity`、`waitInboxReservation`（U2,U3） |
| F14 | [packages/core/agent-loop/src/inbox-plan.ts](../../packages/core/agent-loop/src/inbox-plan.ts) | `InboxPlanCommand`、`planInboxCommand`（U1） |
| F15 | [packages/core/agent-loop/src/inbox.ts](../../packages/core/agent-loop/src/inbox.ts) | `ReactLoopInbox.claimBatch`、`optional appended callback`、`claimBatch`、`publishClaimed`（U1,U2） |
| F16 | [packages/core/agent-loop/src/index.ts](../../packages/core/agent-loop/src/index.ts) | `planInboxCommand/inboxProjectionDefinition exports`、`AgentLoop.prepare/createAgent/resumeStored`、`captured defaultKeepInbox`、`memoized dispose`（U1,U2） |
| F17 | [packages/core/agent/src/inbox-commands.ts](../../packages/core/agent/src/inbox-commands.ts) | `PendingInputCommand`、`resolveInboxTarget`、`updatePendingInput`、`InboxActivityCapture`、`InboxClaimBoundary`、`InboxActivityCapture.assertCurrent/synchronize`（U1,U3） |
| F18 | [packages/core/agent/src/index.ts](../../packages/core/agent/src/index.ts) | `inbox-commands exports`、`AgentSetup`、`CreateAgentOptions/ResumeAgentOptions.disposeOptions`（U1,U2） |
| F19 | [packages/core/agent/src/runtime-types.ts](../../packages/core/agent/src/runtime-types.ts) | `Agent.captureInboxActivity`、`AgentDisposeOptions`、`Agent.onBeforeTurn/onAfterClaim/wakePending`、`MaintenanceOptions`、`Agent.canMaintainInbox/runMaintenance`（U1,U2,U3） |
| F20 | [packages/core/session/src/index.ts](../../packages/core/session/src/index.ts) | `Session.forPlanning`、`SessionStore.messageProjections`、`Session.guardAppends`、`Session.synchronizeCommitted`、`acceptEvent`（U1,U3） |
| F21 | [packages/host/plugin-inventory/src/types.ts](../../packages/host/plugin-inventory/src/types.ts) | `PluginInventorySnapshot.managementWritable?`（U6） |
| F22 | [packages/extensions/tool-cordis/src/api-catalog.ts](../../packages/extensions/tool-cordis/src/api-catalog.ts) | 官方 `gen-cordis-catalog` 同步 U1—U3、U6 的模型可见接口声明；查询函数保持原字节 |
| F23 | [packages/extensions/cordis-client-runner/src/client/api-catalog.ts](../../packages/extensions/cordis-client-runner/src/client/api-catalog.ts) | 官方 `gen-cordis-inspect-catalog` 同步 U7 的 `ConnectionHandle.stop` 声明；查询函数保持原字节 |

两份目录由原生成器和原预算生成，不手工改声明或截断规则。生成与 `--check` 均通过；此前固定 Main 的实际客户端启动图包含 `cordis-client-runner`，其编译目录尚缺 `ConnectionHandle.stop`。最终 Main 已重新冷构建并发布，原三项产物和完整八项业务回归通过；实际新启动图／factory 与 TypeScript AST 解析的 142 项目录声明全部和当前源码等值，具体版本及分项资格由[验收记录](TRIAL-CLOUD-MIGRATION-ACCEPTANCE.md)拥有。

## U1 原生 pending input 命令和 detached Planner

公开原生API扩展；不是云端授权或业务队列实现（F17、F18、F19、F14、F15、F16、F20、F03）。固定官方基线未公开完整 Inbox 命令计划和无生命周期副作用的 detached planning 入口。产品须在外部真实 PG 提交成功后同步原生镜像，不能提前触发 live Inbox 通知、唤醒或重复发布。

边界：复用官方 Inbox splice、目标选择、消息身份/source 与投影；Planner 只生成 canonical events，不 mint grant、不提交 PG、不发送 ACK。forPlanning 保留完整 prefix/header/inherited cut，消费方仍须显式传所属 SessionStore.messageProjections。

全部相关原回归：[packages/core/agent-loop/tests/native-input-seams.spec.ts](../../packages/core/agent-loop/tests/native-input-seams.spec.ts)；[packages/core/agent-loop/tests/inbox.spec.ts](../../packages/core/agent-loop/tests/inbox.spec.ts)；[application/tests/native-input-coordinator.pg.spec.ts](application/tests/native-input-coordinator.pg.spec.ts)；[application/tests/native-scheduler.pg.spec.ts](application/tests/native-scheduler.pg.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/core/agent-loop/tests/native-input-seams.spec.ts
```

移除条件：上游发布等价公开命令/Planner 和 projection roster API，完整历史计划无新增 end-seed/live 发布，原命令顺序和身份不变；先跑原 SDK seams，再跑真实 Coordinator/Scheduler image/offload PG 回归后替换适配并移除本地对应 hunk。

## U2 turn 接线、完整 claim 结算和保留 Inbox 的 creator 生命周期

公开生命周期接线扩展；含已发现的 claim 取消/深冻结行为修复（F13、F15、F16、F18、F19）。基线没有 awaitable before-turn/after-complete-claim 接线和 pending-only wake API；默认 owner/factory teardown 清空 Inbox。初始 SDK seam 曾在不可逆完整 claim 后因取消跳过持久化 listener，且 restored message 嵌套图未深冻结，已有独立 P2 和闭合记录。

边界：hook 在官方 turn/claim 位置 await，已消耗完整 cohort 的结算监听器在取消/较早失败后仍清理；随后才允许 live claimed 通知和模型/step。creator 仅增加显式 keepInbox 生命周期选项，默认清空仍保留，首次 dispose 结果不可改写；不改变模型/工具执行算法。

全部相关原回归：[packages/core/agent-loop/tests/employee6-before-turn.spec.ts](../../packages/core/agent-loop/tests/employee6-before-turn.spec.ts)；[packages/core/agent-loop/tests/native-input-seams.spec.ts](../../packages/core/agent-loop/tests/native-input-seams.spec.ts)；[packages/core/agent-loop/tests/scope-lifecycle.spec.ts](../../packages/core/agent-loop/tests/scope-lifecycle.spec.ts)；[packages/core/agent-loop/tests/resume.spec.ts](../../packages/core/agent-loop/tests/resume.spec.ts)；[application/tests/native-scheduler.pg.spec.ts](application/tests/native-scheduler.pg.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/core/agent-loop/tests/employee6-before-turn.spec.ts packages/core/agent-loop/tests/native-input-seams.spec.ts packages/core/agent-loop/tests/scope-lifecycle.spec.ts packages/core/agent-loop/tests/resume.spec.ts
```

移除条件：上游具备等价 before-turn、不可跳过完整 claim 结算、深冻结 boundary、保留 pending wake 和 create/resume/owner/factory 统一 keepInbox 规则；先跑原四份 SDK 回归，再跑实际 Scheduler handoff/owner-first/归档回归，验证默认及显式 dispose 行为后移除。

## U3 运行中 Inbox 占用和已提交 canonical suffix 同步

公开原生活动占用/同步API扩展（F13、F19、F17、F20）。整 Agent maintenance 只适合 idle，不能保护真实 model-streaming 阶段的 Inbox/Session cursor；live append 也不能在外部已提交后用于无重复 publication 的镜像导入。

边界：占用只允许 idle 或当前 model-streaming 阶段；原 signal、phase、cursor 和 reservation 必须相同，普通 append 被阻止，取消/清空及模型结束等 holder 清理。suffix 先整批验证后导入且不再 session/event 发布；外部 Writer/receipt/PG 授权仍由产品复核。

全部相关原回归：[packages/core/agent-loop/tests/running-inbox-maintenance.spec.ts](../../packages/core/agent-loop/tests/running-inbox-maintenance.spec.ts)；[packages/core/agent-loop/tests/native-input-seams.spec.ts](../../packages/core/agent-loop/tests/native-input-seams.spec.ts)；[application/tests/native-input-coordinator.pg.spec.ts](application/tests/native-input-coordinator.pg.spec.ts)；[application/tests/native-running-inbox-maintenance.pg.spec.ts](application/tests/native-running-inbox-maintenance.pg.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/core/agent-loop/tests/running-inbox-maintenance.spec.ts
```

移除条件：上游有等价 running Inbox reservation、stale capture 拒绝、取消后 committed receipt 同步及原子 silent suffix import，且正常 append/idle 默认语义保留；先跑 running-inbox-maintenance 原回归，再跑实际 PG Coordinator 编辑/删除与镜像回归后移除。

## U4 可复用模型 fold、图片 occurrence 和原文件存储 API

公开 helper/导出扩展；不称原生算法缺陷修复（F04、F05、F03、F06）。产品授权的 PG carrier 和迁移消费者需要复用官方 model intent fold、声明事件中的原图定位、原字节文件存储。基线实现存在但公开导出不足；按 fork 前缀选择同字节不同元数据 occurrence 还需要可选 metadata predicate。

边界：model fold/file helpers 实现字节未改；image helper 只遍历官方声明 event 字段和 completed assistant blocks，保留首次匹配元数据，不扫描未知 payload。鉴权、归属、fork inclusive cut 和读后复核在产品适配层。

全部相关原回归：[application/tests/native-projections.spec.ts](application/tests/native-projections.spec.ts)；[application/tests/native-images.spec.ts](application/tests/native-images.spec.ts)；[application/tests/native-attachments.spec.ts](application/tests/native-attachments.spec.ts)；[application/tests/native-attachment-storage.spec.ts](application/tests/native-attachment-storage.spec.ts)；[application/tests/employee5-legacy-migration-v2.spec.ts](application/tests/employee5-legacy-migration-v2.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/native-projections.spec.ts products/power-evolve/application/tests/native-images.spec.ts products/power-evolve/application/tests/native-attachments.spec.ts products/power-evolve/application/tests/native-attachment-storage.spec.ts
```

移除条件：上游同一发布公开等价 fold/原文件 helper 和可按元数据限定 occurrence 的原图定位 API；先跑原 projections/images/attachments/storage PG 回归，再跑迁移 parent/child 原图与有序附件回归，消费者改为该公开 API 后移除相应导出/selector hunk。

## U5 公共 Remote stream mux 和有界 downlink 清理

公开 carrier 扩展；含 send/close 行为修复（F01、F02）。产品需要给官方 mux 提供自有 Peer 鉴权，避免复制网关；无 callback 的 WebSocket write 会使写链/close 等待失去有界结束，队列等待也应计入 deadline。

边界：保留官方协议与错误 mapper；未开始 frame 取消只移除该项并保持写顺序，开始后丢 callback/timeout 结束 carrier，close await 实际 iterator 异步清理；业务 RemoteError terminal frame 可送达。产品鉴权 callback 不下沉 SDK。

全部相关原回归：[packages/api/gateway/tests/public-mux.host.spec.ts](../../packages/api/gateway/tests/public-mux.host.spec.ts)；[packages/api/gateway/tests/stream-server.host.spec.ts](../../packages/api/gateway/tests/stream-server.host.spec.ts)；[packages/api/gateway/tests/gateway-stream.host.spec.ts](../../packages/api/gateway/tests/gateway-stream.host.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/api/gateway/tests/public-mux.host.spec.ts packages/api/gateway/tests/stream-server.host.spec.ts packages/api/gateway/tests/gateway-stream.host.spec.ts
```

移除条件：上游公开 authenticated carrier mux/503拒绝入口，并提供同等 send queue deadline/cancel/order/iterator cleanup 语义；先跑这三份原网关回归，再核对产品 native-remote 公开 Peer 装配与真实断连场景后移除。

## U6 共享 Profile 只读权限的官方 Plugins 页面呈现

可选类型/API及UI呈现扩展；不是SDK端云权限授权（F07、F21、F11、F09、F12、F10）。共享 Profile 的只读 Peer 可读 inventory，但官方页面应获知不能写入并解释原因；仅靠缓存按钮状态不能授予权限。

边界：省略 managementWritable 保留 operator-local 默认；false 禁用新增入口并沿用行只读呈现，不复制页面。每次真正修改权限仍在产品 native-remote 当前 account/deployment capability 复核。

全部相关原回归：[packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts](../../packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts)；[packages/client/ui-plugin-manager/tests/components.client.spec.tsx](../../packages/client/ui-plugin-manager/tests/components.client.spec.tsx)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts packages/client/ui-plugin-manager/tests/components.client.spec.tsx
```

移除条件：上游 inventory/Plugins 页面具备相同可选 shared-profile writability/reason 和省略默认，先跑原两份 Client 回归，再验证产品服务端仍逐次拒绝无权写入后移除；UI disabled 不替代服务端权限。

## U7 身份撤销后停止当前 connection generation

公开生命周期API扩展（F08）。应用确认身份到期/账户变更后，需要撤回当前 generation 并关闭网络 owner，而非以 reconnect 继续已撤销身份的连接尝试。

边界：复用现有 exact owner release/disposer；stop 可重复，旧 owner 不能清掉替代者，不包含云账户/令牌判定。

全部相关原回归：[packages/client/connection/tests/generation.client.spec.ts](../../packages/client/connection/tests/generation.client.spec.ts)。

上游替代前待运行（仓库根目录；未在本次整理执行，不是本轮通过证据）：

```sh
pnpm exec vitest run --config vitest.config.ts packages/client/connection/tests/generation.client.spec.ts
```

移除条件：上游提供等价 stop/release 当前 generation API，先跑 generation.client.spec.ts 的身份撤销、重复 stop/reconnect 和世代撤回回归，再跑产品 account-expiry/current-owner 消费者场景后移除。

## 证据和登记边界

已有员工2 S1—S6 scope audit 支持 mux、connection stop、Profile 呈现和 helper 导出的指定边界；S7 SDK review 支持原生 seam 的指定边界。原 claim 取消／深冻结两项 P2 有后续源码和回归路径闭合记录。S7 Host 漏传 message projection 的 P2 随后在两处调用、真实 21 例 PG 回归和 App 构建组合中闭合；它属于产品消费者接线修复，不计作本表新的 SDK fix。以上均不替代当前冻结门禁、全 SDK 审查或新版本系统验收。

34 份文档、48 份测试、7 份配置／工具另列 Root inventory。纯文档、测试第五参数兼容及 Agent double 适配、配置／锁／测试转换器不称生产 fix；12 份 session-query-sqlite 生成字节保持原样，不算 patch，不纳入迁移提交。

详细原始审查与运行证据由交付证据目录和集成状态记录维护，不随正式 Markdown 打包私有源数据、配置或凭据。原 21 份接口和行为 source hash 保持已登记值；新增两份生成目录的执行和检查收据单列，最终镜像资格由当前验收记录确认。
