# 云端命令镜像

[English](README.md) | 中文

## 摘要

在持久 Workspace 和 Home 挂载中运行获授权的云端命令，Skill 包只读。已受理命令保留输出和状态，调用者可观察原执行而无需再次派发。Platform 拥有授权与 Kubernetes 资源身份。命令使用固定且不含凭据的环境；清理不确定时保留写者预留。文档工具需要独立核验镜像、字节与渲染。

## 目录

- [运行](#runtime)
- [工具链与构建](#toolchain-and-build)
- [验证](#verification)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="runtime"></a>
## 运行

<details>
<summary>命令受理与写者清理</summary>

认证 Runner 在私有镜像中作为 root PID1 运行；命令和目录子进程使用 UID/GID 1000。Platform 提供私有 token。Workspace 与 Home 挂载可写，Skill 挂载与镜像文件系统只读。

无凭据原生执行使用 UID/GID 1000。Linux 构建的 worker 文件和目录使用 0555 权限，进程可遍历 worker 目录，镜像仍保持只读。

`runner.mjs` 在 Runner token 下提供 health、命令受理、已受理状态及取消。请求绑定准确 Runner 实例、执行 ID、命令、相对 cwd 和超时。相同已受理输入只返回留存状态；同 ID 的不同输入冲突。`PE_RUNNER_MAX_EXECUTIONS` 配置回执留存上限，默认 4096、最大 65536；达到上限拒绝新 ID，不遗忘已受理回执。每条输出流最多保存 64 KiB，并解码跨块 UTF-8。此镜像不提供文件发布或产物观测。

`command-children.mjs` 向 `command-child.py` 发送有界 JSON，不传入模型或连接器凭据。目录授权使用 descriptor 遍历，只接受解析到工作区内部的链接。命令使用 Bash 和固定 PATH、HOME、USER、LANG。取消依次请求 TERM 和 KILL，并等待真实 child close。已知命令退出事实与写者清理分别保存。

Linux 清理在检查私有 PID namespace 前，核验 UID/GID 1000、root PID1 Runner 的准确命令行和父进程身份。它终止剩余 UID1000 写者，包括改变进程组的后代，并要求两次完整安静观测。本机或无法核验的 namespace 被拒绝。清理失败继续保留写者预留；关闭输出管道不能释放预留。不支持后台任务。

可选 STDIO v2 库与命令共享写者预留。`PE_RUNNER_STDIO_V2_CONFIG_FILE` 恰好提供 SDK 各项预算和完整响应预算；配置无效阻止启动，未设置则 STDIO 路由不可用。审批和当前写者授权仍由 Platform 拥有，详见[连接器 provider](../connector-runner/README.zh.md)。

</details>

-----

<a id="toolchain-and-build"></a>
## 工具链与构建

Dockerfile 用摘要固定 Node 基础镜像，用签名快照固定 Debian 包。`requirements-skills.lock` 固定 Python 包版本和分发摘要；OfficeCLI 固定版本及各架构 SHA-256。Dockerfile 选择 Git、Python、LibreOffice Writer／Calc／Impress／Math 与 UNO、Pandoc、Poppler、XeLaTeX／CTeX 和中文字体。命令 child 不继承镜像 ENV；需要 `OFFICECLI_SKIP_UPDATE=1` 时由命令显式设置。

[库构建配置](tsdown.config.ts)为镜像打包已准备的连接器库。[Dockerfile](Dockerfile)使用该产物和固定的工具链输入。镜像拥有者必须核验完整构建，并部署已审查的不可变 registry digest；本机镜像 ID 仅提供本机证据。[部署工具](../deploy/README.zh.md)拥有应用 Profile 启动与恢复。

-----

<a id="verification"></a>
## 验证

在非 root POSIX 账号运行 `node --test products/power-evolve/sandbox/tests/runner.test.mjs`。测试使用真实 HTTP、Python、Bash、文件及 child-close 事件，以本机 UID 替代生产 UID1000，验证命令字节、回执重放／冲突、输出边界、目录拒绝、取消和进程组清理。这不证明 Linux PID1 namespace 清理、gVisor、实际部署 Platform 授权或完整报告流程。`qa-skills-toolchain.sh` 在独立所有挂载中验证文档工具；产出须核对字节及渲染，不能只以退出码判定成功。


-----

<a id="further-exploration"></a>
## 进一步阅读

- [可信 Platform](../platform/README.zh.md) — 操作受理与归属明确的资源。
- [连接器 provider](../connector-runner/README.zh.md) — 可选 STDIO 执行。
- [已确认迁移范围](../CLOUD-MIGRATION-PLAN.md) — 当前验收要求。

-----

<a id="model-experience"></a>
## 模型体验

通过提交获授权命令并记录结果的应用工具间接影响模型。镜像提供有界执行输出；Host 与 Platform 拥有模型说明、原生事件和续接。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

执行与验证有以下限制：

- 不支持后台任务；清理不确定时保留写者预留。
- 本机 POSIX 测试不能证明生产 UID1000 隔离、Linux PID1 清理或 gVisor 限制。
- 镜像构建、文档渲染和同版本 Platform 集成需要各自的当前验收证据。
- 未配置 STDIO 时相应路由不可用；disabled 行为不能认证 enabled 执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

准确镜像身份、工具链结果和实际命令保存在私有构建证据与迁移记录中。本文不认证镜像或已部署执行环境。

</details>
