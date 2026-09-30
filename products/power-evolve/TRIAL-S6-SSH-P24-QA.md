# SSH V24 真实试用进度

## 范围

2026-09-30 至 2026-10-01，在提交 `171f2b98e6` 上使用原生 DSH Web、真实 DeepSeek、独立 PG 数据库和 gVisor 中的 OpenSSH 目标进行验收。本文是阶段证据，尚未冻结新的 SSH 试用版本；[连接器完成出口](S6-CONNECTOR-COMPLETION.md)仍需全部通过。

## 环境

| 项目 | 实际配置 |
| --- | --- |
| Host／可信平台／测试 API | `19660`／`19661`／`19662` |
| 数据库 | `pe_ssh_p24_20260930`，schema V24；未迁移固定 MCP 或 S8 数据库 |
| 集群／命名空间 | `pe-e32-session-probe`／`pe-connector-ssh-p24-qa` |
| 执行目标 | 真实 OpenSSH，两个独立 Unix 账号；Home 权限 `0700` |
| Runner／目标镜像 | `pe-connector-runner:ssh-p24-qa`／`pe-ssh-target-fixture:p24-qa` |
| 资源限制 | k3d 节点容器 2 CPU、4 GiB；测试 PG 1 CPU、512 MiB |

凭据保存在工作区外的私有目录；浏览器向可信平台提交密码、私钥与口令。平台使用命名空间范围的 kubeconfig：实测可创建 Pod，不能创建 Deployment 或列举 Namespace。禁止访问探针由独立健康的监听服务提供。

## 已观察到的结果

| 路径 | 结果 |
| --- | --- |
| Alice 密码连接 | 原生页创建、启用、真实认证成功；临时 Runner 已回收 |
| Alice 加密私钥 | 原生页把同一连接从密码改为加密私钥，配置与凭据版本均变为 2；真实认证成功 |
| Alice 普通命令 | 独立审批展示冻结目录、目标、指纹、版本和完整命令；执行 `id -un`、`pwd`、`printf` 后原会话得到退出码 0、`qa-alice`、`/home/qa-alice/quote's space` 和预期标记 |
| Bob 普通私钥 | 全新登录后看不到 Alice 的会话、连接或审批；新建本人连接，真实私钥认证成功 |
| Bob 普通命令 | 独立审批后原会话得到退出码 0、`qa-bob`、`/home/qa-bob/work space` 和预期标记；远端 `test ! -r` 确认 Bob 不能读取 Alice 的测试目录 |
| 执行位置 | PG 中工作区 Sandbox 与 cloud execution 均为 0；SSH 在独立 Connector Runner 中执行 |

Alice 的认证调用为 `ef78d00a-05e2-497e-8e40-8f1d6b70a341`、`c51705bc-e867-4aa9-899a-60439b74bfbd`；Bob 为 `5045b71c-91ed-49f5-89e4-ebccbf69853f`。三个认证记录均为 `succeeded` 且 `cleanup_complete=true`。Alice／Bob 命令动作为 `e722e6ab-1f37-4215-9c2e-ab4ff6fa0356`／`18fe0fd7-bd26-4fa9-b803-0eba88b70798`。浏览器记录及脱敏 PG 查询保存在 `.artifacts/power-evolve/s6-ssh-p24-qa/browser-evidence/`。

远端 Unix 目录权限检查只证明该测试目标的账号权限；产品跨用户 API 拒绝仍须单独验证。上述三种认证形式分别实际运行过，尚未覆盖每个用户的全部认证形式。

## 发现的问题与未完成项

1. 修改连接后，卡片仍显示旧版本的认证成功状态。正在修复当前连接与历史检查的关联显示。
2. Host 将 UUID、用户名与地址拼成一串，真实模型误把整串当作 `connectionId`，首次提案被拒绝。提供准确 UUID 后两个用户的审批、执行、续接均通过；修复工具描述后仍须无人工 ID 提示复验。
3. 三次认证约需 91–92 秒才显示成功。代码审查发现认证 `running` 后等待 90 秒租约过期才再次观察，命令执行已有短轮询释放；认证路径正在补齐相同的围栏机制。
4. 尚需当前版本的拒绝／撤销／错误凭据／主机指纹失败、重复请求、执行中断对账、重启、备份恢复及双用户越权拒绝的真实验收。既有针对性自动测试不替代这些试用结果。
5. 修复集成和复验完成后再冻结独立试用；生产多节点、共享卷与生产入口仍按 S7 验收。
