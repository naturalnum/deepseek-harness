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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Profile 状态与 Platform consumers</summary>

[cordis.patch.yml](cordis.patch.yml) 通过[应用适配](../application/README.zh.md) 替换本地 JSONL、provider 凭据和执行 providers。原生 base 与 Web bundles 拥有自身 Settings、tools 与 consumer 行为。原生设置和插件编辑保存完整账号私有 Profile，包括用户 patch、package 配置与 storage。Launcher 在 Runtime 代际之间保留该 Profile，同时每个 incarnation 拥有独立生命周期目录；恢复进程不会重放子会话提示。

Filesystem、subprocess 与 sandbox providers 捕获精确发起 Agent 的服务器签发 execution world。权限模式来自已提交的原生 Session events，后续模式 event 会使旧代际失效。原生 PTC node bootstrap 为执行镜像中的 `/opt/power-evolve/native-ptc-process.mjs`。Platform 控制物理执行 Pod；Runtime 没有 Kubernetes 或数据库凭据，也不挂载执行 Workspace。

原始 ToolRuntime 注册和当前已记录 request header 冻结每个 operation 的原生工具声明。MCP 与 STDIO 保留已接受 catalogs 和 schemas，与原生注册冲突时拒绝。原生 Search 保留原始 Messages 请求、持久化请求 event 与结果映射；Platform 固定其 endpoint 与凭据。原生 event callbacks 保留原始 Gateway 身份，PG 提供持久化 Session membership。

冷启动的原生命令和闲置 Terminal 获取独立、有界的交互 PG grant 与 Writer。它不记录 prompt 或模型输入，也不能调用模型。默认有效期为 15 分钟，每 8 秒检查续期；新的模型任务先关闭交互 owner。关闭时 drain 原生 Agent 与执行 clients，再释放原占用。撤销后，仅精确的原 operation 与 Writer 证明可关闭已提交日志；数据库 receipt 不证明物理进程已停止。Runtime claim 轮询终结已过期且无 owner 的派生任务，不重启 Agent 或重放命令。

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文</summary>

Runtime pool 拥有 Pod 与稳定用户 Profile；执行 provider 拥有独立 Workspace Pod。重建任一镜像时，保持两者 mount 与 credential 的独立所有权。

</details>
