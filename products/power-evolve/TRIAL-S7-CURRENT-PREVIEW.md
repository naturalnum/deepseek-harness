# S7 当前代码独立恢复预览

固定代码提交：`8dc235181f294c331c0b364849f11b0bd5308633`（独立 worktree 分支 `qa/s7-current-preview`）。2026-09-30 从只读 S7c b1 备份恢复到全新的 `s7-preview-v19-c2`，没有改动源 V18、S6 固定试用或旧 S7c 目标。本次是本机 S7 预览，不是跨物理机生产发布验收。

## 保留的试用

| 项目 | 固定值 |
| --- | --- |
| 登录 | <http://127.0.0.1:19431/login> |
| 原生 DSH Web | <http://127.0.0.1:19430/native/> |
| 试用名与 PostgreSQL 端口 | `s7-preview-v19-c2`，`18541` |
| 私有配置与脱敏试验记录 | `/Users/jingchao/.config/power-evolve/shared-host-s7-preview-v19-c2/`（0700） |
| 独立 Sandbox 命名空间 | `pe-s7-preview-v19-c2`，上下文 `k3d-pe-e32-session-probe` |
| 日志与 Web 快照 | 本 worktree 的 `.artifacts/power-evolve/s7-preview-v19-c2/` |
| 只读来源备份 | `/Users/jingchao/.config/power-evolve/s7c-backups/b1`；源 `s7c-src-b1` |

Alice/Bob 的密码仍只在上述私有目录的 `users.json`；不要复制到聊天或仓库。试用进程、PG 卷、POSIX 文件和原生 Web 快照均保留。管理命令须从本报告所在 worktree `/Users/jingchao/agent_work/main_agent/power-evolve-s7-preview` 执行：

```sh
export PE_TRIAL_NAME=s7-preview-v19-c2 PE_DATABASE_PORT=18541
export PE_HOST_PORT=19430 PE_PLATFORM_PORT=19431 PE_TARGET_PORT=19432
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s7-preview-v19-c2
export PE_SSH_ENABLED=0 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 只停止本试用的 Host、Platform 与 API 进程，保留 PG 卷和数据。2026-09-30 最后一次 `status` 为 API `19432`、Platform `19431`、Host `19430` 均运行；Platform `/health` 为 `ready: true`、schema **19**、`sshAvailable: false`、`stdioMcpAvailable: false`。SSH 和 STDIO 新调用未在此预览验收，旧的历史 STDIO 结果只验证可读。旧 S6 专项连接器试用仍独立保留。

## 实测

1. `pnpm install --frozen-lockfile` 与 `pnpm run build` 在固定 worktree 通过；构建出的原生 Web 为 36 个客户端模块、231 个静态文件。`backup-trial.mjs restore` 校验 b1 的 112 条清单并恢复 PG 与 POSIX 字节，启动前 schema **18**，启动后 **19**；到健康接口可用为 **34,634 ms**。记录在私有 `restore-evidence.json`。本次没有运行全套测试。
2. 现有 [`qa-s7c-restore-browser.mjs`](scripts/qa-s7c-restore-browser.mjs) 在两个独立浏览器账号分别通过 `files` 和 `artifacts` 两轮：历史 Session/回复、右栏文件与产物、技能条目、STDIO 连接元数据、Home/技能包标记及原有 Git 提交均读回；跨账号读取文件/产物和切换对方连接为 404。脱敏结果在私有 `native-files-verify.json`、`native-artifacts-verify.json`。这验证历史数据，未在本轮重新执行 STDIO 工具。
3. 新浏览器登录后，Alice/Bob 各自开新 Session 发送字面 `hi`，再问上一条消息是什么。四条真实 DeepSeek 操作都完成，各账号的两轮在同一 Session；两人第二轮均答出上一条为 `hi`。原生事件含 `assistant/message`，对应模型 token 用量可在会话页检查。两个新 Session 的 `pe_sandbox_instances` 均为 **0**，没有因普通对话启动沙盒。每人随后经产品 RPC 在本人 Session 写文件、发布并预览产物；跨用户文件和产物读取均为 404。私有 `current-preview-evidence.json` 记录 Session、操作和产物 ID。
4. Bob 的新云 Git 请求由真实模型调用 `cloud_exec`，实际 Sandbox Pod UID 为 `a77d5f10-e5dd-452e-bf41-f705f785e9b4`；在隔离目标修正恢复后的 `.git` 所有权后，Runner 写入文件并提交，HEAD 为 `0c7a30dd5dd9e64b25d61101794d56426734e465`。私有 `cloud-git-evidence.json` 保存操作/Pod/Git 对照。随后运行上述 `trial.mjs restart`，Alice/Bob 的新会话历史、新文件和新产物均再次读回；Bob 的 Git HEAD 与文件也保持。检查时目标 Sandbox 命名空间已无 Sandbox 或 Pod。

## 失败与限制

- 第一个全新目标 `s7-preview-v19-c1` 的 PG dump 已还原，但 Platform 启动因复用的 SSH QA 配置引用新连接器命名空间中不存在的 `power-evolve-forbidden-listener` Service 而失败。错误见该目标 `.artifacts/power-evolve/s7-preview-v19-c1/platform.log`。该目标仅停了进程、保留部分写入现场；没有原地重试恢复。`c2` 关闭可选 SSH fixture 后重新从同一只读备份恢复成功。这是本次配置缺项，不能推断恢复脚本能自动配置 SSH fixture。
- b1 包中的 `skill-packages/<userId>` 是 S7c 播种的 0600 marker 文件，用户目录原为 0700，并非真实 ZIP 展开包。恢复后 [`Sandbox` 挂载校验](application/src/platform/sandbox.ts#L111-L129)要求用户目录可读/可执行；Alice 首个 `cloud_exec` 因 `mount_skill_package_root_unavailable` 在创建 Pod 前进入 `uncertain`，留下 `pe_mount_slots.reserved` 与 `pe_sandbox_instances.creating`。此后她的新执行尝试得到 `mount_slot_reserved`。本次仅把 **c2** 的两个 marker 用户目录调为 0755 以继续试用，没有修改备份、源或 PG；Alice 槽未人工清理，她的云执行当前不可用。该失败已经交给产品/恢复实现修复，不能把 Bob 的成功扩展为双用户云执行通过。
- Bob 的首个真实 Pod 已启动，但恢复后的 `.git` 为 UID 0:0、mode 0755，Runner UID 1000 无权创建 `.git/branches`，该次调用失败。备份中的 `.git` 为本机 UID 501:20；Node `fs.cp` 到 OrbStack 目标未保留执行所有权。本次只在 **c2** 的 Bob 工作区 `.git` 子树运行宿主 `chown -R 1000:1000`，随后新请求成功。历史 Git 可读不能代表恢复后可继续写；干净恢复仍需产品修复和新目标重验。
- 原生 Web 试用位于单台 macOS/OrbStack/k3d 机器，模型使用私有 `model.env` 的真实 DeepSeek 配置。独立物理机、RWX 存储、外部 PG、真实 Ingress、生产出口、容量及回滚仍未验收；详见 [S7 集成边界](TRIAL-S7-INTEGRATED.md)。
