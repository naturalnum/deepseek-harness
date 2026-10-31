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
| [Loader entries](../../vendor/loader/src/config/entry.ts)、[Loader](../../vendor/loader/src/index.ts)、[groups](../../vendor/loader/src/config/group.ts) | 原生编辑器与 Cloud 保存共用精确变更检查、条目版本和真实子更新结算。未安装 guard 的默认行为仍属原生。Vendor 修改记录见 [vendor/README](../../vendor/README.md)。 |
| [Gateway](../api/gateway/src/index.ts)、[Connection](../client/connection/src/rpc-host.ts) | [pe-cloud-access Peers](pe-cloud-access/src/peers.ts) 绑定认证和转发。共用原 mux、iterator/Peer 完成及可选完整帧预算，不复制流引擎。 |
| [Workspace metadata](../workspace/workspace/src/metadata.ts)、[Attachment store](../attachment/attachment-local/src/file-store.ts) | [pe-cloud-files](pe-cloud-files/README.zh.md) 与 [account attachments](pe-cloud-runtime/src/account-attachments.ts) 提供实际项目、存储授权。原存储及关闭、发布结果仍为权威。 |
| [Shell](../shell/shell/src/index.ts)、[Fs](../fs/fs/src/index.ts)、[Subprocess](../subprocess/subprocess/src/index.ts) | [pe-opensandbox providers](pe-opensandbox/src/native-providers.ts) 将原 Shell/Fs/Subprocess 消费接口接到同一 Session 环境，并拥有执行槽位。单有路径不能授权访问；释放未知不能归还槽位。 |
| [Instruction injection](pe-account-instructions/src/session.ts) | pe-account-instructions 预留 files 拥有的有界读取，提供原生回合快照，不建立另一套 prompt 或 Session 历史。 |
| [Client persistence](../client/store/src/index.ts)、[Web entry](../client/web/src/boot.ts) | [pe-cloud-client lifetime](pe-cloud-client/src/client/page-lifetime.ts) 在激活前提供账号、代际绑定的端口，在清理前撤销。复用原生 UI 和模块生命周期。 |
| [Web bootstrap](../../apps/web/src/cloud-web.ts) | 该模块加载前入口归 pe-cloud-client 集成负责，但保留为明确的应用补丁。迁入动态 client 入口需要另一条静态、动态构建路径；在原生提供等价 pre-boot 集成前保留当前启动方式。 |
| [Frontend](pe-cloud-access/src/frontend.ts)、[field policy](pe-cloud-api/src/ordinary-config-policy.ts) | Cloud 公开页路由和普通字段可编辑策略位于现有 Cloud 包。原生 frontend 与 ConfigField 实现已恢复。Models 使用原生 onboarding；受保护的 Cloud 密钥使用独立手动集成。 |

通用修复保留为原生补丁：UTF-8 与完整帧上限、取消和关闭结果、CSV 分段字节预览、回答完成后的文件链接、上传收据、配置脱敏、宽度几何和激活判定。把这些引擎移到 Cloud 会重复原生功能。保留原归属测试，作为可单独向上游提交的修改评估。

## 升级步骤

1. 修改前记录当前干净源码、实际部署、目标上游修订及可信配置。源码测试与旧运行版本是不同证据。
2. 查看 `git diff --stat <base> HEAD` 与职责表。Cloud 策略留在所属包。只有等价公开原生能力保留实际调用方、默认行为、授权、取消和结算时，才删除对应补丁。
3. 在工作区外执行 `git diff --binary --full-index <base> HEAD > /absolute/output/cloud-native.patch` 导出。若拆为 Cloud、原生 API、原生 client、原生 runtime 和配套补丁，各变更路径必须覆盖一次。在精确基线上用隔离 Git index 回放，并比较所得 tree 与 `HEAD^{tree}`；这只证明可重建，不证明兼容更新的上游。
4. 在目标上游的隔离 checkout 中审查冲突。不得用旧补丁强制覆盖已变化的提交点，不削弱 guard、不复制原生引擎，也不靠增加租户配额解决冲突。
5. 构建变更制品，执行对应原生默认行为及 Cloud 组合回归。配置修改覆盖 `packages/boot/config-editor/tests` 和 Cloud 已批准操作测试；浏览器修改还须执行所属 GUI、浏览器用例。检查跳过项并保留失败记录。
6. 准备有版本的产品并保留前版，随后正常停止、join 原应用，确认 owner、allocation 释放后再启动后继。实测登录、模型/Shell 执行、历史、文件预览下载及退出。不能把关闭的可选能力写为通过，也不能把隔离状态改成 ready。

删除原生补丁的条件是等价行为，不是减少文件数量。可选插件管理、预览、任意 SSH、主机故障接管和大文件验收各自需要运行证据；通过此维护流程不会启用这些能力。
