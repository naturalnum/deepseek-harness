# Host generation 首批接线提案

2026-10-09，员工7。只读检视已完成；本单位仅新增 `application/src/host/native-operation-generation.ts`、`application/src/host/native-pending-wake.ts` 及同名专用 tests。原 reader、writer、RuntimeScope、persistence、publisher、scheduler、model、Host／Platform 入口均不由本单位修改。writer acquisition／renew／release 复用 Root 的 `HostNativeWriterClient`；Scheduler 尚未接线。

generation 持有准确 Grant 对象、原生 prepared／claimed／settled／retired frame、自己的 AbortController、已启动回调及操作级 disposer。prepared 可持久写入 claim 所需原生事件，模型／工具执行必须等持久 claim 对账；claimed 且 turnEndSeq 非 null 或 settled 均不再启动执行。A 封存后拒绝新调用，排空已开始回调和 persistence，再关闭真实 NativeAssistantPublisher 并取得完整 seal；hook 不接收或调用 Agent.whenIdle／AgentHandle.dispose。迟到 A 的 renew、timeout、publisher failure 只能影响 A，不能取消 B。

同一 write slot 显式换 publisher：排空 A → 保留 transitionId／candidateToken → 接收并验证原子 PG receipt／current → 同步发布 B。reader 保留原 capturedGrant。网络失败保留原请求，重试不重新 mint；PG 已提交但本地安装失败保留请求和 receipt，下一次仍向 Platform重放并读取 current，不能拿缓存 bearer 复活已过期 B。result.prepared 不表示 current.prepared；claimed／settled／retired 对账不重插 input。current.expired 不发布执行权。

Session 级 wake pump 保留 queue revision，每个 Session 至多一个 pump，等待正在运行的 driver 收敛后调用原生 wakePending，并按显式配置限制重试。只有成功安装对应 generation 的协调者能确认 revision；wake 本身不确认。健康 parked 保留 Agent 和 writer，释放 operation effects。关闭 pump 只终止其任务，不能复活 disposed Agent。hook 等待条件由 revision 通知直接唤醒，不能在自身 hook 内等待 pump 或 Agent.whenIdle。

最小共享修改由 Root 串行实施：RuntimeScope 增加准确旧 generation 比较后的 grant／publication 同步交换；PlatformHandle 的 write 分支持有同一 write slot 并使用准确 generation append，read 分支继续固定 capturedGrant；close 不再通过已结算 A 执行 native-assistant release；model／tools／skills／renew／timeout／监听捕获 generation 并在等待后复查；Scheduler 作为 Session Coordinator 保留 Agent／writer，调用封存、PG transition、安装和 native claim 对账。Platform 仍须独立拒绝 prepared 的模型／外部效果，Host 检查不能替代服务端授权。

首批测试针对实际 NativeAssistantPublisher、generation 状态管理与公开 AgentLoop wake 行为。PG continuation 两新表未正式注册 schema5，故本模块测试不宣称正式 A→B 原子事务、完整 Coordinator、Profile 或队列 parity；混合 next-step cohort、parked durable 输入控制与最终 Platform phase 授权仍由对应后续单位验收。各测试、覆盖和输入摘要将在独立 handoff 中列明。

开发期类型发现：`@deepseek-ai/dsh-agent` 的公开 Source Service Definition `packages/core/agent/src/runtime-types.ts:188/196` 已声明 onBeforeTurn／wakePending，第一次私有类型检查时 project-reference artifact `packages/core/agent/lib/types/runtime-types.d.ts` 尚未包含两方法，随后 Root 已重建，实际 artifact 现在包含两声明。本单位未加断言、镜像 Agent 接口或修改共享产物。generation 构造回调的自引用推导已显式标注 NativeOperationGeneration，消除隐式 any。员工6当前 response.current.live 已收紧为 prepared／claimed，settled／retired 不携带 live bearer；本单位测试随正式协议校准，terminal inspection 仅用于消费对账。
