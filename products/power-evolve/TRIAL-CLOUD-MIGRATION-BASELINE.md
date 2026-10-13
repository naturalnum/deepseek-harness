# PowerEvolve 云端迁移来源核查记录

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

2026-10-08，Asia/Shanghai。此记录固定本轮文档使用的源码、候选目标和未提交修复，不是迁移后系统验收报告。本轮只读核对会话、源码、测试及历史 QA，编辑迁移文档；没有创建迁移分支、启动或切换服务、运行产品功能测试或升级数据库。

## 固定来源

| 项目 | 核查值 | 依据 |
| --- | --- | --- |
| 官方仓库 | `deepseek-ai/deepseek-harness` | 现有 upstream remote |
| 官方目标标签 | `dsh-v0.2.1-alpha.1` | 2026-10-08 对 upstream 的只读远端查询 |
| 官方目标提交 | `5badb15009ae1756c3afe0ae0cef1faafc290ccc` | 查询时 `master` 与目标标签一致；并核对既有只读审计仓库 |
| 旧产品分支 | `power-evolve/native-cloud-client` | 当前工作树 Git 状态 |
| 旧产品提交 | `4acb888058b3e5a95ec7d085ba75bcf2442d3636` | `feat(power-evolve): integrate native Cloud STDIO management` |
| 当前产品 Schema | 37 | [schema.ts](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/application/src/platform/schema.ts)；不是固定试用库的实时版本 |
| 旧官方来源 | `dsh-v0.1.7-rc.2`，`477b4f420553e8a52c2fbccc464d7561b239c443` | [初始 baseline](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/baseline.json)；其中 schema 1 是初始记录，不是当前 Schema |
| 文档来源会话 | “插件和安全组件” | 最后文档整理回合中断；两个主文档此前未保存 |

目标标签只作为本轮固定候选；开工核验必须与这里的提交一致。后续上游更新另行登记，不改变本记录的查询时刻。

## 未提交迁移来源

核查开始时有八个已跟踪文件修改和一个未跟踪回归文件。已有变更本轮保留，尚未以本轮完整系统验收认证。

- 根 `package.json` 中的 Web built 测试入口。
- `client-extension-center/README.md`、`README.zh.md`、`README.i18n.yaml` 中的产物说明。
- `client-extension-center/package.json`、`tsdown.config.ts` 中的构建和测试修改。
- `client-extension-center/src/client/PluginsPage.tsx` 中精确 disabled metadata 的处理。
- `client-extension-center/tests/stdio-v2-panel.client.spec.tsx` 中对应客户端回归。
- 未跟踪的 `client-extension-center/tests/client-bundle.built.test.mjs`。

原始 tracked `git diff --binary` 的 SHA256 为 `f63db5ab64377db651a5b5e108a9dfa8e577efce291262cf7fae2f59054b7306`；未跟踪工厂回归文件 SHA256 为 `cf508553ee1f563bba82e128ed03a00f9a3b0f43ca0379a296b9042b19dc2c27`。摘要用于辨认核查输入，不能代替开工前实际保存差异、独立提交和重跑适用测试。

## 来源中的当前缺口与迁移风险

| 编号 | 核查结论 | 分类与后续要求 |
| --- | --- | --- |
| G01 | [Host 原生桥接](application/src/host/native-remote.ts)的 `settings/describe` 返回只读空配置，没有完整新版设置／模型／插件管理等接口映射 | 当前适配范围有限；M0 逐项对照目标客户端调用，M1 实际原生页面验收 |
| G02 | [STDIO management RPC](application/src/stdio-v2-management-rpc.ts)请求 `/stdio-v2/config`；真实 [Platform](application/src/platform/index.ts) enabled 路由没有对应 case | 静态接线缺口；补齐真实接口并用 Host＋Platform＋PG 验证，不能以 disabled 503 测试替代 |
| G03 | [Schema 常量](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/application/src/platform/schema.ts)为 37；[Office 兼容测试](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/application/tests/office-artifact-schema.test.mjs)仍断言 34 | 静态失配，本轮未运行产品测试；保留原始持久事实检查后更新审查范围 |
| G04 | [Web 构建](cloud-web/scripts/build.mjs)以旧客户端根列表装配；[构建测试](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/cloud-web/tests/build.test.mjs)要求官方插件管理器缺席 | 迁移耦合；恢复目标官方 Web 组成，按公开插槽接入产品 MCP／SSH |
| G05 | [账号插件](client-account/src/client/index.ts)仍注册自定义设置分区，旧文件／产物插件增加自定义控件 | 账号迁入允许的菜单；用户已确认五项旧功能不迁入，不再要求 M0 提供其等价原生入口 |
| G06 | [产品测试总入口](../../package.json)包含 Desktop；根 [Vitest](../../vitest.config.ts)不覆盖全部产品服务测试 | 测试入口范围风险；新增云端独立入口并核对执行文件与 skip |
| G07 | 通用 STDIO 已有 [services](application/src/platform/stdio-v2-services.ts)、[call admission](application/src/platform/stdio-v2-call-admission.ts)、[continuations](application/src/platform/stdio-v2-continuations.ts)及 worker 组合 | 实现存在；不能沿用旧路线的“尚无 call”结论，也不能据实现存在宣称真实双用户整系统通过 |
| G08 | Device 运行依赖进入共享协议、Platform、Profile 和构建范围 | 云端切分需追踪传递依赖；保留旧数据兼容，不迁 Device 权限与执行器 |

## 内置技能来源

核查 [catalog.json](application/assets/builtin-skills/generated/catalog.json)及 [Platform Profile](platform/cordis.patch.yml)，固定九个预置包。目录、manifest、ZIP 摘要及历史安装版本需一起迁入；源码中的技能目录与旧报告实际使用版本分别记录。

| 技能 ID | 来源版本 |
| --- | --- |
| `builtin.word` | 1.0.2 |
| `builtin.excel` | 1.0.2 |
| `builtin.powerpoint` | 1.0.2 |
| `builtin.pdf` | 1.0.0 |
| `builtin.latex-report-writer` | 1.0.5 |
| `builtin.power-grid-technical-report-writer` | 1.1.41 |
| `builtin.report-reviewer` | 1.1.1 |
| `builtin.report-workflow-orchestrator` | 1.1.30 |
| `builtin.tech-report-writer` | 1.1.45 |

## 历史证据索引

下表用于选择迁移回归，不汇总成当前 HEAD＋未提交修复已经全功能通过。真实／替代组件、提交、Schema 和镜像以原记录为准；多物理节点、生产网络与外部 PG 不在本机试用证明范围内。

| 证据 | 已证明的固定范围 | 本轮迁移如何使用 |
| --- | --- | --- |
| [账号 V25](reference/TRIAL-S3-ACCOUNT-V25-QA.md) | 账号生命周期、真实 PG 锁等待、独立恢复及原生读回 | 保留撤权、租约及账号状态回归 |
| [云端组合](reference/TRIAL-CLOUD-COMBINED-QA.md) | 账号、存储绑定、技能及 SSH 与云执行衔接 | 重验纳入的新版本受理、系统恢复和双用户链路；排除旧绑定恢复专项 |
| [正式构建](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/deploy/QA-RELEASE-BUILD.md)、[组合记录](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/deploy/QA-RELEASE-COMPOSITION.md) | 各自固定镜像、锁闭包、真实执行、故障演练与恢复 | 建立同版本构建和运行证据，不跨镜像追认 |
| [正式固定试用](reference/TRIAL-FORMAL-IMAGE-LOCAL.md) | 应用 `54c4fe23f57258f53682a4500747e986b097c137`、备份工具 `95cc9b6d0b1cb13f1b2f28f1e2a36f5aebb5c659` 的本机组合 | 精确启停与恢复模板；不据旧试用文案判定 HEAD 功能状态 |
| [完整报告](reference/TRIAL-S8-REPORT-WORKFLOW.md) | `20bdcc65efc1d810d12f60bf7bc3eacfc77af047` 上报告 `COMPLETED`、Word 确认及成果字节 | 迁移后重验；不能称报告流程历史上尚未完成 |
| [不可变预览 O3](reference/TRIAL-NATIVE-PREVIEW-O3.md) | Host `12673cfbc2cf8255948bb86113cb4b2bc0adfaaf`、Schema 33 及另固定 Platform 镜像 | 参考原生预览、Loader 与崩溃恢复；旧产物专项不属于本轮迁移 |
| [STDIO 结果](reference/TRIAL-STDIO-V2-RESULTS.md)、[worker](reference/TRIAL-STDIO-V2-WORKER.md) | 对应固定内部链及实际 PG／Docker；部分物理资源是替身 | 作为底层回归；补真实 k3s、独立挂载、原生 discovery／call 和唯一续接 |
| [V33 Office 备份](reference/TRIAL-OFFICE-BACKUP-V33.md) | 辅助恢复检查、真实 PG 与缓存字节 | 不能替代 Schema 37 完整恢复和目标服务启动 |
| [历史完整性审计](reference/PARITY-AUDIT.md) | 旧基线功能对照及后来补齐的索引 | 以用户操作查遗漏，结合当前源码与新证据更新迁移清单 |

## 本轮文档交付

[云端迁移方案](CLOUD-MIGRATION-PLAN.md)拥有本次范围、分支、任务顺序、接口与完成标准；[工程复盘](CLOUD-ENGINEERING-REVIEW.md)拥有常见失效原因、预防措施和回归入口。本记录拥有确切来源与版本，后续实施新增独立验收报告，保留这份核查范围。

## 迁移范围确认

2026-10-08 用户确认，[原生 DSH 没有的五项旧功能](CLOUD-MIGRATION-PLAN.md#本次不迁入的旧功能)不迁入，相关专用实现和测试退出本轮任务与验收。功能清单调整为 18 项，原 F06、F08 移除，F07 收敛到原生文件／资源适配；原生能力、Skills ZIP 导入和报告生成文件仍按各自纳入范围验证。

## 官方工程规范核查

2026-10-08，核对固定官方目标 `dsh-v0.2.1-alpha.1` 的 [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/AGENTS.md)、[dsh-doc](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/.agents/skills/dsh-doc/SKILL.md)、[dsh-code-review](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/.agents/skills/dsh-code-review/SKILL.md)、[defensive-patterns](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/defensive-patterns.md)、[testing](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/docs/testing.md)及相关检查工作流。官方通用工程要求分布在这些拥有者中；当前来源仓库已含相应文档与技能，不需要在迁移前另外复制一套规范。

| 核查项 | 观察结果 | 实施影响 |
| --- | --- | --- |
| 来源与目标规则 | 目标根规则与代码审查移除运行时 `./invariant` 要求；目标文档工作流增加 `upgrade-guide` 类型 | 从目标基线继承规则；保留失败路径验证，对用户可感知破坏性变化同步编写升级指南 |
| 生命周期与检查选择 | `defensive-patterns` 和 `dsh-pre-push-checks` 在两版相同；目标审查仍要求接口两端、注册清理、实际入口及负向案例 | 采用官方工作流，产品复盘补充已发生故障，不另写重复规则 |
| 根测试与覆盖率 | 当前 [Vitest](../../vitest.config.ts)的测试 glob 不包含产品目录；覆盖率包括 `packages/*/*/src/**/*.{ts,tsx}` | 产品另接完整适用测试和覆盖检查；官方覆盖率结果不能代替产品证据 |
| 重复代码范围 | 当前[根命令](../../package.json)执行 `jscpd --config .jscpd.json packages scripts` | 在目标分支把纳入产品源码加入适用检查范围 |
| 产品入口范围 | 当前根类型入口调用产品检查，产品脚本包含 Desktop、旧产物及执行选择插件 | M0 按 18 项纳入能力确定范围；M1 接入云端独立入口与 CI，剔除排除功能专项 |

已在[迁移方案](CLOUD-MIGRATION-PLAN.md#工程规范与质量检查)登记采用规则、产品检查缺口、M0／M1 接入工作和 M5 通过条件。本轮只修改三份迁移文档，未修改 `AGENTS.md`、检查脚本、覆盖阈值或 CI；这些接入工作尚未实施，也不能据此宣布迁移代码质量检查已经通过。

## 首次文档交付验证

- `pnpm run test:docs`：20 项通过，零失败、零跳过。
- `pnpm run doc-sync`：42 项通过，零失败、零跳过，包含文档类型、站点构建和配对检查。
- 新增三份文档专项检查：129 个链接及锚点有效；表格列数、段落换行和文件末尾有效；功能表 20 项，阶段表 6 项；架构 Mermaid 解析通过。
- README 中英入口及配对记录已同步；`git diff --check` 通过；核查前九个变更文件的内容摘要不变，HEAD 不变。
- `pnpm run lint`：前置构建完成，lint 失败。报错来自本轮未改动的 `apps/desktop`、`packages/client/ui-directory-picker-*`、`ui-sidebar-browser`、`ui-sidebar-files` 和 `ui-workspace` 中的 TypeScript 规则；文档检查通过不表示全仓 lint 已通过。本轮保持只编辑迁移文档的范围。

## 本次工程规范补充验证

目标启动后的进一步来源核查见 [M0 接口与迁入边界](TRIAL-CLOUD-MIGRATION-M0.md)，其中区分同名 dispatch、实际参数兼容、待拆分依赖和尚未关闭的 M0 条件。该记录不扩大此前文档检查和历史 QA 的证明范围。

- `pnpm run test:docs`：20 项通过，零失败、零跳过。
- `pnpm run doc-sync`：42 项通过，零失败、零跳过。
- 三份文档专项检查：156 个链接及锚点有效，表格列数、段落和文件末尾有效；18 项纳入能力、五项排除功能与六个阶段保持本轮确认范围。
- `git diff --check` 通过；九个已有源码变更的内容摘要保持不变。本次未重复运行全仓 lint，首次交付记录中的既有失败仍未修复；未运行迁移后的产品行为、覆盖率和 CI 检查。
