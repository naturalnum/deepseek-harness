# Cloud 不确定执行结案：本机固定试用

## 已验证范围

2026-10-04，应用源码固定为 `671c94e0d9aad7f0c8b89273abd1ab7cd6c69abc`，官方 DSH 基线为 `dsh-v0.1.7-rc.2`。原生 DSH Web、真实 DeepSeek、两个 Host、两个 Platform、PG、共享 POSIX 和真实 k3s Runner 参与人工结案流程。它是[不确定执行结案约定](EXECUTION-RESOLUTION-COMPLETION.md)的 Cloud 本机验收；Device、SSH 结案和生产部署仍未通过本片验收。

| 实际场景 | 观察结果 |
| --- | --- |
| Alice、Bob 分别全新登录并发送 `hi` | 两条真实模型对话完成，执行记录及 Sandbox 数量不增加 |
| C2：原 Runner 通道失联，可信页面提交结案 | 原命令保留 `closed_unknown`；确切停止后释放槽，原会话续接一次；另一个新命令可创建新代次环境 |
| C3：双份停止证明持久化后，两个 Platform 退出 | 新副本沿用原请求和证明；旧 Pod 消失后结案，原会话续接一次 |
| C4：首次受理响应未被读取，停止证明生成前两个 Platform 退出 | 恢复先查询原 requestId；相同内容重试返回同一回执，改变内容返回 409；权限恢复后取得真实停止证明并结案 |
| 本人／另一用户、审批 audience、Origin、指纹 | 本人可读；跨用户返回 404，错误凭据或 Origin 被拒绝；篡改指纹返回 409；Host 没有结案写入口 |
| 固定版本正常停服并重启 | 八张业务表完整行摘要和三个测试文件字节不变；两用户浏览器读回原历史 |

C2–C4 各自的原命令只有一条执行记录，续接操作各只有一条且已完成。三个工作区文件通过授权文件 API 读回，Bob 读取均为 404；读文件前后物理 Runner Pod 都为零。文件中各有一次 START 和 END，只说明保留下来的文件内容，不能据此把原执行改成成功。

C2、C3 的停止确认来自真实可信浏览器页面。C4 使用有界 Node HTTP 客户端在响应头到达时关闭连接，不读取首次受理 JSON；它不是浏览器网络故障模拟。可信页面及原生执行对账区随后实际读回同一回执。故障注入只改确切 QA Service selector、测试 finalizer 或临时收紧 QA Role 的 Sandbox 删除权限；这些测试修改均已清理，未伪造 kubelet 证明。

## 试用

原生入口为 <http://127.0.0.1:20034/native/>，可信登录为 <http://127.0.0.1:20036/login>。测试账号为 `alice`、`bob`；沿用本机私有目录 `/Users/jingchao/.config/power-evolve/report-r9-restore-check-20261003/projection/users.json` 中的测试密码，不在本文记录凭据。

1. 用 Alice 登录原生入口，查看现有会话，发送普通对话并刷新查看历史。
2. 打开输入区的“执行对账”，查看 C2–C4 的“已停止，结果不明”和持久请求编号；“前往独立可信审批页”使用独立审批身份。
3. 在同一会话中请求一个新的小型云端编程任务；新任务按需启动环境，工作区文件保留。不要重放已结案的测试命令。
4. 另一个浏览器用 Bob 登录；其历史、文件和执行列表仅显示本人资源。

本片实际验收包含前两项与双用户隔离；C2 后的新代次执行已有真实证据。平台未暴露任意测试故障按钮。IAB 中链接的 `target=_blank` 未实际打开新页，验收通过观察到的准确 URL 打开可信页，不能记为该浏览器的一键跳转已经通过。

## 固定版本与启停

应用镜像为 `docker.io/library/pe-resolution-app@sha256:c61b59132b3c9a7c8a6b42d84c3a0d436fbaad2ae57c5bd9d3d24a331716d9b3`；Runner 镜像为 `docker.io/library/pe-release-cloud-runner@sha256:286e886c1cb7f65ce10eb67c825121fbe6ac4c2085d794be1533a309b7e31b27`。运行目标是 `k3d-pe-e32-session-probe` 中的 `pe-report-r9-restore-qa`，数据库为 `pe_report_r9_restore_20261003`，schema 为 28，文件根与原报告试用分开。原 [R9 报告试用](TRIAL-S8-REPORT-WORKFLOW.md)已停止，保留 schema 27、原镜像和数据；不能用 R9 的旧镜像启动本目标。

在仓库根运行以下已实测命令；operator 校验其九个冻结文件的摘要以及确切 Deployment 身份。`stop` 只在持久任务与物理执行环境空闲时停止 Host，再停止 Platform，并保留 PG、文件和 Secrets；`start` 要求已保存的停服围栏以及其他应用试用零副本。

```bash
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/execution-resolution-c1-20261004/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/execution-resolution-c1-20261004/fixed-trial.mjs stop
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/execution-resolution-c1-20261004/fixed-trial.mjs start
```

运行日志通过 `kubectl --context k3d-pe-e32-session-probe -n pe-report-r9-restore-qa logs deployment/power-evolve-host` 或 `deployment/power-evolve-platform` 查阅；逐 Pod 转发和 loopback 代理日志保留在下述证据根。固定 operator 仍使用本机 Node、kubectl、已有 PG 工具及依赖目录，不是离线安装包。

## 完成结案的备份恢复

正式 `deploy/backup.mjs create` 从空闲 2＋2 捕获停写围栏并生成 format-3、schema 28 快照，路径为 `/Users/jingchao/.config/power-evolve/backups/cloud-resolution-c1-20261004-a`，包含 3,224 个 inventory 条目。正式 `restore` 将其恢复到独立空库 `pe_cloud_resolution_c1_restore_20261004` 和新 POSIX 根；目标应用未启动。七张相关表的完整行摘要、V28 约束及 JSON 字段定义、三个原执行的身份、停止证据、持久回执、唯一完成续接和三个文件哈希，与停写来源一致；最后一个槽的双份证明和释放状态也保留。

原目标通过同一围栏 `resume` 恢复为 2＋2，并刷新逐 Pod 转发。此检查验证完成结案的持久数据恢复；未重复真实浏览器故障，也未验证运行中意图的备份。正式 idle guard 拒绝未结案的 `uncertain` 执行及 `accepted/stopping` 意图，不能以停服复制绕过对账。快照不包含 OCI 镜像或完整离线依赖。

## 回归、证据与限制

实际构建、类型检查、Host／Platform 路由、可信页面 DOM、原生客户端及真实 PG 结案回归通过。自动测试中的模型和 Kubernetes Runner 替身只验证相应分支，不计入上述真实故障证据；停用账号、错误／缺失证明和过期 epoch 的自动回归也不等于对应的真实集群演练。

证据根为 `.artifacts/power-evolve/release-integration/execution-resolution-c1-20261004/`：`two-user-hi-no-sandbox.json`、`real-http-denials.json`、`real-http-idempotency.json`、`c3-final.json`、`c4-*.json`、`persistent-markers.json`、`trial-restart-before.json`、`trial-restart-after.json`、`resolution-backup-before.json`、`resolution-backup-after.json`、镜像构建／导入记录及原生浏览器截图。C4 首次 operator 的业务检查通过，但套接字集合清理存在时序误报；修正 QA helper 后继续查询原请求，未重发首次受理。该原始失败证据保留。

本次运行目标来自 R9 的独立恢复数据并迁移到 V28。真实节点失联、删除响应丢失、停用账号全过程、生产 HTTPS/CNI、独立物理节点和目标容量未因本机验收而标为通过。后续按[桌面复用约定](DESKTOP-COMPLETION.md)先补 Device 的持久身份、受限停止回执和目录写者协调，再装配官方桌面宿主。
