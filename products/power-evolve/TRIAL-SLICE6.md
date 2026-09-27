# 切片 6：双宿主试用

本切片让两个共享 DSH 宿主在同一入口后服务相同用户。会话、任务和事件在可信平台的 PostgreSQL 中；负载均衡器只按健康状态路由 HTTP 请求，不保存会话，也不自动重试失败的 POST。云端命令仍按需进入 k3s + Agent Sandbox。本地设备沿用[切片 5](TRIAL-SLICE5.md)的独立 Profile；本指南主要验证云端多宿主。

## 启动与试用

先满足[切片 4](TRIAL-SLICE4.md)的 k3s、Agent Sandbox、gVisor 和持久 POSIX 卷条件。私密目录 `~/.config/power-evolve/shared-host-slice6/` 中放置 `model.env` 和 `sandbox.json`；本试用的命名空间、PG 端口、工作区子目录与切片 5 分开。不要提交或分享密钥、试用账号密码和集群凭据。

```sh
pnpm install --frozen-lockfile
pnpm run build
export PE_TRIAL_NAME=slice6 PE_MULTI_HOST=1 PE_DATABASE_PORT=18437
export PE_HOST_PORT=18920 PE_HOST_SECOND_PORT=18921
export PE_PLATFORM_PORT=18922 PE_TARGET_PORT=18923 PE_LOAD_BALANCER_PORT=18924
pnpm run power-evolve:trial up
```

若本机 Docker 默认地址池已经耗尽，可把现有可信 Docker 网络名设为 `PE_COMPOSE_EXTERNAL_NETWORK` 再启动；该选项只影响本机试用 PG 容器的网络。当前机器使用 `pe-shared-host-slice5_default`，但数据库卷和账号仍属于切片 6。

网页入口：<http://127.0.0.1:18924/>；可信登录和审批：<http://127.0.0.1:18922/login>、<http://127.0.0.1:18922/approval>。宿主 A、B 的 `/health` 分别在 18920、18921；负载均衡器的 `/health` 在 18924，展示两路健康状态和各自请求数。两个账号的登录方式记录在本机私密的 `users.json`，不要复制到聊天中。

1. 在两个隔离的浏览器会话中分别登录 Alice、Bob，经 18924 新建对话并说 `hi`。刷新和继续追问；两人的历史应各自保留，且不创建云沙盒。
2. 连续刷新或发起多个请求，观察 18924 `/health` 的两路 `served` 均增加。同一对话在不同宿主响应时，历史、设置和文件保持一致。
3. Alice 和 Bob 分别要求 Agent 用 `cloud_exec` 在各自工作区运行 `git status` 或创建并读取一个小文件。两人的命令、输出及文件互不可见；沙盒回收后再次执行仍能读取原工作区。
4. 对照宿主 `/health` 的 `activeAgents`、`loadedSessions`、`activeGrants`：任务完成后应回到零。可用 `pnpm run power-evolve:trial status` 检查服务；重复运行 `up` 会修复已退出的试用进程。故障注入需先核对目标进程的 readiness 记录，避免误停其他试用。

停止时使用相同环境变量运行 `pnpm run power-evolve:trial stop`。日志和本机试用证据在 `.artifacts/power-evolve/slice6/`。停止服务不会清除 PG、工作区、私密配置或仍在终止中的沙盒。

## 验收证据与边界

`PE_PRIVATE_DIR="$HOME/.config/power-evolve/shared-host-slice6" pnpm run test:power-evolve` 使用独立临时 PG 数据库与确定性模型运行自动回归。它验证两台原生宿主经负载均衡处理同一会话、宿主退出和重入、16 个并发对话及空闲对象释放；另验证用户公平领取、过期写入者拒绝、执行租约续期、命令 ID 去重和事件输出背压。自动测试不能替代真实模型与集群验收。

真实模型故障试验中，云端命令运行期间强制终止宿主 A；客户端改由 B 接续读取，命令结果进入原会话一次，工作区追加文件只有一行。宿主 A 重启后重新加入。切片 6 的试用 PG 已由结构版本 7 升至 8；旧切片 5 的数据库未迁移。

真实模型、真实 k3s 的容量探针使用两个用户和两个宿主，每轮各并行执行一条命令，并等待两个沙盒回收。8 轮共 16 次命令均成功，两个工作区最终各有 8 行且无重复；每条执行记录领取 2 次，对应运行中观察和最终结果观察，runner 命令没有二次写入。试验结束后，管理员视角下该命名空间没有残留的 PowerEvolve Sandbox 或 Pod。空闲检测时两个宿主的 Agent、Session、Grant 计数均为零。

探针的进程 RSS（MiB）从宿主 A/B 约 122/110、平台 146，变为约 123/119、平台 173。平台在第 4 至 8 轮约 171–173 MiB；宿主 A 第 7 轮有一次明显 GC 回落。这个小样本只能说明当前负载下没有观察到持续线性增长，不能推算万人容量。每个沙盒配置为请求 100m CPU/128 MiB、上限 1 CPU/768 MiB；宿主每实例最多 4 个并发 Agent，平台每用户最多 1 个活动任务、总计最多 4 个并发沙盒。`PE_PROBE_ROUNDS=8 PE_TRIAL_NAME=slice6 node products/power-evolve/scripts/capacity-probe.mjs` 可在已启动的真实试用环境重复运行；报告写入 `.artifacts/power-evolve/slice6/capacity-probe-8.json`。

结构版本 8 给用户任务领取增加轮转时间。迁移已有数据前，先停止写入并备份 PG 与 POSIX 工作区；需要回滚时同时恢复旧程序、PG 备份及对应工作区。稳定的切片 5 位于另一检出目录和独立端口。当前负载均衡器仅监听本机，用于试用；生产 TLS、入口保护、多平台副本、跨节点共享卷一致性与更大规模压测仍需部署验收。已进入模型的输入若中途失去宿主，会标记中断而不自动重新调用模型；云端命令的结果则通过稳定执行 ID 查询和对账。
