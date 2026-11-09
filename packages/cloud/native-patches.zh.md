# 原生集成维护

[English](native-patches.md) | 中文

本参考说明七个 Cloud 包与其消费的原生代码之间的职责，不增加运行组件。比较基线为 `master`，即本分支审查时采用的本地原生基线；这不代表它是最新上游版本。升级前须另外选定目标上游修订。

## 职责归属

Cloud 包负责账号身份、owner 路由、租户策略、存储准入、执行绑定和浏览器撤销。原生 DSH 负责 Agent/Session 状态、分发、配置应用、文件系统原语、Shell 消费接口和通用界面。原生回调在实际提交或释放点检查；HTTP 前置检查不能替代 await 之后的检查。

| 原生位置 | Cloud 消费者与保留的原生责任 |
|---|---|
| [Session Controller](../api/session-controller/src/index.ts)、[commands](../api/session-controller/src/commands.ts) | [pe-cloud-api/native](pe-cloud-api/src/native.ts) 提供项目、目录、prompt 文件和模型准入。创建、收据绑定和模型选择仍由原生负责。 |
| [AgentLoop](../core/agent-loop/src/index.ts)、[Subagent](../subagent/subagent/src/index.ts) | [pe-cloud-runtime integration](pe-cloud-runtime/src/account-native-integration.ts) 提供实际 graph、父 Agent 和项目准入。复用原生 Agent、回合执行和子 Agent 释放。 |
| [Settings Controller](../api/settings-controller/src/index.ts)、[Credentials](../credentials/credentials/src/index.ts) | [Native first screen](pe-cloud-api/src/native-first-screen.ts)、[save hook](pe-cloud-api/src/native-save-hook.ts) 和模型密钥策略，将授权保持到原写入及其真实失败。 |
| [Config impact](../boot/app-boot/src/config-impact.ts)、[ConfigEditor](../boot/config-editor/src/index.ts)、[PluginManager](../boot/plugin-manager/src/index.ts) | [Plugin control](pe-cloud-api/src/plugin-control.ts) 提供策略。原组合、预先判定的影响、持久化和 Loader 应用仍属原生；计划私有持有自己的准备状态。 |
| [Loader entries](../../vendor/loader/src/config/entry.ts)、[Loader](../../vendor/loader/src/index.ts)、[groups](../../vendor/loader/src/config/group.ts) | 原生编辑器与 Cloud 保存共用精确变更检查、条目版本和真实子更新结算。不变的声明条目对类型化表达式源码取快照，不执行求值；普通运行表达式及表达式编辑仍为 unknown。未安装 guard 的默认行为仍属原生。Vendor 修改记录见 [vendor/README](../../vendor/README.md)。 |
| [Gateway](../api/gateway/src/index.ts)、[Connection](../client/connection/src/rpc-host.ts) | [pe-cloud-access Peers](pe-cloud-access/src/peers.ts) 绑定认证和转发。既有 HTTP bridge 提供可选同步响应检查，供 Cloud 在响应头前复核并保留响应体清理未知的责任；省略时保留原生行为。共用原 mux、iterator/Peer 完成及可选完整帧预算，不复制流引擎。 |
| [Workspace metadata](../workspace/workspace/src/metadata.ts)、[Attachment store](../attachment/attachment-local/src/file-store.ts) | [pe-cloud-files](pe-cloud-files/README.zh.md) 与 [account attachments](pe-cloud-runtime/src/account-attachments.ts) 提供实际项目、存储授权。原存储及关闭、发布结果仍为权威。 |
| [Shell](../shell/shell/src/index.ts)、[Fs](../fs/fs/src/index.ts)、[Subprocess](../subprocess/subprocess/src/index.ts) | [pe-opensandbox providers](pe-opensandbox/src/native-providers.ts) 将原 Shell/Fs/Subprocess 消费接口接到同一 Session 环境，并拥有执行槽位。单有路径不能授权访问；释放未知不能归还槽位。 |
| [Instruction injection](pe-account-instructions/src/session.ts) | pe-account-instructions 预留 files 拥有的有界读取，提供原生回合快照，不建立另一套 prompt 或 Session 历史。 |
| [系统提示词组装](../core/system-prompt/src/index.ts) | 可选的作用域 `system-prompt/prepare` waterfall 在读取任何提供方之前等待。Cloud MCP 在真实 Agent 的首个工具快照前恢复原客户端；非 Agent 检查不触发恢复。没有监听器时保留原生提供方收集与输出。 |
| [启动器关闭参与](../boot/cmdline/src/index.ts) | 可选 `appShutdown` 能力在 Fiber 处置前等待实际 Cloud Root 缓存的 `close()`。关闭失败跨提前卸载继续保留。既有 CLI 负责期限、信号及退出码，Cloud 保留清理和隔离责任。仅有诊断日志不会使关闭失败。 |
| [目标及自动续轮](../goal/goal/README.zh.md)、[续轮驱动](../goal/goal-round-driver/README.zh.md) | [账号组装](pe-cloud-runtime/src/account-native-integration.ts) 在账号目标所有者下安装原驱动。目标状态、收件箱准入及续轮策略仍归 Native。[Cloud 事件注销](pe-cloud-api/README.zh.md) 在账号关闭时等待原 Gateway 所有者。 |
| [MCP 客户端](../mcp/mcp-client/src/index.ts)、[连接监督器](../mcp/mcp-client/src/connection.ts) | 可选的程序化生命周期观察口将原生监督器的传输关闭确认交给 Cloud MCP 管理。未知关闭在重试后仍为未知，宿主保留该连接责任并拒绝替换。未提供观察口时保留原生插件销毁和诊断行为。严格模式的首次失败在确认关闭后交给就绪调用方，监督器不重试或记录该失败；无法确认关闭和已建立连接丢失仍保留原诊断。可选 `maxIncomingResponseBytes` 通过 SDK fetch 注入口，在 JSON/SSE 解析前限制解码后的 HTTP 响应，并由同一监督器代际等待实际 reader 结束。`listMaxPages` 选择既有 SDK 分页上限。省略这些选项保持原生默认行为。 |
| [Cordis service lifecycle](../../vendor/cordis/src/fiber.ts) | [Cloud 页面清理](pe-cloud-client/src/client/page-lifetime.ts)使用原生销毁。状态通知只跳过已被前一个同步通知撤销的服务记录，保留原 owner 检查和清理失败结果。通用修复记录见 [vendor/README](../../vendor/README.md)。 |
| [Client persistence](../client/store/src/index.ts)、[Web entry](../client/web/src/boot.ts) | [pe-cloud-client lifetime](pe-cloud-client/src/client/page-lifetime.ts) 在激活前提供账号、代际绑定的端口，在清理前撤销。复用原生 UI 和模块生命周期。 |
| [终端设置](../client/ui-settings-shell/src/client/index.ts) | [受管终端](pe-cloud-client/src/client/management/plugins/managed-terminal.tsx) 通过有作用域的原生渲染服务复用 Shell 卡片，三个只读限制值来自当前账户的实际 Shell 执行器；本地原生表单行为保持不变。 |
| [工作区操作](../client/ui-workspace/src/client/index.ts) | 可选删除禁用原因沿用原生菜单和确认框。[准备好的 Cloud 页面](pe-cloud-client/src/client/prepared-page.ts) 提供该值，因为 Cloud 未开放工作区删除；未提供时保留原生行为。 |
| [Agent 预设选择](../preset/agent-preset-registry/src/index.ts)、[原生客户端列表](../client/ui-agent-preset/src/client/settings-store.ts) | [Cloud 预设准入](pe-cloud-api/src/native-presets.ts) 继承原生注册表。默认无操作的选择回调允许在原生队列内及选择记录提交前执行精确账户检查；原生 UI、四种声明及 Settings 默认值选择均沿用原生。选择在原生 FIFO 内使用原有 Agent 维护操作，排队消息须等待重新组合及选择记录结算后才开始执行。 |
| [Web bootstrap](../../apps/web/src/cloud-web.ts) | 该模块加载前入口归 pe-cloud-client 集成负责，但保留为明确的应用补丁。迁入动态 client 入口需要另一条静态、动态构建路径；在原生提供等价 pre-boot 集成前保留当前启动方式。 |
| [Frontend](pe-cloud-access/src/frontend.ts)、[field policy](pe-cloud-api/src/ordinary-config-policy.ts) | Cloud 公开页路由和普通字段可编辑策略位于现有 Cloud 包。 工作区检查在该包 Root 入口之外允许精确的 `pe-cloud-access/frontend` 入口。原生 frontend 与 ConfigField 实现已恢复。Models 使用原生 onboarding；受保护的 Cloud 密钥使用独立手动集成。 |

Root 配方封印执行完整的原生计划校验。准入时，原计划以常量时间检查 Entry 和 Fiber 的变更版本及原有身份，并保留 provider 与健康状态审查；直接更新原生 Fiber 时，更新 waterfall 继续之前会撤销封印。Fiber 版本还会检测在 waterfall 前被拒绝的更新尝试。版本检查本身不能证明配置或 ready 状态；它跟踪原生更新 API，不检测对可信 Host 内部对象的直接修改。

通用修复保留为原生补丁：UTF-8 与完整帧上限、取消和关闭结果、有界分段字节预览、[回答完成后的文件链接](../client/ui-primitives/README.zh.md#rendering-agent-output)、上传收据、配置脱敏、宽度几何和激活判定。把这些引擎移到 Cloud 会重复原生功能。保留原归属测试，作为可单独向上游提交的修改评估。

原生文件树接收预先准备的 `workspaceFileManagement` 接口；选择状态、系统文件选择器及可编辑目录节点仍由 `ui-sidebar-files` 管理。原生上传所有者将可选工作区目标与附件内容分别接收，并支持不保留对话回执的工作区专用流式上传；浏览器完成事件使不支持目录监听的 Cloud 后端也能刷新文件树。Connection 桥接器终止已取消的请求体读取，在销毁未读请求前刷出提前响应，然后等待原始销毁完成，不排空剩余请求体。Cloud 适配器在现有 Connection Fetch 注册入口提供流式附件响应，文件所有者通过带版本的原 staging 组件发布工作区文件；没有引入另一套上传、下载或账户文件系统所有者。

可选的 `conversation.hero.header` 位置默认保留原生空白会话欢迎内容；Cloud 以空占用者填充该位置。工作区选择、草稿身份与驻留输入框仍由原生实现拥有。

原生输入框在启动所选文件批次前，检查附件提供方投影的可接受图片类型。空列表保持内联图片入口关闭并显示本地化提示；Cloud 附件提供方发布空列表，与既有 prompt 及命令策略一致。原生提供方保留各自的可接受类型和文件入口。

Cloud 账户组合通过固定私有 runtime builtin 复用公开的 Native Cordis 检查注册表和第一方 Host provider，不激活动态插件 runner。Standard 委派消费原生模型选择设置服务并保留关闭的默认值；这些依赖不改变四个 Native 预设声明。

Native `FileSystem.supportsTextEdit` 声明提供方是否实现文本编辑；Cloud 提供方返回 false 时，Native ToolFS 即使在已有预设开启编辑的情况下也会省略 `edit`。现有提供方的默认值仍为 true。这只是能力声明：Cloud 尚未实现原子编辑，写入授权、版本检查和结算均保持不变。

Native `FileSystem.scopeRoot` 提供可选的调用者作用域发现元数据。Cloud 文件系统返回原受保护 Workspace target；原生 agent-instructions 在该边界停止项目标记发现，并保留失败语义。无界 Native provider 继续使用既有搜索，所有文件系统授权仍由原 provider 持有。

Native `skill-filesystem.includeDefaultUserRoots` 允许部署在启用默认根目录时排除默认用户技能根目录。默认值为 true，保持原生发现行为；显式设为 false 仍保留项目根目录和显式配置的根目录。当宿主用户根目录位于账号授权范围之外时，Cloud profile 需要显式设置该选项。

Native 内置技能提供方接收可选部署调用上限：`skill-office.invocation` 与 `skill-filesystem.bundledInvocation`。Cloud 可展示完整不可变包供检查和下载，同时在执行环境合格前关闭模型和用户调用。文件系统上限不会启用来源已关闭的调用入口，也不影响其他根目录；省略配置时保留 Native 行为。原技能消费者执行调用策略，包字节保持原样。

Gateway `inspectInvocation` 将既有严格/SRC 解析器作为只读 Host 检查供账户能力审核使用。它要求调用方 fiber 有效，不执行查找、授权或业务调用；普通分派保留全部原检查。

原生[文件发现](../fs/tool-fs-search/src/glob.ts)把六个 VCS 名称聚合为两条排除模式，保留目录剪枝及从 VCS 元数据目录本身或内部开始搜索时的排除行为。完整调用使用 9 个 argv 元素，显式指定路径时为 11 个，符合原有 16 元素 Cloud 命令上限。执行、输出收集和排序仍由 Native 拥有。

原生[主题设置](../client/ui-theme/README.zh.md)将原 Host 写入结果与调色板预览分开投影。外观行在加载、保存及写入结果未确认期间禁用选择；只有 Host 接受更改才显示已保存。当前共享布尔写入结果无法区分所有拒绝与结构化传输失败，因此 false 与 Promise 拒绝均保留为未确认且不重放。原生设置排序、持久化与取消行为不变；刷新仍可能取消尚未获得回执的写入。

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
