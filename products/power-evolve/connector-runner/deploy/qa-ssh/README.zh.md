# 一次性 k3d SSH 验收检查

[English](README.md) | 中文

`run.mjs` 在明确指定的本地 k3d 集群中创建随机的 `pe-connector-qa-*` 命名空间。它使用现有脚本签发仅限该命名空间的 Platform kubeconfig，导入指定的 Connector Runner 镜像，并启动 SSH 目标和独立的禁止访问监听器。SSH 目标使用镜像内固定版本的 `ssh2`，只接受随机生成的 `qa` 用户密码；唯一可执行的命令 `qa:ping` 返回 `qa:ssh-ok`。主机密钥、密码和 kubeconfig 保存在仓库外的 0700 私有目录中。脚本在成功或失败后删除此目录及命名空间。

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
