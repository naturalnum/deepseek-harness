# PowerEvolve M2 原生会话与工作区实施记录

2026-10-09，Asia/Shanghai。当前迁移工作树尚未提交，不是已交付版本；本文记录本次实现与实际运行证据。完整范围仍以[已确认方案](CLOUD-MIGRATION-PLAN.md)为准，M0—M5 未整体验收。

## 当前实现

原生目录选择器访问本人 `/workspace` 逻辑目录，支持创建子目录并注册工作区。目录名称不映射为 Host 物理根。工作区标题、顺序、Session 顺序、归档与置顶使用本人 PG 状态。注销注册保留文件及历史，重新选择同一目录恢复注册；未注册工作区拒绝创建新 Session。布局读取拒绝外来 Session、跨工作区顺序、重复身份、归档与置顶重叠，以及缺失父目录的持久记录。

原生搜索返回本人用户及助手文本的有界字面匹配，包含 `%`、`_` 的查询不扩大匹配范围。冷会话重命名提交真实 `session/title` 事件。分支使用固定官方版 `buildForkSeed`，复制准确事件前缀并保留父会话、继承结束标记和收尾事件；Host 恢复读取最后一个继承标记。分支后续模型由同一前缀的官方模型投影决定，下一次受理重新核验当前权限。原生目录、模型、标题、输入及工作区管理保持官方页面与组件。

已移除未装配的旧 Plugins 主面板、其图标、固定 MCP／STDIO 回退页面及专用客户端 API。实际连接器控件仍在官方 `@power-evolve/host` bundle 配置区域。独立审批页只处理 Cloud 对账，不保留产品 Device 分支。生产代码与测试分别使用 Host／Client 类型程序；测试加载所属客户端的 locale 类型扩展。

## 真实原生页面与 PostgreSQL

隔离试用使用当前构建的具名 `power-evolve-cloud-host`、`power-evolve-cloud-platform` Profile、独立 PG 及私有存储。没有修改旧来源工作树、旧库或旧运行应用。模型调用使用真实 DeepSeek 服务；Host 不持有模型密钥。

在原生页面创建“迁移验收工作区”，实际保存逻辑路径 `/workspace/迁移验收工作区`。该工作区的会话完成“多工作区原生流程验证成功。”回复。随后通过原生消息动作创建分支，在分支中获得“分支会话恢复验证成功。”真实回复。原生侧栏菜单把分支改名为“迁移验收：分支与持久重命名”；页面刷新后标题、两轮历史和原工作区归属仍存在。侧栏搜索“分支会话恢复验证”返回该会话的真实消息摘要。

对应 PG 读取记录三个 Alice 会话，其中一个带原生父会话与继承历史；三个受理操作均为 `completed`、模型 `deepseek-v4-flash`，错误字段为空。此证据仅覆盖所述流程，不替代双用户、执行、Office、MCP、SSH、STDIO、报告或恢复验收。

私有证据目录是 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence`。`native-session-search-browser.txt` 保存实际页面文本，`native-session-commands-pg.json` 保存有界 PG 核对，`native-session-integrity-checks.json` 保存检查状态。服务日志及私有部署参数留在该目录，不进入 Git。

## 已执行检查

| 检查 | 实际结果与记录 |
| --- | --- |
| `pnpm exec tsc -b tsconfig.power-evolve.host.json tsconfig.power-evolve.client.json --pretty false` | 生产类型通过；`product-client-cleanup-typecheck.log` |
| `pnpm exec tsc -p tsconfig.power-evolve.test-host.json --pretty false` | 当前 Host 测试类型通过；`product-host-test-typecheck-final.log` |
| `pnpm exec tsc -p tsconfig.power-evolve.test-client.json --pretty false` | 当前 Client 测试类型通过；`product-client-test-typecheck-fixed.log` |
| Session 命令的真实 PG 回归 | 1 文件 4 用例通过，包括两个截点的不同模型继承；`native-session-model-prefix-pg.log` |
| 工作区的真实 PG 回归 | 4 用例在定向运行通过；`native-session-integrity-pg.log` 中另一文件的首轮模型 fixture 缺少 label 已修正，不能把该整轮写为通过 |
| 个人 MCP、SSH、Skills 源码与快照回归 | 7 文件 109 用例通过；`native-personal-client-regressions.log` |
| `pnpm --filter @power-evolve/application run build` | 正式应用构建通过，127 个文件；`native-session-integrity-build.log` |
| `pnpm --filter @power-evolve/cloud-web run build` | 原生 Web 构建通过，68 个模块、267 个静态文件；`native-client-cleanup-web-build.log` |
| 两对 README 配对检查 | application 与 client-extension-center 通过；`native-session-readme-pairing-check-fixed.log` |

上述检查没有使用空的 solution-only `-p` 结果作为生产类型通过依据。初次测试类型检查发现 fixture 使用了禁止传入 id 的消息构造器，以及漏载的事件／locale 类型扩展；已修改 fixture 并使用真实类型入口重新通过。

## 集中运行与尚未完成项目

默认并发的集中源码运行发现 14 个文件、149 个用例，其中 146 通过、3 因 30 秒超时失败。与另一轮覆盖率运行同时进行的 PG 核对观察到多个独立数据库的 `DataFileImmediateSync` 等待；覆盖率轮有 145 通过、4 超时。这些失败保留在原日志，不计为通过。产品 Vitest 配置现将并发限定为 2，保持 30 秒用例期限和逐文件四项 100% 覆盖率。新的 `product-native-source-coverage-bounded.log` 记录 14 文件、149 用例全部通过，用时 88.19 秒，没有跳过用例；命令仍因覆盖率阈值不足退出 1。

覆盖率统计包含应用 Web JavaScript、产品运行时、部署与构建脚本，共 201 个报告文件。当前 140 个有可执行行的文件未被执行；行覆盖率 14.54%、语句 13.43%、函数 17.43%、分支 10.98%。报告位于 `coverage/power-evolve-cloud/coverage-summary.json` 与同目录 lcov／JSON 文件；这里只记录实际测量，没有降低逐文件标准或把未迁入测试当作通过。

原生上传与附件受理、steer、队列修改、活跃写者的标题／模型变更、停止全部活动后归档尚未接完。当前活跃写入拒绝以保护事件序号；这些拒绝不构成完整原生能力通过。Cloud、Office、MCP、SSH、STDIO 的 enabled 真实运行仍待配置并验收。产品完整 lint、文档、依赖、重复代码、测试发现和覆盖率入口及 CI 尚未整体关闭；M0 来源闭包、数据映射、补丁清单也需要随当前实现冻结。备份、来源导入、独立恢复、2＋2 副本与最终独立审查仍须完成。
