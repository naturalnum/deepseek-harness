# M3 原生请求与多副本排队恢复验证

2026-10-09，官方基线为 `dsh-v0.2.1-alpha.1`、HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。本记录对应未提交迁移代码的本轮正式产物，是[云执行验证](TRIAL-M3-CLOUD-RUNTIME.md)后的独立验证记录；完整 M3—M5 验收仍未完成。

## 本轮结果

两组具名 DSH Host／Platform 使用同一独立 PG 数据库和持久存储，各自使用独立 Profile home。四个实际服务均返回 ready。Alice、Bob 分别通过原生 `session/create` 和 `session/prompt` 提交真实 DeepSeek 请求，并通过另一 Host 重试相同创建身份和 prompt requestId。每位用户获得同一个 Session，数据库各保留一个完成操作、一次 epoch 1 领取；两个不同 worker 实际承担任务。每个 Session 保存 14 个原生事件，另一 Host 的 `session/page` 读回预期模型文本，跨用户访问均返回 `session/not-found`。

两个 Host 经出生身份核对后正常停止，实际退出码均为 0。两个仍运行的 Platform 各受理一个新请求，PG 在没有 Host 的窗口中保留两个 `queued` 操作。随后第二个 Platform 正常停止。重启第一组 Host 后，它通过第一组 Platform 完成两个原请求，包括第二个 Platform 已受理的输入；两项操作各保留一次领取、同一恢复 worker，没有补建操作或修改 requestId。第二组服务重新启动后，原生历史读回预期模型文本，再次重试两个原 prompt 仍各只有一个完成操作和一次领取。

本轮证明跨副本原生请求去重、用户隔离和已受理但尚未消费输入的恢复。它没有验证已消费输入的运行中断、网络分区、事件流重连／背压或全部连接器续接，不能作为完整 F19 通过证据。

## 构建与工程检查

| 检查 | 实际结果与范围 |
| --- | --- |
| 正式类型与应用构建 | 当前 Host／Client 类型程序及 application build 退出 0；545 项明确监测的产品输入前后摘要一致，这不是完整上游依赖闭包 |
| 构建产物专项 | 四个发现的 built 文件共 14 例通过、0 失败、0 skip；包括两个 Scheduler、两个 client factory 和十个 Web 产物用例，Scheduler 仍使用内存 Platform／模型夹具 |
| ZIP 完整性 | extraction 在流式展开时累计 Node CRC32，核对中央目录 CRC 后才接受文件；员工7固定输入下 77 例通过，包括 stored 文件字节损坏及合法 deflated 流的中央 CRC 损坏拒绝 |
| 应用格式 | application/src 的样式专项和类型检查退出 0；除两处正则拆行外，整理前后的语法树在常量字符串和括号规范化后相同；两处正则的 pattern 与 flags 完全一致 |
| 完整 lint／覆盖率 | 完整应用 lint 仍有 552 项诊断；其他模块和完整逐文件四项 100% 覆盖检查仍未通过，不据格式专项或行为用例声称工程质量完成 |

CRC 拒绝覆盖真实 ZIP 展开流程，旧失败证据保留。静态类型检查不替代真实 PG、文件字节或用户流程；本轮原生 HTTP 请求也不等于浏览器交互验收。

## 备份失败与停止状态

实际 current-cloud 备份已核对停止的具名 Profile，并生成 PG dump，但复制 Linux volume 数据到 macOS 私有目录时 `fchown` 返回 EPERM。当前 macOS 进程不能保留源文件的真实 UID/GID；失败阶段、dump 和诊断全部保留，未发布 bundle，也未计为备份或恢复通过。完整演练需要具备实际 ownership 保留权限的 Linux 部署环境，两个受监督 Profile 与备份进程须使用可核验的同一进程环境；不能把 macOS 停止记录搬到另一环境当作停止证明。

多副本验证结束前，PG 中 queued／running 操作和非 free mount slot 均为 0。四个服务逐一核对精确出生身份后使用 SIGTERM 停止，四个监督进程均实际退出 0，数据和 Profile 保留。

## 证据位置与后续验证

私有证据位于仓库外 `power-evolve-migration-evidence/private/multi-replica-v1/`，原始事件、凭据及配置仅保存在私有文件中。`native-request-accepted.json`、`native-progress.json` 和 `native-readback-proof.json` 对应首次原生请求；`durable-queued-before-restart.json`、`recovery-progress.json` 和 `recovery-readback-proof.json` 对应排队恢复；`final-stop-confirmed.json` 对应四服务正常停止。构建专项位于 `quality-built-v3/`，输入监测为 `quality-build-audit-v3.json`，应用格式、完整 lint 与等价核对位于 `quality-lint-diagnostics-v2/`。实际备份失败位于 `private/current-cloud-backup-v1/`。

继续按[迁移方案](CLOUD-MIGRATION-PLAN.md)完成 Office 预览、完整报告工作流、启用的 MCP／SSH／STDIO、原生浏览器流程、F19 其余故障路径、旧数据隔离导入、完整备份恢复与发布资料。当前部署的连接器和 Office preview 仍为 disabled；员工的镜像、组件或独立夹具结果不能追认为当前组合通过。
