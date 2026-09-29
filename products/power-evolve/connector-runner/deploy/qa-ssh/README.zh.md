# 一次性 k3d SSH 验收检查

[English](README.md) | 中文

`run.mjs` 在明确指定的本地 k3d 集群中创建随机的 `pe-connector-qa-*` 命名空间。它使用现有脚本签发仅限该命名空间的 Platform kubeconfig，导入指定的 Connector Runner 镜像，并启动 SSH 目标和独立的禁止访问监听器。SSH 目标使用镜像内固定版本的 `ssh2`，只接受随机生成的 `qa` 用户密码；唯一可执行的命令 `qa:ping` 返回 `qa:ssh-ok`。它在 Canary 提前断开时仍会保持运行。主机密钥、密码和 kubeconfig 保存在仓库外的 0700 私有目录中。默认情况下，脚本在成功或失败后删除此目录及命名空间。

从仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-qa
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-ssh/run.mjs
```

集群必须提供 `gvisor` RuntimeClass 并执行 NetworkPolicy。脚本拒绝使用已有命名空间；管理员操作使用指定的集群上下文，Runner 编排和监听器控制探针使用新签发的受限 kubeconfig。脚本还检查此 kubeconfig 无权管理 Deployment 或读取 Namespace。无凭据 Canary 检查 SSH 主机密钥且禁止访问监听器确认存活之后，脚本才发送密码。它先确认错误的固定指纹会在凭据派发前失败。管理员随后在实际受网络策略约束的 Runner Pod 内执行无凭据 TCP 探针，确认允许的 SSH 目标可以连接、禁止访问的监听器被拒绝，并再次通过独立控制探针确认该监听器存活。最后通过 `SshRunnerOrchestrator` 派发真实 SSH 命令，并只读核对执行结果。Runner 就绪要求连续三次连接被禁止访问监听器拒绝。

脚本不会打印密码、私钥、控制令牌、kubeconfig 或请求摘要。命令失败时不会转储 `kubectl` 的输入和输出。如果删除命名空间失败，脚本会打印随机命名空间名称，供人工检查和清理。不要将脚本用于正在使用的 Connector 命名空间。

独立浏览器试用可在运行 `run.mjs` 前将 `PE_SSH_TRIAL_PRIVATE_DIR` 设为 `~/.config/power-evolve/` 下新的绝对路径。相同的 Runner 检查通过后，脚本保留 SSH 目标、禁止访问监听器、受限 kubeconfig 和目录中的 `ssh.json`。准备试用时将 `PE_PRIVATE_DIR` 指向此目录并设置 `PE_SSH_ENABLED=1`；浏览器所需的测试密码保存在私有 `password` 文件。保留模式失败时会打印命名空间供检查，并且不会写入 `ssh.json`。停止试用后再删除该命名空间和私有目录。

独立原生试用启动后，设置 `PE_PRIVATE_DIR`、`PE_HOST_PORT`、`PE_PLATFORM_PORT` 和 `PE_KUBE_CONTEXT`，然后从仓库根目录运行 `node products/power-evolve/scripts/qa-ssh-browser.mjs`。脚本使用 Alice 和 Bob 两个独立浏览器上下文，核对密码直接上传和用户隔离，按新调用 ID 等待认证结果，验证刷新恢复、错误指纹和拒绝目标，并核对 PG 状态与 Runner 清理。重复运行会复用同名连接，但会创建新的检查调用。
