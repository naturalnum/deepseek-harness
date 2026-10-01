# PowerEvolve S7d 部署候选配置

[English](README.md) | 中文

此目录渲染的是**候选配置**，不是已发布的生产部署。它将现有 DSH Host 和 Platform 组合包作为两个独立的 Deployment 运行，各有两个副本。Host 通过内部 Platform Service 发起服务端调用，并暴露自己的 HTTPS Origin；浏览器到 Platform 的调用使用另一个 HTTPS Origin。只有 Platform 获得 PostgreSQL 凭据、提供方凭据、共享 POSIX 卷和投射的 Kubernetes ServiceAccount 令牌。Sandbox Pod 在单独的命名空间运行，不带 ServiceAccount 令牌。

S7b 使用 `hostPath` 和静态 kubeconfig 的试用配置仍可使用。生产配置选择 PVC 和集群内轮换的 ServiceAccount 令牌。若执行配置同时指定节点路径和 PVC，或两者都未指定，Platform 会拒绝。每个 Sandbox 只挂载其会话 Workspace、所属用户的 Home，以及来自运行器命名空间 PVC 的该用户只读 Skill 包子目录。Platform 在使用前会对照 Sandbox 和实时 Pod 核验这些子路径。

## 构建与配置

使用干净的已提交修订版本。Docker 上下文中的归档不包含本地凭据、被忽略的构建输出和 `.git`。分别构建共用的 Host/Platform 镜像和现有运行器镜像，推送两者，然后在 `values.example.json` 的私有副本中使用它们的**镜像仓库摘要**引用。示例摘要和域名会有意使 `--ready` 检查失败。

```sh
git status --short
git archive HEAD | docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -f products/power-evolve/deploy/Dockerfile -t REGISTRY/power-evolve:REV -
git archive HEAD:products/power-evolve/sandbox | docker build -f Dockerfile -t REGISTRY/power-evolve-runner:REV -
docker push REGISTRY/power-evolve:REV
docker push REGISTRY/power-evolve-runner:REV
# Resolve each pushed reference to REGISTRY/name@sha256:<64-hex-digest>.
cp products/power-evolve/deploy/values.example.json /private/path/values.json
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/power-evolve.yaml
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/foundation.yaml foundation
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/workloads.yaml workloads
node products/power-evolve/deploy/preflight.mjs /private/path/values.json /private/path/power-evolve.yaml --context YOUR_CONTEXT
```

使用具有可信服务器证书的外部 PostgreSQL，并在连接 URL 中设置 `sslmode=verify-full`。在应用命名空间中创建 `secrets.shared` 和 `secrets.platform` 指定的 Secret；所需键如下：

| Secret | 键 | 使用者 |
| --- | --- | --- |
| shared | `worker-token` | Host 和 Platform |
| platform | `database-url`, `model-key`, `connector-key`, `runner-key`, `users.json`, `account-management.json` | 仅 Platform |
| TLS | `tls.crt`, `tls.key` | Ingress 控制器 |

`users.json` 沿用现有 Platform 种子用户格式。通过渲染产物以外的流程创建 Secret，且不要把凭据写进 shell 历史记录。两个副本及 Host、Platform 两层必须使用同一个 worker 令牌，并通过协调滚动更新来轮换。runner 密钥签发每个 Sandbox 的 runner 令牌，必须仅由 Platform 持有。

这种种子格式目前最多接受 100 个用户，每个 Platform 副本都会在启动时对这些种子密码进行哈希处理。它适用于分阶段试用；大规模发布还需要另行满足企业账户开通、撤销和身份提供方集成的发布条件。

该部署包声明两个静态 `ReadWriteMany` NFS PV，分别绑定各自命名空间中的 PVC，且都指向**同一服务器与导出路径**。管理员必须确保该导出允许 Platform 修改 POSIX 所有权，并从两台物理节点验证数据及文件权限。Platform 的 `sandboxLocalRoot` 和 `skillLibraryRoot` 均使用 `/data`；运行器的 PVC 仅通过精确的 `subPath` 挂载访问。如果 NFS 导出的 root squash 阻止 Platform 所需的 `chown`，则必须先另行配置所有权，否则该导出不可用。

Platform 的 `/health` 检查 PostgreSQL 并控制就绪状态；`/live` 不依赖 PostgreSQL，只检查服务进程并控制存活状态。数据库故障期间，Platform Pod 应从 Service endpoint 中移除，而不被重启。验证故障持续超过三个存活检查间隔时 `restartCount` 保持不变，然后确认 PostgreSQL 恢复后 Pod 再次就绪。

在 values 中设置真实的 Ingress 类、控制器 Pod 标签、公网 DNS 名称、TLS Secret 和出口 CIDR。`runnerProxySourceCidrs` 必须涵盖 Sandbox Pod 实际观察到的 Kubernetes API Service 代理流量源 IP。将 `apiServerCidrs` 和 `apiServerPort` 设为 CNI 实际匹配的 API 目标地址与端口。若 Service NAT 改变了目标，则应实测 endpoint 地址与端口；示例端口 443 可能不适用。默认拒绝的策略选中两个命名空间中的每个 Pod；Host、Platform 和运行器策略仅允许列明的流量。接入流量前，要验证 CNI 确实执行这些策略。

仅在隔离的命名空间中、审阅渲染后的 manifest 之后应用。部署包会创建命名空间范围的 ServiceAccount、运行器命名空间内的 Role 和 RoleBinding、两个 Deployment/Service、TLS Ingress 以及 NetworkPolicy；它不包含 Secret 值。先应用基础资源，再在新命名空间中配置所引用的 Secret、镜像仓库拉取 Secret（如已配置）和 TLS Secret。集群检查要求 PVC 已绑定且 RoleBinding 存在；应在应用工作负载或开放公网流量之前运行，检查只读。

静态预检会检查 Host 与 Platform 的 Pod 模板。主机网络、PID、IPC 以及共享进程命名空间标志只接受缺省或布尔值 false；Pod 安全上下文须与渲染器完全一致，包括 UID/GID、文件系统组及 seccomp 设置。运行时类、用户命名空间和操作系统选择也须与渲染器一致。既有 Secret 投影、PVC 挂载、ServiceAccount 与容器安全检查继续生效。这些检查验证所提供的 manifest；实际准入后的 Pod 与 CNI 执行效果须通过集群验收。

```sh
kubectl --context YOUR_CONTEXT apply -f /private/path/foundation.yaml
# Provision the named Secrets through your secret manager.
node products/power-evolve/deploy/preflight.mjs /private/path/values.json /private/path/power-evolve.yaml --context YOUR_CONTEXT --ready
kubectl --context YOUR_CONTEXT apply -f /private/path/workloads.yaml
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-platform
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-host
```

首次安装时，通过常规变更控制流程分阶段部署基础资源和工作负载，让 `--ready` 与物理检查在 Ingress 接纳流量之前完成。`--ready` 至少检查两个 Ready 节点、Sandbox CRD/控制器、gVisor RuntimeClass、Secret 键是否存在、TLS SAN、已绑定的 PVC，以及 RBAC 的允许和拒绝行为，包括明确指定 Service proxy 子资源的访问。预期的权限拒绝会通过，探测失败或未知回答会拒绝就绪。它有意不打印 Secret 值，只检查 PostgreSQL URL 形式和 TLS 证书。检查通过**不能**证明跨物理机器的 POSIX 一致性或 ingress 行为。

## 账号配置

`account-management.json` 包含 `maxUsers`、`models` 目录（`id`、`label`、`maxTokens`）及 `initialSettings`（`model`、`maxTokens`）。两个 Platform 副本读取相同的私有文件。Host 不获取此文件或管理员凭据。本机试用准备此文件，但不提升种子用户权限。

管理员初始化须显式启用：将 `accounts.bootstrap` 设为 `true`，并在 Platform Secret 中加入 `account-bootstrap.json`。已有数据库使用 `mode: "existing"`、准确的 `userId` 和 `username`；空数据库使用 `mode: "create"`，另外提供 `displayName` 和私有初始 `password`。初始化后可省略 bootstrap 或设为 `false`。文件内容不进入渲染的 manifest。启动与只读就绪检查共用账号解析器；数据库初始化及账号生命周期验收见[账号切片](../S3-ACCOUNT-COMPLETION.md)。

## 可选的远程 MCP

values 省略 `remoteMcp` 时不启用此功能。启用时提供 `secretName` 和 `destinations`；每个目标包含规范的 `origin`、准确的 IP 地址 `addresses`、可选的 `allowHttp: true` 和 `caKey`。使用 CA 时还须提供 `caConfigMapName`。Secret 必须不同于 Host 的共享 Secret。渲染器仅将各 origin 自身的 TCP 端口和获准 IP 加入 Platform 出口；Host 和运行器策略保持不变。

在该 Secret 中提供 `remote-mcp.json` 和 `remote-mcp-key`。JSON 沿用 [Platform 配置](../platform/remote-mcp.example.json)，并设置 `requireOriginException: true`，将 `credentialKeyFile` 设为 `/run/power-evolve/private/remote-mcp/credential-key`。`internalExceptions` 必须与 values 目标完全一致；CA 路径为 `/run/power-evolve/private/remote-mcp/ca/<caKey>`。在指定的 CA ConfigMap 中保存所引用的 PEM 项。只有 Platform 获得这些只读投影和固定配置路径；渲染后的 YAML 不含秘密字节。

Platform 启动时校验挂载材料和严格 origin 模式。只读 `--ready` 检查只获取指定的 MCP Secret 与 CA ConfigMap，使用运行时解析器校验内容，并与 values 权限核对。渲染及本机解析器测试不能证明实际 CNI 执行、Secret 挂载或目标连通；这些仍属于物理验收内容。

## 可选的进程连接器

省略 `connectorRunner` 或设为 `null`，保持默认关闭。启用已有的隔离 SSH 和固定 STDIO 传输时，加入：

```json
{
  "connectorRunner": {
    "namespace": "pe-production-connectors",
    "image": "registry.example.invalid/power-evolve-connector@sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "proxySourceCidrs": ["192.0.2.30/32"],
    "sshDestinations": [{ "ip": "198.51.100.30", "port": 2222 }]
  }
}
```

替换示例 digest 和地址。连接器命名空间必须与应用、可写云运行器命名空间均不同。构建并推送现有 Connector Runner 镜像，将不可变 digest 同时用于调用与禁止访问的监听器。`proxySourceCidrs` 必须是实际观察到的 API server 代理来源，每项精确到 `/32` 或 `/128`。SSH 目标为固定 IPv4/端口组合，最多 32 项；拒绝 DNS 名称和 IPv6 SSH，因为当前 Application SSH allowlist 解析器不支持 IPv6。空 `sshDestinations` 数组只启用现有固定 `whoami` 进程 MCP，不要求 SSH key，也不提供任意用户进程启动能力。此开关不改变独立远程 MCP 的 origin exception 要求。

SSH 目标非空时，在现有 Platform Secret 中提供 `ssh-credential-key`：准确 32 个随机字节的规范 base64url 编码，两个 Platform 副本共用，并随加密连接历史保留。已有 Platform 专用 `connector-key` 同时用于每次调用的 Runner 认证。用户 SSH 密码、私钥、加密 key 字节或 Kubernetes token 均不得进入 values 或渲染后的 YAML。用户通过现有直接上传到 Platform 的表单保存个人 SSH 凭据，在可信 Platform 页面逐条审批命令。启动和就绪检查使用已有 Application 构造器，在准入前校验 key、allowlist 与 Runner 配置。

连接器 Role 只允许在连接器命名空间内 get/create/delete Pod、Service、Secret，get/create Service proxy，以及 get/create/delete NetworkPolicy。不授予 list/watch、Deployment、exec 或 RBAC 管理权限。RoleBinding 只绑定应用命名空间中的 Platform ServiceAccount；云端 Role 权限保持不变。连接器与监听 Pod 无 API token、共享卷、用户 Home 或 Workspace 挂载。Host 不增加配置、凭据、出口或 Kubernetes 权限。命名空间默认拒绝；监听器只允许声明的代理来源访问 TCP 8080，每次调用仍由已有 orchestrator 建立受限策略。固定 STDIO 没有出口例外。

两个进程 orchestrator 都使用连接器命名空间的 `default` ServiceAccount。设置 `imagePullSecretName` 时，基础资源为该账号配置 `imagePullSecrets`；Platform Profile 向预期调用 Pod 显式传递同名引用，让恢复时准确比对 admission 后的字段。除应用与云运行器命名空间外，还须在连接器命名空间提供该仓库 Secret。监听器使用相同 digest 和 default ServiceAccount。本机预导入镜像不能验证仓库凭据或 admission。

启用进程连接器后，`foundation` 除命名空间、ServiceAccount、RoleBinding 和策略外，还包含监听器 Deployment 与 Service；`workloads` 只包含应用 Deployment/Service 和公开 Ingress。应用基础资源、准备私有材料后，须等监听器 Ready，再执行 `--ready` 并启动应用。就绪检查核对监听器当前 generation、固定镜像、Service 身份、真正以 Platform 身份访问的 Service proxy `/health`，以及命名空间权限的允许与拒绝。材料缺失或非法、旧 generation 的监听器或控制路径不可达都会拒绝通过。它不能证明真实调用 Pod 的 CNI 拒绝或 SSH 目标连通；主 agent 串行物理验收仍须核对这些流量、仓库拉取、审批、原 Session 单次续接与资源回收。

## 物理验收条件

发布前，在配有生产 CNI、ingress 控制器、PostgreSQL 和 NFS 导出的**两台物理机器**上执行：

1. 确认 Host Pod 没有数据库环境变量、Platform Secret、PVC 或 Kubernetes API 令牌；确认 Host 和运行器 ServiceAccount 无权访问 Secret 和 Pod。确认云端 Platform Role 仅限其可写运行器命名空间：只有 Sandbox 允许 `list`，供备份核实没有残留实例。拒绝列出其他命名空间的 Sandbox、列出或创建 Pod、列出 Secret、`watch` 以及集群范围的 PV/RBAC 动词权限。
2. 在节点 A 创建 Sandbox，写入 Workspace/Home/Git 数据和一个 Skill 包，记录其 Pod UID，再停止它并核对 kubelet 停止证据。在节点 B 启动替代实例，核对字节和权限完全一致，且不会重放结果不确定的命令。检查第二个用户无法挂载或读取第一个用户的子路径。
3. 测试 Host 和 Platform 副本故障与重新加入、身份验证登录和审批、原生 Web 流式传输，以及经由两个公开 TLS Origin 的长响应。检查浏览器 Origin/CSP 行为、Ingress 不会重试失败的 POST，以及针对外部 PostgreSQL 的会话恢复。
4. 从每个 Pod 验证所需 DNS、PostgreSQL、模型、连接器、Kubernetes API 和运行器代理流量；验证禁止访问的目标与 CNI 策略执行情况，包括运行器实际观察到的 API server 源 IP。
5. 确认 NFS 权限、容量、备份与恢复、卷隔离、gVisor 与 PVC `subPath` 的兼容性、每个节点的镜像拉取，以及真实节点故障下的滚动更新与回滚行为。

本地 k3d 双节点 S7b 演练共用一台物理主机，不能满足这些条件。此模板不部署公共模型网关、受控连接器 API 或桌面 Device 服务；须提供已配置的模型与连接器 HTTPS endpoint。可选进程连接器使用上文所述的独立命名空间。不得仅凭渲染后的 YAML 或本地演练结果将此候选配置提升为生产部署。
