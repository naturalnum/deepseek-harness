# S7d 渲染网络策略与服务身份实测

`qa-s7d-policy.mjs` 从 `deploy/render.mjs` 生成部署候选的 NetworkPolicy、ServiceAccount、Role 和 RoleBinding，在三个随机命名空间中实际应用。探针跨两个 Ready Kubernetes 节点运行 Node TCP/HTTP 服务，先确认所有目标端口可达，再施加策略检查允许和拒绝。它不启动 DSH 产品进程，不挂载文件或真实凭据；这是部署网络和权限的局部验收，完整原生浏览器纵切面另行验收。

在已有双节点本机试验集群运行：

```sh
PE_S7D_KUBE_CONTEXT=k3d-pe-s7b-multinode \
PE_S7D_PROBE_IMAGE=pe-s7b-runner:65c4ecf \
  node products/power-evolve/scripts/qa-s7d-policy.mjs
```

镜像须已导入两个节点并包含 Node.js。脚本仅创建自己的命名空间、探针 Pod 和渲染出的限权资源；结束删除这些命名空间并等待删除完成。它不创建 PV、不改节点或集群控制器。报告保留于 `.artifacts/power-evolve/s7d-policy-*/policy-evidence.json`，包括实际 imageID、节点及每条结果，不含凭据。

2026-09-30 在 `k3d-pe-s7b-multinode` 运行通过，证据为 `.artifacts/power-evolve/s7d-policy-f9a8b20c/policy-evidence.json`：

| 实际检查 | 结果 |
| --- | --- |
| 带指定 Ingress 标签的来源 → Host/Platform；Host → Platform | 允许 |
| 无 Ingress 标签的来源 → Host/Platform/Runner | 拒绝 |
| Host → PG/模型/Runner；Platform → Runner 直连；Runner → Platform | 拒绝 |
| Platform → 配置的 PG/模型端口 | 允许 |
| Platform → 同目标的未配置端口 | 拒绝 |
| 配置的代理来源 IP → Runner | 允许 |
| Runner 默认外网出口；配置 HTTPS 出口后访问其他端口 | 拒绝 |
| Runner 配置特定 IP 后访问 443 | 允许 |
| Host/Platform/Runner → 集群 DNS | 允许 |
| Host/Runner 自动挂载 Kubernetes token | 未挂载 |
| Platform 在 Runner 命名空间创建 Sandbox、patch Pod | 允许 |
| Platform 列出 Runner Secret、读取应用 Secret；Host 读 Secret；Runner 读 Pod | 拒绝 |

16 条初始流量检查、DNS、token 挂载和 6 条 RBAC 检查全部符合预期；改变 Runner 出口配置后只开放指定 HTTPS 端口。测试末尾再次确认目标端口存活，避免把失效服务当成策略拒绝。三个临时命名空间已清理。

两个 Kubernetes Node 位于同一物理主机。Runner 代理来源使用明确的探针 Pod IP，尚未证明生产 API Service proxy 的实际来源地址。Ingress 使用标签与端口探针，未验证真实 TLS 终止、WebSocket 或长响应。本结果也不证明 NFS/PVC、gVisor、实际 Host/Platform 镜像启动或跨物理机网络策略；仍须在目标环境重复相应纵切面。
