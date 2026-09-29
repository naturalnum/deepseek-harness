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

## 原生浏览器与真实模型验收

若需独立的双用户浏览器试用，保留 Runner 检查创建的命名空间与限定权限 kubeconfig。在 `~/.config/power-evolve/` 下使用新的私密目录；保留模式会在其中写入 `ssh.json`，包含无法路由的 SSH 白名单地址，因为当前 Platform 通过共用 Connector 配置启用 STDIO。浏览器检查仅调用固定的 STDIO whoami 工具。

```sh
export PE_STDIO_TRIAL_PRIVATE_DIR="$HOME/.config/power-evolve/shared-host-native-s6-stdio-qa"
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-stdio/run.mjs
# Put a valid model.env in that private directory as for the other real-model trials.
export PE_PRIVATE_DIR="$PE_STDIO_TRIAL_PRIVATE_DIR"
export PE_TRIAL_NAME=native-s6-stdio-qa
export PE_DATABASE_PORT=18532 PE_HOST_PORT=19350 PE_PLATFORM_PORT=19351 PE_TARGET_PORT=19352
export PE_SSH_ENABLED=1 PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs up
PE_STDIO_RESTART=1 node products/power-evolve/scripts/qa-stdio-browser.mjs
```

将 `PE_KUBE_CONTEXT` 设为同一个明确选定的集群 context。试用端口、名称和命名空间必须未被占用，不要复用稳定试用或其他正在运行的试用。浏览器脚本在两个独立 Chromium 上下文中登录预置用户，通过原生界面创建云 Workspace，在 Plugins 中安装并开关固定的 Process MCP 连接，分别从会话发送真实模型消息，并检查调用归属、独立 Runner 身份、原 Session 续接、刷新后记录、资源清理与重启恢复。可针对同一试用重复运行；不设置 `PE_STDIO_RESTART=1` 即跳过最后的重启检查。命名空间与试用会保留以供检查。检查完毕后，在相同环境下执行 `node products/power-evolve/scripts/trial.mjs stop`，再删除专用命名空间。
