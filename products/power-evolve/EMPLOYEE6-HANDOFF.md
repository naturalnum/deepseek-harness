# 员工6：README 与依赖规范交接

## 摘要

员工6已修复分配的五组 README；十份真实中英文文件在官方产品映射文档检查中零诊断，五组官方配对检查通过。依赖仅调查并生成[可审核建议补丁](employee6-dependency-proposals.patch)，未应用到 manifest 或锁文件。全产品文档与依赖检查仍有失败，不能将本次局部结果作为完整迁移验收。

## 修改范围

修改 `application`、`contracts`、`host`、`platform`、`sandbox` 下的 `README.md`、`README.zh.md`、`README.i18n.yaml`，共十份 Markdown 和五份配对记录；另新增本交接与依赖建议补丁，共十七个文件。其他拥有者的 README、业务源码、检查脚本、构建产物、锁文件、Profile 和私有部署配置均不属于本次修改。未执行 Git add 或 commit。

采用根与产品 `AGENTS.md`、[文档标准](../../docs/AGENTS.md)、[dsh-doc](../../.agents/skills/dsh-doc/SKILL.md)、[dsh-prose-standard](../../.agents/skills/dsh-prose-standard/SKILL.md)、[迁移方案](CLOUD-MIGRATION-PLAN.md)及[工程复盘](CLOUD-ENGINEERING-REVIEW.md)。读取固定目标规则和当前源码；`git fetch origin` 成功，`origin/master` 没有这些产品 README，未从上游分支复制产品说明。

| 拥有者 | 修订内容 | 英／中物理行数 |
|---|---|---|
| [Application](application/README.md) | 保留现有内容，仅统一合法 `kind` 格式并重新确认配对 | 88／88 |
| [Contracts](contracts/README.md) | 改为当前九个导出子路径的库参考；清理旧 Device、手动发布及绑定恢复 API 说明；补摘要、导航、稳定锚点、模型影响和限制 | 97／97 |
| [Host](host/README.md) | 按真实 `dsh.bundle.patch` 分类；补摘要、组合与覆盖语义、模型影响及限制；旧 trial／不存在的锚点改为当前拥有者链接 | 80／80 |
| [Platform](platform/README.md) | 按真实 bundle 分类；保留私有凭据、工作区／Skill 根约束和就绪范围；移除配对 Device 授权说明及旧链接 | 83／83 |
| [Sandbox](sandbox/README.md) | 补导航、稳定锚点、实现折叠、模型影响及验证限制；构建细节链接源码和镜像拥有者，保留已实际执行的 Runner 测试命令 | 90／90 |

Sandbox 没有 `package.json`，不冒充 npm 插件或 bundle，也不新增无拥有者的 `kind`。官方产品映射会检查它的链接、段落、配对；另用官方 Summary collector 验证其英文摘要。Application 是 Cordis 插件入口，Contracts 是普通库，Host／Platform 是 manifest 声明的 bundle。四份包 README 的分类按实际入口与 manifest 确认。

## 实际命令与证据

命令的工作目录均为目标仓库。私有独立证据目录为 `/Users/jingchao/agent_work/private/employee6-20261009`，目录权限为 0700；其中保留原文备份、修订脚本、诊断 JSON、日志、建议 manifest 与内存验证结果，不记录凭据。

| 命令／检查 | 实际结果 | 私有证据 |
|---|---|---|
| `pnpm exec tsx products/power-evolve/scripts/cloud-check.mjs --only=docs,dependencies` | 初次发现 212 runtime 文件、64 source test、4 built test、295 lint 文件、108文档、8 manifests；docs 161诊断，其中本次拥有者34条；dependencies 354诊断。两条并发输入变化使整体证据拒绝，不能当作冻结验收 | `baseline-cloud.log`、`baseline/report.json` |
| `pnpm run verify-translation-pairing --write` 后跟五个拥有者的 `README.md` | 五份配对记录重新写入 | `pair-write.log` |
| `pnpm run verify-translation-pairing` 后跟同样五个 `README.md` | 五组命名配对一致 | `pair-check.log` |
| `pnpm exec tsx products/power-evolve/scripts/cloud-check.mjs --only=docs` | 212 runtime、67 source test、4 built test、298 lint 文件、108文档；本次十份 README 零诊断；全产品仍127诊断 | `after-docs.log`、`after-docs/report.json` |
| 同一官方 `--only=docs` 命令，在交接文件写入后再运行 | 212 runtime、67 source test、4 built test、298 lint 文件、110文档；十份README及本交接零诊断；全产品135诊断，新增8条来自并发写入的员工1交接 | `final-docs.log`、`final-docs/report.json` |
| 最终同一官方 `--only=docs` 命令及五组命名pair复查 | 212 runtime、67 source test、4 built test、298 lint 文件、111文档；全产品135诊断；十份README和本交接零诊断，五组配对一致 | `delivered-docs.log`、`delivered-docs/report.json`、`final-pair-check.log` |
| `node --test products/power-evolve/sandbox/tests/runner.test.mjs` | 8 passed、0 failed、0 skipped、0 cancelled | `sandbox-runner.log` |
| `pnpm exec tsx /Users/jingchao/agent_work/private/employee6-20261009/focused-audit.mts` | 官方 Summary collector 检查五份英文 README：零诊断；官方 `loadCordisYaml` 与 `bundlePluginDependencyErrors` 核对 Host20＋Platform3个引用：零缺声明；重新运行原产品 dependency lane仍354诊断 | `focused-audit.log`、`focused-docs-and-bundles.json`、`dependencies.json`、`dependency-records.json` |
| `git apply --check products/power-evolve/employee6-dependency-proposals.patch` | 通过；只验证补丁可应用，未应用 | `proposal-apply-check.log` |
| `pnpm exec tsx /Users/jingchao/agent_work/private/employee6-20261009/simulate-proposal.mts` | 官方 section collector在建议 manifest 的内存副本上零诊断；原 manifest 摘要保持一致；导出分类仍拒绝 | `proposal-simulation.json`、`proposal-simulation.log` |
| `pnpm exec tsx /Users/jingchao/agent_work/private/employee6-20261009/validate-owned-final.mts` | 独占17文件、11份Markdown、五组pair；官方链接／单段单行／Summary／命名pair和空白检查零诊断，输入摘要稳定 | `owned-final-validation.json`、`owned-final-pair-check.log` |
| `git diff --check --` 后跟十份拥有者 Markdown | 通过；产品树仍未跟踪，因此另对备份与当前十五个文件做 `git diff --no-index --check` 与结尾检查 | `owned-whitespace.json` |

上述 source／本机测试不证明正式镜像、Linux PID1清理、gVisor隔离、真实模型、PG组合或恢复验收。未启动 Profile、修改私有配置或构建 lib／dist。没有运行会重建 Host 产物的根 `pnpm run lint`；没有将全仓库 doc-sync／test:docs 当作本次产品映射结果。集成者仍须冻结输入并执行完整适用集合。

## 依赖诊断与建议

全产品发现八份 manifest。实际导入声明错误为0；Contracts／Connector Runner按普通库检查源码导入与生产声明，不强加 Cordis Host peer。Application、Client Account、Client Extension Center按官方 configured-host／client-host 规则检查，两个 bundle另外核对所有插件引用。

| 类别 | 实际诊断数 | 判断与处理 |
|---|---|---|
| singleton 声明 | 4 | 真实规则缺陷：Application 的 `dsh-scope`／`dsh-session`，两个 client 的 Cordis；建议从 dependencies 改为匹配 peer＋dev |
| 其他 section／range | 32 | 官方规则要求25项移至 devDependencies、2项保持 dependencies-only并统一范围、5项 workspace范围诊断；这些不是通过增加safe例外能解决的问题 |
| 私有 runtime export 未分类 | 266次／80个不同export | 官方导出表没有审查过这些具体私有值；不能由 `private:true` 推断跨副本安全，保留失败 |
| 官方 runtime export 未分类 | 52次／34个不同export | 新产品消费关系超出当前审查表；需要逐个核对实际值、服务身份及消费者，保留失败 |
| policy integrity／直接导入 | 0／0 | 没有将其他失败隐藏成此项通过 |

[建议补丁](employee6-dependency-proposals.patch)只涉及三个 manifest：Application 增加 scope／Session peer＋dev，四项仅类型关系移至dev；两个client将Cordis改为peer＋dev，浏览器构建输入移至dev；按官方 helper 的范围规则将这三个受管包内的私有workspace关系改为 `workspace:~`。不改变任何第三方版本，不修改bundle的生产插件依赖。

36条section／range诊断有重复的范围说明，不能把它们视为36个独立依赖。建议在内存中消除这些诊断后，318条export分类诊断仍在。`scripts/package-dependency-policy.ts` 禁止自动新增safe例外，要求明确人工审查；本次没有修改政策、加宽阈值或把全部私有导出列为safe。没有运行官方 `--fix` 或刷新锁文件。

补丁不是当前构建输入，不是依赖验收结果。建议补丁还须经过生产闭包验证；独占文件最终摘要、链接、段落、行数与空白检查见私有 `owned-final-validation.json`。应用前复核当前manifest摘要、并发源码变化、真实客户端外部模块／内联关系与生产闭包；由集成拥有者统一应用并更新锁文件，再重跑依赖和受影响产物验证。完整未分类export与源码位置保存在私有 `dependencies.json`。

## 仍未通过与协调

09:25文档映射快照的127条剩余诊断分别来自：`reference/` 79、`CLOUD-ENGINEERING-REVIEW.md` 14、`TRIAL-CLOUD-MIGRATION-BASELINE.md` 7、Client Account／Client Extension Center／Cloud Web／Connector Runner各6、`CLOUD-MIGRATION-PLAN.md` 3。员工6没有越权修改这些文件。09:32再检查时文档数为110，诊断为135，新增8条为并发写入的 `EMPLOYEE1-HANDOFF.md` 硬换行段落；十份README和本交接仍零诊断。新的最终整产品文档报告以集成冻结后的执行为准。

员工3确认了独立检查入口、库与client角色修正和真实依赖分类。他已将 `kind` 检查改为解析真实YAML，合法引号不再误报，并将sidecar加入输入变更检测；员工6未修改这些脚本。官方映射文档lane复用链接、单段单行、Summary、canonical headings、kind与双语结构／记录；它不代表已经对产品新增了官方Model Experience所有审查表或完整语义规则。

当前剩余依赖失败为354诊断：36条未应用建议中的section／range，318条尚未审查的runtime export分类。当前产品范围的完整官方规则适配、冻结输入、生产闭包与M5组合验收由对应拥有者继续；员工6的交付限于上述README和建议。
