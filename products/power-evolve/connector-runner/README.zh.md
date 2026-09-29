# 隔离的连接器 Runner

[English](README.md) | 中文

这个短时进程在独立 Kubernetes Pod 中执行一次经平台授权的 SSH 或固定只读 STDIO MCP 调用。它不挂载工作区、Home、技能，不持有数据库或 Kubernetes 凭据，也没有通用命令 HTTP 入口。平台保存持久状态并决定允许执行的准确命令；Runner 只在内存中保存有界结果。重启后 `instanceId` 改变，缺失调用的结果应标记为不确定，不能据此重放。

## 构建与部署

先运行 `pnpm --filter @power-evolve/connector-runner build`，再运行 `pnpm --filter @power-evolve/connector-runner deploy --legacy --prod --ignore-scripts /private/runner-image-context`。使用 `docker build -f products/power-evolve/connector-runner/Dockerfile /private/runner-image-context` 构建镜像。Dockerfile 只复制部署包，以 UID/GID 10001 启动。Pod 必须使用 gVisor、`runAsNonRoot`、只读根文件系统、去除 capabilities、不挂载 ServiceAccount 和用户卷；如需临时目录，应使用私有内存卷。每个 Pod 单独挂载 GID 10001 可读取的控制令牌文件；令牌值不得出现在环境变量或 Pod 描述中。

配置项为 `CONNECTOR_RUNNER_TOKEN_FILE`（默认 `/run/power-evolve/runner-token`）、`CONNECTOR_RUNNER_PORT`（默认 `8080`）、`CONNECTOR_RUNNER_ALLOWED_DESTINATIONS`（以逗号分隔的准确 `host:port`）、`CONNECTOR_RUNNER_FORBIDDEN_PROBE`（一个禁止访问的 `host:port`）。空白名单拒绝全部 SSH 目标；未设置禁止目标探针时 `/health` 保持未就绪。用户不得设置这些部署参数。SSH Pod 网络策略只允许访问获批准的目标及平台入口；STDIO Pod 只允许平台入口，禁止所有出口。

Runner 要求连续三次 TCP 禁止目标探测被拒绝才进入就绪；后续探测若连通或结果不明确，就撤回就绪状态。默认将 `ECONNREFUSED` 视为证据不足。只有平台已经从对照 Pod 独立连通这个固定探针服务，并持续确认其健康，才能设置 `CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL=1`。任意关闭端口返回的拒绝不能证明出口隔离。集群不能提供这种证据时，平台不得派发凭据。平台还需要在部署命名空间实测允许目标和禁止目标的连通性。

## 传输接口

每个请求携带 `x-power-evolve-runner-token`。`GET /health` 返回 `{ready,instanceId}`，就绪前为 503。`GET /calls/{callId}` 返回内存中的状态或 404，附带 `instanceId`，不返回凭据。SSH 的 `POST /calls` 严格接收 `{callId,instanceId,digest,kind,destination,timeoutMs,maxOutputBytes,...}`；`kind` 为 `ssh.inspect`、`ssh.authenticate` 或 `ssh.execute`。`destination` 包含 `host`、`port`、`username`；带凭据的调用还必须包含 `hostKeySha256`。认证和执行调用包含 `credential`（`{kind:'password',password}` 或 `{kind:'private_key',privateKey,passphrase?}`）；执行调用额外包含 `command`。检查主机密钥的调用拒绝凭据且不进行认证。服务器指纹不匹配时，不执行命令。

固定 STDIO 请求严格接收 `{kind:'mcp.stdio.whoami',callId,instanceId,digest,accountId,timeoutMs,maxOutputBytes}`。Runner 在 Pod 的 gVisor 隔离中启动镜像内置 MCP 服务，通过 SDK 的 STDIO 传输调用只读 `whoami`，仅返回有界文本。请求不能指定可执行文件、参数、环境、文件路径、URL、凭据或其他工具名。每次调用启动新进程；共享 DSH 宿主不启动该进程。

平台使用导出的 `requestDigest(unsignedCall, podToken)` 计算 `digest`。算法对不含 `digest` 的调用正文递归按键排序，再用 Pod 令牌计算 HMAC-SHA256；凭据正文也参与计算。返回的摘要不会成为离线猜测密码的公开校验值。同一 ID 和摘要返回已有状态；同一 ID 的不同摘要返回冲突。Runner 默认在生命周期中只接受一个不同的调用 ID。平台在 POST 前查询 GET；恢复时比较 Pod UID 和 `instanceId`，不自动重试结果不明的 SSH 写操作。每个 Pod 只执行一次批准调用，使用新令牌并设置短寿命。

SSH 命令输入上限为 16 KiB，标准输出与错误输出合计 128 KiB，超时上限为 60 秒。STDIO MCP 文本上限为 8 KiB，超时上限为 30 秒。Runner 不提供文件传输、PTY、端口转发、本地 Shell 或任意进程型 MCP 命令；这些能力需分别审查和开发。
