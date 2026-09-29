# S7 简单对话容量探针

`qa-s7-capacity.mjs` 在隔离试用中启动两台共享 Host、两台 Platform、本机负载均衡器和真实 PostgreSQL。它为每位测试用户创建独立 Session，同时提交一次 `hi`，使用确定性 SSE 模型替身完成会话，然后逐一读取原生历史，检查跨用户访问返回 404、Host 的 Agent／Session／Grant 回到空闲且没有创建沙盒。模型登录凭据和数据库卷仅用于本次试验，脚本结束后清理；脱敏报告保存在 `.artifacts/power-evolve/s7cap-*/simple-conversation-capacity.json`。

在仓库根目录完成 `pnpm install --frozen-lockfile`、`pnpm run build` 和 `pnpm run build:power-evolve:web` 后运行：

```sh
PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default PE_CAP_USERS=128 \
  node products/power-evolve/scripts/qa-s7-capacity.mjs
```

本机 Docker 地址池充足时可省略 `PE_COMPOSE_EXTERNAL_NETWORK`。`PE_CAP_USERS` 允许 2–500，但本轮只实测至 128；脚本不把已注册用户数当作同时活跃的会话数。

| 同时提交 `hi` 的用户 | 批量受理耗时 | 完成延迟 p50 / p95 / p99 | 峰值 PG 连接 | 沙盒记录 |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 1,595 ms | 5,596 / 6,250 / 6,250 ms | 17 | 0 → 0 |
| 64 | 1,111 ms | 5,318 / 8,172 / 8,272 ms | 24 | 0 → 0 |
| 128 | 1,062 ms | 8,732 / 14,505 / 15,067 ms | 24 | 0 → 0 |

128 用户一轮的四个服务进程 RSS 基线合计约 495 MiB，采样峰值合计约 627 MiB；完成后 Host 的 Agent、Session、Grant 计数均为零。RSS 是进程驻留内存，不等于需预留的容器内存，试验也没有等待长时 GC 或重复多轮观察增长。报告中保留每个进程的基线、峰值和空闲采样。

这些数值只描述 2026-09-30、提交 `26d6c583cf`（Schema V18）下，本机两 Host、两 Platform、快速模型替身和 128 个一次性会话的表现。真实模型延迟、文件操作、长历史、连接器、沙盒、跨机器网络与共享卷、连续多轮活跃以及峰值登录均未包含，不能据此推算万人容量或生产 p95。Schema V19 的登录准入和最终目标硬件需另测；生产容量还需要按业务组合、持续时长和资源上限重复测量。
