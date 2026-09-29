# S7a：本机双 Host、双 Platform 故障演练

本演练用两个 Host Profile、两个 Platform Profile 和各自的本机 HTTP 负载均衡器验证共享 PostgreSQL 下的故障恢复。两个 Platform 使用同一平台公共源、PG、私有 POSIX 工作区、模型密钥和受控 API；它们不使用各自独立的数据副本。代理只选择健康进程，不自动重放失败的 POST。

## 一键复跑

在仓库根目录完成 `pnpm install --frozen-lockfile`、`pnpm run build` 和 `pnpm run build:power-evolve:web`，并确保 Docker 与 Playwright Chromium 已可用。然后运行：

```sh
node products/power-evolve/scripts/qa-s7a-platform-failover.mjs
```

如果 Docker 默认地址池已耗尽，可为本次独立 PG 容器指定一个现有的用户自定义网络，例如：

```sh
PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default \
  node products/power-evolve/scripts/qa-s7a-platform-failover.mjs
```

脚本随机选择试用名及未占用端口，创建专属 PG 卷和 `~/.config/power-evolve/shared-host-s7a-*/` 私有目录。模型由本机确定性 SSE fixture 提供，账号和模型密钥不会写进报告。脚本在结束时停止自己启动的进程、移除自己的 PG 容器与卷、删除私有目录；脱敏报告和进程日志保留在 `.artifacts/power-evolve/s7a-*/`。设置 `PE_S7A_KEEP_TRIAL=1` 可留住进程、PG 和私有文件供故障检查；脚本退出时模型 fixture 仍会关闭，此模式不用于继续对话。检查后需用同一试用名及端口配置停止进程并清理独立资源。

## 验证内容

1. 原生 DSH Web 经平台公共源登录，经 Host 公共源打开会话；轮询显示两个 Host 与两个 Platform 都服务请求。
2. A 平台在原生输入已持久接收、模型请求尚未完成时被强制终止。B 平台接管后，该输入仅出现一次，已消耗的模型调用不重播；原操作标记为失败。浏览器在同一 Session 中继续对话，写入并读取同一 POSIX 文件。
3. Agent 提议受控便签写入，用户通过独立审批页批准。受控 API 持久写入后故意丢失首次 HTTP 响应；A 平台随后被强制终止。B 平台通过稳定 action ID 查询远端状态，完成原 action，且只在原 Session 续接一次。报告核对远端 POST 次数为 1、便签记录为 1、连接器领取至少 2 次。
4. A Host 被强制终止后，B Host 通过公共源恢复原生记录并在同一 Session 接收后续输入。A Host 重入后，先前文件仍可读取。

本机实测报告：`.artifacts/power-evolve/s7a-b95d5a03/s7a-evidence.json`。其中已接收输入的结果为 `failed`，远端 POST 为 1 次，便签为 1 条，连接器领取为 2 次，续接 Session ID 与原 Session ID 相同。该报告由确定性模型和本机 POSIX 存储产生；它不证明多节点 k3s、跨节点共享卷一致性、生产入口或真实模型的可用性。

如需手动管理同一配置，`PE_MULTI_HOST=1 PE_MULTI_PLATFORM=1` 使 `trial.mjs up` 启动 `host`、`host-b`、`lb`、`platform`、`platform-b`、`platform-lb`。设置独立的 `PE_HOST_SECOND_PORT`、`PE_LOAD_BALANCER_PORT`、`PE_PLATFORM_SECOND_PORT` 和 `PE_PLATFORM_LOAD_BALANCER_PORT`；`status` 查看各进程，`stop-one platform` 和 `start-one platform-b` 可在核对 readiness 记录后操作单个进程。所有 Profile 对外引用两个负载均衡器的公共源。
