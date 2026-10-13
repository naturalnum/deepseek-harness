# PowerEvolve 云端迁移 M0 接口与迁入边界核查

2026-10-09，Asia/Shanghai。用户已确认按现有方案启动迁移，并授权代理作出后续常规技术决策。此记录固定目标接口及来源中的拆分要求，为[迁移方案](CLOUD-MIGRATION-PLAN.md)的 M0 提供输入；不表示产品 CI、完整迁移或运行验收已完成。

## 来源与目标

- 来源工作树为 `power-evolve/native-cloud-client`，HEAD 为 `4acb888058b3e5a95ec7d085ba75bcf2442d3636`。已有未提交修复、文档及旧试用保持原位置；九个原有源码变更的摘要见[来源记录](TRIAL-CLOUD-MIGRATION-BASELINE.md#未提交迁移来源)。
- 本次重新执行 `git ls-remote upstream refs/tags/dsh-v0.2.1-alpha.1 'refs/tags/dsh-v0.2.1-alpha.1^{}'`，官方标签仍解析为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。
- 目标接口取自该提交的五个 API 控制器源码，通过 TypeScript AST 读取 `@Remote` 方法，并核对构造器中显式的 wire namespace。服务名 `sessionController`、`settingsController` 和 `workspaceController` 不等于协议前缀；实际前缀为 `session`、`settings` 和 `workspace`。
- 来源接口取自 [native-remote.ts](application/src/host/native-remote.ts)的手写 dispatch。存在同名 case 只证明有处理分支，不能证明请求参数、返回字段、取消及事件顺序符合目标版。

## 原生接口核查

五个目标控制器共声明 51 个 Remote 方法，来源手写 carrier 中有 16 个同名 case，另有框架 `$events` 分支。其余 35 个方法未出现在该 dispatch；产品自有 HTTP／RPC 服务可能已有部分底层能力，迁移须完成原生入口接线和语义适配。此计数是静态核查结果，不是通过率。

| 目标拥有者 | 同名 case | 缺少的原生入口或需要核对的行为 |
| --- | --- | --- |
| [Session 控制器](../../packages/api/session-controller/src/index.ts) | 8／19：list、create、prompt、cancel、page、follow、projections、control | search、selectModel、initializeDefaultModel、modelCatalog、rename、fork、attachment、updateQueue；三个 Host 桌面操作另按下文的云端能力拒绝处理 |
| [Settings 控制器](../../packages/api/settings-controller/src/index.ts) | 1／5：describe | describe 当前返回空 namespaces；update、replace、mutate、openSettingsDocument 未接线；须区分个人设置与共享 Profile 权限 |
| [Workspace 控制器](../../packages/api/workspace-controller/src/index.ts) | 2／11：create、follow | initializeDefault、rename、delete、insertBefore、insertSessionBefore、archiveSession、unarchiveSession、pinSession、unpinSession；来源 baseline 始终返回空 archived／pinned 列表 |
| [Workspace Files](../../packages/api/workspace-files/src/index.ts) | 5／5：read、readBytes、stat、list、changes | 重验授权、目标返回字段、完整文件／range 预算、相对 baseFile、取消与 watch 生命周期；同名入口不能替代字节和浏览器验证 |
| [原生 Account 控制器](../../packages/api/account-controller/src/index.ts) | 0／11 | 核对官方模型账号的 getState、getProfile、getBalance、bonus、登录／退出和 watch 调用；它与 PowerEvolve 平台用户身份分别拥有状态，不得编造官方余额或登录事实 |

云端不提供 Host 本机打开文件能力。原生 `session/canOpenWorkspacePath` 需如实返回不可用，`session/workspacePathApplications` 不列出 Host 应用，直接调用 `session/openWorkspacePath` 由服务端明确拒绝；保留原生客户端的可用性显示，不增加产品桌面服务或隐藏官方页面。设置文档打开及 Profile 修改同样只允许其实际授权范围。

来源 `session/prompt` 仍接受产品 executionTarget hints，`session/create`、`workspace/create` 的参数也包含旧自定义编码。目标适配必须按固定官方类型验证，云端派发由 Platform 决定；不得继续接受 Device／本机执行选择，或把用户给定字符串解释为物理存储根。

## 三处界面的接入边界

| 区域 | 核查结果 | 迁移处理 |
| --- | --- | --- |
| MCP／SSH／STDIO | 来源[扩展中心](client-extension-center/src/client/index.ts)注册独立 Plugins 主面板及侧栏按钮；目标 [ui-plugin-manager](../../packages/client/ui-plugin-manager/src/client/slot-contract.ts)声明产品 bundle／row 配置插槽 | 迁入管理组件及业务请求，移除旧 Plugins 页面导航；M0 冻结实际 bundle／row ID，使用 `plugins.bundle.config` 或 `plugins.row.config`，不用 `plugins.item` 冒充官方插件 |
| Skills | 来源同一扩展中心注册独立 Skills 页及原生对话试用操作 | 保留已允许的 Skills 页；原生 Session／模型／输入接口适配后再验证试用、选定版本、ZIP 导入和晚响应 |
| 账号菜单 | 来源[账号插件](client-account/src/client/index.ts)已用 `settings.launcher`，但还注册产品 `settings.section` 与过期 overlay | 保留菜单入口，移除额外产品设置分区；修改密码、退出和失效处理必须核对允许的菜单流程及可信 Platform 权限，不扩大 DSH 壳内界面范围 |

官方包安装、共享 Profile 启停与个人连接启停使用不同授权。UI 是否展示按钮不构成权限检查；M4 必须验证服务端实际拒绝及管理员路径。

## 共享代码需要先拆分

源码已经把若干排除能力连接到纳入能力，不能只删目录或隐藏按钮。以下是已读到的具体依赖，不是按文件名推断的删除清单。

| 来源入口 | 当前耦合 | 纳入能力需要的处理 |
| --- | --- | --- |
| [Host](application/src/host/index.ts)与[Platform](application/src/platform/index.ts) | 同一入口注册工作区绑定恢复、旧产物、Device／Desktop、批量下载及纳入服务 | 按 18 项能力逐项组装路由、配置和依赖；排除功能的专用 RPC、服务、配置及测试不进入目标 |
| [FileService](application/src/platform/files.ts)与[原生工作区](application/src/platform/native-workspace-read.ts) | 文件服务创建 StorageBindingService；工作区创建调用其 attachInitial，目录读回依赖 bindingForId | 提取持久云工作区的归属、受保护路径及挂载元数据，保持文件／Git／Home 和写者停止要求；不迁旧个人目录绑定恢复工作流 |
| [Office 预览](application/src/platform/office-previews.ts) | 构造器依赖 ArtifactService，source snapshot 同时支持文件和旧产物 | 保留获授权云端文件／原生资源的隔离转换、缓存、取消和原执行对账；不为删除旧产物服务而删除 Word／PowerPoint 预览 |
| [下载协议](contracts/src/file-download.ts)与[下载服务](application/src/platform/file-downloads.ts) | 单文件和多文件 ZIP 共用 paths 数组、元数据与 URL | 迁入单文件下载所需的授权、路径和流预算；不保留批量选择及打包分支；已生成的 ZIP 文件仍可作为单文件下载 |
| [Scheduler](application/src/host/scheduler.ts)与[共享协议](application/src/contracts.ts) | Grant、来源事件及续接分支包含 desktop_result 等类型 | 只保留 Cloud、连接器、审批及其他纳入结果来源；保留原受理、日志、租约和一次续接语义，不把 Device 历史任务转换为 Cloud 执行 |

STDIO [管理 RPC](application/src/stdio-v2-management-rpc.ts)的所有管理调用先读取 `/stdio-v2/config`；来源真实 Platform 仍没有 enabled 对应 case。M4 必须补真实配置路由并通过 Host＋Platform＋PG 验证，不能靠管理 mock 或 disabled fallback 关闭该缺口。

## 数据范围与覆盖率约定

来源当前产品 Schema 为 37。其历史 DDL 和独立 schema 文件包含 Device、Desktop、旧产物及绑定恢复记录；本次只核查源码，未查询或修改运行数据库。目标数据清单、字段映射与输出 Schema 必须在迁移代码建立前由 M0 冻结，不能因为目标功能减少而直接用同一版本号改写既有库。

必须保留的持久事实包括纳入用户与账号审计、会话原始事件／受理输入／租约、云工作区与 Home 文件、技能版本和安装回执、Cloud／MCP／SSH／STDIO 的原动作和停止／结果／续接事实、Office 任务与缓存。含多个能力的表和 JSON 类型先按消费者分解；排除功能的原记录由旧版本及匹配备份保留。任何导入都先停止旧写者，验证归属、路径、字节和版本，并在独立目标启动验证。

覆盖率采用官方逐文件 100% 的标准，统计纳入的 TypeScript／JavaScript 运行时代码的行、语句、函数和分支。纯类型声明、生成内容、配置及第三方资产按其类别验证；涉及 worker／子进程的自有代码须收集对应执行证据，不能因为当前 runner 看不到就默认排除。文件集合由 [完整清单](scripts/cloud-corpus.json)和[当前 MCP／PDF 范围](scripts/cloud-scope-mcp-pdf.json)登记，源码入口合并 Vitest 与原生子进程的实际采集；混合模块仍验证整份文件，不使用行级忽略或较低阈值。空函数入口没有可执行语句时，仍须有函数 instrumentation 和实际调用，函数指标也须100%；全部 instrumentation 缺失的可执行源码保持拒绝。错误案例验证漏跑、缺失详细报告和阈值不足均被拒绝。Python 技能与外部转换器按其拥有者的实际执行／文件结果验证，不能从 TypeScript 覆盖率推定通过。

## 本轮交付的覆盖率例外

2026-10-12，用户确认先完成同版本真实业务验收、必要回归及独立审查和部署交付，将逐文件四项100%覆盖率不足作为后续质量事项。此例外只改变本轮发布阻塞条件：原312份当前运行文件的统计集合、行／语句／函数／分支100%阈值、采集与CI入口保留；不足时原检查仍返回FAILED，不删除文件、降低阈值、改写退出码或宣称检查全部通过。

集成者负责登记交付版本的实际报告、缺口文件、尚未验证的行为及后续负责人，员工3复核业务验收与例外适用范围。只有全部必测业务用例通过、所选文件与用例完整、同版本真实系统与恢复通过、其他必需工程检查及独立审查通过时，才能以“本轮迁移验收完成，覆盖率补齐后续推进”交付。行为FAIL、漏跑／必测skip、缺失源码执行或详细报告、账号／挂载隔离与恢复问题不能套用此例外。

已保存的N15完整基线为2,800项业务PASS，覆盖检查FAILED；312份runtime中108份四项100%、204份有缺口，整体行84.26%、语句80.09%、函数86.52%、分支76.12%。缺口的用途分组为主体／MCP／PDF及共享能力150份、旧数据转换35份、延期专项相关代码18份、Web构建脚本1份。此基线不是修改后版本的最终回归；新交付版本须运行并保存自己的完整业务及覆盖报告，聚焦新增测试不替代它。后续补测试与较重统计在独立环境及用户空闲时段进行，报告固定到具体代码版本。

## M0 来源核查时的待办（2026-10-09）

1. 用户已确认启动迁移；迁移分支和来源私有快照已建立。
2. 固定官方目标上的干净检查基线及产品专用入口设计；当前来源文档检查通过不是目标代码基线。
3. 原生入口的请求／返回／流语义映射，以及模型账号与产品用户身份的权限处理。
4. 18 项能力的目标文件闭包、产品 bundle／row ID、配置与上游补丁清单。
5. 纳入数据的完整字段映射、目标 Schema、兼容迁移与恢复场景。
6. 覆盖统计的完整文件集合、采集入口和具名例外，以及每个 F 编号的适用回归／真实验收出口。

本记录不能作为 M0 完成证据。来源差异已保全，隔离分支已建立；设计冻结与基线检查的现行状态见[集成进度](TRIAL-CLOUD-MIGRATION-STATUS.md)，实际实施按 M1—M5 推进。
