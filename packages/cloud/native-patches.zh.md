# 原生集成维护

[English](native-patches.md) | 中文

本参考说明七个 Cloud 包与其消费的原生代码之间的职责，不增加运行组件。比较基线为 `master`，即本分支审查时采用的本地原生基线；这不代表它是最新上游版本。升级前须另外选定目标上游修订。


上传适配保留目标文件/图片引擎和暂存回执判别项。原有限 Native intake/回执所有者及受保护文件/工作区钩子通过目标 Schemastery 配置接回；实际 body return 等待源取消、终态、已开始读取和锁释放，不代替 Connection 的 wire 关闭。Cloud 只把确切 file 分支交给原 collector/存储/发布所有者，在源工作前拒绝未授予的图片提示 intake。准备好的 Client 提供原 context carrier 和显式仅文件草稿投影，图片 MIME 选择保留普通文件路径，Native 默认图片行为不变。附件可选 unknown 标记不创建已结算默认值，未知清理/交接责任继续保留。
## 职责归属

Cloud 包负责账号身份、owner 路由、租户策略、存储准入、执行绑定和浏览器撤销。原生 DSH 负责 Agent/Session 状态、分发、配置应用、文件系统原语、Shell 消费接口和通用界面。原生回调在实际提交或释放点检查；HTTP 前置检查不能替代 await 之后的检查。

| 原生位置 | Cloud 消费者与保留的原生责任 |
|---|---|
| [Session Controller](../api/session-controller/src/index.ts)、[commands](../api/session-controller/src/commands.ts) | [pe-cloud-api/native](pe-cloud-api/src/native.ts) 提供项目、目录、prompt 文件和模型准入。创建、收据绑定和模型选择仍由原生负责。 |
| [AgentLoop](../core/agent-loop/src/index.ts)、[Subagent](../subagent/subagent/src/index.ts) | [pe-cloud-runtime integration](pe-cloud-runtime/src/account-native-integration.ts) 提供实际 graph、父 Agent 和项目准入。复用原生 Agent、回合执行和子 Agent 释放。 原工厂同时为账号排空提供有界的活跃空闲观察和同一个缓存 stop 结果；晚到句柄与个体清理失败继续归其持有，Context 卸载等待同一结果。 |
| [Settings Controller](../api/settings-controller/src/index.ts)、[Credentials](../credentials/credentials/src/index.ts) | [Native first screen](pe-cloud-api/src/native-first-screen.ts)、[save hook](pe-cloud-api/src/native-save-hook.ts) 和模型密钥策略，将授权保持到原写入及其真实失败。 |
| [Config impact](../boot/app-boot/src/config-impact.ts)、[ConfigEditor](../boot/config-editor/src/index.ts)、[PluginManager](../boot/plugin-manager/src/index.ts) | [Plugin control](pe-cloud-api/src/plugin-control.ts) 提供策略。原组合、预先判定的影响、持久化和 Loader 应用仍属原生；计划私有持有自己的准备状态。 |
| [Loader entries](../../vendor/loader/src/config/entry.ts)、[Loader](../../vendor/loader/src/index.ts)、[groups](../../vendor/loader/src/config/group.ts) | 原生编辑器与 Cloud 保存共用精确变更检查、条目版本和真实子更新结算。不变的声明条目对类型化表达式源码取快照，不执行求值；普通运行表达式及表达式编辑仍为 unknown。未安装 guard 的默认行为仍属原生。Vendor 修改记录见 [vendor/README](../../vendor/README.md)。 |
| [Gateway](../api/gateway/src/index.ts)、[Connection](../client/connection/src/rpc-host.ts) | [pe-cloud-access Peers](pe-cloud-access/src/peers.ts) 绑定认证和转发。既有 HTTP bridge 提供可选同步响应检查，供 Cloud 在响应头前复核并保留响应体清理未知的责任；省略时保留原生行为。共用原 mux、iterator/Peer 完成及可选完整帧预算，不复制流引擎。 |
| [Workspace metadata](../workspace/workspace/src/metadata.ts)、[Attachment store](../attachment/attachment-local/src/file-store.ts) | [pe-cloud-files](pe-cloud-files/README.zh.md) 与 [account attachments](pe-cloud-runtime/src/account-attachments.ts) 提供实际项目、存储授权。原存储及关闭、发布结果仍为权威。原容量错误码可跨 attachment 安装识别，并经 Native 图片读取器原样传递而不附转换建议；本地清理与发布子类保留自己的未知结算标记，不增加通用的“已结算”断言。 |
| [Shell](../shell/shell/src/index.ts)、[Fs](../fs/fs/src/index.ts)、[Subprocess](../subprocess/subprocess/src/index.ts) | [pe-opensandbox providers](pe-opensandbox/src/native-providers.ts) 将原 Shell/Fs/Subprocess 消费接口接到同一 Session 环境，并拥有执行槽位。单有路径不能授权访问；释放未知不能归还槽位。 |
| [技能来源](../skill/skill-filesystem/src/source.ts)、[原生提供方](../skill/skill-filesystem/src/index.ts) | [旧样例](pe-cloud-api/src/skill-source.ts)与[完整包](pe-cloud-api/src/managed-skill-source.ts)技能来源借用文件所有者的不可变快照，供 Native 发现与解析。原账号、Agent、项目检查和完整资源物化仍归 Cloud。可选只读来源要求隔离根目录且没有宿主监视或回退，私有来源路径不成为公开指引。加载在完整物化期间保持同一个借用，保留取消、原始失败及未解决的释放责任。 |
| [Instruction injection](pe-account-instructions/src/session.ts) | pe-account-instructions 预留 files 拥有的有界读取，提供原生回合快照，不建立另一套 prompt 或 Session 历史。 |
| [系统提示词组装](../core/system-prompt/src/index.ts) | 可选的作用域 `system-prompt/prepare` waterfall 在读取任何提供方之前等待。Cloud MCP 在真实 Agent 的首个工具快照前恢复原客户端；非 Agent 检查不触发恢复。没有监听器时保留原生提供方收集与输出。 |
| [启动器关闭参与](../boot/cmdline/src/index.ts)、[profile 启动](../../apps/cli/src/profile-boot.ts) | 可选 `appShutdown` 能力在 Fiber 处置前等待实际 Cloud Root 缓存的 `close()`。关闭失败跨提前卸载继续保留。既有 CLI 负责期限、信号及退出码，接收其已有的显式关闭预算，关闭失败后仍释放代理；Cloud 保留清理和隔离责任。仅有诊断日志不会使关闭失败。 |
| [目标及自动续轮](../goal/goal/README.zh.md)、[续轮驱动](../goal/goal-round-driver/README.zh.md) | [账号组装](pe-cloud-runtime/src/account-native-integration.ts) 在账号目标所有者下安装原驱动。目标状态、收件箱准入及续轮策略仍归 Native。[Cloud 事件注销](pe-cloud-api/README.zh.md) 在账号关闭时等待原 Gateway 所有者。 |
| [MCP 客户端](../mcp/mcp-client/src/index.ts)、[连接监督器](../mcp/mcp-client/src/connection.ts) | 可选的程序化生命周期观察口将原生监督器的传输关闭确认和确切拥有的公开工具名交给 Cloud MCP 管理；保存连接 id 选择该原实例，用于计数、恢复资格和隔离探测结果。未知关闭在重试后仍为未知，宿主保留该连接责任并拒绝替换。未提供观察口时保留原生插件销毁和诊断行为。严格模式的首次失败在确认关闭后交给就绪调用方，监督器不重试或记录该失败；无法确认关闭和已建立连接丢失仍保留原诊断。可选 `maxIncomingResponseBytes` 通过 SDK fetch 注入口，在 JSON/SSE 解析前限制解码后的 HTTP 响应，并由同一监督器代际等待实际 reader 结束。`listMaxPages` 选择既有 SDK 分页上限。省略这些选项保持原生默认行为。 |
| [Cordis service lifecycle](../../vendor/cordis/src/fiber.ts) | [Cloud 页面清理](pe-cloud-client/src/client/page-lifetime.ts)使用原生销毁。状态通知只跳过已被前一个同步通知撤销的服务记录，保留原 owner 检查和清理失败结果。通用修复记录见 [vendor/README](../../vendor/README.md)。 |
| [Client persistence](../client/store/src/index.ts)、[Web entry](../client/web/src/boot.ts) | [pe-cloud-client lifetime](pe-cloud-client/src/client/page-lifetime.ts) 在激活前提供账号、代际绑定的端口，在清理前撤销。复用原生 UI 和模块生命周期。 |
| [运行状态](../client/ui-chat/src/client/chat/RunningStatus.tsx)、[Flow](../client/ui-chat/src/client/chat/ChatFlow.tsx) | [Cloud 品牌](pe-cloud-client/src/client/branding.tsx) 通过两个 inline root chain 供应闪电和八语文案。Native 保留原鲸尾／文案回退及计时、暂停、holding 和静态无障碍播报；原图片和样式不变。旧无消费者 fork 通知回调及词典键恢复目标原生。 |
| [终端设置](../client/ui-settings-shell/src/client/index.ts) | [受管终端](pe-cloud-client/src/client/management/plugins/managed-terminal.tsx) 通过有作用域的原生渲染服务复用 Shell 卡片，三个只读限制值来自当前账户的实际 Shell 执行器；本地原生表单行为保持不变。 原生只接可选超时值及渲染时文案回调；八种语言的业务文案归 Cloud。 |
| [工作区操作](../client/ui-workspace/src/client/index.ts) | 可选删除限制仅提供显示回调，沿原生菜单与确认框禁用。[准备好的 Cloud 页面](pe-cloud-client/src/client/prepared-page.ts) 通过自有八语词典及原 root 的当前 locale 求值；限制跨 Cloud 条目撤回持续到原生图关闭。不提供时保持原生删除行为，服务器授权不变。旧行菜单通用失败额外通知恢复原生静默，保原分支 Promise 与不自动重试。 |
| [Agent 预设选择](../preset/agent-preset-registry/src/index.ts)、[原生客户端列表](../client/ui-agent-preset/src/client/settings-store.ts) | [Cloud 预设准入](pe-cloud-api/src/native-presets.ts) 继承原生注册表。默认无操作的选择回调允许在原生队列内及选择记录提交前执行精确账户检查；原生 UI、四种声明及 Settings 默认值选择均沿用原生。选择在原生 FIFO 内使用原有 Agent 维护操作，排队消息须等待重新组合及选择记录结算后才开始执行。 |
| [Web bootstrap](../../apps/web/src/cloud-web.ts) | 该模块加载前入口归 pe-cloud-client 集成负责，但保留为明确的应用补丁。迁入动态 client 入口需要另一条静态、动态构建路径；在原生提供等价 pre-boot 集成前保留当前启动方式。 |
| [Frontend](pe-cloud-access/src/frontend.ts)、[field policy](pe-cloud-api/src/ordinary-config-policy.ts) | Cloud 公开页路由和普通字段可编辑策略位于现有 Cloud 包。 工作区检查在该包 Root 入口之外允许精确的 `pe-cloud-access/frontend` 入口。原生 frontend 与 ConfigField 实现已恢复。Models 使用原生 onboarding；受保护的 Cloud 密钥使用独立手动集成。 |

Root 配方封印执行完整的原生计划校验。准入时，原计划以常量时间检查 Entry 和 Fiber 的变更版本及原有身份，并保留 provider 与健康状态审查；直接更新原生 Fiber 时，更新 waterfall 继续之前会撤销封印。Fiber 版本还会检测在 waterfall 前被拒绝的更新尝试。现有 `/account` 入口向 API 和执行插件提供两个提供记录读取函数。集中模块归属低层 account 编译面，沿其现有声明与打包产物发布，避免通过 runtime Host 编译面形成反向引用。Cloud 对规范 Fiber 身份、有效配置、提供方与隔离记录的读取集中于 [native-state](pe-cloud-runtime/src/native-state.ts)。API 和执行所有权检查使用目标原生提供记录，保留隔离重复项与等待卸载的记录，维持当前性、身份检查和有限访问上限。原 AgentRegistry 条目保留 create/resume 显式提供的可选创建者原对象，`isOwnedBy` 只观察该对象，不推断持久血缘或授予当前父级权限。目标工厂在原发布点记录该关系；SubagentManager 提供新建创建者或冷恢复实时根，仍持有原祖先关系和资源生命周期。同一原缓存 Agent teardown 在驱动、作用域、写句柄和注册表清理后消费既有清理观察接口。被放弃且未结算的 setup 或清理失败只报告一次 unknown，晚到 setup 不升级该结果；准备前失败没有回执。原 Cloud 容量预留仍由原所有者持有。原 SubagentRuntime 在提供方派发、冷重建和实际工厂/activation 发布点，通过 effect 作用域检查消费已有准入类型。Cloud 读取目标扁平 start 规格及实际管理器停止信号，保留原账户、Workspace、模型、preset 检查和容量。提供方登记身份区分同一对象撤回后重新登记。无贡献时不改变原生默认行为或驻留消息行为。版本检查本身不能证明配置或 ready 状态；它跟踪原生更新 API，不检测对可信 Host 内部对象的直接修改。

通用修复保留为原生补丁：UTF-8 与完整帧上限、取消和关闭结果、上传收据、宽度几何和激活判定。把这些引擎移到 Cloud 会重复原生功能。保留原归属测试，作为可单独向上游提交的修改评估。

Cloud 在 `pe-cloud-client` 持有 `workspaceFileManagement`、选择状态、文件／文件夹选择器、目录表单及操作文案。它使用原生标题列表、可选 Session 行 Factory 及原分栏刷新回调；Native 保留目录树与导航引擎。上传及建目录在派发前等待目录关闭确认。旧调用方传入 watch-FS 的补丁已撤回：Native 恢复使用服务自己的文件系统，Cloud 提供方仍明确拒绝目录监听。原生上传所有者将可选工作区目标与附件内容分别接收，并支持不保留对话回执的工作区专用流式上传；浏览器完成事件使不支持目录监听的 Cloud 后端也能刷新文件树。Connection 桥接器终止已取消的请求体读取，在销毁未读请求前刷出提前响应，然后等待原始销毁完成，不排空剩余请求体。Cloud 适配器在现有 Connection Fetch 注册入口提供流式附件响应，文件所有者通过带版本的原 staging 组件发布工作区文件；没有引入另一套上传、下载或账户文件系统所有者。

可选的 `conversation.hero.header` 位置默认保留原生空白会话欢迎内容；Cloud 以空占用者填充该位置。工作区选择、草稿身份与驻留输入框仍由原生实现拥有。

原生输入框在启动所选文件批次前，检查附件提供方投影的可接受图片类型。空列表保持内联图片入口关闭并显示本地化提示；Cloud 附件提供方发布空列表，与既有 prompt 及命令策略一致。原生提供方保留各自的可接受类型和文件入口。

Cloud 账户组合通过固定私有 runtime builtin 复用公开的 Native Cordis 检查注册表和第一方 Host provider，不激活动态插件 runner。Standard 委派消费原生模型选择设置服务并保留关闭的默认值；这些依赖不改变四个 Native 预设声明。

Native `FileSystem.supportsTextEdit` 声明提供方是否实现文本编辑；Cloud 提供方返回 false 时，Native ToolFS 即使在已有预设开启编辑的情况下也会省略 `edit`。现有提供方的默认值仍为 true。这只是能力声明：Cloud 尚未实现原子编辑，写入授权、版本检查和结算均保持不变。

Native `FileSystem.scopeRoot` 提供可选的调用者作用域发现元数据。Cloud 文件系统返回原受保护 Workspace target；原生 agent-instructions 在该边界停止项目标记发现，并保留失败语义。无界 Native provider 继续使用既有搜索，所有文件系统授权仍由原 provider 持有。

Native `FileSystem.listDirectory` 增加带完整性标记的 `FsDirectoryListing { entries, truncated }`，`listDir` 仍完整返回或失败。默认实现包装原提供方完整结果，保留 Local 和 SSH 行为。仅 Native WorkspaceFiles 列表消费该结果，将提供方截断与既有答案上限合并，沿用面板提示。Cloud 有界提供方要求 helper 真实报告 `directoryListingVersion: 1`，才准入整组内容能力；完整方法拒绝部分结果。本次不增加分页游标或跨请求保留的目录描述符。

Native 可选 `FileSystem.openDirectory` 为 `WorkspaceFiles.listPages` 提供 Provider 枚举。每次 credit 与页面交付都复核原 Peer／Entry／已持有 Use。同一上行流携带 close，实际 Native 清理与 slot 结算后才发关闭回执。Files face 只保留一页，原预览／下载先等回执与原流终端；关闭未知时阻止依赖动作。独立 helper 能力 `directoryPagingVersion: 1` 和显式配置保留旧 helper 及 Local／SSH 路径。

Native `skill-filesystem.includeDefaultUserRoots` 允许部署在启用默认根目录时排除默认用户技能根目录。默认值为 true，保持原生发现行为；显式设为 false 仍保留项目根目录和显式配置的根目录。当宿主用户根目录位于账号授权范围之外时，Cloud profile 需要显式设置该选项。

Native 内置技能提供方接收可选部署调用上限：`skill-office.invocation` 与 `skill-filesystem.bundledInvocation`。Cloud 可展示完整不可变包供检查和下载，同时在执行环境合格前关闭模型和用户调用。文件系统上限不会启用来源已关闭的调用入口，也不影响其他根目录；省略配置时保留 Native 行为。原技能消费者执行调用策略，包字节保持原样。

Gateway `inspectInvocation` 将既有严格/SRC 解析器作为只读 Host 检查供账户能力审核使用。它要求调用方 fiber 有效，不执行查找、授权或业务调用；普通分派保留全部原检查。

原生[文件发现](../fs/tool-fs-search/src/glob.ts)把六个 VCS 名称聚合为两条排除模式，保留目录剪枝及从 VCS 元数据目录本身或内部开始搜索时的排除行为。完整调用使用 9 个 argv 元素，显式指定路径时为 11 个，符合原有 16 元素 Cloud 命令上限。执行、输出收集和排序仍由 Native 拥有。

原生[主题设置](../client/ui-theme/README.zh.md)保留原调色板预览及设置写入路径。附加的通用保存反馈状态、文案及选择禁用政策已撤回；调色板预览不能证明 Host 已持久化。排序、拒绝、取消和未知结果仍归原设置所有者持有，Cloud 账号持久化继续绑定原页面。

Native Chat 保留原[装饰性运行指示器](../client/ui-chat/src/client/chat/RunningWhaleTail.tsx)，动态效果与无障碍行为由[Chat 包](../client/ui-chat/README.zh.md)定义。FileUploads Schema 在插件激活前规范化省略的配置；原回执/接收容量仍保持有限。

## 升级步骤

1. 修改前记录当前干净源码、实际部署、目标上游修订及可信配置。源码测试与旧运行版本是不同证据。
2. 查看 `git diff --stat <base> HEAD` 与职责表。Cloud 策略留在所属包。只有等价公开原生能力保留实际调用方、默认行为、授权、取消和结算时，才删除对应补丁。
3. 在工作区外执行 `git diff --binary --full-index <base> HEAD > /absolute/output/cloud-native.patch` 导出。若拆为 Cloud、原生 API、原生 client、原生 runtime 和配套补丁，各变更路径必须覆盖一次。在精确基线上用隔离 Git index 回放，并比较所得 tree 与 `HEAD^{tree}`；这只证明可重建，不证明兼容更新的上游。
4. 在目标上游的隔离 checkout 中审查冲突。不得用旧补丁强制覆盖已变化的提交点，不削弱 guard、不复制原生引擎，也不靠增加租户配额解决冲突。
5. 构建变更制品，执行对应原生默认行为及 Cloud 组合回归。配置修改覆盖 `packages/boot/config-editor/tests` 和 Cloud 已批准操作测试；浏览器修改还须执行所属 GUI、浏览器用例。检查跳过项并保留失败记录。
6. 准备有版本的产品并保留前版，随后正常停止、join 原应用，确认 owner、allocation 释放后再启动后继。实测登录、模型/Shell 执行、历史、文件预览下载及退出。不能把关闭的可选能力写为通过，也不能把隔离状态改成 ready。

删除原生补丁的条件是等价行为，不是减少文件数量。可选插件管理、预览、任意 SSH、主机故障接管和大文件验收各自需要运行证据；通过此维护流程不会启用这些能力。

原生 PTC 与终端 spawn 请求将已解析的本次沙箱策略传给远程 provider。本地 argv 包装仍由原生实现负责；Cloud provider 消费原始约束交接，并在同一操作上为已批准策略签名。

原生可选 `ProfileContext.entryAliases` 使受信启动期入口重命名在独立 boot/HMR 读取与原 ConfigEditor 中保持一致。Cloud 使用一个有界且显式选择的历史 `presets` 到 `agent-preset-registry` 别名，复用原受保护提供方；现有 profile 字节在显式原生保存前保持不变。普通原生 profile 不设别名。

原生附件暂存提供方仅在释放自有描述符和临时名称后，对发布前自有 I/O 暴露带阶段的存储容量错误。Cloud 通过原修改结算和原生收据映射保留这一精确失败，不从源错误、队列预留或文件系统预检推定容量。

独立账号插件通过 Runtime 原有的 `projectForSession` 回调复用 `CloudAccountApi.sessionProject(actualSession)`；缺少回调或当前业务准入时拒绝访问。该 Host 方法不创建 Session、Agent 或执行权限。

原生 SubprocessHandle 增加可选 `releaseCollected()`；Cloud 收集输出句柄将其转交给原有 ManagedCommandOperation.release()。消费者先复制输出。原有执行范围和 I/O 结算继续持有容量及未知清理责任，使同一原生科研工具可顺序执行工作流或 Git 命令，而无需将全部已结束输出保留到最终投影。

配置计划计算和原准备状态由 app-boot 持有，profile 在原 Loader 上安装检查器；框架仅保留检查入口、变更计数、异步预留与原生应用。直接[树命令](../../vendor/loader/src/config/tree.ts)在分配 id、修改列表、移动父节点/store 或写配置前先检查。Runtime 对规范 Fiber 身份、有效配置、提供方与隔离记录的读取集中于 [native-state](pe-cloud-runtime/src/native-state.ts)，原取消、关闭和结果未知责任不变。

原 Session Controller 在 Service 初始化时将嵌入方准备、模型检查及有限控制缓冲接到既有 Agent、Command 和 Control 所有者。[准备与结算规则](../api/session-controller/README.zh.md)保留 Native 默认行为、受保护工厂与 SessionPreparation、原回执及未知结果。Cloud 提供既有账号策略，仅暴露已审核方法；不新增 Session 存储、迁移或运行时所有者。

原 Host Schedule 运行时接收一次可选的初始化前投递准入，输入为已存任务及其显式目标和回执。准备阶段异步等待后、预留、创建 Session、恢复唤醒及入队前复查。已接受消息仍由原链路完成 flush 和回执。就绪重扫与空闲观察复用同一运行时、修改 FIFO、通知及执行槽；原生默认行为、保留限制、间隔及未知写入不变。Cloud 目标授权由其适配器另行提供。

同一 Schedule 管理 FIFO 提供 `prepareMutation(before, after, actorSessionId)`，供嵌入方根据实际已存行与拟写行检查准入。其同步复查在异步准备完成后、每次原 put/delete 或批量删除开始前执行。拒绝检查不启动写入或变更通知；已接受写入保留原结算及未知结果。

Plugin Manager 在原 profile 写入流程周围保留一个可选保存提交钩子及一个选择检查器。entry 与 bundle 选择准备实际 profile 组合，检查原生计划和发布结果归属，并保留原生应用、重启、诊断及未知结果所有权。受控预览不持久化或激活条目；不安装钩子的原生调用者保留既有行为。

Agent 预设选择在原 Agent 队列和维护操作中、追加已提交选择前复查可选嵌入方准入。账户策略读取所属注册表带类型的 `presetForSession()`，不按字符串投影键读取。原生 ZIP 导出注册保留原 Fetch 响应、ZIP 流和清理；嵌入方可以在任何读取前授权实际解析的 Session，并提供结算前持续使用的取消信号。原生挂载保留独立的 Markdown 路由。

公共兜底所有者通过 resource 模块复用原生静态 Request/Response 响应器。WebServer 将明确公共注入行与需要 Peer 的首页来源及原始 tap 分开渲染，原生认证渲染不变。Client Modules 可以明确声明浏览器包，而不激活其 Host 入口，继续检查当前产物修订并沿原图撤回；仅模块声明在浏览器端也保持未激活。

只读导出与表格转换保留原 Native 默认。日志下载仅保原认证 HEAD 与可选导航绑定口，手动下载链接/临时 DOM 挂接等通用增强已撤；浏览器接管并不证明实际保存完成。CSV 双 BOM 及合成尾行通用修复已撤，只读预览不修改原文件字节；Cloud 文件提供方、限额及实际下载绑定保持原有所有者。

附加的 `skills/change` 订阅、共享 API 事件选择、既有受准入约束的账号发送者及原依赖生命周期归 Cloud 持有；Native 事件转发文件恢复默认。Native ui-skill 仅通过 `uiSkillCatalog.invalidate()` 显式控制原缓存；嵌入方未调用时，Native 预设／插件管理／连接重置行为不变。目录读取、取消、Session 引用和 RPC 实际结束仍由原 Native 引擎持有。

Cloud 持有原有提供方受限时的完整字节预览政策及有界分段；Native 仅增加可选 `DocumentPreviewByteReader` 回调和 renderer 标识数据，省略时保留原单次 Remote 读取及完整文件缓存。每窗口的原账号授权、版本／路径／大小一致性和真实待处理 RPC 结束仍须满足，解析器、Session、tab 与 store 所有权不变。

Native 默认保留原生成方法 `install` 的名称冲突检查；可选 `ClientRemoteMethodCompatibility` 回调仅让嵌入方显式选择确切 namespace，不替换命名空间引擎。Cloud 在挂载原生成贡献前只提供已有 `cloudSkills` 选择；Service／原型冲突、原 codec 与 Connection 分派、挂载生命周期及 Host 授权保持不变。

模型密钥呈现已归 Cloud：原七条八语动作文案留在 Cloud 自有贡献，仅本地化拒绝回调和显式提供商布局值进入 Native。Native locale 精确恢复固定目标。无嵌入方的设置编辑器恢复未知写入后原手动重试，显式已准备凭据与仅目录模式保留捕获意图的阻止重复写入。可选密钥动作准备、可取消意图与对话框亦已迁 Cloud。Native 只经可选 root 插槽派发原行 JSON 和展平回调，并以 Native 持有的 operations／schema／locale 将原编辑器注册为 Factory。Cloud 使用此框架 Factory，不复制编辑器、Remote 引擎或凭据存储；缺少贡献时保持 Native 默认。原 UI 目的迁至 Cloud 拥有的测试，通过真实已声明 Native 父组件、SlotRegistry 和 Factory，保留捕获引用、只读、未知、取消、撤回及 HMR 核验。

完成回复的文件呈现归 Cloud。Native 在原 Markdown、mention、文件打开与菜单引擎上只保可选 JSON／select 绑定及原 closing／stream 守卫；原 Native 文件名 regex 和布尔产品开关撤回。Cloud 经原 root 贡献提供产物文件名选择与严格作用域 URI 展示选择。原24个未满足 URI 目的保留在改前基线，归 Cloud 拥有范围修复；Native 默认 DOM 与原图片／路径行为分别核验不变。回调不授予 Host 文件权限，也不证明实际部署页面。

Cloud 已批准插件字段的元组与密钥字典键脱敏策略归自有 `config-redaction`。Native redact 先恢复目标实现，再只重加公共结构类型与可选纯投影回调；省略回调保持原默认、secret role 原生先行。Cloud 对每个子项复用原 walker，不复制遍历引擎。Native schema 文件精确恢复固定目标；Cloud 受保护字段原本就不序列化其 schema/default/value，原真实 ESM 隐私断言继续负责该效果。

非空 Cloud Root 的具体保存阻断保留一项有明确目的的原生修正：重组把实际不可变根行交给原补丁编译器，与受检计划一致。原首次更新探针只发现 config 载体差异，没有重复调用或根键差异；回归归原 Settings 和真实 ESM 插件控制保存目的负责。不放宽原生载体或身份检查，不授权重试任何未知正式事务；其余通用修复仍各自需要具体案例。
