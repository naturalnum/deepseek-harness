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

SSH 失败保留 `state:'failed'` 和 `errorCode`，并包含 `effectMayHaveOccurred`。Runner 尝试 `exec` 前为 `false`，包括认证与指纹失败；调用 `exec` 时变为 `true`。此后的断开、超时、取消和输出超限始终保留 `true`；未分类的执行异常也保守返回 `true`。命令通道关闭时，若未观察到退出码或非空退出信号，则以 `ssh_exit_missing` 失败。GET 与重复 POST 返回相同的已记录效果位。对于执行调用，效果位为 `true` 或旧 Runner 缺少该字段时，平台必须将命令结果视为不确定。STDIO 响应保持现有结构。

整个 HTTP JSON 正文上限为 256 KiB（`MAX_CALL_BODY_BYTES`），包括 JSON 转义；超过上限时在占用调用 ID 前返回 413。各 UTF-8 字段上限保持不变：命令 16 KiB、密码 4096 字节、私钥 7168 字节、私钥口令 1024 字节。SSH 标准输出与错误输出合计上限为 128 KiB，超时上限为 60 秒。STDIO MCP 文本上限为 8 KiB，超时上限为 30 秒。Runner 不提供文件传输、PTY、端口转发、本地 Shell 或任意进程型 MCP 命令；这些能力需分别审查和开发。


## 共享 STDIO SDK 调用器

`@power-evolve/connector-runner/stdio-v2` 导出 `runStdioV2(input, options, signal)`，供隔离的 Cloud 和 Device 执行器复用。它尚未接入此 Runner 的 HTTP API 或产品 Profile。共享 Host 不得执行它。执行器负责审批、不可变 Runner/程序 pin、目录授权、prepare/permit、持久请求身份、结果判定及容器/UID 清理。

独立的 Node 专用 `@power-evolve/connector-runner/stdio-v2-digest` 叶模块不启动进程。它使用共享浏览器安全编码器，以不同的 management／configuration／task／catalog／prepared／scope／spec／dispatch／result 域散列完整原始 JSON。完整有序目录指纹包含所有 schema、metadata 和扩展字段。审批 HMAC 使用平台已有的 32 字节密钥及独立域；执行器不接收该密钥。编码预算包含完整域 envelope。浏览器安全的 contracts 包不导入此叶模块或 SDK 调用器。原 legacy 请求摘要不变。

输入选择 `discover` 或 `call`，指定字面程序、参数数组及绝对 cwd。调用还提供冻结的完整原始目录、原始工具名和 JSON 参数。选项传入全部输入/消息/协议/JSON/分页/工具/目录/结果/stderr/运行/请求/清理预算、严格的 `HOME`/`PATH`/`LANG` 环境，以及验证完整原始目录并计算共享冻结摘要的同步回调。调用器不另造规范化摘要实现。macOS 中 Node 可能自行加入 `__CF_USER_TEXT_ENCODING` 编码提示；调用器不合并父环境。HOME 和 PATH 必须指向执行器批准的隔离位置。

公开 SDK2 Client 使用显式 `legacy` 协商模式执行一次 `initialize`（支持的 2025 年协议握手，与产品固定 `whoami` 路由无关）。公开 Transport 适配器以 `shell:false` 启动一个子进程，复用 SDK 公开的分帧及消息 schema helper，严格检查 UTF-8 JSONRPC 行并累计收发协议原始字节。不支持的协议直接失败，不启动兄弟进程、不重复 initialize、不重连、不重试。调用器通过 SDK 公开请求读取全部工具分页，核对完整目录后恰好发出一次 `tools/call`。原始 schema、annotations、metadata、content、structured content、`isError`、扩展字段及转义 NUL 保持 JSON。`readOnlyHint` 不授予批准；`isError:true` 仍是完成的 RPC，由外层判定工具结果。

程序启动本身可能产生效果。回复丢失、取消、目录改变或预算失败均保留保守的效果/调用事实，不发布截断的成功目录或结果。清理独立等待配置的 stdin、TERM 和 KILL 截止时间，记录真实直接子进程的 `exit` 和 `close` 事件。未观察到 close 时以 `cleanupConfirmed:false` 失败；SDK close 本身不能证明退出。即使确认直接子进程关闭，也不能证明后代、容器、writer 或其目录租约已经退休。外层 stop 协议必须提供这些证据，不得重放结果不明的调用。

在仓库根目录运行定向源码测试：`node --import tsx/esm --test products/power-evolve/connector-runner/tests/stdio-v2.test.ts`。测试使用真实 SDK2 Client 与测试独占的合成 Node 服务，覆盖分页、字面特殊参数、完整 JSON、目录变化、回复丢失、预算、abort、KILL 及后代持有管道。测试摘要回调替代后续共享目录验证器。这些测试仅验证调用器行为，不证明审批、Cloud/Device 接线或已部署产品流程通过。
