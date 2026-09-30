# S7c：独立试用的停写备份与恢复

本演练在独立的 PostgreSQL 卷、POSIX 子目录、私有配置、端口和 Kubernetes 命名空间中，从仍运行 V18 的源试用制作一致性快照，再用当前 V19 程序恢复到全新试用。脚本只管理指定试用，不清理其他试用。备份包含 PG 自定义格式 dump、`workspaces`、`homes`、`skill-packages`、`artifacts` 的字节，以及重建登录、模型和加密状态所需的私有配置。Kubernetes kubeconfig、Sandbox 与 Connector Runner 的调度配置由目标试用单独创建，不能照搬源环境的路径或命名空间。


## 当前脚本的存储布局

`prepare-trial.mjs` 在私有目录记录 `storage-layout.json`（0600），并把实际工作区、产物及技能根写入生成的 Profile。无沙盒的技能根默认为 `$PE_PRIVATE_DIR/skill-library`；云沙盒使用 `sandbox.json` 的 `localRoot`。自定义 `PE_SKILL_LIBRARY_ROOT` 须在首次准备时指定，后续启动保留记录的路径；改变根会被拒绝，应通过新试用恢复迁移，不能直接修改记录冒充数据迁移。已有试用升级后，首次备份前须以原实际存储根运行 `prepare-trial.mjs`，缺少记录时备份不会猜测路径。

新备份使用格式 2，在清单中保存存储布局；归档内仍以 `data/skill-packages` 命名。创建和恢复按各自实际技能根映射，并核对 PG 中全部包版本的文件、大小与哈希，包含历史版本、停用及撤销包；完整技能树也保留报告套件。恢复继续接受有效的格式 1 备份。旧备份若已漏掉 PG 记录对应的包字节，恢复会明确失败，不能靠重装当前目录替代丢失的历史版本。

这些规则适用于当前脚本；下文记录的 V18→V19 数据、耗时及浏览器验收仍是原固定版本的证据。真实包的定向恢复回归覆盖布局映射、PG dump/restore 和包读取；完整生命周期的独立复测另行记录，不把定向测试计为生产 RTO 验收。

## 使用方法

在仓库根目录安装依赖并构建产品及原生 Web。试用还需要 Docker/OrbStack、kubectl、可用的 Sandbox 控制器与 Runner 镜像、Playwright Chromium，以及目标试用独有的 `sandbox.json`、`ssh.json` 和限权 kubeconfig。准备方式沿用 [S6 原生试用](TRIAL-S6-FINAL-QA.md)；两个 JSON 的 `localRoot`、`nodeRoot`、`workspaceRoot`、命名空间和端口应指向目标独有资源。目标私有目录必须位于 `~/.config/power-evolve/` 下，目标 PG 卷尚不存在。`model.env` 留在私有目录，不能提交到仓库。

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

`create` 先停止指定试用的 Host/Platform 写入进程，确认没有未结束的 PG 操作、Sandbox 对象或 Connector Runner Pod，再执行 `pg_dump` 和 POSIX/私有配置复制；目录清单记录每个文件的 SHA-256 和符号链接目标。完成后原子发布备份目录并重启源试用。失败时删除未完成的临时目录并尝试重启源试用；若重启失败，应立即用同一组环境变量运行 `trial.mjs status`、检查日志并修复源试用。源端运行期间不要直接复制卷来替代此停写步骤。

恢复前创建全新目标私有目录及独有 `sandbox.json`、`ssh.json`、kubeconfig 和命名空间，不运行 `prepare-trial.mjs`，以免预先生成本应从备份恢复的私有文件。示例目标环境：

```sh
export PE_TRIAL_NAME=s7c-dst-b2 PE_DATABASE_PORT=18537
export PE_HOST_PORT=19400 PE_PLATFORM_PORT=19401 PE_TARGET_PORT=19402
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s7c-dst-b2
export PE_SSH_ENABLED=1 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
export PE_BACKUP_BUNDLE=/Users/jingchao/.config/power-evolve/s7c-backups/b1
node products/power-evolve/scripts/backup-trial.mjs restore
```

`restore` 在改动目标前核验清单，拒绝已有 PG 卷、非空数据目录和已存在的备份私有文件。它等待 PG 连续可连接，确认 `public` schema 中没有关系对象后，严格检查 `pg_restore --exit-on-error` 的退出码；随后启动当前代码并检查迁移后 schema。失败后的目标可能已含部分复制内容或部分 PG 表，**不能在该目标上直接重试**。先停止该目标，用其 Compose project 执行 `down -v`，确认本目标的 Sandbox/Runner 已清理，再删除仅属于该目标的私有目录和 POSIX 子目录；更稳妥的方式是新建另一个试用名、端口、卷、命名空间重新恢复。保留源端和备份不动。

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
