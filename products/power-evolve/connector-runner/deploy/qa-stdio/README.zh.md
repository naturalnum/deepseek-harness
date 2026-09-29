# 临时 k3d STDIO MCP 验收

[English](README.md) | 中文

仅在明确指定、启用 gVisor 和 NetworkPolicy 的本地 k3d 集群运行。脚本创建随机的专用命名空间和私密的限定权限 kubeconfig，启动独立健康的禁止访问监听器，再创建两个不同的进程型 MCP Pod。每个 Pod 都必须无法连通该监听器、只返回分配给自己的账户、重复调用保留原结果，并拒绝同一调用 ID 改换账户。完成或失败后，脚本删除专用命名空间和私密文件，不修改稳定试用的平台或宿主服务。

从仓库根目录构建并导入当前 Runner 镜像，然后运行验收：

```sh
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-stdio-qa
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-stdio/run.mjs
```

脚本不打印 Runner 令牌、kubeconfig 或单次调用摘要。若删除命名空间失败，会打印随机命名空间名称，供人工检查。
