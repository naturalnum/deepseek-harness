---
description: "核对云端 API 的精确开放清单、绑定后的原生 Session 委派与实际模型调用准入。"
kind: "package-reference"
---
# @deepseek-ai/dsh-pe-cloud-api

[English](README.md) | 中文

## 概述

明确选择云端配方允许开放的原生 RPC、逻辑流、Fetch 路由和设置字段。未知操作保持关闭，原生清单变化会撤销先前审核。共享守卫在原生 Session 委派及实际模型调用前执行。runtime、项目和配置保存集成不完整时，账户挂载明确失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在部署方拥有的组合中挂载根入口；账户挂载需要完整的可信集成。

### When to choose it

需要执行经审核的云端开放规则，并保留原生 Session DTO 和业务操作时使用本包。认证、owner 选路、项目文件系统核验和账户就绪仍是前置条件。

### Minimal configuration

[已执行的 Loader 夹具](tests/fixtures/root.cordis.yml) 展示根配置；空清单不会开放操作。产品组合选择本包的 `/root` 和 `/account` 入口；必需集成缺失时，账户入口拒绝挂载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `recipeVersion` | 必填 | 经审核的精确配方标识。 |
| `rpcEndpoints` | 必填 | 精确一元端点、原生处理者和资源守卫声明。 |
| `streamEndpoints` | 必填 | 精确逻辑流声明。 |
| `exactFetchRoutes` | 必填 | 精确方法、路径、处理者和资源守卫声明。 |
| `allowedSettings` | 必填 | 精确 namespace 和实际变化的字段路径。 |

清单审核将配置声明与原生已挂载处理者比较。额外注册的原生入口保持关闭。根匹配只声明部署策略；每个账户还须核对当前 runtime 绑定、实际启用处理者和资源。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部机制 — 点击展开</summary>

根拥有不可变策略，并在其 fiber 销毁时撤销审核。[开放清单实现](src/exposure.ts) 使用精确映射，不解码路径或按前缀授权。[私有原生装配](src/native.ts) 注册公开 SessionController 的唯一子类，继承其 Config、DTO、Remote 标记及业务方法。Create、prompt 和 fork 等待共享项目/Preset 核验，并在调用原生 super 前立即复核准入。同步 cancel 检查实际附着 Agent 的既有 scope，随后保留原生取消或 notfound，不加载 Session。

私有[账户暴露视图](src/account-exposure.ts) 从根的冻结 manifest 中选择同配方子集。RPC 与流类别、Fetch 方法/路径、handler、guard 和 settings 字段必须对应根的精确声明。每图拥有自己的 inventory 审核和销毁失效；A 的审核或失效不改变 B 或根。审核及操作准入核验实际安装的精确 AccountBinding 与可信 graph/mount-current 回调，允许在 ready 前受限挂载时审核，拒绝过期或关闭的图。现有 ExposurePolicy 消费者可直接接收该视图，不增加 Loader 服务或全局账户注册表。

Page 和 follow 对普通 Session 地址等待共享项目守卫。Page 在原生读取前和返回结果前复核准入。Follow 要求已审核的流声明，并在每次推进原生迭代器前及交付结果前检查准入和取消。原生迭代器接收调用者与图生命周期的取消，继续独占历史、promotion 及清理责任。Subagent 历史地址在单独范围审核前继续拒绝。

Controller 准入使用实际安装的图 AccountBinding 及与实际 LLM 守卫共用的可信 business-ready 回调，独立于 HTTP/Peer AccountUse 生命周期。外部 AccountUse 也必须满足 business-ready；视图的 graph/mount-current 审核不能代替这一检查。装配须声明原生依赖、保留所属 fiber，并排除第二个基础 Controller。共享守卫失败、binding 过期、开放审核撤销或处理者停用都会阻止委派。原生进程内调用保留守卫抛出的错误；传输序列化遵循现有 Gateway 规则。原生业务结果与失败保持原义。

Controller 必须接收固定的 `NativeSessionGuards.projectDirectory` 能力，持有实际安装的精确 binding，并由可信 files 装配提供可等待的 `prepare(cwd)`。其原生 protected 覆盖在目录准备前后检查 binding、业务准入、已审核暴露和处理者可用性，关闭或被替换的图不能因迟到结果创建 Agent。能力使用既有有界 files lane，并独立核验批准项目；cwd 是输入，不是授权。S2 已有批准项目可在注册窗关闭后继续验证，新目录仍遵守 provider 原有批准要求。该适配不回退宿主 mkdir、不增加 files 池，也不重开注册窗。

工厂须提供真实 files/Workspace/Preset/模型守卫，包括不另建批准表的同步活跃 scope 核验。可信端口和生命周期要求完成集成前，账户入口保持关闭。

[私有 AgentLoop 工厂](src/native-agent-factory.ts) 检查同一实际安装的图绑定，在原生持久化创建或恢复写入 ownership 前，等待共享项目/模型/Preset 准入。它保留原 setup 及其同步 commit，在 setup 后及 commit 前后核验实际准备的 Agent。普通根 Session 允许省略委托深度或深度为零；parent/subagent/seeded 路径、启动 agents 及 direct AgentLoop.create 保持关闭。所属配方声明原生 AgentLoop 依赖，并排除第二个 loop。

原生持久化 append 可在 setup commit 与 registry 发布之间等待。调用者和图生命周期取消会传入原生事务；commit 后取消会在实际 append 结算后阻止后续发布。成功发布后的调用者取消继续保留原生 creation-only 含义，不取消已提交的 Agent。Runtime 必须在重配置及实际 teardown 中持续持有已准入工作；仅观察者被拒绝不能证明迟到的后端 ownership 已关闭。

[LLM 监听器](src/llm-guard.ts) 在原生流继续前检查账户代际及批准的 provider/model。它保留冻结请求。账户工厂必须提供与目录和模型选择共用的允许集。

Runtime 创建并持有一个[配置协调器](src/config-saves.ts)，显式限制全局/账户在途、排队、跟踪条目、嵌套工作和观察者数量。准入在调用原生 callback 前同步登记责任。同一账户的保存串行执行；必需嵌套写入归入当前操作，不排在自己后面等待。必需应用仍属于同一结果。

Pause 关闭顶层准入，但允许已登记工作完成；只有静止、无未解决失败的 pause 才能在 runtime 重新审核图后恢复。Stop 是终态。观察者取消或 deadline 到期返回 unknown，不释放实际工作或容量。失败和结果未知保留脱敏证据及跟踪容量；本包不自动清除失败。

[原生适配](src/native-save-hook.ts) 通过账户装配及同包测试使用的内部辅助函数，将公开原生 hook 接到同一屏障。`installNativeConfigSaveHook` 准入默认模型保存、Settings 写入及 legacy rename、直接 ConfigEditor 编辑；其他顶层 writer 标识被拒绝。旧的 `installNativeDefaultModelSaveHook` 保留较窄范围；每个编辑器只安装一种 hook。`installNativeCredentialSaveHook` 观察本地 provider 的 set、unset、modify-record 和 delete-record 操作，不留存地址或密钥值。原生返回值、失败、队列、必需发布及选模响应时序均保留。

两个安装器要求调用 Context 及其独立根持有与屏障完全相同的 binding，并在准入及排队后提交前复核。Runtime 必须保留每个 hook 的调用 fiber，直到终态确认静止；强制销毁 fiber 可以绕过显式 disposer 守卫撤回原生 hook。实际 Settings/editor 嵌套共用原生准入，跨服务嵌套工作仍登记到同一屏障操作。

私有[prepare 期安装](src/account-install.ts) 返回两个固定原生子类，在初始化前将 hook 绑定到实际 constructor receiver。因此本地凭据 provider 的初次扁平文档迁移及 Settings legacy 导入也被覆盖，无需复制原生队列或写入。Credentials 要求显式绝对路径及 watch=false。句柄持有实际安装的精确 binding 与根签发的屏障，暴露既有 pause/resume/stop 控制，暴露视图初始未审核。撤钩要求终态、无失败的实际结算，并等待真实原生 Loader 初始化；它不销毁账户 Context，也不释放根容量。

服务就绪后安装 hook 无法补记更早的初始化写入。Constructor 路径解决该本地迁移缺口，但 runtime 仍须在迟到结算期间保留 hook fiber 及初始化 ownership，在 resume 前重新审核，并在开放账户前提供真实图、存储授权及 I/O 预算。保存失败保留证据；观察者取消和强制 fiber 销毁不能证明 teardown 干净完成。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Runtime 输入](../pe-cloud-runtime/README.zh.md) — 账户身份与生命周期归属。
- [原生 Session API](../../api/session-controller/README.zh.md) — 命令、历史与流。
- [Gateway](../../api/gateway/README.zh.md) — 原生传输与 Peer 规则。
- [LLM](../../llm/llm/README.zh.md) — 实际流式调用。

-----

<a id="model-experience"></a>
## Model Experience

### Model-call admission

#### What the model sees

本包不添加提示词正文或工具 schema。`llm/stream` 监听器在原生 adapter 前核验 `provider` 和 `model`，被拒绝的调用不会进入 adapter。批准调用保留原生请求和会话历史。

#### Token effect

本包增加零请求 token。

#### KV Cache effect

守卫保留请求内容及可复用前缀；provider 缓存是否可用仍由 provider 负责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

必需集成缺失时，账户入口明确失败。

- 生产原生清单提取、传输选路、项目核验和绑定签发仍需集成；本包不发布 ready。策略测试证明视图隔离；独立的原生 Loader 测试检查真实公开 handler 元数据。安装测试使用显式 runtime 绑定及自有 Node 路径，不代表生产 owner 或存储授权。
- F06 对所有可达原生 writer 的提交覆盖及 runtime 装配仍不完整。协调器和已审核的原生适配不构成完整 F06 验收；账户入口中的模型选择和配置写入保持关闭。
- 其他凭据 provider、PluginManager 写入及技能发布/投影仍未覆盖。Watch 刷新和可选监听器工作保留原生语义，安装 hook 不代表它们已被核定为持久保存。
- F09 影响预检、受控提交、插件/key/技能修改及版本资源 hook 保持关闭。
- 原生 Profile 测试覆盖默认模型、Settings、直接 editor、本地 credentials、constructor 期迁移及迟到的启动/写入结算。实际私有 Controller 装配测试覆盖原生 Gateway 派发、创建、prompt、fork、同步 cancel 及恢复尝试的先后顺序。完整账户持久化恢复、认证 Web 及完整云端配方验收仍需集成；产品构建及这些检查由主控负责。
- 历史测试使用真实 JSONL 读取和冷 follow 恢复。私有 AgentLoop 适配守卫普通工厂激活，但生产装配及可信项目/模型/Preset 提供者尚未集成。其他激活及 child 路径仍待审核；账户装配继续关闭。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
