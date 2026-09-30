# S7c：独立试用的停写备份与恢复

本演练在独立的 PostgreSQL 卷、POSIX 子目录、私有配置、端口和 Kubernetes 命名空间中，从仍运行 V18 的源试用制作一致性快照，再用当前 V19 程序恢复到全新试用。脚本只管理指定试用，不清理其他试用。备份包含 PG 自定义格式 dump、`workspaces`、`homes`、`skill-packages`、`artifacts` 的字节，以及重建登录、模型和加密状态所需的私有配置。Kubernetes kubeconfig、Sandbox 与 Connector Runner 的调度配置由目标试用单独创建，不能照搬源环境的路径或命名空间。


## 当前脚本（参考）

本节按 `3aa65817cc` 的 [备份入口](scripts/backup-trial.mjs) 与 [PG、私有文件和运行器检查](scripts/backup-support.mjs) 核对当前行为。下文 V18→V19 的数据、耗时、浏览器验收及当时的脚本描述保留为固定版本的历史证据；V23 MCP 试用的真实备份、独立恢复及随后进行的健康和原生客户端复验见 [远端 MCP QA 记录](TRIAL-S6-REMOTE-MCP-QA.md)，V24 SSH 进度见 [SSH QA 记录](TRIAL-S6-SSH-P24-QA.md)。保持应用停止的恢复不报告健康 RTO，后续启动另行验证。

### 存储布局

`prepare-trial.mjs` 在私有目录记录 `storage-layout.json`（0600），并把实际工作区、产物及技能根写入生成的 Profile。无沙盒的技能根默认为 `$PE_PRIVATE_DIR/skill-library`；云沙盒使用 `sandbox.json` 的 `localRoot`。自定义 `PE_SKILL_LIBRARY_ROOT` 须在首次准备时指定，后续启动保留记录的路径；改变根会被拒绝，应通过新试用恢复迁移，不能直接修改记录冒充数据迁移。已有试用升级后，首次备份前须以原实际存储根运行 `prepare-trial.mjs`，缺少记录时备份不会猜测路径。

新备份使用格式 2，在清单中保存存储布局；归档内仍以 `data/skill-packages` 命名。创建和恢复按各自实际技能根映射，并核对 PG 中全部包版本的文件、大小与哈希，包含历史版本、停用及撤销包；完整技能树也保留报告套件。恢复继续接受有效的格式 1 备份。旧备份若已漏掉 PG 记录对应的包字节，恢复会明确失败，不能靠重装当前目录替代丢失的历史版本。

### PostgreSQL 与工具选择

`PE_TRIAL_DATABASE` 默认为 `compose`，恢复要求目标试用的 PG 卷尚不存在。设为 `external` 时，脚本使用操作者预先提供的 `$PE_PRIVATE_DIR/database-url`，不创建数据库、容器或卷；源 PG 必须可连接，目标必须是独立的空数据库，不能把源库的 URL 复制到目标。库名、用户及密码取自该私有 URL，不固定为 `powerevolve`。

`external` 默认从本机 `PATH` 使用 `psql`、`pg_dump`、`pg_restore`，也可用 `PE_BACKUP_PG_BIN_DIR` 指定工具目录，或用 `PE_BACKUP_PG_CONTAINER` 显式选择已经存在的工具容器。容器内默认连接本地 socket，可用 `PE_BACKUP_PG_HOST`、`PE_BACKUP_PG_PORT` 指定其连接目的地；选择容器不等于选择了正确数据库，身份核验必须通过。`compose` 未指定工具容器时使用该试用对应的 PostgreSQL 容器。URL 和密码不进入工具 argv 或失败诊断，连接凭据通过子进程环境传递。

执行 dump 或恢复前，脚本比较 Node 客户端与 `psql` 读到的集群标识摘要和数据库 OID；备份清单记录源数据库身份。操作者须有读取 `pg_control_system()` 的权限。`external` 恢复在复制目标文件前拒绝同源数据库；缺少源身份元数据的旧备份还须设置 `PE_BACKUP_SOURCE_DATABASE_URL_FILE`，指向源私有 `database-url` 文件进行核验。字面库名含 `=` 或以 `postgres://`、`postgresql://` 起始时会被拒绝，防止 `pg_restore --dbname` 把库名解释成另一连接。

### 远端 MCP 私有配置

备份已有通用远端 MCP 连接或草稿时，必须显式设置 `PE_REMOTE_MCP_CONFIG_FILE`。脚本校验该配置，并把配置原始字节、其 `credentialKeyFile` 指定的原密封密钥及每个 `internalExceptions[].caFile` 引用的 CA 文件一并归档；私有目录为 0700，文件为 0600，文件字节和权限位进入完整性清单。不能用新密钥替代原密钥，否则历史加密凭据无法解密。

恢复把这些文件写入新目标的 `$PE_PRIVATE_DIR/remote-mcp/`：配置为 `configuration.json`，密钥为 `credential-key`，CA 为 `ca-<索引>.pem`；索引对应 `internalExceptions` 的原数组位置。配置只重写密钥及 CA 文件引用，保留其余设置。新配置绝对路径写入 `restore-evidence.json` 的 `remoteMcpConfigFile`；以后启动该目标须把 `PE_REMOTE_MCP_CONFIG_FILE` 显式设为此路径，不能沿用源路径。归档遗漏已有 MCP 历史所需的配置或密钥时，恢复拒绝启动应用。

### SSH 不确定结果与运行器检查

SSH `uncertain` 调用只有在 `cleanup_complete=true` 时才允许备份；执行调用还须有归属、操作、连接及凭据版本、请求摘要均匹配的 `uncertain` 动作。待执行动作、活跃调用和排队或运行中的续接继续阻止备份。已有 SSH 历史必须保留原 `ssh-credential-key`。恢复原样保留不确定状态和历史凭据版本，不把它们改成成功或重新派发。

停止应用后，脚本分别使用 `sandbox.json` 和 `ssh.json` 中固定 kubeconfig 的 `current-context` 检查对应命名空间；不使用全局 context 替换运行器实际配置。即使没有 `sandbox.json`，已有 SSH 配置也必须检查 Pod；已清理的不确定调用缺少 SSH 配置时拒绝备份。缺少 context、列举失败、残留或正在删除的 Connector Runner Pod 都会拒绝备份。受限 Connector Role 须有本命名空间的 Pod `list` 权限，见[部署权限说明](connector-runner/deploy/README.zh.md)。清理标记不能代替实际资源检查。

## 使用方法

备份依赖已构建的产品代码；恢复后启动应用还需要产品及原生 Web 构建产物。使用 Compose 或现有工具容器时需要 Docker/OrbStack；启用云 Sandbox、SSH Runner 或浏览器验收时，另需 kubectl、可用的 Sandbox 控制器与 Runner 镜像、Playwright Chromium，以及目标试用独有的 `sandbox.json`、`ssh.json` 和限权 kubeconfig。准备方式沿用 [S6 原生试用](TRIAL-S6-FINAL-QA.md)；两个 JSON 的 `localRoot`、`nodeRoot`、`workspaceRoot`、命名空间和端口应指向目标独有资源。目标私有目录必须位于 `~/.config/power-evolve/` 下，`model.env` 留在私有目录，不能提交到仓库。以下命令块保留 V18→V19 历史 Compose 演练的参数；当前外部 PG 与 MCP 配置按上节提供。

源试用已有 Alice/Bob 的真实模型对话、Session 历史和 STDIO 调用时，可用以下模式复跑。每个试用都设置自己的 `PE_TRIAL_NAME`、三个端口、`PE_PRIVATE_DIR` 和 Kubernetes 配置；以下为本机实测值。`PE_BACKUP_BUNDLE` 须为一个尚不存在的绝对路径，其父目录只供本机当前用户访问。

```sh
export PE_TRIAL_NAME=s7c-src-b1 PE_DATABASE_PORT=18535
export PE_HOST_PORT=19380 PE_PLATFORM_PORT=19381 PE_TARGET_PORT=19382
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s7c-src-b1
export PE_SSH_ENABLED=1 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
export PE_BACKUP_BUNDLE=/Users/jingchao/.config/power-evolve/s7c-backups/b1
node products/power-evolve/scripts/prepare-trial.mjs
node products/power-evolve/scripts/backup-trial.mjs create
```

`create` 先通过 PID 和健康接口的 `instanceId` 确认源试用原先存活的服务，再逐个执行 `stop-one`；无法核实的存活进程会使备份被拒绝。脚本完成上述 PG 与运行器检查后才执行 dump 与复制。MCP `queued`/`running` 发现检查和 `approved`/`preparing`/`dispatch-intent` 动作阻止备份；MCP 待人工决定的 `pending` 和终态 `uncertain` 可以原样保存，恢复不会把它们变成自动派发许可。新清单记录文件 SHA-256、权限位和符号链接原始目标，旧格式 1/2 清单仍按其已有字段核验。

成功后脚本原子发布备份目录；失败时清理未完成目录。默认只尝试重启本次通过 `stop-one` 停止并记录的服务，预先已停止的服务不会因备份被唤醒。设置 `PE_BACKUP_KEEP_STOPPED=1` 时，创建备份后不重启这些服务，恢复后也不启动应用；该选项不停止 PG，Compose 恢复仍会准备并启动目标 PG。若源服务重启失败，用同一组环境变量运行 `trial.mjs status`、检查日志并修复源试用。源端运行期间不要直接复制卷来替代停写步骤。

恢复前创建全新目标私有目录；启用云执行时另准备其独有 `sandbox.json`、`ssh.json`、kubeconfig 和命名空间。不先运行 `prepare-trial.mjs`，以免生成本应从备份恢复的私有文件；`external` 模式另预先写入目标空库的私有 `database-url`。以下仍是历史 Compose 目标参数：

```sh
export PE_TRIAL_NAME=s7c-dst-b2 PE_DATABASE_PORT=18537
export PE_HOST_PORT=19400 PE_PLATFORM_PORT=19401 PE_TARGET_PORT=19402
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s7c-dst-b2
export PE_SSH_ENABLED=1 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
export PE_BACKUP_BUNDLE=/Users/jingchao/.config/power-evolve/s7c-backups/b1
node products/power-evolve/scripts/backup-trial.mjs restore
```

`restore` 先核验清单及源/目标路径，拒绝路径重叠（包括符号链接别名）、存活目标服务、非空数据目录和已存在的备份私有文件。`external` 在复制前完成数据库身份及空库核验；Compose 则先拒绝已有目标 PG 卷，准备新 PG 并等待连续可连接，再核验身份及空库。空库允许初始化内建对象和空 `public` schema；用户关系、函数、类型、collation、大对象、语言、事件触发器、FDW/server、publication/subscription、默认权限、数据库本地设置及内置 operator family 新增的 loose 成员都会导致拒绝。具体对象检查由上节链接的 PG 处理代码维护。

脚本使用 `pg_restore --exit-on-error --single-transaction` 并检查退出码。单事务只覆盖 dump 的数据库还原，不覆盖已复制的私有文件、POSIX 数据、权限准备或 Compose 资源；后续 schema、技能包或启动检查失败时，数据库还原也可能已经提交。默认恢复后启动应用并核对 schema；`PE_BACKUP_KEEP_STOPPED=1` 时保持应用停止，`restore-evidence.json` 记录 `keptStopped=true`，`readyAt` 与 `rtoToHealthMs` 为 null，不报告健康 RTO，也不代表已验证启动迁移。

失败后的目标可能保留复制内容、资源或已提交的还原数据，**不能在该目标上直接重试**。先停止目标应用并确认其 Sandbox/Runner 已清理：Compose 目标只对自己的 project 执行 `down -v`；外部 PG 由数据库操作者清理或重建本次独占的目标数据库，不删除复用的 PG 容器或共享资源。再清理仅属于该目标的私有目录和 POSIX 子目录，或改用另一套全新目标资源重新恢复。保留源端和备份不动。

云执行目标在启动前，按恢复 PG 中的工作区和用户归属，把 Workspace 与 Home 的复制条目设为执行器的 `1000:1000`，保留文件字节和权限位；只更改符号链接本身的所有者，不跟随目标。平台持有的技能包和产物不做该所有权转换；旧备份的 `0700` 用户技能挂载根仅转换为 Runner 可遍历的 `0755`，包内容、私有父目录及未知用户目录保持原样。修复数量写入 `restore-evidence.json`。运行恢复的身份必须有目标卷的相应 `chown` 权限，否则恢复失败且不启动写入者。新备份和恢复复制保留符号链接的原始目标文本；旧工具已改写的链接目标不能由该步骤推断还原。

源端可运行 `qa-s7c-restore-browser.mjs seed`，恢复后运行同脚本的 `verify`。需要设置源或目标的 `PE_PRIVATE_DIR`、`PE_HOST_PORT`、`PE_PLATFORM_PORT`，并把 `PE_S7C_EVIDENCE_FILE` 指向源端私有 `s7c-seed-v2.json`；同一文件用于恢复后比对。验证脚本在原生 Web 中分别登录 Alice/Bob，打开历史 Session，核对历史 STDIO 返回、Files、Artifacts 预览和 Plugins；通过 Host API 读回文件、技能、STDIO 连接，并检查 Git HEAD、Home、技能包字节及跨用户 404。`PE_S7C_NATIVE_PANE=files` 和 `artifacts` 分别验证两个右侧栏视图。测试数据文件和账号信息只保存在私有目录。

## 本机实测与故障恢复

2026-09-30 在 `s7c-src-b1` 以真实 `deepseek-flash` 模型生成 Alice/Bob 各自的 STDIO 工具调用与原 Session 续接，再播种各自的文件、Git 提交、工件、技能、Home 和技能包标记。停写快照含 112 个清单条目，其中 7 个私有配置文件；源端停写后到捕获完成为 **2,940 ms**，随后源端恢复服务。损坏备份副本追加一个字节后，恢复在写入目标前被完整性检查拒绝；目标 PG 卷及用户配置均未创建。

首次恢复到 `s7c-dst-b1` 时，PG 初始化重启窗口使 `pg_restore` 返回错误。该错误被显式判为失败；排查时在独立目标清空并重建数据库后，手动恢复成功。首次自动恢复到 `s7c-dst-b2` 又遇到同一 PG 初始化竞态，目标资源只清理了 `b2` 自己的容器、卷和已复制内容。脚本随后增加连续三次 PG 查询的稳定性等待，并在全新 `b2` 卷上完整自动恢复成功；没有忽略任何 `pg_restore` 错误。目标启动前 schema 为 V18，启动后为 V19，健康接口可用的恢复时间为 **34,356 ms**。当前代码进一步检查空目标数据库的所有 public 关系对象；此查询在空 `template1` 得到 0，在已恢复数据库得到 39。

| 数据项 | 源 V18 | 恢复 V19 |
| --- | ---: | ---: |
| 用户 | 2 | 2 |
| Session | 6 | 6 |
| 事件 | 58 | 58 |
| 工件 | 5 | 5 |
| STDIO 连接 | 2 | 2 |
| 用户技能 | 5 | 5 |

在最终自动恢复的 `s7c-dst-b2` 上，Alice/Bob 的原生 Files 和 Artifacts 两轮验证都通过：历史 Session ID 与实际 transcript、文件内容、Git commit、工件预览、STDIO 连接 ID/修订/启用状态、技能、Home/技能包字节一致；跨用户读文件、预览工件和切换连接均返回 404。源端与目标端健康接口分别返回 V18/V19、`stdioMcpAvailable` 和 `sshAvailable` 为 true；检查时两个 Sandbox 命名空间无活动 Sandbox，Connector 命名空间无 `pe-cr-*`/`pe-mcp-*` Runner Pod。验证记录位于目标私有目录的 `restore-evidence.json`、`native-files-verify.json`、`native-artifacts-verify.json`；种子记录位于源私有目录。登录密码和密钥均不在报告中。

以上恢复结果验证了历史读取；后续[当前版本预览](TRIAL-S7-CURRENT-PREVIEW.md)发现旧种子技能目录为 `0700`，且复制后的 `.git` 所有者无法供 Runner 写入。修复启动前所有权准备、技能根兼容和本地挂载检查后，全新 c3 从原 b1 自动恢复，两位用户均完成真实云 Git 提交及重启后读回，未人工修改权限或 PG。其恢复耗时和逐项证据以预览报告为准；旧备份的技能目录只有状态标记，并非真实安装包的恢复演练。

本次 RPO 是**备份捕获时刻**：成功停止写入后，已确认的源端状态完整进入快照。若发生在两次备份之间的故障，可恢复到的最近时点取决于备份频率；本演练未验证定时备份。34,356 ms 是这一台本机从启动恢复到服务健康的 RTO；两轮顺序浏览器核验分别在恢复开始后约 76.7 秒和 123.3 秒完成，包含测试脚本调度时间。该 k3d 与 POSIX 卷都位于同一台 OrbStack 主机，结果不证明异机共享存储一致性、备份异地保存、物理节点损坏后的恢复或生产级 RPO/RTO。

备份包中有明文登录凭据和模型、加密密钥；本机试验只用文件权限保护，没有验证外部存储加密或密钥托管。清单校验能发现意外损坏，但未签名，不能把来自不可信来源的备份包当作可信输入。

最终恢复目标 <http://127.0.0.1:19401/login> 保留供复查。验收完成后，本机源端和目标端的 Platform 进程都曾因 PG 连接意外断开而退出，PG 容器没有重启；目标 V19 Platform 已单独重启，Alice/Bob 的原生 Files、历史、Plugins，以及 Git、工件 API 和跨用户拒绝检查再次通过。源端 PG 和 POSIX 字节仍保留为 V18 迁移样本，暂不以当前 V19 程序重启源 Platform，故源登录页当前不可用。异常断连的根因不在本演练中确定。私有目录权限为 0700，备份目录为 0700，私有文件为 0600。中间诊断目标 `s7c-dst-b1` 亦为独立资源；此前的 S6 稳定试用未改动。
