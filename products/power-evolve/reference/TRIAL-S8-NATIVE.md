# S8 内置技能固定试用

本阶段完成[交付计划](DELIVERY-PLAN.md)中“内置技能接入”这一行，保留原生 DSH 页面、共享 Host 和独立可信后台。固定代码标签为 `power-evolve-native-s8-trial`；DSH 基线仍是 `dsh-v0.1.7-rc.2`。它是云端本机试用，不是整个产品或生产部署验收完成。

正在运行的独立 QA 工作区固定在 `509e2889f15087ae3dff3f9c391ab38a1fb28015`，应用、客户端和 Profile 源码与主线冻结时一致。健康接口修复后只重启本试用 Platform；Host、Platform、测试 API 均就绪，Platform 报告版本与 PG 实际值同为 21。主线另执行真实隔离 PG 的断连恢复与双副本准入测试，3/3 通过；日志为 `/tmp/pe-s8-health-schema.log`，没有重复运行技能或模型任务。

## 试用入口

| 项目 | 固定值 |
| --- | --- |
| 登录 | <http://127.0.0.1:19551/login> |
| 原生 DSH Web | <http://127.0.0.1:19550/native/> |
| 试用工作区 | `/Users/jingchao/agent_work/main_agent/power-evolve-parity-audit` |
| 试用名／PG 端口 | `s8-office-qa`／`18553`，schema 21 |
| 私有配置 | `/Users/jingchao/.config/power-evolve/shared-host-s8-office-qa/` |
| 日志与证据 | 上述工作区的 `.artifacts/power-evolve/s8-office-qa/`；新证据在 `evidence-qa3/` |
| 执行环境 | 命名空间 `pe-s8-office-qa`，Runner `pe-s8-skills-runner:qa3`；完整镜像摘要见[验收记录](TRIAL-S8-SKILLS-QA.md) |

Alice 和 Bob 的密码保存在私有配置目录的 `users.json`。使用两个独立浏览器会话登录；不把密码或模型密钥复制到聊天、日志或仓库。原 c3 试用继续独立保留。

1. 新建会话发送 `hi`，再连续追问，刷新后检查历史。该路径无需沙盒。
2. 打开“技能”，检查“全部／我的”、搜索和说明。两个账号各有 9 个内置包；说明和包内文本资源读取不创建执行沙盒。
3. 在 Alice 账号停用一个技能，再用 Bob 查看同名技能，Bob 应保持启用；Alice 可重新启用。新受理任务使用各自的技能选择。
4. 在新会话使用 `/pdf`，要求生成包含 `S8 PDF` 的一页 PDF 并放在 `/workspace`；首次执行按需创建沙盒。通过原生文件侧栏预览、下载结果。也可查看已留存的 Word、Excel、PowerPoint 及报告样例；它们的确切执行与渲染范围见验收记录。
5. 刷新页面，检查自己的会话和文件仍在。另一个账号不能读取这些 Session 或文件；沙盒空闲回收不会删除持久工作区。

## 管理试用

从上表的固定试用工作区运行下列配置。外部 Docker 网络是该试用启动配置的一部分；停止或备份后的重启也需保留它。

```sh
export PE_TRIAL_NAME=s8-office-qa PE_DATABASE_PORT=18553
export PE_HOST_PORT=19550 PE_PLATFORM_PORT=19551 PE_TARGET_PORT=19552
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s8-office-qa
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
```

同一组环境下，`trial.mjs up` 启动，`trial.mjs stop` 停止并保留 PG 卷和文件，`trial.mjs restart` 重启。已验证的启动及版本升级过程见[原始 QA 记录](TRIAL-S8-SKILLS-QA.md)。不要清空卷或手改 PG 来绕过恢复失败。

升级前 schema 20 的只读备份为 `/Users/jingchao/.config/power-evolve/backups/s8-office-qa-pre-v21-20260930`，849 项清单均已核对。V21 的结果和日志存储可保留 NUL；旧二进制拒绝这个版本。回退使用匹配的旧二进制和升级前备份恢复到另一个试用，不能把当前含 NUL 的数据强制转回 JSONB；备份后的新操作不会出现在旧快照中。备份工具及真实恢复的适用证据见[备份报告](TRIAL-S8-BACKUP-RESTORE.md)。

## 已通过与未覆盖

两个用户的目录预置、说明摘要、18 次跨用户读取拒绝、五包显式升级和旧版本选择保留均有真实浏览器／PG 证据。真实 DeepSeek 和 k3s 执行覆盖 Office 小文件、PDF、LaTeX 样例、报告校验、排版与渲染；九包逐项范围以[当前验收矩阵](TRIAL-S8-SKILLS-QA.md#current-acceptance-summary-at-ba1307f14d)为准。禁用和撤销的持久拒绝另有真实备份恢复证据，不声称每个新包版本都重跑该场景。

长输出堵塞、NUL 入库及 Runner JSON 响应预算的修复均有针对性回归。真实 Runner 满额输出为 stdout、stderr 各 65,536 字节，PG 逐字节保留，原会话正常续接且各测试会话只有一次执行；模型接收带明确截断标记的有界摘录。原始结果与模型上下文的边界见[无损存储记录](TRIAL-S8-LOSSLESS-OUTPUT.md)。

整份有来源依据的报告生成—审核闭环、Office 广泛功能、字体精确还原和 OfficeCLI screenshot 路径仍未验收。通用 MCP／SSH、账号生命周期、文件与产物入口补齐以及外部物理集群发布验证继续按交付计划推进；这些不因技能切片通过而算完成。
