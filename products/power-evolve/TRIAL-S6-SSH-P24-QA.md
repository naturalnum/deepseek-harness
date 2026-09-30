# SSH V24 真实试用进度

## 范围

2026-09-30 至 2026-10-01，使用原生 DSH Web、真实 DeepSeek、独立 PG 数据库和 gVisor 中的 OpenSSH 目标进行验收。起始提交为 `171f2b98e6`；三项修复在 `c4964c1cad` 复验，连接名称与运行中故障场景在 `c0957b17e0` 复验，备份恢复及无需刷新的会话接管在 `31943714fb` 复验。真实 SSH 子切面已完成下列验收，并固定为可按需启动的独立试用，见[固定试用快照](#固定试用快照)；完整边界见[连接器完成出口](S6-CONNECTOR-COMPLETION.md)。

## 环境

| 项目 | 实际配置 |
| --- | --- |
| Host／可信平台／测试 API | `19660`／`19661`／`19662` |
| 数据库 | `pe_ssh_p24_20260930`，schema V24；未迁移固定 MCP 或 S8 数据库 |
| 集群／命名空间 | `pe-e32-session-probe`／`pe-connector-ssh-p24-qa` |
| 执行目标 | 真实 OpenSSH，两个独立 Unix 账号；Home 权限 `0700` |
| Runner／目标镜像 | `pe-connector-runner:ssh-p24-qa`／`pe-ssh-target-fixture:p24-qa` |
| 资源限制 | k3d 节点容器 2 CPU、4 GiB；测试 PG 1 CPU、512 MiB |
| 恢复后的试用 | Host／平台／API：`19670`／`19671`／`19672`；库 `pe_ssh_p24_restored_20261001`，Runner 命名空间 `pe-connector-ssh-p24-restore` |

凭据保存在工作区外的私有目录；浏览器向可信平台提交密码、私钥与口令。平台使用命名空间范围的 kubeconfig：实测可创建 Pod，不能创建 Deployment 或列举 Namespace。禁止访问探针由独立健康的监听服务提供。

## 已观察到的结果

| 路径 | 结果 |
| --- | --- |
| Alice 密码连接 | 原生页创建、启用、真实认证成功；临时 Runner 已回收 |
| Alice 加密私钥 | 原生页把同一连接从密码改为加密私钥，配置与凭据版本均变为 2；真实认证成功 |
| Alice 普通命令 | 独立审批展示冻结目录、目标、指纹、版本和完整命令；执行 `id -un`、`pwd`、`printf` 后原会话得到退出码 0、`qa-alice`、`/home/qa-alice/quote's space` 和预期标记 |
| Bob 普通私钥 | 全新登录后看不到 Alice 的会话、连接或审批；新建本人连接，真实私钥认证成功 |
| Bob 普通命令 | 独立审批后原会话得到退出码 0、`qa-bob`、`/home/qa-bob/work space` 和预期标记；远端 `test ! -r` 确认 Bob 不能读取 Alice 的测试目录 |
| Bob 第二个连接 | 同一目标新增连接，先验证加密私钥，再编辑为密码认证；两个形式均成功。错误私钥口令被拒绝且 Runner 已清理。模型只根据“Bob 备用 QA”名称选中第二个连接，在其含单引号的目录执行成功 |
| 执行位置 | PG 中工作区 Sandbox 与 cloud execution 均为 0；SSH 在独立 Connector Runner 中执行 |

Alice 的认证调用为 `ef78d00a-05e2-497e-8e40-8f1d6b70a341`、`c51705bc-e867-4aa9-899a-60439b74bfbd`；Bob 为 `5045b71c-91ed-49f5-89e4-ebccbf69853f`。三个认证记录均为 `succeeded` 且 `cleanup_complete=true`。Alice／Bob 命令动作为 `e722e6ab-1f37-4215-9c2e-ab4ff6fa0356`／`18fe0fd7-bd26-4fa9-b803-0eba88b70798`。浏览器记录及脱敏 PG 查询保存在 `.artifacts/power-evolve/s6-ssh-p24-qa/browser-evidence/`。

远端 Unix 目录权限检查只证明该测试目标的账号权限；产品跨用户 API 拒绝单独验证，见下文。两位用户均已实际验证密码、普通私钥与加密私钥，并分别保存两个连接；两个账号在同一浏览器依次登录，此记录不声称同时使用独立浏览器上下文。

## 发现的问题与未完成项

| 问题 | 修复与实际复验 |
| --- | --- |
| 编辑后仍显示旧认证成功 | 检查绑定请求与配置版本；新版页面显示“当前配置尚未检查”，保留并标明旧检查结果。旧 POST／轮询晚到及失败覆盖由定向客户端测试验证。 |
| 模型把 UUID 与目标拼接串当作 ID | 系统说明分别列出 ID、名称和目标字段；新建会话不给 UUID，只用“Bob 备用 QA”名称即可生成合法提案。两个连接指向同一 SSH 目标，实际选中指定连接及其工作目录。原生记录与回放通过。 |
| 认证等待完整租约过期 | 确认 `running` 后按配置释放租约供观察。实测调用 `6d07a831-75b5-4e3d-bdec-68c4e0f575bb` 在 10,130 毫秒后成功并回收；相同请求重复两次仍只有一条调用，改动版本返回 409。 |

Bob 拒绝动作 `cc7d7f69-0d29-4be7-9f9d-11e70714f19d` 后没有执行调用，原会话仅续接一次；直接检查 OpenSSH 目标确认 `rejected-marker.txt` 不存在。工作目录不存在的动作 `76ba8c49-fb1d-416e-960e-2fe6846239a9` 返回真实退出码 2 和目录错误，原会话没有自动重试；直接检查确认绝对路径的测试标记也未写入。

真实 Host RPC 和 Platform HTTP 验证 Bob 不能读取 Alice 的认证与执行、停用或删除其连接、批准其动作；均返回 404。伪造用户字段返回 400，Agent 令牌用于审批返回 401。原连接版本及启用状态未改变。此协议测试与浏览器列表隔离分别留存证据。

SSH 定向轮询／租约／恢复检查 8 项通过；原生 Host／Platform／PG 集成文件的 23 项检查及记录回放通过，使用确定性模型。客户端执行者报告 40 项相关组件检查通过，真实新版页面复验如上。应用 TypeScript 构建、扩展中心 bundle 与原生 Web 静态产物构建通过；没有运行全仓库测试。

## 运行中故障与取消

动作 `960968a7-ac55-4f25-b81e-19538534a92a` 先向远端测试文件追加一行，再等待 20 秒。PG 确认调用为 `running` 后，校验可信平台实例身份并对该进程发送 `SIGKILL`，随后通过原 Profile 重启。恢复后的调用沿用原 Pod UID、Runner 实例和 dispatch 摘要，`dispatch_epoch=1`，最终成功并清理；续接任务只有一条且已完成，直接检查远端文件只有一行。浏览器手动刷新后读回退出码 0 和 `recovery-finished`。

此次重启暴露原生会话自动恢复缺口：浏览器到 Host 的连接仍在，但平台短暂不可用导致历史读取失败，页面未自动显示后续结果，只能手动刷新。修复前证据为 `inflight-restart-*.json` 和 `bob-inflight-restart-*.txt`；下述复验单独验证无需刷新的客户端恢复。

动作 `ab4b0067-be86-4800-81ca-068c95de3e8b` 在观察到远端已写入一行后，删除经 UID 核验的该调用 Runner Pod，再从本人 Host RPC 请求取消。调用与动作均保留 `uncertain`、错误码 `ssh_cancel_effect_unknown`，且 `cleanup_complete=true`；命名空间内无 Connector Runner，续接只有一次，原会话明确展示结果不确定并未重试。远端文件仍为一行。此检查不声称取消能撤回已发出的远端效果；该不确定记录在下述备份恢复和固定版本重启后仍保持原状态。

`e96fca0ed3` 修复产品 Host 的原生会话读取：临时网络错误及 502／503／504 沿原游标重试，权限拒绝、非法响应和历史缺口仍终止。恢复后的动作 `f9fb844e-d4c1-4e50-a143-1f8cba1bab53` 在运行中再次强制终止平台，等待 5 秒后重启；原页面未经刷新自动得到退出码 0 和 `restored-recovery-finished`。原 Pod、Runner、dispatch 摘要未改变，派发 epoch 为 1，续接只有一条，远端文件只有一行。旧不确定动作仍保留原状态及一条续接。证据为 `restored-restart-*.json` 和 `restored-restart-no-refresh.txt`；28 项源代码回归与应用构建通过，源代码测试已纳入产品测试命令。

## 撤销、指纹与准备阶段取消

Alice 第二连接的错误主机指纹检查 `8e1f63d8-fb89-4146-8535-3a30564af992` 在 canary 阶段失败，未产生认证派发摘要；该调用 Pod 和策略已清理。编辑为正确指纹后，普通私钥检查 `67e3c6cd` 成功。检查 `5a8b63c1-c61c-4c34-a711-0c46ec9824c6` 在 PG 显示 `preparing` 时从原生页面取消，最终 `cancelled`、`cleanup_complete=true`，仍无派发摘要。

Alice 对动作 `6ead1da5-b1af-4d59-a8dd-f0f8e8a4dc92` 先提交审批，再停用所用连接；从原可信审批页批准时得到 `ssh_connection_revoked`，没有执行调用，仅续接一次。直接检查远端标记文件不存在。随后在原生页删除该连接，认证与冻结审批历史仍可读；重新创建同名连接使用新身份。对应证据为 `auth-cancel-*.json`、`connection-revoked.json`、`alice-deleted-*.txt`。

## V24 真实备份与恢复

使用现有 PG 容器和独立目标库，以 `PE_BACKUP_KEEP_STOPPED=1` 执行备份及恢复。备份包位于 `~/.config/power-evolve/backups/s6-ssh-p24-20261001-a`，目标私有目录为 `~/.config/power-evolve/shared-host-s6-ssh-p24-restored`。54 张 public 表、445 行记录、420 个文件／符号链接及权限逐项一致；8 个历史凭据版本、8 条命令历史和 5 条加密结果均可使用恢复密钥读取。不确定调用及其已清理状态原样保留，恢复未重新派发。

备份检查曾因受限凭据不能列举 Pod 而拒绝。`441e8ed221` 为 Connector Role 增加仅限本命名空间的 Pod 列举；实际验证 Secret 列举、其他命名空间、Deployment 和集群访问仍被拒绝。9 项 PG／备份 CLI／kubectl 替身回归通过，其中 Kubernetes 与 Runner 为明确替身；随后真实命名空间检查与备份通过。清理后的不确定调用允许归档，但待执行动作、活跃续接、残留 Pod、缺少配置或密钥仍拒绝，操作说明见[备份参考](TRIAL-S7C-BACKUP.md)。

目标使用独立受限 kubeconfig 与 Runner 命名空间，试验 SSH 服务作为固定外部目标继续保留；目标网络策略只额外允许恢复命名空间的 Connector Runner 访问该 SSH 端口。启动恢复版本后，Alice 加密私钥调用 `710bc67b-c89e-4aa0-b04d-afee6e6bf0c0` 真实成功，两用户原生历史读回，Bob 完成上述无需刷新的恢复命令。PG 中工作区 Sandbox 和 cloud execution 仍为 0。备份恢复与后续人工核验分开执行，不报告连续健康 RTO。证据见 `backup-restore-evidence.json`、`backup-rbac.json` 和 `restored-*.txt`。

## 固定试用快照

固定提交为 `0f7a58fd5f61e48e380e0a67112dcfaff5e9533e`，本地标签为 `power-evolve-native-s6-ssh-trial`。独立 checkout 为 `/Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-recovery`；目录沿用准备工作树名称，内容为本节的 SSH 版本。它使用恢复库 `pe_ssh_p24_restored_20261001`、schema 24、私有目录 `~/.config/power-evolve/shared-host-s6-ssh-p24-restored`，与 MCP、S8 的持久数据分开。

构建产物、依赖、原生 Web、Profile 和链接已复制并逐项校验；运行时不引用主开发 checkout。以下本机控制器在启动前核对固定提交、产物、原容器身份、数据库版本以及现有 SSH 目标。启动使用已固定的 Profile，自动更新 PG 动态映射端口，不重新准备配置或创建集群。

```sh
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-recovery/.artifacts/power-evolve/s6-ssh-p24-restored/snapshot-tools/fixed-trial.mjs start
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-recovery/.artifacts/power-evolve/s6-ssh-p24-restored/snapshot-tools/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-recovery/.artifacts/power-evolve/s6-ssh-p24-restored/snapshot-tools/fixed-trial.mjs stop
```

试用步骤：

1. 确认现有 `pe-e32-session-probe` 集群及固定 SSH 目标可用，执行 `start`，打开 `http://127.0.0.1:19670/`。Alice／Bob 登录信息由上述私有目录的 `users.json` 在本机读取，不复制到聊天或文档。
2. 登录 Alice，读取原 SSH 会话的 `p24-alice-ok` 结果，进入“插件 → SSH”，查看自己的两条连接和检查历史。
3. 退出后登录 Bob，读取 `restored-recovery-finished` 的原会话结果，查看自己的两条连接；Alice 的清单不应出现。新建会话发送 `hi` 可验证普通对话。
4. 若需新命令，明确指定本人连接及命令，在独立可信入口 `http://127.0.0.1:19671/approval` 登录同一账号审核。历史中的旧源环境链接仍保留原地址，当前新审批使用此恢复环境地址。
5. 用完执行 `stop`。控制器只停止经 PID、工作目录和健康身份核对的三个进程；共享测试 PG 无其他客户端时随之停止，数据库与文件保留。控制器不停止共享 k3d。

固定版本实际通过三角色启动、停止、再次启动，PG 动态端口更新，以及 Alice／Bob 顺序全新登录、历史和连接清单读取。Bob 新检查 `937bbfa4-800a-4e79-9d96-ed15929e4c37` 使用真实 SSH 私钥成功，`cleanup_complete=true`、派发 epoch 为 1。再次启动后，原有 19 条完成操作仍在；真实 DeepSeek 的新 `hi` 为第 20 条完成操作，工作区 Sandbox 仍为 0，原不确定执行没有重放。原生 Host／Platform／PG 的 23 项确定性组合回归在集成代码上再次通过。

本机证据及日志位于该 checkout 的 `.artifacts/power-evolve/s6-ssh-p24-restored/`：`freeze-evidence.json`、`browser-evidence/`、`snapshot-tools/preparation.json` 和三个角色日志。默认停止此试用以降低笔记本负载。可先运行 `status` 检查；源码、产物、数据库版本或固定目标不符时启动拒绝，不会自动替换现有环境。若 SSH 目标 Pod 被重建，需明确恢复或更新目标配置，不能把变化后的主机静默当成原目标。

下一组补齐账号生命周期，再补文件与产物入口；生产多节点、共享卷、生产入口及真实容量仍按 S7 验收。
