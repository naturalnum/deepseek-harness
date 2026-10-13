# 原生队列与逐操作授权：只读核查及最小改动提案

2026-10-09，员工6。本文交付下一批实施方案，未实现 hook、队列、授权或 Schema 变更。核查保存了当前分支 23 份源码快照及 SHA，证据在 `/Users/jingchao/agent_work/private/employee6-native-queue-architecture-20261009/inputs.json`。搜索生产文件、五份已冻结自有测试及搜索交接文件的七个 SHA 均与上一轮交付一致；没有修改原始来源树、共享配置、运行时文件或现有进程，没有 Git add／commit。

## 结论与当前能力

完整方案需要一个 Session 保持一个原生 Agent／writer，由原生 inbox 执行真实 followup 和 steer；每个原生 turn 使用一个已冻结 OperationGrant，steer 作为该 turn 的授权输入成员。逐 turn 交接需要一个公开、可选的异步生命周期 hook，位置在 `turn/start`、首次 inbox claim 和 prompt／tools assembly 之前。当前公开接口缺少这个位置，可以在当前分支维护最小通用补丁；无需依赖 agent-loop 私有类，也无需等待新官方 tag。

产品当前仅支持 queue：[`native-remote.ts`](application/src/host/native-remote.ts) 第 33–36、283–288 行的严格 parser 拒绝 `mode:'steer'`，然后转发 queue 输入；并非接受 steer 后降级。当前未接 `session/updateQueue`，未命中的方法走第 327 行错误。下面提案覆盖全部队列范围；局部接通 running steer 不能作为完整队列验收。

## 固定源码证据

| 公开能力或实现证据 | 当前语义及其实施影响 |
| --- | --- |
| [`Agent` 公开接口](../../packages/core/agent/src/runtime-types.ts)，176–241 行 | `followup` 是 next-turn 的普通输入，每 turn 仅一个；`steer` 唤醒并进入最近的 next-step，idle 时开新 turn；`inject` 不唤醒，不能代替 steer。`whenIdle` 等整个 Agent 活动稳定结束，不标识某个 message 的结算。`cancel` 默认清 inbox，只有显式 `keepInbox` 才保留。 |
| [原生驱动](../../packages/core/agent-loop/src/agent.ts)，154–173、214–242、252–285、295–395 行 | 已取消活动后的 waking input 被重新归为 next-turn；每次 first preStep 先 claim、再 assembly、再公开 `agent/pre-step`。turn/end 后还有 pending 就继续驱动下一 turn。`send(...,'next-turn',false)` 只是不唤醒新 driver，正在运行的 driver 仍会自动消费它。这里只读实现以解释语义，产品不导入这些私有成员。 |
| [原生 inbox](../../packages/core/agent-loop/src/inbox.ts)，109–113、140–155、217–240 行 | 首步 claim 全部 next-step，再 claim 一个 next-turn；后续仅 claim next-step。重复 pending messageId 被拒绝。splice 先记录原生事件，再同步通知；claim 的持久事件仅含 removedCount，身份须从此前 inbox 状态还原。 |
| [正式生命周期事件](../../packages/core/agent/src/runtime-types.ts)，248–261、288–337、364–381 行 | created 只在初始化；claimed 提供精确 message／turn；pre-step 在消费和 assembly 后；request 可替换模型配置，不能改输入或提前安装当前 assembly 的工具；turn-stopping 在关闭前，还允许 steer 延长当前 turn。当前三处 Agent／AgentLoop／SessionController 源码没有命名 before-turn hook。 |
| [初始化 setup](../../packages/core/agent/src/index.ts)，100–118、125–143 行 | setup 在 create／resume 发布前只执行一次，不能当作逐 turn 交接。 |
| [SystemPrompt](../../packages/core/system-prompt/src/index.ts)，19–31、66、85、521、558–634 行 | section／context／tool provider 同步收集，async `system-prompt/assemble` waterfall 在收集之后。在其中换注册并不会重收集当前 tools；递归 assemble 会重复其他 waterfall，且外层恢复先前 complete section／context suppression，不能作为已经验证的最小交接方案。 |
| [原生 Session 请求](../../packages/api/session-controller/src/types.ts)，167–174、332–369 行；[命令实现](../../packages/api/session-controller/src/commands.ts)，329–366、432–503、602–614 行 | prompt 支持 queue／steer，accepted 表示进入 Agent inbox。messageId 新建于消息，requestId 保存在 `source.rpcId`。updateQueue 的 itemId 是 messageId；edit 仅非空纯文本且保留 id／source；remove 删除 pending；steer 仅允许 running Agent 的 next-turn 项，使用原消息 remove＋steer。原生请求去重查 pending 或 user/message，不替代产品永久受理账本。 |
| [Scheduler](application/src/host/scheduler.ts)，121、160–208、210–246 行 | 当前每 grant resume 一个 Agent，工具注册属于整个 Agent，所有输入使用 followup；把 requestId 同时用作 messageId。等待 whenIdle 后折叠消息之前 turn/start 至日志尾，随后 dispose 再 finish。多个 turn 自动 drain 后，这段尾部折叠可能取到其他操作的结局。 |
| [持久 writer](application/src/host/persistence.ts)，50–69 行；[模型代理](application/src/host/model.ts)，31–38 行；[技能工具](application/src/host/skills.ts)，45–69 行 | writer 每次 append 从当前 runtime grant 取 token，之后该 batch 在 chain 中固定使用它；不是构造时永久固定。flush 旧 chain 后同 Host 可继续单 writer。模型代理在 await flush 之后取当前 token；技能工具则捕获原 grant token，注册效果属于 agent.ctx。仅换 Map 会造成不同生命周期的授权混用。 |
| [TaskStore](application/src/platform/tasks.ts)，121–221、331–366、411–430、467–487 行 | accept 冻结模型／技能／连接选择和 admitted 内容；claim 限制同 Session 当前租约及用户容量；authorized 在锁等待后重查有效期／epoch；finish 的前提是 Agent 已 flush 且 dispose，结算同时释放 Session 租约。现有 finish＋普通 claim 不能提供连续 writer 的原子交接。 |

## 最小 generic public hook 补丁提案

建议新增 `agent/before-turn`，事件声明放在公开 Agent API；scope 与 dispatch 沿用 [`AgentEventDispatch`](../../packages/core/agent/src/dispatch.ts) 第 54–80、138–141 行。其唯一职责是等待插件在新 turn 开始前完成准备；不包含 OperationGrant、PG、模型选择、工具清单或产品策略。下列是待审阅提案，未写入上游：

```ts
// Public event declaration; listeners return no bail value.
'agent/before-turn'(
  this: Scoped<Agent>,
  payload: { agent: Agent; turn: number; signal: AbortSignal },
): undefined | Promise<undefined>
```

在 `ReactLoopAgent.turn()` 现第 303 行计算候选 `turn` 后、305 行 append 前 dispatch serial，并在前后检查 signal。准备块必须在现有 turn 的 try／finally 之外：准备失败不能写一个没有 turn/start 的 turn/end，也不能更新 phase.turn／lastTurn／step。异常沿用 driver containment，但非取消异常的 `agent/error` 应明确报告候选 turn、step 0；不能用当前 `throwError()` 无条件归到上一个 turn。后续 `turn/start → claim → assembly → pre-step` 和 turn/end 原顺序保持。serial 的返回值不得成为跳过 turn 的产品控制值。

```ts
// Proposed insertion before the existing turn/start try block.
try {
  signal.throwIfAborted()
  await this.dispatch.serial('agent/before-turn', { turn, signal })
  signal.throwIfAborted()
} catch (error: unknown) {
  if (!signal.aborted) this.dispatch.emit('agent/error', { turn, step: 0, error })
  throw error
}
```

hook 等待时已有 driver reservation，公开 status 仍为 running。失败后 driver 回到 idle，未 claim 的输入保持 pending，下一次明确 wake 可以重试；没有自动热循环重试。取消必须响应该 hook 的 signal，结束后再检查 signal；`cancel(...,{keepInbox:true})` 保留 pending，默认 cancel 的清队列语义仍成立。等待 hook 的 whenIdle 等整个 driver，因此 listener 不得 await 自己的 whenIdle／dispose。listener 自己 clear／remove 的输入不在 loop 的保留保证内。

listener 必须协作响应 signal 并等待自己的事务／效果清理结束。不能用 Promise.race 提前退休 driver、却让尚未结束的 listener 继续换 grant 或注册工具；取消时若事务已经提交，先按 transition receipt 对账，再结束准备。该 generic hook 不提供任意异步回调的硬抢占。

这个 hook 只保护首次 claim 之前的准备；不能承诺已有 `agent/pre-step` reject／assembly failure 后的 claimed 输入自动回到队列，也不能保证后续每 step 的 pending 不被消费。已 claimed 而未 user/message 的输入仍须按原生 claim 与 turn/end 对账，不能按“没有 user/message”重放。

异步准备会允许其他 input 到达，不能按一个未锁定的 inbox peek 选择 grant 后无条件 claim。产品 Coordinator 应串行原生 inbox 的交付／edit／remove／move，在准备期间保留交付 gate，基于受控 pending 状态选择本 turn 的成员。用公开 claimed 通知核对预期 batch，gate 至整个初始 batch 已 claim 后再放行；空 batch 用 turn/start 后的同步流程及终止清理处理。因 emit 通知的异常被容纳，核对失败必须在正式 pre-step waterfall 显式 reject，并对已消费 batch 结算，不能靠 claimed listener throw 阻止 loop。Agent 外部的其他输入生产者也必须接入此 gate 或明确纳入 cohort。lease renewal 和 cancel 不等待该 gate，避免授权过期／取消死锁。

无 listener 时新增 await 也可能改变微任务时序。补丁须保留 status 的同步 reservation，明确 queued delivery 的线性化点，以无 listener 的原生回归及 SDK snapshots 核对可见顺序；不能声称零行为变化。若要求保持首 claim 的同步时序，再在公开 dispatch 层提供经过测试的无匹配 listener 快路，不私查 Cordis 内部注册表。

## Session Coordinator 与原子 continuation claim

Coordinator 持有单 Agent／writer 和一个不可变 active frame：operationId、attempt epoch、token、冻结 settings／tool manifests、受理输入成员、native turn。Session 生命周期注册公共 hooks；逐操作工具与 prompt 注册改为明确返回 disposer 的一组效果。换操作先停止 A 的新增调用并等待其已启动回调／写入／工具工作收敛，flush 原生 turn/end，释放 A 的操作效果；B 的效果必须在 before-turn 返回前完成。`agent/request` 每次从固定 frame 返回完整冻结配置，避免沿用上个 request/header 或修改 Agent.options。工具 closure／模型调用在 await 前捕获 frame，执行时使用该 frame 的原 token；不能在后续 await 之后借新 frame 的 token 继续旧动作。

Platform 增加 `continueSession`，使用当前 owner Session fence、旧 operation／attempt epoch、幂等 transitionId、最后已持久 turn/end seq 和预期下一 pending messageId。事务沿用 account → Session → operation 的锁顺序，并在锁等待后重查时钟、账号、writer fence 与 execution lease；读取原生日志验证有界 turn 结局，结算 A，再为同一 writer 领取 B、签发新的 operation token／epoch，或返回 parked。普通 claim 必须排除仍由这个 live writer 保留的 Session，不能在 A finish 后抢 B；容量与公平性仍由 Platform 处理。事务同时保存 transition 结果，响应丢失重试返回原 B，不再领取 C。

不要声称 PG 事务和本地 effect 注册可以跨进程原子提交。实施顺序是：本地 gate 阻止新 claim／调用；A 收敛并 flush；Platform 原子 transition；Host 安装 B 效果并一次发布 B frame；最后释放 before-turn。若 B 注册失败或响应不确定，hook 抛出、未 claim 输入保持原 messageId，按 durable transition 对账；不可回滚到 A token，也不可调用旧 finish 释放 B 的租约。短暂没有执行容量时，hook 可随 signal 等待容量通知并续 writer lease，不能拿旧 grant 运行 pending。

如果需要真正 park 后由通知单独恢复，当前 API 还有一个小缺口：send／followup／steer 都插入消息，没有纯 wake 方法，不能重复 followup 已 pending 的 messageId，或用 remove＋重插制造唤醒。建议同一公共提案增加 `Agent.wakePending(): void`：空 inbox 无动作；idle 时只启动现有 driver；live driver 仍自动 drain；aborted 活动沿用 wake latch，disposed 活动保留停放；既有目标和身份不变。loop 内部可复用现 wakeDriver，产品只调用公共方法。新 owner 恢复、transition 对账成功或 capacity 通知由 Coordinator 调用它，每次仍重新经过 before-turn 授权。若不增加该方法，必须明确保留 hook 内等待或等待另一个新 waking input 的限制，不能宣称仅凭 pending 保留完成独立恢复。

最小连续执行路径可保持现 PlatformHandle，旧 append chain flush 后再改 runtime grant：已经排队的 batch 使用原 token，新 batch 才使用 B token。不过原子 continuation 必须保证这个 handle 一直属于同一 writer。为完整 queue 的 idle 接收、跨 Host 控制及恢复，仍建议独立 writer lease：现 pe_sessions.execution lease 继续限制每用户 active operation；新增 writer owner／epoch／token／expiry，不把 idle Agent 占有计作模型执行容量。事件写入 envelope 同时携带 writer fence 和执行 frame／控制 intent，避免一个 Session writer 权限替代任意逐操作权限。assistant publisher 的发布身份也需按这个区分核对；本报告不改 root 正在冻结的 publisher／Schema 3。

## steer 与受理冻结的兼容条件

[迁移计划](CLOUD-MIGRATION-PLAN.md) 第 83–84、143–149 行要求 F03 持久受理／requestId 冲突、F04 单写者和不盲目重放，并明确接受时配置快照。当前 accept 实际每个 prompt 创建独立 queued operation。新增 steer 应有专门受理分支：Platform 重新验证 browser 身份与 Session ownership，在事务中绑定当前 operation／epoch，按该 operation 的已冻结模型、工具及附件能力冻结 steer 的输入授权，保存原始内容摘要／requestId／messageId。它是当前 turn 的新增输入，不签发另一模型／工具 grant，不抢占正在运行的请求，不把 steer 改叫普通 queue。后续个人设置变更不影响该 cohort；执行端仍检查资源撤权和当前 epoch。

受理与消费之间 A 可能关闭或被 cancel；Host 必须核对实际 native splice target。原生 waking-after-abort 会把 steer 转为 next-turn，不能在账本继续宣称它已进入 A 的下一 step。成员尚未 claim 时保留原输入及冻结授权记录，Platform 明确裁决下一 turn 的执行归属／续接权限；不得静默借用下一 grant。idle steer 则创建一个冻结执行 frame 并真正唤醒 Agent；初始 claim 前用 gate 固定成员，避免后来普通 B 的不同快照混入。恢复发现不同冻结执行计划混在同一初始 native batch 时，必须先对账裁决，不能选一个 token 跑全部。

已经 queue 的 B 转 steer 有单独矛盾：B 的受理模型／工具可能与当前 A 不同。只保留 B 原记录、实际却在 A 的选择下执行，并不能证明“已受理 B 使用原冻结选择”。严格保持该承诺时，仅执行快照完全一致且 A 授权覆盖该输入时允许 move；比较模型、token budget、全部工具／技能／连接版本及执行目标等语义字段，不比较必然不同的 lease token。不同快照应明确拒绝，不能 fallback queue，并将此限制记为尚未满足的原生 parity。

要支持不同快照的完整原生 move，应把用户 `updateQueue.steer` 明确规定为新的控制受理：保留 B 的原输入和选择，终止其独立执行计划，新增指向 A 冻结 frame 的授权意图，原 messageId／source.rpcId 不变；原 requestId 的重试读回这一历史结果，不能重建 B。这个动作确实改变 B 的执行归属，需要同步说明 F03／F04 的 mutation 语义并更新消费者和测试；它不等于在 A 中途启用 B 的模型／工具。推荐下一批完整实现采用此显式控制语义，同时保留所有原受理审计数据。当前尚未实现或验收该语义。

## 必须新增的 durable 数据

| 数据 | 最小用途与恢复约束 |
| --- | --- |
| input admission 映射 | 唯一 `(sessionId,requestId)`，稳定 messageId、原内容／mode 摘要、原始 admitted 内容、当前内容 revision、有效 native target、执行 plan／cohort 归属及状态。重试相同请求读原回执；改内容／mode 冲突；edit 是独立 mutation，不能覆盖原始摘要；remove 后不能重新 followup 原输入。复用现 pe_native_prompt_inputs 的原内容存储及 pe_operations 的冻结选择。 |
| queue control／delivery outbox | 稳定 commandId／transitionId、itemId、edit／remove／steer 意图、预期 queue revision、writer epoch、提交状态／结果及原生 seq。现 updateQueue 请求没有独立 mutation ID，产品传输要补充并固定重试身份。控制仅由当前 fenced writer 通过公开 inbox API 执行；另一 Platform／Host 不直接在活 Agent 背后追加 Session 事件。 |
| turn 与 operation 绑定 | native turn、operation／attempt epoch、claimed messageIds、inbox claim seq、user admission seq、turn/end seq、每个 cohort member 的结算。通过公开 inbox projection 和连续 native splices 重建被 claim 的身份。按精确 turn 切片使用公开 foldConsumedWork，不能把整段尾部最后的 end 或 whenIdle 当作某请求的结果。 |
| writer ownership 与 continuation receipt | 独立 writer owner／epoch／expiry／token digest；同 owner 的 transition 结果、原／新 operation epoch 和 parked 状态。旧 Host 无法续租、append、控制或确认新 epoch；op token 只授权自身调用。控制写入与执行写入分别核对关联 intent／frame。 |

这些是产品业务 PG 数据，不需要为了映射账本添加新的模型可见 SessionEvent；输入／队列／请求仍记录正式原生事件。新增 Schema 使用 root 当前最新受管版本之后的相邻迁移，不回写历史 DDL。现 [`pe_operations`](application/assets/cloud-schema-v1.sql) 第 908–950 行只允许 queued／running／completed／failed；若使用 superseded 等正式状态，必须迁移约束；最小方案可用 failed＋明确终止原因和独立控制状态，不能写不存在的 state。

原生 move 有 remove 和 steer 两个 splice，当前 observer 每个事件独立 append；崩溃可能只持久化 remove。必须先提交 move intent，记录完整原消息和预期 seq，再由 writer 执行／flush／ack。恢复用原生事件判断未执行、半完成、已完成或已消费；补齐缺失的同一个 messageId，不能新建一个输入。可以进一步在 persistence 提供受控批次持久提交，以现 EventStore 的原子 batch 写入减少半完成窗口；批次不能靠过滤或伪造 native 事件实现。

停机另有保留缺口：[`AgentHandle.dispose`](../../packages/core/agent-loop/src/index.ts) 第 538–557 行再次默认 cancel 并清 inbox。Scheduler 的先 `keepInbox:true` 并不保证后续 dispose 保留队列。必须先停止 delivery、确认持久未消费 intents，再选择公开 disposal 保留选项的单独 generic 提案，或明确记录因卸载产生的 canceled splices 并按可恢复 intent 重建。恢复规则需区分用户 remove／cancel 与系统卸载，不能把所有 canceled 都自动重放。

## 下一批实施与验收

实施顺序：先新增 admission／control／turn binding／writer fence 和原子 continuation；再提交公开 before-turn 的声明、实现、JSDoc、Agent／AgentLoop README、architecture／公开 subsystem 文档及升级说明；随后把 Scheduler 改为 Session Coordinator、逐 frame 效果和模型授权，最后接 native prompt 两种 mode 与 updateQueue 三种 action。公共补丁与产品 policy 分开审阅，但端到端验收必须一起完成。原生 inbox projection 继续是 UI pending 的来源，不能用 queued operation 列表替代。

必须验证：hook 无 listener／顺序等待／失败／取消和 pending 保留；A→B 不同模型及工具、无旧能力泄漏、旧 chain flush、两 Host 并发 continuation 与响应丢失；idle／running steer、cancel 后 native target、move 保留同 messageId、edit／remove／原 requestId 重试；move 两次 splice 之间崩溃、outbox ack 丢失、claimed 但无 user/message、turn/end 先持久后交接；writer／operation 分别过期、旧 callbacks 拒绝、新 owner 接管、权限撤销和系统 unload。公开生命周期变化同时更新 TypeScript SDK 与 Python SDK 的真实 Session snapshots；模型可见差异补 assembled keyless recorded-session 场景，不能用 mock／单测代替。产品 concurrency／recovery 使用隔离真实 PG，进程只通过命名 dsh profiles 启动。

本轮仅执行源码核查、输入 SHA 对比和本报告的链接／格式检查；未运行新的模型、队列、租约或恢复测试，未完成上述实施或 parity 验收。已冻结搜索的 27 例通过属于上一轮证据，不计作本方案验证。报告检查期间 root 修改了 EventStore 的返回值 JSDoc；已复核第 33–75 行原子 batch 逻辑仍一致，原核查快照和新 SHA 均保留，不将共享树声明为整体未变。
