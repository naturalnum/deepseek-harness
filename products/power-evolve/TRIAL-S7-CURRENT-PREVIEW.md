# S7 当前代码独立恢复预览

2026-09-30 从只读 S7c b1 备份恢复到全新的 `s7-preview-v19-c3`，没有改动源 V18、S6 固定试用或旧 S7c 目标。原生 Web 静态快照来自固定产品提交 `8dc235181f294c331c0b364849f11b0bd5308633`（36 个客户端模块、231 个静态文件）；当前恢复脚本和 Platform 运行时代码为预览分支提交 **`1b2e70319c8533a59146ba02de958e40f66df969`**，含主线修复 `a7a7d4e131` 与 `6eca12da2e`。两个修复没有改前端源码；本 worktree 使用既有静态快照和定向 `pnpm exec tsc -b products/power-evolve/application/tsconfig.json --pretty false`，没有重新运行全仓构建。本机预览不等于跨物理机生产发布验收。

## 保留的 c3 试用

| 项目 | 固定值 |
| --- | --- |
| 登录 | <http://127.0.0.1:19441/login> |
| 原生 DSH Web | <http://127.0.0.1:19440/native/> |
| 试用名与 PostgreSQL 端口 | `s7-preview-v19-c3`，`18542` |
| 私有配置与验收记录 | `/Users/jingchao/.config/power-evolve/shared-host-s7-preview-v19-c3/`（0700） |
| 独立 Sandbox 命名空间 | `pe-s7-preview-v19-c3`，上下文 `k3d-pe-e32-session-probe` |
| 日志与 Web 静态快照 | 本 worktree 的 `.artifacts/power-evolve/s7-preview-v19-c3/` |
| 只读来源备份 | `/Users/jingchao/.config/power-evolve/s7c-backups/b1`；源 `s7c-src-b1` |

Alice/Bob 的密码只在上述私有目录的 `users.json`；不要复制到聊天或仓库。c3 的 Host、Platform、API、PG 卷、POSIX 数据和原生 Web 静态快照均保留。在本报告所在 worktree `/Users/jingchao/agent_work/main_agent/power-evolve-s7-preview` 使用下列环境管理，仅作用于 c3：

```sh
export PE_TRIAL_NAME=s7-preview-v19-c3 PE_DATABASE_PORT=18542
export PE_HOST_PORT=19440 PE_PLATFORM_PORT=19441 PE_TARGET_PORT=19442
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s7-preview-v19-c3
export PE_SSH_ENABLED=0 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷与文件。最后一次重启后的 `status` 为 API `19442`、Platform `19441`、Host `19440` 均运行；Platform `/health` 为 `ready: true`、schema **19**，`sshAvailable: false`、`stdioMcpAvailable: false`。本预览没有新 SSH/STDIO 调用验收；恢复后的旧 STDIO 结果与连接元数据只验证可读，S6 连接器专项试用仍独立保留。

## 干净恢复与双用户实测

1. c3 是新私有目录、端口、PG 卷、POSIX 根及 Kubernetes 命名空间。使用修复后的 [`backup-trial.mjs`](scripts/backup-trial.mjs) 从原 b1 自动恢复，未人工 `chmod`、`chown` 或改 PG。恢复前校验备份清单；启动前 schema **18**，启动后 **19**；到健康接口可用为 **15,922 ms**。私有 `restore-evidence.json` 记录 `skillMountPermissionsRepaired: 2`、`executionEntriesPrepared: 144`。备份中的两个技能目录仅含 S7c seed marker；恢复程序只兼容其 0700 用户挂载根，不递归改包文件。
2. 现有 [`qa-s7c-restore-browser.mjs`](scripts/qa-s7c-restore-browser.mjs) 在 Alice/Bob 两个原生浏览器账号分别通过 `files`、`artifacts` 右栏两轮：历史 Session/回复、文件、产物、技能、STDIO 元数据、Home/技能包 marker 和原有 Git HEAD 均读回；跨账号读取文件/产物、切换对方连接返回 404。私有 `native-files-verify.json` 与 `native-artifacts-verify.json` 留存结果。上述是历史 STDIO **读取**，不是新执行。
3. Alice/Bob 各自新登录、开新 Session，发送字面 `hi`，再问上一条消息是什么。四条真实 DeepSeek 操作均完成，各账号的两轮在同一 Session，两个模型回复分别明确写出上一条为 `hi`；原生事件含 `assistant/message`。两个新 Session 的 `pe_sandbox_instances` 均为 **0**，普通对话未启动 Sandbox。每人又在本人 Session 写入并发布新文件为产物，预览读回；对方读取文件或产物返回 404。私有 `current-preview-evidence.json` 记录 Session/操作/产物 ID。
4. Alice/Bob 分别要求模型使用 `cloud_exec` 写文件并执行 Git add/commit。两次真实调用都为 `succeeded`，独立 Sandbox Pod UID 为 Alice `dec7c076-df6f-4dde-ad79-12e3b7953ab3`、Bob `d2c171da-3b59-439a-b9fe-bb982187ebaf`；Git HEAD 分别为 `6e060847f670`、`5dcd81c8687b`，文件字节读回匹配。私有 `alice-cloud-git-evidence.json`、`bob-cloud-git-evidence.json` 保存操作、Pod 和完整 HEAD。全程未人工修复恢复目录权限，也未手改 PG；这与先前 c2 的失败形成直接对照。
5. 运行上述 `trial.mjs restart` 后，Alice/Bob 的新会话历史、新文件与产物再次通过浏览器登录和产品 RPC 读回；两个 Git HEAD/文件仍保留。检查时 c3 命名空间无 Sandbox 或 Pod，Platform 健康且 schema 19。以上分别是本机真实模型/Pod 试用和恢复脚本结果；主线程另在修复提交上完成产品构建及挂载/POSIX 回归 13/13，本 worktree 不重复全套测试。

## 先前目标与发布边界

- `s7-preview-v19-c1` 因复用 SSH QA 配置但新连接器命名空间缺 `power-evolve-forbidden-listener` Service，在 Platform 启动时失败；该目标已停进程并保留部分恢复现场，没有原地重试。它是试用配置缺项，不能视为 c3 SSH 验收。
- `s7-preview-v19-c2` 成功恢复，但旧技能 marker 用户目录的 0700 模式使 Alice 首次云执行在 Pod 创建前 `uncertain / mount_skill_package_root_unavailable`，留下 reserved 槽；Bob 的旧 `.git` 在恢复后成为 UID 0:0，首次真实 Pod Git 写入被拒。c2 只经人工调整目标目录模式和 Bob `.git` 所有权后完成部分云 Git，继续保留为失败/人工修复样本；它不是双用户云编程通过的证据。c3 用新修复从**原 b1** 全新自动恢复并通过两用户云 Git，没有覆写 c2 或源备份。
- 所有试用都在单台 macOS/OrbStack/k3d 主机，模型来自私有 `model.env` 的真实 DeepSeek 配置。独立物理机、真实 RWX 卷、外部 PostgreSQL、HTTPS Ingress、生产出口、容量及回滚仍未验收；详见 [S7 集成边界](TRIAL-S7-INTEGRATED.md)。
