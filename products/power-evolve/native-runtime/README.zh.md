---
description: "在 Platform Session authority 上组合账号拥有的原生 Settings、预设与 Agent consumers。"
kind: package-bundle
---
# @power-evolve/native-runtime

[English](README.md) | 中文

## Summary

此 bundle 为单个账号提供维护中的原生 Settings、Profile 编辑器、权限命令与四种 Agent 预设。Platform pool 在该账号隔离的 Runtime Pod 内，将其挂载在 base 与 Web bundles 之后。原生 consumers 在有界 Platform 适配之上保留自身实现。PostgreSQL 拥有 Sessions、模型凭据和 execution grants；Runtime 只持有自身可撤销账号凭据与私有 Profile 状态。


## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

[部署 launcher](../deploy/README.zh.md) 拥有私有具名 Profile 与账号 Pod。它提供 `PE_RUNTIME_USER_ID`、`PE_RUNTIME_ID`、`PE_RUNTIME_TOKEN_FILE`、`PE_PLATFORM_INTERNAL_URL`、`PE_HOST_PUBLIC_ORIGIN`、`PE_PLATFORM_PUBLIC_ORIGIN` 和 `DSH_HOME`。Runtime 通过 Platform identity 读取当前账号模型；启动环境不包含模型 provider 或共享 worker 凭据。

端口 8080 提供 `/native/runtime/invoke`、`/native/runtime/ready`、`/health` 和 `/native/api/remote.mux`。一元与多路复用浏览器 carriers 要求 `x-power-evolve-browser-token` 中的原始 Browser Agent token，以及 `x-power-evolve-runner-token` 中本实例自身的 broker token。Health 与 ready 要求 broker token。每次 admission 重新检查 Platform 撤销、固定账号和代际；readiness 报告实际原生 service 与 preset 注册。

原生 Connection 与自身 Profile 凭据保持启用，使原生客户端图包含真实依赖和两个 PowerEvolve 客户端包。监听前的统一准入覆盖原始路由并拒绝旧 `/api` 运输；执行 RPC 继续经过 `/native/api`。共享 Host 将原始 `/plugins` 资源与 HMR 事件代理到 `/native/plugins`，使用独立 HttpOnly cookie 路径、Platform 同用户准入，以及有界并等待关闭的运输。慢 HMR 消费者重连后读取原始当前模块图。

Host 配置 `nativeClientMaxRequests` 与 Pool 配置 `clientMaxRequests` 默认最多受理 100 个请求，在途鉴权也计入。`nativeClientLifetimeMs` 与 `clientLifetimeMs` 默认 30 秒；原生 EventSource 会在这一有界运输代结束后重连。旧操作员 Pool JSON 使用这些经校验的默认值。

智能体团队、自动授权审查、开发者工具和语音输入仍显示在页面中，并提示当前部署不可用。此云端镜像未提供它们的运行组件。原生管理器拒绝启用相应组合包与组件，包括安装时自动启用，但允许关闭已有选择。终端、Agent 循环、子智能体、网页搜索和 MCP 配置保留原生行为。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Profile 状态与 Platform consumers</summary>

[cordis.patch.yml](cordis.patch.yml) 通过[应用适配](../application/README.zh.md) 替换本地 JSONL、provider 凭据和执行 providers。原生 base 与 Web bundles 拥有自身 Settings、tools 与 consumer 行为。原生设置和插件编辑保存完整账号私有 Profile，包括用户 patch、package 配置与 storage。Launcher 在 Runtime 代际之间保留该 Profile，同时每个 incarnation 拥有独立生命周期目录；恢复进程不会重放子会话提示。

原生 Models 页面编辑此账号由 Platform 持有的适配器设置和只写凭据引用。浏览器必须使用直接接收器；Runtime 只接收公开模型元数据和原生块。提供商注册从账号目录刷新，并保留原生重试策略；模型解析保留原生上下文、推理和图片计价行为。原生 `prepareCall()` 在 Platform 捕获当前账号的一份配置快照及其模型元数据与图片计价信息，分发时以原始操作 bearer 消费该不透明标识。原生块与重放状态保持不变。Session 与子 Agent 消费者使用各自冻结的提供商、模型和可选推理选择；新 Session 继承账号默认值。

Filesystem、subprocess 与 sandbox providers 捕获精确发起 Agent 的服务器签发 execution world。权限模式来自已提交的原生 Session events，后续模式 event 会使旧代际失效。原生 PTC node bootstrap 为执行镜像中的 `/opt/power-evolve/native-ptc-process.mjs`。Platform 控制物理执行 Pod；Runtime 没有 Kubernetes 或数据库凭据，也不挂载执行 Workspace。

原生指令配置提供方先于 standard、PTC 与 Cordis 预设激活。它保留维护版指令加载器及字节预算，以 `/home/agent/.dsh/AGENTS.md` 读取用户全局指令，并通过 `.` 标记将规范化 Session cwd `/workspace` 作为项目根。Workspace 发现不会探测执行世界外的祖先路径。Home 与 Workspace 指令保留原生持久指令 events；执行权限仍来自 Platform 与物理挂载。

原始 ToolRuntime 注册和当前已记录 request header 冻结每个 operation 的原生工具声明。MCP 与 STDIO 保留已接受 catalogs 和 schemas，与原生注册冲突时拒绝。原生 Search 保留原始 Messages 请求、持久化请求 event 与结果映射；Platform 固定其 endpoint 与凭据。原生 event callbacks 保留原始 Gateway 身份，PG 提供持久化 Session membership。

冷启动的原生命令和闲置 Terminal 获取独立、有界的交互 PG grant 与 Writer。它不记录 prompt 或模型输入，也不能调用模型。默认有效期为 15 分钟，每 8 秒检查续期；新的模型任务先关闭交互 owner。正常的精确结算在原 PG 事务中同时退休该 Operation 的交互 grant 和 Session lease，使已完成的 owner 归还有界交互容量。原 authority 明确结束的 409 触发精确 cleanup，而不使 Runtime 永久不可用。原 Agent、执行 clients 和 cleanup receipt 必须全部 settle，随后通过有界 journal reconciliation 解析已退休的 receipt，或放弃未物化的原请求。所有 32 条记录的批次共用一个 transport deadline。当前 operation 的 blocked 记录、混合错误、无效 cleanup ACK、Writer transport 失败和未确认的物理停止仍保留为 sticky 拒绝；完整证明到期收口后，同一 Runtime 代际可提供新的交互 Session。关闭时 drain 原生 Agent 与执行 clients，再释放原占用。撤销后，仅精确的原 operation 与 Writer 证明可关闭已提交日志；数据库 receipt 不证明物理进程已停止。Runtime claim 轮询终结已过期且无 owner 的派生任务，不重启 Agent 或重放命令。

未发布的 Agent setup 通过已获取的 Platform write handle 提交明确的新 append events。随后原生 factory 接受同一精确前缀而不重复写入；setup 不执行同步历史扫描。Runtime Sessions 与持久化提供缓存的 `shutdown()` 结果，保留 cleanup 失败。执行关闭拒绝提供方解析，并先等待每个 Agent 已接受的绑定读取，再清理保留的 binding。执行 binding 的显式 `close()` 在释放 Context 前 join 原始文件与进程 cleanup，因为 Cordis 会记录 effect 失败并让 fiber disposal fulfilled。Cleanup 失败使交互 admission 不再可用，并保留原失败供调用方观察。

原生子 grant 冻结父会话的权限模式与代际。父权限变化使子 grant 失效。子 Agent 可在首个 turn 前选择账号已授权的模型，并将 token 预算限制在父预算内；随后 Platform 冻结该选择用于模型出口。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [应用适配](../application/README.zh.md) — 原始 grants、持久化与 consumer 授权。
- [Host 层](../host/README.zh.md) — 外层浏览器路由。
- [部署生命周期](../deploy/README.zh.md) — 私有 Profile 所有权与进程生命周期。

-----

<a id="model-experience"></a>
## Model Experience

此层改变 consumer providers 与账号所有权。维护中的原生 preset 与 tool packages 拥有模型可见 schemas、prompts 和结果文本；此 bundle 不添加替代 Agent loop 或模型指令。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

源码与隔离 PG 检查不能证明物理 Linux 隔离或真实 PTY/PTC 执行。这些结果要求部署的执行镜像与原始原生 consumers。持久化交互 authority 之外，仍需验证 Runtime 装配与冷启动原生 consumers；Browser Agent cookie 本身不授予执行权限。

原生一元 RPC 使用维护中的 Gateway 结果编解码。有界私有 JSON 中转显式携带字节附件，共享 Host 恢复原生 multipart，使浏览器调用者收到 `Uint8Array`。PG 在 Session 水位保存已提交的权限旋钮折叠值，账户 Runtime 通过其当前原生预设目录与默认值展示，包括自定义名称和 Auto。浏览器不会收到私有旋钮元数据。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文</summary>

Runtime pool 拥有 Pod 与稳定用户 Profile；执行 provider 拥有独立 Workspace Pod。重建任一镜像时，保持两者 mount 与 credential 的独立所有权。

</details>
