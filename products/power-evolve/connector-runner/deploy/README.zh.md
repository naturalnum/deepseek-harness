# 本地 k3d Connector Runner 准备

[English](README.md) | 中文

本流程为本地 k3d 集群准备[隔离的 Connector Runner](../README.zh.md)。平台使用独立的 `pe-connector-*` 命名空间，以及仅能在该命名空间管理 Pod、Service、Secret 和 NetworkPolicy 的私密 kubeconfig。平台不能管理 Agent Sandbox、Deployment、其他命名空间或禁止目标监听器；准备人员单独部署监听器。平台创建的 Runner Pod 只挂载每 Pod 独立的令牌 Secret 和内存临时卷，不挂载用户 Home 或 Workspace。这个命名空间须与可写 Sandbox 命名空间分开。

## 准备镜像和受限访问凭据

需要 Node 22.19+、pnpm 11、Docker、k3d 和 kubectl。所选集群需要可用的 `gvisor` RuntimeClass，并执行 NetworkPolicy。从仓库根目录明确设置以下值；选择新的专用命名空间和仓库外的私密目录：

```sh
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_NAMESPACE=pe-connector-local
export PE_CONNECTOR_PRIVATE_DIR="$HOME/.config/power-evolve/connector-runner"
export PE_CONNECTOR_KUBECONFIG="$PE_CONNECTOR_PRIVATE_DIR/connector-kubeconfig"
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-local
kubectl --context "$PE_KUBE_CONTEXT" get runtimeclass gvisor
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node products/power-evolve/scripts/prepare-connector-access.mjs
node products/power-evolve/connector-runner/deploy/prepare-forbidden-listener.mjs
```

默认情况下，镜像脚本先记录源锁文件和 Connector 清单，再构建包，并在仓库外创建临时的 `pnpm deploy --legacy --prod --ignore-scripts --frozen-lockfile` 产物，设置 `strict-dep-builds=true`。Legacy deploy 即使带有 frozen 标志也可能重新解析依赖。Docker 构建或 k3d 导入前，脚本要求源文件未变，且生产及可选依赖的锁元数据一致，包括依赖边、peer 与平台约束及完整性值。元数据缺失或漂移会拒绝准备。这个检查只比较锁元数据，不验证安装字节或运行架构。

校验通过后，脚本以这个产物和固定基础镜像的 Dockerfile 构建镜像，并导入指定集群。成功或准备、校验、构建、导入失败后，脚本都会清除临时产物。根工作区必须继续执行严格安装策略；`ssh2` 和 `cpu-features` 的安装脚本被禁止。

访问脚本只创建 `pe-connector-*` 命名空间，拒绝没有归属标签的已有命名空间，并在权限为 0700 的私密目录内以 0600 权限写入令牌 kubeconfig。它不修改平台配置。kubeconfig 是凭据，不得提交或显示其内容。

只构建镜像而不导入集群时，使用 `--build-only`。这个模式需要 Node 22.19+、pnpm 11、Docker，以及带标签的 `PE_CONNECTOR_IMAGE`；它不读取 `PE_K3D_CLUSTER`，也不调用 k3d。构建完成并清除临时产物后，脚本输出 `Built IMAGE`。镜像仓库传输和集群导入由单独的发布操作完成。

```sh
PE_CONNECTOR_IMAGE=pe-connector-runner:s6-local \
  node products/power-evolve/connector-runner/deploy/build-and-import.mjs --build-only
```

监听器脚本部署名为 `power-evolve-forbidden-listener` 的 gVisor Deployment 和 ClusterIP Service，等待就绪，再通过平台受限的 Service 代理检查 `/health`。它使用已导入镜像和固定的 Node HTTP 监听命令，不需要 Runner 令牌或 SSH 凭据。Connector 调用期间必须保持 Deployment 运行。重新创建 Service 后 ClusterIP 可能改变，配置平台前须重新读取。

## 验证权限并配置平台

执行以下检查，不输出令牌：

```sh
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create pods
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i list pods
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create networkpolicies.networking.k8s.io
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i get services/proxy
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create sandboxes.agents.x-k8s.io
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create deployments.apps
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i list secrets
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" get namespaces
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" get --raw "/api/v1/namespaces/$PE_CONNECTOR_NAMESPACE/services/http:power-evolve-forbidden-listener:8080/proxy/health"
kubectl --context "$PE_KUBE_CONTEXT" -n "$PE_CONNECTOR_NAMESPACE" get service power-evolve-forbidden-listener -o jsonpath='{.spec.clusterIP}'
```

前四项权限检查返回 `yes`，后三项返回 `no`，列举命名空间被拒绝。健康响应为 `{"healthy":true}`。平台 `SshRunnerConfig` 使用此 kubeconfig 路径、命名空间、镜像和 `runtimeClassName: 'gvisor'`，并将 `forbiddenProbe` 设为 Service 的 ClusterIP 和端口 8080。`proveForbiddenListener` 回调必须在准备和派发凭据前立即查询固定 Service 的代理，并要求健康响应。不得将探针 ClusterIP 加入 Runner 允许的出口目标。受限 Role 对 Pod、Service、Secret 和 NetworkPolicy 有 `get/create/delete` 权限，对 Pod 有 `list` 权限以在备份前确认执行已停止，对 `services/proxy` 有 `get/create` 权限；没有集群级授权或 Secret 列举权限。

Runner 需要连续三次被拒绝的 TCP 探测才能使 `/health` 就绪。平台能通过代理访问健康监听器，本身不能证明 Runner 出口隔离。在使用凭据前，需要从该命名空间内带相同标签且被策略选中的 Pod 验证允许目标可连接、活动的禁止监听器不可连接。如果禁止结果不明确，应停止派发凭据。只有固定监听器持续独立保持健康，且已验证集群的拒绝行为，才能设置 `CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL=1`。本地准备流程不启用 SSH 试用，也不连接外部目标。

## 删除一次性环境

对于仅为本流程创建的一次性命名空间，先停止平台使用对应 kubeconfig，再使用管理员 context 删除准确的命名空间，并删除其私密 kubeconfig 目录。删除命名空间也会删除监听器和受限 RBAC。不要对正在使用的 Connector 或 Sandbox 命名空间执行此操作。
