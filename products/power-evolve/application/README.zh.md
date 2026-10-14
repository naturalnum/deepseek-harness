---
description: "通过独立的云端 Host 与可信 Platform Profile 运行按用户隔离的 DSH 会话。"
kind: package-reference
---
# @power-evolve/application

[English](README.md) | 中文

## 摘要

使用云端 Host 与 Platform Profile 验证用户身份、保存原生 DSH 会话并隔离工作区。Platform 持有 PostgreSQL、凭据和执行授权。Host 只接收有界 API 与操作授权。原生 Web 客户端使用官方界面，并加入迁移方案限定的三处扩展。


## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过具名的 [Host](../host/README.zh.md) 与 [Platform](../platform/README.zh.md) bundle 启动。配置分别提供端口、私有凭据文件、存储和数据库访问。部署启动器读取 Git 之外的运维文档，不把凭据值复制进 Profile。

Host 的 `nativeShellEnabled` 选项通过按操作授权绑定的云端 Shell 提供方组合未经修改的原生 Bash 工具。Host 使用原插件声明的服务注入，并等待安装完成后再接入输入。工具在同一调用中等待原持久执行结果。提供方显式使用 `shellPollMs`、`shellTimeoutMs`、`shellMaxTimeoutMs` 和 `shellMaxOutputBytes` 限制。默认保留现有回执路径；候选实例须具备匹配的 Platform 数据库代和 Runner 后才能启用此选项。准备和执行共用原生合并截止时间。观察失败后仍保留原执行以完成精确清理；Agent 释放会请求原句柄停止，并等待终态证据。本片前台能力尚不提供实时输出流或后台任务。

Host 根路径跳转至 `/native/`。登录、独立审批和账号管理由 Platform 提供。 独立审批模块从 `@deepseek-ai/dsh-util-crypto` 的公开浏览器模块生成请求编号；该模块由明确的同源资源路由提供，也适用于局域网普通 HTTP 来源。[原生 Web 构建](../cloud-web/README.zh.md)包含官方组件；[个人连接器配置](../client-extension-center/README.zh.md)占用官方 Host bundle 的配置插槽。

登录页显示产品名称、工作空间主标题和说明，以及居中的账号、密码表单。输入框聚焦、填写或由浏览器自动填充时，标签浮动至边框上方。Platform 验证凭据后，经 Host Cookie 交换进入原生界面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

[原生租户 Runtime bundle](../native-runtime/README.zh.md) 在单个账号拥有的进程中组合维护中的 base 与 Web bundles。独立可撤销的 Runtime 凭据绑定账号、实例和代际；它不能作为 Browser Agent 或共享 worker 认证。原生 Runtime 的任务领取、intent 维护及每次浏览器 carrier 均校验固定账号。Platform 拥有已提交的原生 sandbox-policy 代际和精确 operation 工具快照。原生子会话 grant 派生自原始活跃父 operation 与 Writer；普通任务领取排除这些子会话，防止进程丢失后重放提示。

<details>
<summary>持久化、授权与原生行为</summary>

Runtime 冷启动就绪检查先等待原 Pod 运行，再读取其服务。代理路由尚未出现、暂时的服务端失败和连接中断仅可在配置的就绪 deadline 内重试；每次读取均受剩余预算限制。账号、UID、镜像、finalizer、schema 和认证检查仍立即拒绝失配。就绪重试不会创建另一代 Runtime，也不会重放原生 RPC。

采用 `restartPolicy: Never` 的原 Runtime Pod 在首次删除把元数据代际推进到第二代后，kubelet 状态仍可能保留第一代。原生停止分类器要求原 UID、不可变镜像、零次重启、每个声明的容器严格早于删除截止时间结束，以及 sandbox 和就绪条件的正向停止事实。仅当两项时间戳均精确到整秒时，sandbox 停止时间可以等于截止时间；带小数的相等时间或更晚的观察仍保持不确定。拥有方提交正向停止证据前，原观察和 finalizer 均保留。

Host RPC、流式上传和每轮完整的 native-intent reconciliation 均持有可释放的请求 deadline。调用方取消和配置超时覆盖响应 body；完成后释放调用方监听和计时器。

受理操作固定模型、Skills 和连接器选择。账号锁、当前凭据、Session 租约与 epoch 约束写入。原生事件追加在同一 PG 水位提交模型、输入队列和标题投影检查点。检查点编码 2 将已验证 JSON 文本存入 jsonb，以保留 NUL 和未配对代理项；旧编码 1 仍可读取，并在追加时升级。未来编码、损坏文本和不一致水位会被拒绝。转次判断按块读取已验证事件，避免 PostgreSQL JSON 提取，原始事件 JSON 保持不变。当前写者持有 Session 租约时，冷会话的标题和模型修改会被拒绝。

cloud-native 数据库通过相邻迁移推进至 schema 12，保留既有代际的资产和记录。独立的临时助手呈现表存储 JSON 文本；原生 Session 事件仍是恢复来源。固定旧版导入器生成 schema 2，由正常 Platform 启动经保留的相邻代际升级至 schema 12。事件与投影写入可与呈现状态变更共用调用者已授权的 PG 事务；调用者负责最终租约核验和提交。

原生前台 Shell 接收要求实际已消费的输入集合及当前打开的步骤。Platform 保留原始请求超时、实际采用的超时、grant 摘要和凭据版本。捕获的 Runner 请求使用有界尾部输出，只附带受控的 `DSH_SHELL`、`DSH_HOME` 和 `DSH_SESSION_ID` 变量。结果归属于原工具调用；这些执行不会创建沙盒结果续跑。原始 token 过期后仍可恢复同一回执并请求清理，但账号撤销和归档仍禁止输出读取。首次取消原因持久保存且不可覆盖；自动丢失执行所有权记录为 abort。原生 Runner 取消携带该持久原因。准备阶段尚无结果时使用持久原因；真实结果保留 Runner 的 `timedOut` 事实，Host 晚到的期限不能把成功改为超时。接受取消不等于确认停止。结果缺失时保留未决状态，直到确切停止捕获的原执行器；无法核验的结果以 `closed_unknown` 结案。既有回执式执行保留续跑交付方式。

独立的原生会话写入占有与操作授权分离。准确的活动 worker、token 摘要及 writer epoch 控制维护操作；释放保留最后身份和 epoch 以供重试。普通任务领取排除活动占有，在 Session 锁等待后再次核验。调用者持有的事务可锁定并复查准确占有，不延长其有效期。授权恢复使用原受理输入及选择，要求准确的活动 attempt，并在读取后重新核验权限；普通领取使用同一恢复方法。Platform已挂载有界writer取得及维护路由。Host Scheduler 为整个 Session run 取得一个保留的 Writer 身份，独立续租，在所有本地代际释放后再 release；取得响应不确定时保留同一随机 token 重试。操作取消立即停止新增续租；已发出的 Writer 续租保留原配置的传输期限，release 等待其原始响应或有界传输超时。已发请求的真实失败由显式 Scheduler close 报告，期限到达不代表服务器已确认。冷交互 owner 与子会话写入句柄使用相同的已发请求屏障；维护失败调用原身份 cleanup，不能完成为 completed，显式 close 和 shutdown 会保留失败；当前验证范围由 冷 Session 在取得原占用后立即开始 grant 和 Writer 维护，早于持久化加载以及 preset、文件系统和 shell 初始化。初始化取消会等待已发出的维护与精确清理；真实传输失败在重复 close 和 shutdown 时仍可见。[writer集成记录](../TRIAL-M3-NATIVE-WRITER.md) 拥有。

有序助手发布器归属一个捕获的操作授权。原始原生帧与正式事件共用其有界顺序；待处理条目和字节计数包含正在传输的批次。Host 模型迭代器等待由现有条数和字节限制推导的水位，在已验证的回执或已完成的输入预约恢复容量后继续拉取。每个等待接缝重新检查原 Grant、Agent、Session 和 publisher。EOF 等待全部暂存条目确认，不等待纯心跳。取消仅停止模型等待方，publisher 继续负责提交和输入预约的清理。首次发布失败阻止后续发布，并可携带一条不含事件或模型文本、标签固定的数值预算快照。关闭等待归属的工作完成后，再释放准确的 publisher 身份；释放及过期状态清理保留正式历史。

在 native 执行期间，Host 为操作 epoch 的首个保留异常输出一条 `operation_first_failure` 错误日志，包含 Session/operation ID、epoch、stage 及有界类别／错误码。日志不含异常文本、堆栈、正文或凭证；日志输出失败不改变取消或结算。

canonical 输入、账本和呈现回执通过原生输入端点共用实际 Platform 事务。Host Coordinator 在发布前预留原生前缀，在 prompt 组装前提交完整领取，并绑定实际已发布的 step。claim 回执保留 removal splice 坐标及完整 claim batch 摘要，其中包括原始 operation 摘要。验证 admission 或 queue 的真实回执后，Host 静默同步准确写 handle 和 live Session；它在修改 cache 前验证完整 suffix，并在等候持久性屏障时保留每次读取的原 prefix。Scheduler 在唤醒输入前安装 Coordinator 并登记当前输入归属。受理 origin 仅在未预留的 idle 或原生模型流阶段通过有界 polling 入队；其他阶段保留在 PG pending 中。

Platform 安装实际 frame、执行授权 provider、已受理输入读取和 [v2 续接](native-turn-continuation-v2.zh.md)。[只读 advance 准备器](native-turn-advance-intent-v2.zh.md)从 PG 推导关闭的 turn、完整 cohorts 和准确的 pending head。转移响应不确定时，Host 保留返回的完整意图并原样重试。准确退役已消费的 publisher seal 会阻止旧代际写入，并跳过该转移已完成的 release。模型代理及 runtime 业务工具路由要求实际 claimed-step 执行授权。snapshot、publication、原始图片及已选 Skill 读取分别使用其存储授权。下一 turn 开始前，Scheduler 排空 admission 和 operation 续租，保留完整准备意图，退役已证实的原始 seal，销毁 Agent 并保留待处理输入，仅安装单独证实为 live 且具有原始选择的后继。 原生模型失败可以通过同一 v2 事务结算已持久化并关闭的回合。输入或持久化失败使结算进入 unsafe 状态；Coordinator 在原生 agent/error 发出前报告这些失败，下游模型错误仍保持原生含义。

操作过期或 park 后，普通领取先选择原生 next-turn 队列头，再选择首个 next-step 输入。已消费的当前 owner 仍优先等待对账。授权通过当前 Session epoch 的活动 attempt 确定操作。prepared 恢复端点在新签发的 attempt 和独立取得的 Writer 下保留原受理 audit 及完整冻结快照；历史 frame 行保持不变。原 audit 附件必须匹配完整快照中的有序子集，不重复 admission。没有消费或业务事件的中断 turn 可在新 claim 前复用原生 resume factory 的修复。已消费输入恢复则保留原 claimed 身份，复用原生中断 closers，在当前存储授权下证明完整历史 cohort 后结算；不会唤醒 inbox、安装业务工具或为该已消费输入授权再次执行模型。

未消费 prepared 输入的用户取消使用[专用事务](src/platform/native-prepared-cancel.ts)。Host 复用原生 closers，并规划原候选最新 pending revision 的一次 canceled 删除。同一事务先提交规范删除及其实际 publication 回执，再退役 frame、结束来源 attempt，且仅清除该 Session 的租约；原 epoch、冻结选择及其他输入均保留。完整无令牌回执在原 Writer 作用域及完整请求摘要下只存一次，因此回复不确定时，即使来源或 Writer 已过期、publisher 已清除，也能原样重试。Host 在第一次退休请求前停止并等待 operation 续租，独立 Writer 保持续租直到本地同步完成，再按已提交回执退役 publication。现有 `operationTimeoutMs` 覆盖 resume、规划及重试。普通浏览器删除仍拒绝活动 prepared owner。

浏览器队列命令保留原 carrier nonce，经 Platform 路由到当前活动 Writer 的 Host。`nativeInputOwnerRoutingFile` 指定绝对私有 JSON 文件，其中的 `workerOrigins`、`timeoutMs` 和 `maxResponseBytes` 由运维提供；缺少配置时拒绝路由。Platform 通过 `nativeInputMaxCohortInputs`、`nativeInputMaxAcceptedAuditBytes`、`nativeInputMaxRevisionBytes`、`nativeInputMaxCommandBytes` 和 `nativeInputMaxFrameBytes` 限制输入依据的读取。接收 Host 要求准确登记的 Coordinator，沿用原浏览器 bearer 提交原子 PG 修改；客户端输入和路由均不会签发 operation 或 Writer token。

启用助手流的 follow 在同一归属校验和 PG Session 锁下读取历史及原生助手基线。私有 publisher 位置不进入原生 Client 数据包。publisher 退役或环形条目淘汰时，已发出 opening 的 generation 正常结束，原生 Client 随后重开；持久状态损坏则终止 follow。Platform 通过 `nativeAssistantMaxOpeningBytes`、`nativeAssistantMaxBaselineChunks`、`nativeAssistantMaxPacketItems`、`nativeAssistantMaxPacketBytes` 和 `nativeAssistantMaxCanonicalReadBytes` 限制完整 opening、基线片段及数据包条目和字节。Host 通过 `nativeFollowMaxGenerationMs`、`nativeFollowMaxGenerationItems` 和 `nativeFollowMaxGenerationBytes` 限制每个 generation。opening 前超时报错；opening 后超时或累计预算耗尽则正常退役。取消传至正在执行的 Platform 读取。Host 另外向公共 Gateway 提供 `nativeStreamSendTimeoutMs`，默认10,000毫秒；下行帧截止时间包含等待前序写入的时间。取消尚未开始的帧会移除该帧，保留前序写入；未收到完成回调的发送开始后，取消或截止时间到达会终止物理通道及其逻辑流。Gateway 关闭等待源迭代器清理完成。

浏览器凭据交换消耗提交的 Agent token，保留原有效期。每个 Host 在每次请求中通过 Platform 核验限定路径的浏览器 Cookie，因此撤销在副本间生效。可信账号页面仅提供清单内的资源，并设置限制性的浏览器响应头；资源缺失或无效时不回退到入口页面。个人展示偏好按用户独立持久化，拒绝过期修订号和嵌套修改路径。

原生分支通过官方分支函数复制准确的已提交事件前缀，保留继承历史、收尾事件和父会话关系。后续模型取自该前缀的官方投影，持久受理时重新核验用户当前的模型权限。原生 Session 取消停止活动工作，保留排队输入及其回执；产品取消接口还可取消最早的排队输入。

当前 Session 头保留官方可选的绝对工作目录、子 Agent 来源、委派深度、Agent preset 和分支关系。这些字段不赋予归属或续接权限。原生浏览器响应展示云端逻辑目录，持久元数据保持不变；未知头字段校验失败。

搜索在一个只读 PG 快照中校验本人的已提交日志，并将其恢复到每次请求独立的官方 SQLite 内存索引。该服务搜索当前用户及助手消息，使用原生全文排序和按 Unicode 限长的摘要；原始 PG 事件 JSON 保持不变。持久事件字节水位计量规范化 JSON，与原始 JSON 写法分别核验。查询须包含可见文本，不得含 NUL，最多500个 UTF-16 编码单元。Platform 配置通过 `nativeSearchDeadlineMs`、`nativeSearchMaxSessions`、`nativeSearchMaxEvents` 和 `nativeSearchMaxBytes` 控制整次截止时间及总量；每份历史按原始或规范化 UTF-8 总字节中的较大值计入预算，各会话存储限额仍适用。超过时间或额度时返回失败，不返回部分成功。调用方断开会销毁本操作独占的 PG 连接；同步投影和 SQLite 工作在有界工作前后检查取消，连接释放不承诺 PG 后端立即终止。

云端目录是 `/workspace` 下按账号归属的逻辑名称，不选择 Host 文件系统根。工作区保留不可变的 Session 归属和私有物理存储。移除工作区只注销注册，保留文件和会话；再次选择同一目录可恢复注册。未注册的工作区不能创建新会话。私有排序、归档和置顶记录拒绝他人身份、重复条目及不完整的目录树。

按账号归属的持久归档集合及未完成的归档停止请求，在账号及 Session 锁下阻止新输入受理、普通领取、原生 inbox 修改及业务执行。已受理输入的准确重试仍返回原回执。受阻的 continuation 若仍有 pending 输入，会拒绝签发后继，不把该输入报告为空队列。存储读取、原生 closers 与结算保留各自的授权。恢复显示不会撤回已发出的停止请求。专用领取通道只取得存储权限，用于真实取消尚未消费的 pending 输入并结算已消费工作，保留原 frame 和冻结选择。原生清理完成必须确认 inbox 为空、边界闭合、attempt 已结束且 Session 租约已释放；物理 worker 保留各自的取消及清理证据。带 `stopActivity` 的归档先持久化归档集合，再向该 Session 的原 operation root 和归属执行服务发出持久停止请求。返回结果确认请求已发出；物理清理保留各 provider 的原身份和结果。

Office 部署必须指定经过运维验证、在解析器启动前禁用外部网络的 RuntimeClass。不可变 Pod 意图和转换器安全版本 2 保留该选择；提交拒绝缺失或不同的运行时。安全版本 1 快照仍可作为历史事实读取。NetworkPolicy 提供附加隔离，不能证明其规则生效前已受到保护。

[文件适配器](src/platform/native-files.ts)通过受保护文件服务读取本人工作区字节。独立转换与执行服务保留原身份及不确定状态，直到匹配观察能够结算。服务校验、限额和失败语义由实现旁的说明定义；来源历史记录不能认证当前运行版本。

原生文件上传经 Host 流式送至 Platform，提交归属接收会话的持久回执。输入受理在事务中绑定原始顺序的文本与回执。原始字节保存于可写 Workspace、Home 和 Skill 挂载之外的私有存储，沿用的附件后端核验摘要和长度。分支只继承准确事件前缀中出现的文件引用，并保留原存储身份。`cloud_file_read` 不启动沙盒即可读取有界 UTF-8 行；`cloud_file_copy` 幂等创建工作区副本，供获授权的 Office 或执行工具使用。部署在初始化数据库之前拒绝原文件与可写根目录重叠。 上传在账号锁下计量本人的不可变物理对象、已发布文件名和崩溃暂存内容；回执提交失败后仍消耗配置的字节和文件预算。数据库断连会中断停滞的输入等待，HTTP 通道关闭未完成的输入。文件读取在核验原始字节后重新检查授权，复制受理在工作区写锁等待后重新检查授权。

原图沿用 Platform 现有的 `attachmentRoot`，附件备份因此包含字节不变的 SDK 对象。Host 作用域读取器在传输及 SDK 派生前后检查准确图片引用和当前操作授权。迁移图片保留独立的历史核验权限；Host 登记沿用的图片卸载投影并保留原元数据。`legacyImageMaxBytes`、`legacyImageMaxPixels`、`legacyImageMaxLedgerBytes` 和 `legacyImageReadTimeoutMs` 限制历史读取。Host 配置图片尺寸、数量及总字节数；`legacyImageCacheRoot` 定位到绝对 `readyFile` 旁的 `image-request-cache`，或另一已配置的绝对私有缓存。派生图片可重新生成。

新提示词通过原生载体提交编码图片。Platform 在存储前检查所选模型的官方能力，按序绑定暂存文件，并在账号和 Session 锁下使用 [SDK 图片受理](src/platform/native-image-admission.ts) 处理整批内容。相同请求的重试先于存储检查。共享附件物理配额包含受理失败留下的对象；保存不会返回部分引用。持久受理前检查连接断开、受理期限及当前浏览器权限；无法取消的 SDK 工作完成后才关闭其存储上下文。[原生图片权限](src/platform/native-images.ts) 将准确 SDK 元数据和原存储身份绑定到完整受理内容摘要；操作读取核验该来源，且在字节校验后再次核验当前 Grant。浏览器预览使用当前账号凭据、所属 Session 的规范历史及官方图片引用查询，无需活动操作。分支仅继承原生保留前缀内的图片引用。Platform 的 `nativeImage*` 配置控制 SDK 受理、归一化、并发及权限字节数，并将相同受理限额提供给原生 Client。两端载体的 `maxRequestBytes` 同时限制编码提示词；`nativeUploadTimeoutMs` 设置受理截止时间。

[账号桥接](src/account-contracts.ts)显式导出运行时校验器并保留类型导出。Application 将 Contracts 声明为匹配的 peer 与开发依赖；[Host](../host/README.zh.md) 和 [Platform](../platform/README.zh.md) 安装提供生产 provider。每个 Node isolate 在接收请求前都必须将全部协议子路径与 Zod ESM 入口解析至选定 provider。仅用于云端的 [peer 策略](../scripts/cloud-peer-policy.mjs)保留官方 SAFE 分类。浏览器 bundle 拥有各自的校验实例。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [已确认迁移范围](../CLOUD-MIGRATION-PLAN.md)
- [Host bundle](../host/README.zh.md) 与 [Platform bundle](../platform/README.zh.md)
- [原生 Web](../cloud-web/README.zh.md)
- [当前迁移证据](../TRIAL-CLOUD-MIGRATION-M0.md)

-----

<a id="model-experience"></a>
## 模型体验

模型接收受理操作中获授权的配置与选定说明。到达模型的输入和结果均记为原生 Session 事件。模型提议受控动作，独立审批凭据保留在 Platform。已组合的 DeepSeek 适配器将推理解析为 `off`；原生目录与持久选择也报告这一值。

原生关闭回合的转移会先在原 operation 和 Writer 仍有效时等待该 Agent 已捕获执行绑定的原始停止完成。只有确认原对象停止后才允许封存 publisher 并在 PG 退役操作；排空失败保留原始错误并阻止结算。既有进程的观察通过此前明确提交的 cohort 跨越步和回合的关闭窗口，新执行仍要求当前已 claim 的开放步。持久 Bash 回归使用原生 Loop、两条真实命令与原 PG/HTTP provider，Kubernetes 侧限于受控 TLS 观察、工作进程使用调用者拥有的不可变 Linux 镜像（`PE_TEST_CLOUD_IMAGE`）；这些观察不能替代实际 gVisor 验收。

原生模型出口把已提交的请求 Header 绑定到当前 operation 和 epoch。仅 Host 可见的 Session projection 在原生 Loop 的继续步骤中保留该序号；原生 Loop 为下一 operation 开始自己的请求系列。Platform 先核对原始已认领 Frame 的前缀，再接受该序号，并把采样的原生工具 schema 与已受理 MCP／STDIO 定义一起冻结。派生子会话使用原始新建记录或继承 seed 的切点；继承会话缺失该标记时拒绝授权。启动期间只含名称的注册用于保留目录名称，不能授权原生模型请求。

Platform JSON 响应读取器在消费响应期间保留原始调用者 signal 与配置的 deadline。读取中断时，先取消并等待自己持有的 Reader，再报告原始取消或超时原因。独立的取消失败同时保留该原因与清理错误。传输取消后，服务端事务结果仍然未知；只有原始保留回执才能证明确认。

云端 Bash 增加已记录的说明，要求在命令结果未知或不可用时不要重复原命令。其前台结果属于原工具调用，不创建新的用户消息。Platform 只向命令提供 `DSH_SHELL`、`DSH_HOME` 和本人的 `DSH_SESSION_ID`，不转发 Host Profile 路径或凭据。

对于已受理上传，已记录的说明区只列出本会话获授权的文件身份，解释云端读取与复制工具。文件元数据本身不表示模型已经读取内容。原文件不具有 Host 本机执行路径。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

原生执行 broker 在 PG 中冻结原 Agent operation、存储 generation 和权限 generation。Runtime 客户端仅获得有界 world 方法；数据库及 Kubernetes 凭据留在 Platform。每个进程或文件工具在独立 gVisor Pod 中以 UID 1000 运行，移除 capabilities、不挂载 service-account token，镜像根只读。只读模式将用户数据和临时文件挂载为只读；工作区写入模式允许 Workspace 和私有临时文件写入，Home 保持只读。原生调用完成前等待精确 Pod 的持久 kubelet 停止观测。broker 启动时按原 Pod 名称和 UID 对账，不重建命令；缺少停止证据的受理记录保持不确定。

通过同步的原 Agent binding resolver 装配 `installNativeExecutionProviders`。`createNativeExecutionHttpBinding` 仅使用该 operation bearer 和 native-world 路由。存储读取允许 Agent 在首个已声明步骤前初始化；修改和任意子进程须具有完整的当前原生执行 cohort。配置内需声明构建产物 `lib/native-execution-worker` 中的无凭据文件工具、Platform 的 kubectl、私有 kubeconfig、控制端与 PVC 对应的存储路径和有限 Pod 截止时间。每个原生消费者均受 PG 授权和同 world 挂载约束。

进程监控与纯输出收集校验精确的原 PG 受理记录、Pod UID、原已声明 cohort、operation、Writer、租约和 world 代际。在原 operation 仍活跃时，这些检查保留已经受理的持久 Shell，使它跨越步骤边界和正常 turn 结束。新子进程、stdin、control、终端写入和前台操作仍须通过完整的当前开放步骤检查。收集已停止范围的输出还会校验原有的正向 Pod 停止观测；收集不会分配或重启进程。

当前限制由相应原生 API 明确表达：

- broker 的文件工具回包和保留输出有明确上限。无凭据进程 relay 承载原始子进程字节、fd7 控制通道和真实 guest PTY；产物平面的物理用例实际执行原生 Bash、PTC 宿主绑定和已注册 Terminal 后端。文本流读取使用有界 UTF-8 帧和已确认的字节窗口，与文件总大小无关。Runtime 消费者暂停读取时，原始子进程和 PTY 管道会暂停真实来源。显式 binding `close()` 等待原始 start、stop 和 release 完成，并在 Cordis 销毁之外保留清理失败。Pod 调度请求 `requestCpu` 和 `requestMemory` 可独立于硬限制 `cpu` 和 `memory` 配置；加载部署配置时，未指定的请求会显式采用对应硬限制的值。文件监听及完整输出溢出文件恢复尚不可用。生产 Profile 与浏览器验收另行执行。
- 原生云端 Shell 当前仅支持有界前台 Bash。后台任务、标准输入／环境覆盖、原生文件权限以及完整 FS／Subprocess／PTY 提供方仍属于[运行改造计划](../CLOUD-RUNTIME-PLAN.md)中的独立切片。不确定命令按原身份对账。
- 打开 Host 本机文件及修改共享 Profile 需要云端用户不会自动获得的权限。
- 当前输入适配器接受排队文本、普通文件回执及 SDK 受理的图片；插队、编辑和删除通过当前 Writer 的 Coordinator 提交。活动 prepared owner 的删除会被拒绝。
- 当前续接支持关闭回合的结算、未消费的 prepared 或 capacity park 输入接管，以及历史 claimed 对账。跨重启保留修改意图及其余停止／失败组合仍需验收；当前源码 PG 恢复检查不能认证生产重启部署。
- 历史 prepared 输入可以在新 owner 的完整 cohort 中结算，或作为实际待处理后继接收原完整冻结快照。每个旧 attempt 和 frame 都须通过有界 prepared-only 证明；原身份和计数仍保留。
- 增量发布及一致切面 follow 仍须完成同版本真实 Profile、Web 和多副本验收，包括实际传输背压。不确定发布回执仍需要对账及重试处理。
- 活跃会话拒绝冷标题或模型写入。不带 `stopActivity` 的归档拒绝活跃工作；带此参数的归档在返回前发出持久取消请求。
- 搜索在配置的输入额度内保留授权语料，建立临时原生索引；不保留跨请求复用的搜索索引。
- 云执行、Office 和连接器 worker 需要明确的私有部署配置与真实服务验收；关闭组合不构成这些功能的通过证据。

租户 Role 禁用上游搜索 provider，并将 `power-evolve-web-search` 作为独立的 Platform provider 条目插入。原生 Settings 保留现有 `web-search-deepseek` 页面命名空间，同时把真实描述、写入和变更通知路由到该条目。模型、API 版本及 token/搜索次数预算仍是原生实时偏好。原 Settings schema、密钥隐藏及修订号检查仍是权威；搜索发出前仍先提交原请求事件，再使用有界操作令牌。 并发查询各自须匹配当前步骤内已记录的精确请求体和 API 版本；其他步骤的记录不能授权。

原生权限检查点将精确的预设、沙箱和审批覆盖值私下传给账户 Runtime。维护中的原生权限服务按该账户当前目录与默认值，在相同已提交水位派生当前名称。原生一元字节结果跨越有界私有 JSON 中转时，保留原 Gateway 编解码及浏览器 multipart 格式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

采用固定官方发布版及产品 [AGENTS.md](../AGENTS.md) 的要求。源码测试和正式构建产物使用独立入口。迁移状态与准确执行命令保存在试用证据中，不放入本文参考。

</details>

租户渲染的 Native 文档、引导脚本和资源使用独立的 `pe_native_document` HttpOnly Cookie。原来的三个 `pe_agent` Cookie 作用域保持独立；租户文档与 HMR 使用同一账号的原始模块图和资源修订。

租户引导脚本保留原文，以内容寻址的 `/boot` 资源交付，并保持原浏览器 CSP。Native UI 准入通过 `maxBootBytes` 与 `maxBootResources` 显式配置有界缓存预算。
