# PowerEvolve 云端开发工程复盘

## 摘要

`power-evolve/native-cloud-client` 的主要工程风险发生在模块交接、异步状态、执行副作用和验收证据之间。后续迁移要以完整用户切片交付，分别验证源码、产物、真实服务和运行环境，并把恢复能力与功能一起迁入。本文是开发前和代码审查时查阅的参考，具体开发顺序及范围以[云端迁移方案](CLOUD-MIGRATION-PLAN.md)为准。

事实分类固定为三类：历史故障且记录已修复、来源核查发现的当前缺口、测试保护或迁移风险。历史修复只说明相应版本通过，当前缺口以[来源核查记录](TRIAL-CLOUD-MIGRATION-BASELINE.md)固定的源码为限。测试覆盖的危险路径不自动等于曾经发生实际事故。

## 目录

- [客户端与构建](#客户端与构建)
- [授权租约与执行恢复](#授权租约与执行恢复)
- [数据与组合验收](#数据与组合验收)
- [开发与审查检查表](#开发与审查检查表)
- [证据使用规则](#证据使用规则)

## 客户端与构建

客户端测试要覆盖从源码到实际浏览器的完整加载过程。工作区解析器、VM factory 和原生 Loader 验证的是不同对象，不能相互替代。

### 源码依赖可解析而浏览器 module table 缺模块

历史产物预览曾把路径 helper 留作浏览器外部依赖，源码测试无法暴露实际加载失败。[O3 试用](reference/TRIAL-NATIVE-PREVIEW-O3.md#实际验收)记录了修复及产物检查。当前 STDIO 页面增加运行时 validators 后也需要处理 contracts、Zod 和 brand 的依赖闭包，修复仍在核查时的未提交工作区。

预防措施是区分必须共享身份的 React／Cordis／UI 服务与可内联的协议工具；检查实际 emitted factory 的外部请求、动态代码生成及目标 CSP。纳入的客户端保留[扩展中心工厂回归](client-extension-center/tests/client-factory.built.test.mjs)等产物检查，并另做真实 Loader、挂载、卸载和 Platform 调用验证。旧产物工厂回归仅作来源参考，不要求为已排除的插件迁入测试。工厂返回 `apply` 不表示组件已经可用。

### 异步目录快照被误作上传权限依据

历史上传逻辑曾要求客户端 Workspace 目录已同步，导致 Session 已被 Platform 授权时仍报无工作区。前端最终一致的列表不是服务端权限事实。旧客户端工作区文件插件的专用回归仅作历史参考，不要求迁入该插件。

迁移时按当前 Session 请求上传，由 Platform 在实际资源操作处鉴权；测试目录尚未到达、Session 切换与服务端拒绝。上传失败不得插入有效附件引用，前端不得为了可用性绕过服务端拒绝。

### 产物关联依赖错误的原生事件顺序

[执行产出验收](reference/TRIAL-S2-PRODUCED-FILES-QA.md#真实流程与结果)记录了续接实际事件为 `turn/start → step/start → user/message`。只在轮开始时建立关联，会导致文件已生成但续接摘要没有对应操作。

该事故及来源的原生产出回归作为历史参考保留。本轮已排除旧产物列举与可信执行产出专项功能，不要求迁入其关联组件或回归用例；纳入的原生 Session／资源适配仍须按真实事件序列验证。

### 不可用与服务故障被合并为一种失败

核查时的未提交修复仅在明确的 `503/stdio_v2_unavailable` 时进入旧固定 STDIO 入口；401、网络故障或其他 Platform 错误仍保持失败。这属于来源修复，不能据此宣布 enabled 通用 STDIO 完整可用。

保留[metadata 分类回归](client-extension-center/tests/stdio-v2-panel.client.spec.tsx)，检查失败分类与管理请求是否误发。迁移后通用 enabled 路径仍需接通真实配置接口，不得用 fallback 掩盖 404 或认证错误。

### 页面生命周期与已受理操作的生命周期不同

现有测试防止账号／Session 切换后的晚响应覆盖新页面，并保留不确定写入的原 requestId。它们是预防性覆盖，不能据此断言曾发生跨用户泄漏。

读请求随视图 abort，结果到达后核对当前身份和代次；已经受理的写入通过原回执对账，关闭组件不能创建新请求重新执行。保留[账号卸载回归](client-account/tests/session-expiry.spec.ts)、[STDIO 回执与切换回归](client-extension-center/tests/stdio-v2-panel.client.spec.tsx)。插件注册使用可释放 effects，热重载和卸载不得遗留监听者。

## 授权租约与执行恢复

入口校验无法覆盖请求体等待、数据库锁等待和外部执行之间的变化。迁移必须保留持久受理点、最终授权检查与精确执行身份；不能把恢复简化为重试整个动作。

### 锁等待跨过租约到期时间

[账号 V25 验收](reference/TRIAL-S3-ACCOUNT-V25-QA.md)记录了真实 PG 负例：过期 renew、事件追加和 claim 在锁等待后获得错误结果。修复使用拿锁后的数据库时钟和最终条件更新。

迁移保留 lease、epoch、token 和最终有效期检查，在真实 PG 中覆盖 claim、renew、append 及最终更新窗口。保留来源持锁回归的验证目标；假时钟或无竞争事务无法证明这类保证。

### 撤权发生在浏览器请求受理之前

[云端组合验收](reference/TRIAL-CLOUD-COMBINED-QA.md#路线与发现)记录了请求体或账号锁等待期间撤销后仍可提交新存储意图的问题。修复在持久受理事务内复核 bearer，已提交意图按既有账号语义继续。

对纳入的持久操作保留账号到资源的锁顺序与最后授权检查，测试请求体等待、锁等待、跨用户和错误 audience。来源存储受理授权回归作为历史参考，排除功能对应的用例不要求迁入。不要把已撤销凭据继续观察原执行的有限权限，扩展为新动作授权。

### 存储恢复与闲置回收竞争

[存储绑定验收](reference/TRIAL-S2-STORAGE-BINDINGS-QA.md)记录了恢复候选被闲置回收、终结请求继续占用当前引用，以及正常停服后接管受阻的问题。对应修复保留阶段所有权、请求回执和原写者停止事实。

本轮已排除旧绑定失效及恢复功能，不要求迁入其专用服务或连续换绑验收。该事故仍说明执行与资源回收需要同一所有权判断；纳入的 Cloud 执行和回收保持原 Pod UID、当前写者及精确停止证明检查，不通过手工清空 PG 或直接删 Pod 制造通过。

### 创建超时后的挂载预留和不确定执行

来源发布组合记录中的创建恢复部分记录了未派发沙盒创建超时后，同请求被已有预留阻塞的问题；创建取消部分另验证了原预留的停止与释放。该记录仅作历史参考，未迁入当前部署文档。

恢复继续观察同一预留及原资源，已捕获 UID 变化必须拒绝；取消后保存确切停止事实再释放写入占用。将“尚未派发”与“已经派发但结果未知”分开测试，不因请求超时、GET 404 或父进程退出就重造资源、重放命令或认定全部写者停止。历史创建恢复不证明所有镜像拉取故障或所有已派发命令恢复。

## 数据与组合验收

完整迁移包括数据兼容和实际成果读回。测试入口、部署角色和运行版本都必须与声明的交付范围匹配。

### 长结果在续接层成为阻塞任务

[Office 长结果事故](reference/TRIAL-S8-SKILLS-QA.md#long-office-guide-initially-left-a-queued-operation-and-starved-other-continuations-fixed-and-replayed)中，执行已成功，但持久续接文本的 43,574 字符超过旧 Grant 的 16,384 字符限制。claim 事务反复回滚并优先选择同一任务，另一用户的短结果也无法领取，重启无效。修复后两条原请求自然完成，没有重放工具执行。

迁移统一模型／Runner 输出、PG、Grant、RPC 与流的预算及超限策略，区分字符数与 UTF-8 字节数。验证 Unicode、NUL、长结果、第二用户公平性、原请求重启与唯一 continuation；工具 exit 0 不能作为端到端完成出口。

### 测试替身提供了真实服务缺少的路由

核查的 [STDIO management RPC](application/src/stdio-v2-management-rpc.ts)先调用 `/stdio-v2/config`，但来源真实 Platform 路由的 enabled 分支没有对应 case；来源 Host 测试的替身提供了该接口。因此这是来源静态核查时的接线缺口，不是本轮运行复现的结果；不能用当前 [Platform 路由](application/src/platform/index.ts)反推来源已经通过。

迁移必须以真实 Host＋Platform＋PG 验证 enabled metadata、管理、discovery、approval、call、cancel 和原会话一次续接，再验证 disabled 与权限拒绝。只有管理 mock 通过或 disabled 返回正确，不能关闭 F16。

### Schema 与兼容测试漂移

核查时来源源码 `CURRENT_SCHEMA_VERSION` 为 37，而来源 Office 兼容测试仍断言 34。它表明兼容审查入口需要更新；不能只改断言数字而跳过原始事实检查。[V33 备份记录](reference/TRIAL-OFFICE-BACKUP-V33.md)也仅覆盖其固定版本的 PG／缓存范围。

每次 DDL 变更把相邻迁移、旧行与原 JSON／时间／停止证据、重复启动、未来版本拒绝和当前完整备份恢复作为同一交付。兼容测试更新必须说明哪些持久事实保持、哪些发生合法变化；使用恢复后的新服务实际启动和新任务证明可用。

### 备份预检暗含数据库管理员权限

来源发布组合记录中的正式镜像停写备份与恢复部分记录了直接读取受保护 `pg_user_mapping` 导致普通角色被拒绝的问题。修复使用 `pg_user_mappings`，没有通过增加宽泛授权绕过；该记录仅作历史参考，未迁入当前部署文档。

使用实际部署角色测试空目标接受、非空目标在写入前拒绝，以及 PG、文件、私有配置和技能历史的独立恢复。当前[数据库备份与恢复回归](deploy/employee4-backup.test.mjs)使用隔离普通角色。超级用户成功不能替代普通角色交付条件。

### 测试入口与物理环境的证明范围不同

根 [Vitest 配置](../../vitest.config.ts)与[产品 scripts](../../package.json)使用不同入口；当前产品总测试还包含 Desktop。STDIO 的[PG／Docker 结果记录](reference/TRIAL-STDIO-V2-RESULTS.md)明确两用户顺序共用容器，Pod／PVC／manifest 是替身，不能证明物理文件系统隔离。

迁移建立云端独立测试入口，登记实际执行文件与 skip。物理隔离必须核对两个执行身份、受限挂载和文件哨兵；真实 PG、真实 Docker、真实 SDK 分别注明，不能汇总为“真实云环境全部通过”。

### 源码与生产产物闭包不同

[源码测试配置](../../vitest.config.ts)使用 source paths 避免加载第二份 lib 单例；产物应在普通 Node 和生产依赖目录中验证。来源正式构建记录还记录了 legacy deploy 在 frozen 参数下重新解析依赖，独立锁闭包校验才约束了实际版本和 integrity。该记录仅作历史参考，未迁入当前部署文档。

每个检查标明 source 或 artifact，清洁输入构建后核对实际生产闭包、peer／optional 依赖、镜像与运行 Profile。不要把 source import 改成 lib 来凑通过，也不要把编译成功当作正式镜像或目标架构通过。

云端 Host 的运行时导出由[具名 peer 分类](scripts/cloud-peer-policy.mjs)在官方策略上合并，保留原有 SDK token；新增 SDK 与私有 Runner 导出须核对实际值定义、当前 Host 用法和 Profile provider。分类为 peer 后，消费包仍须声明匹配的 peerDependencies 与 devDependencies，生产 provider、锁闭包和运行时身份由集成验收核对；类型导入只要求开发依赖。此分类不扩充 SAFE 或 duplicate-safe 许可，门禁继续拒绝未分类导出、namespace、过期条目、未声明导入及错误依赖区段。

### 功能完整性与固定试用版本被错误汇总

[历史完整性审计](reference/PARITY-AUDIT.md)针对旧基线，后续记录已经补齐其中若干缺口；[正式试用](reference/TRIAL-FORMAL-IMAGE-LOCAL.md)、[报告流程](reference/TRIAL-S8-REPORT-WORKFLOW.md)和[O3 预览](reference/TRIAL-NATIVE-PREVIEW-O3.md)又分别固定不同源码与镜像。完整报告已有历史通过证据，不能按旧路线文字重新判定未实现。

按用户确认的范围、用户操作、后端状态和恢复出口建立迁移清单。[五项原生 DSH 没有的旧功能](CLOUD-MIGRATION-PLAN.md#本次不迁入的旧功能)已明确不迁入，不要求替代界面或工具流程；其余纳入能力不得遗漏。每个通过结果绑定实际版本；只重跑受影响场景，但不能用新版本的一次读回追认全部历史流程。

固定试用保存独立数据、私有配置、运行闭包和精确启停工具。环境操作核验数据库、namespace、Deployment、镜像、进程和端口身份；保留失败现场，停止当前写者并对账后再切换版本，不删除共享 PG／k3s 或重放旧任务。

## 开发与审查检查表

官方通用工程规范及产品检查接入要求由[迁移方案](CLOUD-MIGRATION-PLAN.md#工程规范与质量检查)拥有，本复盘补充已发生故障对应的审查重点。实施采用固定目标版本的规则，避免从旧来源带回已移除的检查机制。

| 时点 | 开发者与审查者必须确认 |
| --- | --- |
| 接任务前 | 对应纳入的 F 编号、完整用户出口、允许修改目录、来源版本、依赖接口和失败恢复条件明确；适用规范与检查能发现本切片；排除功能不分配迁移任务 |
| 设计接口时 | 稳定 requestId、最后授权检查、持久受理点、lease／epoch、状态语义、输出预算和原会话续接明确 |
| 改客户端时 | 公开插槽、locale、外部模块表、身份／Session 切换、卸载和回执恢复覆盖；个人开关不改共享 Profile |
| 改执行时 | 一次派发、原资源查询、精确执行身份、独立停止证明、unknown 不重放；取消与撤权不丢原事实 |
| 改数据时 | 相邻迁移及保留事实、旧数据、重复启动、版本拒绝和当前恢复检查同步更新 |
| 集成时 | 使用最终构建产物与真实服务，完成客户端到成果读回；核对产品 CI 的实际文件／用例范围和适用检查结果；根配置、锁文件、Profile 和补丁由集成者统一处理 |
| 宣布完成前 | 独立验收，明确真组件／替身、实际测试／skip、源码／镜像／Schema；同版本用户流程与恢复、必需工程检查和独立审查通过 |

## 证据使用规则

当前 MCP／PDF 验收使用[具名范围清单](scripts/cloud-scope-mcp-pdf.json)，由 CLI、Vitest、原生 coverage 收集、静态类型程序与 CI 共用。只有四个纯客户端 SSH 运行时文件和三个历史测试延期；混合 transport、原生服务、legacy 数据、Office 依赖及共享 Skills 按整文件保留，四项逐文件 coverage 均要求 100%。临时类型配置保留原编译选项、有效 ambient 类型查找目录和项目引用，仅从根文件列表移除批准延期的文件。新增文件缺少 owner、范围或原因时拒绝发现结果。

本轮交付依据[M0覆盖率例外](TRIAL-CLOUD-MIGRATION-M0.md#本轮交付的覆盖率例外)记录未达100%的文件及原FAILED报告，补齐覆盖继续作为后续质量工作。此例外不放宽必测业务、真实系统与恢复、其他工程检查或独立审查，也不将CI的覆盖失败隐藏为通过。

当前入口为 `pnpm exec tsx products/power-evolve/scripts/cloud-check.mjs --scope=current`，保留的完整 backlog 通过 `--scope=full` 复现；直接运行 Vitest 的完整入口还需设置 `PE_CLOUD_SCOPE=full`。报告明确记录所选范围及完整 backlog 是否执行；当前范围通过不能替代完整 backlog 的验收。

源码 CLI 子进程须加载当前源码入口，使用门禁从冻结输入生成的原生 coverage 环境，并核对实际子进程 PID、执行代码、source map 与源码哈希。Vitest 仅传递该环境；产物 CLI／Profile 用例在普通 Node 中独立消费同版本 lib 与包导出。执行 lib 不给未执行的源码分支记 coverage，源码与产物结果分别报告。

历史 QA 是回归设计和已发生故障的证据，不能替代新版本验收。源码存在是实现依据；静态失配是待解决项；替身和产物 factory 只能支持其记录的范围；真实用户流程与精确运行身份才支持对应组合结果。

验收报告保留失败和修复后的结果，不能手工改持久状态、重发未知命令或扩大权限以制造通过。未覆盖条件放入具名缺口；是否属于本轮完成范围，以[迁移方案](CLOUD-MIGRATION-PLAN.md#功能迁移清单)为准。
