# S8 技能包备份与恢复证据复核

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

复核日期：2026-09-30，时区 Asia/Shanghai。原验收固定提交：`dca63cfcc523b848218db4298046ac180248b816`。本记录基于主线 `59b736bafe873422606f360a85cf2ecbeadcd413` 编写，只复核工程师2保留的原始证据，没有重跑备份、恢复或长测试。

## 结论与版本范围

运行 `ad58a16856` 的终态为 `passed`、`cleaned=true`。原始日志、断言脚本和固定提交的实现相符，支持旧目录技能包的真实 PostgreSQL 备份、全新目标恢复、读取和授权状态保留。本记录不代表新版技能包的真实模型会话、报告生成或云执行已经通过。

该次验收使用旧目录中的九个内置包，并上传同一自定义技能的 `1.0.0`、`2.0.0` 两个版本。`59b736bafe` 发布的 Word、Excel、PowerPoint、LaTeX `1.0.1` 和技术报告 Word `1.1.32` 不在该次备份快照中；新版安装、历史版本选择及真实会话需要各自的验证证据。

## 原始证据位置与校验值

证据保留在原 checkout `power-evolve-s6-stdio-recovery` 的 `.artifacts/power-evolve/engineer2-fullchain/` 下，未纳入 Git。本次复核时该 checkout 的 HEAD 为上述 `dca63cfcc523`，且没有跟踪文件修改。原运行读取编译后的 `application/lib/platform/skills.js`；证据未保留构建日志或编译产物的独立校验值。

| 文件，相对证据根 | SHA-256 |
| --- | --- |
| `ad58a16856/evidence.json` | `74080415c90294fab191fed940715d22f919d3b8d2568f986ff0405024a29f69` |
| `run.mjs` | `492523f2835e8ac862b8a3cd97ba28545a9fd1d7588c5b41fe1e23fc695da47c` |
| `ad58a16856/06-backup-create.log` | `f8186ef42883b12f2e334d7041260226c4725251381dac37114cd65043549ac6` |
| `ad58a16856/07-backup-restore.log` | `7c6d68db5608e451f24689df712955ff1588e3658dad516eb9d842555ef1eb7d` |

成功运行目录共有 12 份阶段日志，覆盖独立网络创建、准备、源端启动、两次 ZIP 制作、备份、恢复及清理。日志未输出凭据；本记录不复制用户文件、技能指令正文、数据库连接串或身份令牌。

## 核对结果

| 核对项 | 原始断言与观察 | 范围 |
| --- | --- | --- |
| 源端与目标端进程 | `sourceInitialHealth`、`sourceRestartedHealth`、`targetHealth` 均有 api/platform/host 三项 `ready=true`；源端三项 instanceId 在备份后均改变 | `realProfiles=6` 是六个健康服务角色；实际为四个 DSH Profiles 加两个试用 API 进程，见下文 |
| 真实 PG 备份与恢复 | `run.mjs` 调用实际 `backup-trial.mjs create/restore`；该实现执行 Docker 内 `pg_dump --format=custom` 与 `pg_restore --exit-on-error`；源端日志显示 PG 健康，恢复日志显示 schema `20 -> 20` | 无 schema 升级场景；恢复前实现检查目标卷不存在和 public schema 为空 |
| 包版本与安装收据 | 源端读取 `pe_skill_package_versions` 的 11 行及 `pe_builtin_skill_install_requests` 的 9 行，恢复后逐行 `deepEqual` | 11 个版本为九个旧内置版本和两个上传版本；9 是收据行数，不是用户或会话数 |
| 包文件与权限位 | 源自定义技能库、备份库和恢复库的目录 mode、文件长度、SHA-256 清单均 `deepEqual` | 包文件字节与 POSIX 权限位；未比对 UID/GID，未覆盖符号链接样例 |
| 历史版本与当前读取 | 旧 `1.0.0` 的封存选择通过 `SkillService.readSelected` 读回并与源端相等；当前 `2.0.0` 的 `/skills/read` 返回与源端相等 | 技能版本读取；没有历史 Session 继续运行或执行挂载验证 |
| 禁用保留 | 源端禁用 Word；目标 `/skills/list` 全量结果与源端相等，保留 `enabled=false` | 禁用状态保留；未尝试执行禁用技能 |
| 撤销保留与拒绝 | 源端撤销 PDF；目标列表保留状态，目标 `readSelected` 对原选择拒绝，错误码为 `skill_revoked` | 撤销技能的版本读取拒绝 |
| 跨用户拒绝 | 非所属用户在源端及目标端读取上传技能均返回 HTTP 404 | 两个合成试用用户，当前上传技能的读取接口 |
| 执行状态 | 恢复后的 SQL 计数为 `pe_cloud_executions=0`、`pe_sandbox_instances=0`、`pe_operations=0`；恢复记录的 `executionEntriesPrepared=0`、`skillMountPermissionsRepaired=0` | 无执行、Sandbox 或操作需要恢复，不能据此判定运行中执行恢复已通过 |

启动方式已与 [trial.mjs](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/trial.mjs) 核对：源端 `bfull-ad58a16856-src` 和目标端 `bfull-ad58a16856-dst` 各启动 `power-evolve-host`、`power-evolve-platform` 两个真实 DSH Profiles；api 角色由 [trial-api.mjs](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/trial-api.mjs) 的 loopback 远程 API fixture 提供。身份登录和技能操作访问真实 Platform API 与 PG。脚本没有模型请求步骤，`modelCalls=0` 是运行记录的标注，并非独立的提供方调用审计。

源端通过显式 `PE_SKILL_LIBRARY_ROOT` 使用私有根以外的合成技能库；脚本检查 `storage-layout.json`、备份 manifest 的 `storage.skillLibraryRoot` 与该根一致。目标恢复至其私有目录下的默认 `skill-library`，并再次检查所有包版本文件。相关实现入口为 [backup-trial.mjs](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/backup-trial.mjs) 和 [backup-posix.mjs](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/backup-posix.mjs)，这两个文件在原固定提交与本记录基线之间没有差异。

## 时间测量

| 指标 | 原始值 | 定义与限制 |
| --- | ---: | --- |
| 备份 writer freeze | 903 ms | `06-backup-create.log`；实现按 `capturedAt - stoppedAt` 计算，从停服务命令返回至文件清单采集完成，不含停止耗时、manifest 落盘、目录发布和源端重启耗时 |
| 恢复到健康 | 14,782 ms | `restore.readyAt - restore.startedAt = 1790733127080 - 1790733112298`；从进入 restore 分支至目标 `trial up` 完成，随后三个健康接口均通过 |
| schema | `20 -> 20` | 恢复完成和目标启动后相同，没有迁移耗时或升级兼容性结论 |

备份捕获时间为 2026-09-30 09:51:49.128 +08:00；恢复开始为 09:51:52.298，健康时间为 09:52:07.080。903 ms 不是完整用户不可用时间，14,782 ms 不是生产环境恢复时限承诺。原备份 manifest 已随清理删除，无法从保留 JSON 单独重算 903 ms；该值由日志和固定实现的计算式支持。

## 复跑入口与限制

复跑入口是原 checkout 中保留的 `.artifacts/power-evolve/engineer2-fullchain/run.mjs`。它依赖固定旧提交及其已安装、编译的运行产物、Docker/Compose、`zip`、本地可用的 PG 镜像，以及私有配置根的写权限。原 PG 日志包含 amd64 镜像运行于 arm64 Host 的平台提示，随后健康检查通过。脚本创建随机试用名、私有目录、端口和自有外部网络，执行原链路并尝试清理；本次复核没有执行以下长测试入口。

```sh
# 从固定 dca63cfcc523 checkout 的仓库根运行；先核对 HEAD。
git rev-parse HEAD
node .artifacts/power-evolve/engineer2-fullchain/run.mjs
```

脚本指定 Word `1.0.0`，且证据根中的脚本未入 Git；在 `59b736bafe` 新目录上直接运行不是新版验收入口。复跑会生成新的随机运行目录，不能复用旧运行的时间、实例 ID 或结果。原备份 bundle、数据库、私有状态、逐项文件清单和 PG 行内容已清理；保留的终态 JSON 是断言摘要，不能在原数据库上再次逐行核验。这里的 SHA-256 标识保留证据文件，不能替代已经删除的备份 bundle 校验值。

## 清理核对

`08`、`10` 日志分别记录源端和目标端 api/platform/host 停止；`09`、`11` 记录各自 PG 容器和卷删除；`12` 记录自有网络删除。`evidence.cleaned=true` 与脚本的清理路径相符。

本次只读检查确认：Docker 中不存在名称含 `bfull-ad58a16856` 的容器或卷，不存在 `pe-bfull-ad58a16856` 网络；日志所指临时私有根及两个试用的 `.artifacts/power-evolve/<trial>` 目录不存在。原始证据 JSON、12 份日志及父目录脚本仍保留。本次未启动或停止任何服务、创建执行资源或删除数据。
