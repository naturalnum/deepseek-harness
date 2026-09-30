# S8 执行结果与原生日志的无损存储

日期：2026-09-30。实现固定提交：`d34f077a7c`。本记录覆盖真实 PostgreSQL、构建后的 DSH Profiles 和确定性模型／Runner；随后[真实 k3s 验收](TRIAL-S8-SKILLS-QA.md#real-nul-output-after-runner-response-fix-at-ba1307f14d)分别验证了小样本和双流满额 NUL 输出、原会话续接、刷新与跨用户拒绝，测试替身不能代替该证据。

## 修复边界

V20 把命令结果存为 JSONB，含 NUL 的成功结果触发 PostgreSQL `22P05`，无法落盘，云执行被反复标记为结果不明。V21 将 `pe_cloud_executions.result`、`pe_desktop_executions.result`、`pe_connector_actions.result` 和 `pe_events.event` 迁移为 JSON，保留完整载荷；控制状态、授权和索引仍使用原独立列。协议、执行 ID 和原生日志格式没有变化。

迁移和回退约束见 [应用说明](application/README.zh.md#恢复与限制)。旧版 Platform 不接受 V21；回退须恢复升级前快照，不将含 NUL 的值强制转回 JSONB。本轮未升级现有 c3 稳定试用数据库。

## 实际验证

| 检查 | 已观察结果 | 证据日志 |
| --- | --- | --- |
| V20 → V21 | 四列原有值迁移后相等；重复初始化保持 V21；NUL、中文、emoji、字面量 `\\u0000` 与孤立代理项可按整值读回 | `/tmp/pe-nul-storage-regression.log`，`s8-lossless-storage` |
| 云执行对账 | V20 先复现结果入库失败；同一 Runner 已完成记录在升级后被查询并落盘，命令仅 POST 一次，续接仅入队一次 | `/tmp/pe-nul-cloud-reconcile.log`，2/2 |
| 桌面结果 | 原样保存输出，重复 finish 幂等，修改结果被拒绝；续接文本使用 JSON 转义，保留输出含义 | `/tmp/pe-nul-storage-regression.log`，`slice5` |
| 连接器 | 已发生的便签写入丢响应后对账，远端只写一次；带 NUL 的返回元数据可持久化 | `/tmp/pe-nul-storage-regression.log`，`s6-notes-plugin` |
| 备份恢复 | Docker 内真实 `pg_dump`／`pg_restore` 保留技能版本、收据及含 NUL 的事件／结果值；一个终态执行行是存储 fixture，Sandbox 计数为零 | `/tmp/pe-nul-storage-regression.log`，`s8-backup-skill-storage` |
| 原生日志录制 | 确定性模型返回 NUL 与字面量转义；真实 Profiles 保存、读取并在重启后恢复，同一输入只调用模型一次，跨用户读取拒绝 | `/tmp/pe-nul-native-record.log`，20/20 |
| 原生日志回放 | 新 [会话快照](../../snapshots/power-evolve/lossless-output/session.v4.jsonl)提供输入与模型输出，同时校验完整事件；既有三个快照语义保持相等 | `/tmp/pe-nul-native-replay.log`，20/20 |

首次并行存储回归中，原慢启动测试的 450 ms 租约出现两次认领，断言失败；测试失败后未关闭 worker，导致进程未退出。已补充失败清理，并将试验租约设为 3 秒、慢启动设为 5 秒，仍须实际续租才能保持一次认领。修正后云执行测试 2/2 通过；没有修改生产租约或放宽一次执行的断言。原失败日志保留，不将该次整组运行记作全通过。

构建命令 `node node_modules/typescript/bin/tsc -b products/power-evolve/application`、README 配对检查、提交 lint 和空白检查通过。其他只更新 schema 版本断言的测试未在本轮全部重跑。

## Runner 传输边界补充

固定提交 `0fec8964e0` 修复了存储之前的响应上限：两路各 65,536 字节的合法 NUL 输出经 JSON 转义后超过原 256 KiB 限制，云沙盒与 SSH Runner 现显式使用 1 MiB；普通资源预算保持不变。同时修复了 HTTPS 响应半途断开后 Promise 未及时结束的问题。

隔离分支的真实 TLS 公共适配器测试最终 8/8 通过：满额双流 NUL／中文／emoji／字面量转义完整读回，1 MiB 与 256 KiB 的精确边界接受、超一字节拒绝，SSH reconcile 接受合法输出并将超限结果标为不确定，断开及超时关闭连接，后续健康请求可完成。已有 ServiceAccount 令牌轮换和 SSH 权限回归另有通过证据；测试使用 HTTPS fixture，未执行真实命令，也不代替 k3s 端到端验收。复跑入口为 `application/tests/s7d-kubernetes-bounded-response.test.mjs`。

## 复跑命令范围

从上述提交构建 application，设置 `PE_PRIVATE_DIR` 指向可创建独立测试数据库的私有 PG 配置目录；测试使用随机数据库并清理。备份项另外设置 `PE_TEST_BACKUP_POSTGRES_IMAGE` 为本地 PostgreSQL 17 镜像。使用 `node --test` 运行 `application/tests/` 下的 `s8-lossless-storage.test.mjs`、`slice4.test.mjs`、`slice5.test.mjs`、`s6-notes-plugin.test.mjs`、`s8-backup-skill-storage.test.mjs` 和 `slice1.test.mjs`。普通回放不设置 `PE_RECORD_SNAPSHOT`，不能在失败时自动刷新快照。

这些证据不证明运行中 Pod 丢失后的输出恢复、桌面容器实际清理或生产数据库迁移的容量与锁时长；对应部署与设备验收仍按交付计划执行。
