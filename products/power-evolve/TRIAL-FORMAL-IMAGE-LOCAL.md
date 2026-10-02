# 正式镜像本机固定试用

本机试用采用原生 DSH Web、两个共享 Host、两个独立可信 Platform、真实 PG、k3s＋Agent Sandbox 和同机 POSIX 卷。运行镜像来自 `54c4fe23f57258f53682a4500747e986b097c137`，正式备份工具来自 `95cc9b6d0b1cb13f1b2f28f1e2a36f5aebb5c659`；官方 DSH 基线是 `dsh-v0.1.7-rc.2`。这是 Mac 单机 HTTP 试用，不代表生产 HTTPS、跨物理节点或外部数据库验收。

## 入口与登录

- 原生应用：<http://127.0.0.1:19904/native/>。
- 可信登录：<http://127.0.0.1:19906/login>；审批入口：<http://127.0.0.1:19906/approval>。
- 两个测试账号为 `alice`、`bob`。密码保存在本机权限为 `0600` 的 `/Users/jingchao/.config/power-evolve/formal-restored-20261003/projection/users.json`，不写入文档或聊天。使用两个不同浏览器验证两用户。

## 固定资源

| 资源 | 本机试用配置 |
| --- | --- |
| Kubernetes context | `k3d-pe-e32-session-probe`，单个节点 |
| 应用／云执行／连接器 namespace | `pe-formal-restored-qa`／`pe-formal-restored-runners`／`pe-formal-restored-connectors` |
| 应用镜像 | `docker.io/library/pe-release-app@sha256:ba24807afab11b884e95ef32db09a9d0b620815c462dc9d3903014269778ec16` |
| 云 Runner 镜像 | `docker.io/library/pe-release-cloud-runner@sha256:ce9a705b429721328c34e68869a940839ab05d17a601176e3b392ca7a056b67d` |
| Connector 镜像 | `docker.io/library/pe-release-connector@sha256:d6febdee0e8048816841e1e51dc14a0c79f6d66015083110c2eeeacae1a94778` |
| 独立数据库／角色 | `pe_formal_restored_20261003`／`pe_formal_restored_qa` |
| 节点 POSIX 根 | `/var/lib/power-evolve-e31-shared/pe-formal-restored-20261003` |
| Mac 实际数据根 | `/Users/jingchao/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-formal-restored-20261003` |
| 私有配置 | `/Users/jingchao/.config/power-evolve/formal-restored-20261003` |

源应用 `pe-release-image-qa` 保持零副本，数据库、文件和配置保留。早期固定切片及旧候选版也保留自己的数据和版本。当前只运行这一套应用，复用已有 PG、k3s、Notes／MCP 和 SSH 测试目标。

## 启停

在 `/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud` 执行：

```sh
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/formal-backup-restore/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/formal-backup-restore/fixed-trial.mjs stop
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node .artifacts/power-evolve/release-integration/formal-backup-restore/fixed-trial.mjs start
```

选择所需命令执行，先查看状态。停止要求任务已结案，且空闲云 Sandbox 和 Pod 已回收；默认空闲回收阈值为五分钟。未满足条件时工具拒绝停止，不强行删除执行环境。启停工具核验固定 context、namespace、镜像、Deployment UID／spec、PG 身份、文件摘要及代理的进程／端口身份；停止时关闭应用写者、代理及端口转发，保留数据和 Secrets。启动仅恢复同一组 Deployment，并重新验证四个副本与两个公共入口就绪。遗留锁、资源漂移或失败现场需先核对，不盲目重新渲染或重放任务。

生命周期、状态检查和代理源码保存在同目录 `snapshot/`，十个固定工具文件的摘要保存在 `frozen-files.json`。私有停止围栏及启停状态在私有配置根；用户凭据未复制进仓库。`fixed-trial.mjs` 管理应用，不关闭共享 PG、k3s 节点或测试目标。源应用的恢复围栏另存于 `/Users/jingchao/.config/power-evolve/formal-backup-20261003/source-pause-for-restored-fence.json`；切回源版前先停当前试用。

## 试用步骤

1. 在两个浏览器分别登录，打开各自“HTTP 编程验收”工作区中的原会话，查看已有文件、Git 结果和恢复后的新消息。
2. 发送 `hi` 并追问；刷新页面，确认历史仍可读。普通对话、技能说明和受控文件读取不需要云执行沙盒。
3. 在原编程会话要求运行 `git rev-parse HEAD` 和 `python3 -B -m unittest -v`。`cloud_exec` 的 `cwd` 为相对目录，根目录用空字符串；执行结果通过原会话自动续接。两用户的 Git、文件和 Pod 各自独立。
4. 在原生“插件”页查看 SSH 与 MCP。Bob 保存的私钥可做登录检查，公开 MCP 可发现两个工具；停用或清除凭据的连接保持原状态。普通 SSH 命令和外部写操作仍需审阅具体动作并在可信入口审批。
5. 任务结束、云环境空闲回收后使用启停工具；原浏览器登录状态可读回历史，再发送一个新普通请求。

## 实际通过的范围

正式停写快照已恢复到独立空库、POSIX 根和私有投影，启动前 61 张表、1,345 行、631 个数据项、六个 Git HEAD 和十个私有文件读回一致。恢复后实际原生浏览器完成双用户登录、无沙盒普通输入、旧编程历史及双用户新云 Git／测试；两用户成功执行使用不同 Pod，输出各含一次标记，分别只有一个完成的续接。接口与 PG 读回核验文件摘要、原产物下载、九个用户技能、相同请求重试、冲突请求和跨用户拒绝；旧中断输入仍保持唯一失败记录，没有新增尝试。

Bob 的原私钥修订完成一次真实 SSH 认证且清理完成；恢复后的已启用公开 MCP 完成一次新工具发现，得到两个工具。停用／清除的私有 MCP 未重新启用，不能将公开连接的成功当作私有凭据调用证明。一次 Bob 云请求的绝对 `cwd` 被 Runner 拒绝；该失败保留，另一个明确使用相对目录的新请求完成复核。

固定工具实际停止四个应用 Pod 和公共入口后，恢复了同镜像四个新 Ready Pod。重启前后七张持久业务表的完整行摘要与计数一致；原浏览器登录状态重新读回历史，并各自完成一个新普通请求。这里验证的是正常停服恢复；正式镜像此前的容器故障范围见[组合记录](deploy/QA-RELEASE-COMPOSITION.md)，不把旧镜像故障演练改标成本次版本。

证据在 `.artifacts/power-evolve/release-integration/formal-backup-restore/`：`restore-readback.json`、`restored-native-readback.json`、`restored-execution-readback.json`、`restart-before.json`、`restart-after.json`、`post-restart-browser.json` 和原生浏览器截图。端口转发日志为 `replica-host-*.log`／`replica-platform-*.log`，公共代理日志为 `frozen-host-proxy.log`／`frozen-platform-proxy.log`；应用日志通过固定 context 与应用 namespace 的 `kubectl logs` 查询，不公开原始私有内容。

内置技能完整报告流程、当前 Office 定向验收、桌面最终适配与打包继续按[交付计划](DELIVERY-PLAN.md)推进；任意用户 STDIO MCP 服务尚未实现，当前只有固定 `whoami` 预设。多物理节点、生产 HTTPS／CNI、外部 PG、组织身份源和目标硬件容量保持各自未验收范围。
