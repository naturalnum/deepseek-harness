# 员工6：Contracts 运行导出与多副本审计

本文保留10:44源码快照对应的只读审计与历史虚拟方案。授权后的真实桥接、四份manifest和独立cloud PEER切片见[当前实施交接](EMPLOYEE6-PEER-HANDOFF.md)；下文的“未实施”描述属于该次历史审计，不代表最新工作区。原SAFE补丁仍不应用。

## 结论与边界

最新实施建议是独立cloud范围的具名`peer-required`表、共享Contracts提供者及正式resolver／安装闭包保证，不新增SAFE例外。原[13项SAFE补丁](employee6-export-policy-proposals.patch)原样保留为历史证据，**不应用，也没有策略要求的人工授权**。主控对任务结果的复核不构成人工SAFE审查。当前真实策略未改变；下文的源码／manifest／分类变更均为只读虚拟方案，现有2＋2运行不受本轮操作影响。61个当前具名schema／工厂仍未分类，未完成真实运行闭包验证。

本次交付只新增本审计与补丁文件；没有应用补丁，没有编辑manifest、锁文件、运行源码、[正式策略](../../scripts/package-dependency-policy.ts)或产品检查器，没有Git add／commit。主控已自行整理上一轮三个manifest；旧354诊断不代表整理后的当前依赖结果。本次导出模拟只讨论classification，不替代section、生产闭包或完整迁移验收。

消费者表的源码快照时间为2026-10-09 10:44:55 +08:00；分析301个发现文件，并对全部文本先做内存快照，再以TypeScript符号绑定识别导入别名、运行引用、Contracts内部组合及account相对façade。此次trace期间输入摘要未变、未解析的导入为0。所有119行均给出定义行、具名Host导入次数、外部消费者引用行和内部引用行；类型位置不计入运行引用。探针来自独立复制的九份Contracts源码、brand和Zod4.4.3。Contracts源码在探针与策略模拟之间摘要一致。

## 分类依据

| 类别 | 全部导出数 | 多副本行为与本次处理 |
|---|---:|---|
| P：primitive | 14 | 数字／字符串或依赖同类值的计算；消费者做值比较、长度预算或路径组合。原SAFE候选有7项；现不应用，实施方案统一具名peer |
| R：record | 5 | `as const`仅限制TypeScript，运行对象未冻结；不同副本对象身份不同。已核对读取字段、spread或路由表构造，无修改记录或用记录身份作注册键的当前消费者。原SAFE候选有3项；现不应用，实施方案统一具名peer |
| F纯：函数 | 3 | 相同已验证的普通输入产生相同URL、布尔值或完整JSON文本；不维护服务、实例注册或跨调用计数。原SAFE候选3项不应用，实施方案统一具名peer |
| F捕获：Zod工厂 | 2 | `stdioJsonV2`直接、`stdioObjectV2`间接捕获调用者的原预算对象；修改该对象会改变验证结果。是调用者状态，不能称为数学纯函数。返回schema还受Zod共享配置影响；不建议SAFE；拟按具名peer共享提供者 |
| F副本：Zod工厂 | 7 | 先parse配置得到局部预算副本，再分配schema／局部闭包；没有包级执行服务。返回schema仍有引用身份和Zod配置依赖；不建议SAFE；拟按具名peer共享提供者 |
| Z／Z别名：静态schema | 88 | 模块级Zod对象拥有本地schema身份及内部缓存；不同副本对象不相等，虽在同版本探针中parse及异常兼容，仍不足以放行共享配置／registry相关行为；不建议SAFE；拟按具名peer共享提供者 |

119项包括19个值、12个函数和88个静态schema，另91个显式type／interface只存在于编译期，不是运行分类候选。未发现Contracts导出的服务类、Cordis context、事件总线、持久化实例、模块级授权注册或once-consumption状态；这不等于没有可变对象。上游 [brandString](../../packages/util/brand/src/index.ts)只返回原字符串，品牌不是运行时unique symbol、注册token或认证证据。

P／R／F纯是具体导出值的重复安装行为判断，原SAFE建议不实施；当前方案为统一协议提供者采用具名peer约束。除纯JSON模块外，所在模块会加载Zod；补丁没有将这些模块或Zod标为整体duplicate-safe，也没有解除其余schema的失败。人工复核应同时审视宿主的Zod加载／配置顺序。若路由记录被新增写入、身份比较或registry用途，本次R判断失效；本补丁不能表达或自动维护这样的源码不变量。

## 111组schema探针与共享状态反例

使用同一Node realm中的两份物理Contracts＋brand＋Zod4.4.3副本，没有借用同一node_modules/zod链接冒充多副本。88个静态schema逐项用合成有效值和无效`undefined`检验，并对9个工厂产生的23个返回schema做同样检验，共111组。每组比较parse结果和拒绝issues，并验证A的schema在B的`z.object`组合中工作、A的错误满足B的`ZodError instanceof`。另核对19个值的结构一致与三项纯函数。测试fixture与完整逐项结果保存在私有证据目录，不含真实凭据。

| 证据 | 实际观察 | 能支持的结论 |
|---|---|---|
| 111 schema组 | 两副本有效／无效输入结果、跨副本组合及错误识别一致 | 当前版本、同Node realm、既定fixture下的行为兼容；不是任意输入、任意Zod版本或真实浏览器bundle证明 |
| Zod `Symbol.hasInstance` | 源码检查`_zod.traits.has(name)`，不是只比构造器地址 | 当前 [HTTP错误处理](application/src/http.ts)中的跨副本`ZodError`识别有实现与探针依据 |
| 共享config反例 | A设置自定义locale后，加载B重置该locale；A/B的`z.config()`返回同一对象 | 第二份Zod的导入可影响第一份副本的错误消息；不具备配置隔离 |
| 共享registry反例 | A/B的`globalRegistry`同一对象；两不同schema登记同一metadata id后，idmap指向B的schema | schema身份／metadata注册不能以结构同名代替；当前消费者没有使用该路径，仍不放行schema |
| schema／record身份 | 不同副本对象引用不同；Office prepare别名仅在各自副本内相等 | 不允许从同名、同结构或副本内别名推断跨副本身份相等 |
| caller预算反例 | 修改传给`stdioJsonV2`的原`maxBytes`，已建立的两个验证器均改变行为 | `stdioObjectV2`也经该闭包捕获原预算；冻结或复制预算属于调用者约束，不是包单例 |
| JSON realm边界 | 外realm的原始plain object被拒绝；JSON文本经本realm的`JSON.parse`重建后接受 | 不保证跨realm原始对象互操作；进程／HTTP文本边界与本realm副本问题应分别判断 |

Zod实现证据来自安装的4.4.3：`src/v4/core/core.ts`69–73行的`Symbol.hasInstance`、128–152行的`__zod_globalConfig`，`src/v4/core/registries.ts`32–43及96–105行的WeakMap／idmap与全局registry，`v4/classic/external.js`8–10行的`config(en())`。registry探针最初以“同id会抛错”作为待验证假设而失败；源码和第二次探针确认实际是idmap后注册覆盖，审计采用后者。首个失败的stderr来自工具执行记录，另转录到`zod-shared-state-probe-first-failure.log`并标明并非当时重定向保存；第二次的实际执行日志与JSON独立保留，不隐藏失败。

当前产品运行源码没有`z.config`、schema`.meta`／`.register`或全局registry使用；读取`.shape`／`.options`、parse、safeParse及组合派生schema不能证明以后也不会添加身份依赖。[Contracts浏览器构建](contracts/tsdown.config.ts)与两个Client构建明确写共享`jitless=true`并内联Zod。这次未执行正式构建或多bundle启动序列，不能把本地ESM探针外推到任意宿主配置；因此52个当前具名静态schema及9个工厂继续未分类，未贸然写入peer-required表。

## 序列化与权威身份

`stdioCanonicalJsonV2`每次调用复制／验证预算，使用调用内栈、WeakSet与token数组；按code-unit排序对象key，不规范化字符串，保留完整JSON字段。探针覆盖Unicode、转义NUL、数字形key、`__proto__`／`constructor`字段、accessor拒绝且不执行getter、字节上限拒绝、外realm对象拒绝与本地JSON重建。普通有效JSON与预算得到相同文本，预算超限拒绝，不截断。该函数的单副本和双副本行为不需要共享注册、schema或服务；它不认证输入来源。

[STDIO digest实现](connector-runner/src/stdio-v2-digest.ts)用固定`power-evolve-stdio-…-v2` domain包住原值，再对规范JSON的UTF-8文本做SHA／HMAC；[dispatch实现](connector-runner/src/stdio-v2-dispatch.ts)比较原permit／executorOwner的完整规范JSON。当前消费者比较primitive id、digest、路径及完整值，而不是比较Contracts schema地址。不同副本schema输出的品牌id仍是普通字符串，不能代替真实用户、PG租约、原Runner／Pod／UID或一次授权身份。

[Cloud数据库定义](application/assets/cloud-schema-v1.sql)与[STDIO入队](application/src/platform/stdio-v2-call-admission.ts)、[管理保存](application/src/platform/stdio-v2-connections.ts)使用PG `json`及`JSON.stringify`／`::json`保存完整原任务、配置与结果；这些路径不能擅自改成jsonb重整或去掉原始扩展字段。普通Account／Office metadata存在jsonb用途，本审计不要求所有JSON都使用同种列。schema通过、多副本输出一致与规范digest一致均不证明PG保存文本的字节完全一致，也不证明真实授权、外部副作用停止或重放可行；[worker存储](application/src/platform/stdio-v2-worker-store.ts)与[lease验证](application/src/platform/stdio-v2-leases.ts)仍须独立维持这些权威条件。

## 源码模块与消费者索引

以下模块都在`@power-evolve/contracts/`下；“具名Host”是正式collector看到的具体named import occurrence，不是表达式引用次数。account另有一次无界重导出。C索引覆盖实际外部运行表达式，M索引覆盖Contracts内部运行组合；如“C01:10,20”表示对应快照文件第10和20行，未合并成模糊的包级consumer。无外部表达式的符号仍列出内部引用，不据此新增unused策略项。

| M索引／源码 | 导出子路径 | 运行导出 | type／interface | 具名Host符号／次数 |
|---|---|---:|---:|---:|
| M1：[源码](contracts/src/account.ts) | `@power-evolve/contracts/account` | 35 | 12 | 1／3 |
| M2：[源码](contracts/src/execution-resolution.ts) | `@power-evolve/contracts/execution-resolution` | 17 | 10 | 10／19 |
| M3：[源码](contracts/src/file-download.ts) | `@power-evolve/contracts/file-download` | 11 | 5 | 11／23 |
| M4：[源码](contracts/src/office-preview.ts) | `@power-evolve/contracts/office-preview` | 15 | 15 | 14／26 |
| M5：[源码](contracts/src/stdio-management.ts) | `@power-evolve/contracts/stdio-management` | 4 | 17 | 4／9 |
| M6：[源码](contracts/src/stdio-mcp-json.ts) | `@power-evolve/contracts/stdio-mcp-json` | 1 | 1 | 1／5 |
| M7：[源码](contracts/src/stdio-mcp.ts) | `@power-evolve/contracts/stdio-mcp` | 27 | 23 | 24／133 |
| M8：[源码](contracts/src/stdio-runtime.ts) | `@power-evolve/contracts/stdio-runtime` | 5 | 6 | 5／18 |
| M9：[源码](contracts/src/storage.ts) | `@power-evolve/contracts/storage` | 4 | 2 | 4／5 |

| C索引 | 实际消费者 | 运行用途 |
|---|---|---|
| C01 | [application/src/contracts.ts](application/src/contracts.ts) | 共享传输、模型工具或schema组合；直接成员：`shape` |
| C02 | [application/src/file-download-http.ts](application/src/file-download-http.ts) | 共享传输、模型工具或schema组合；直接成员：`length`, `parse` |
| C03 | [application/src/host/index.ts](application/src/host/index.ts) | Host API桥接／原响应校验／路径与模型工具输入；直接成员：`capabilities`, `parse` |
| C04 | [application/src/host/native-office-preview.ts](application/src/host/native-office-preview.ts) | Host API桥接／原响应校验／路径与模型工具输入；直接成员：`cancel`, `content`, `generation`, `parse`, `prepare`, `safeParse`, `shape`, `status` |
| C05 | [application/src/host/stdio-v2.ts](application/src/host/stdio-v2.ts) | Host API桥接／原响应校验／路径与模型工具输入；直接成员：`options`, `shape` |
| C06 | [application/src/mcp-json-schema.ts](application/src/mcp-json-schema.ts) | 共享传输、模型工具或schema组合 |
| C07 | [application/src/mcp-model-tools.ts](application/src/mcp-model-tools.ts) | 共享传输、模型工具或schema组合 |
| C08 | [application/src/platform/account-authority.ts](application/src/platform/account-authority.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`deleted`, `disabled`, `forbidden`, `notFound`, `parse`, `passwordChangeRequired`, `safeParse`, `unauthorized` |
| C09 | [application/src/platform/account-bootstrap.ts](application/src/platform/account-bootstrap.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`bootstrapConflict` |
| C10 | [application/src/platform/account-config.ts](application/src/platform/account-config.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取 |
| C11 | [application/src/platform/account-routes.ts](application/src/platform/account-routes.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`capabilities`, `changePassword`, `create`, `list`, `login`, `logout`, `me`, `models`, `parse`, `receipt`, `remove`, `resetPassword`, `unauthorized`, `update` |
| C12 | [application/src/platform/accounts.ts](application/src/platform/accounts.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`currentPasswordInvalid`, `executionActive`, `lastAdministrator`, `limit`, `modelNotAuthorized`, `notEmpty`, `notFound`, `parse`, `passwordInvalid`, `requestConflict`, `revisionConflict`, `usernameConflict` |
| C13 | [application/src/platform/cloud-execution-resolution.ts](application/src/platform/cloud-execution-resolution.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C14 | [application/src/platform/cloud-storage-types.ts](application/src/platform/cloud-storage-types.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`extend` |
| C15 | [application/src/platform/execution-resolution-routes.ts](application/src/platform/execution-resolution-routes.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`executionResolutionInspect`, `executionResolutionStatus`, `executionResolutionsList`, `inspect`, `list`, `parse`, `resolve`, `status` |
| C16 | [application/src/platform/file-downloads.ts](application/src/platform/file-downloads.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C17 | [application/src/platform/files.ts](application/src/platform/files.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse`, `safeParse` |
| C18 | [application/src/platform/identity.ts](application/src/platform/identity.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C19 | [application/src/platform/index.ts](application/src/platform/index.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`cancel`, `content`, `generation`, `parse`, `prepare`, `status` |
| C20 | [application/src/platform/managed-storage.ts](application/src/platform/managed-storage.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C21 | [application/src/platform/model.ts](application/src/platform/model.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取 |
| C22 | [application/src/platform/office-preview-config.ts](application/src/platform/office-preview-config.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取 |
| C23 | [application/src/platform/office-preview-pod.ts](application/src/platform/office-preview-pod.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse`, `shape` |
| C24 | [application/src/platform/office-previews.ts](application/src/platform/office-previews.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`nullable`, `parse`, `safeParse`, `shape` |
| C25 | [application/src/platform/sandbox.ts](application/src/platform/sandbox.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`options`, `parse` |
| C26 | [application/src/platform/skills.ts](application/src/platform/skills.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C27 | [application/src/platform/stdio-v2-actions.ts](application/src/platform/stdio-v2-actions.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`options`, `parse` |
| C28 | [application/src/platform/stdio-v2-admission.ts](application/src/platform/stdio-v2-admission.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`nullable`, `parse` |
| C29 | [application/src/platform/stdio-v2-authorization.ts](application/src/platform/stdio-v2-authorization.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse`, `shape` |
| C30 | [application/src/platform/stdio-v2-call-admission.ts](application/src/platform/stdio-v2-call-admission.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse`, `shape` |
| C31 | [application/src/platform/stdio-v2-cloud-capture.ts](application/src/platform/stdio-v2-cloud-capture.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C32 | [application/src/platform/stdio-v2-cloud-runtime.ts](application/src/platform/stdio-v2-cloud-runtime.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C33 | [application/src/platform/stdio-v2-cloud-worker.ts](application/src/platform/stdio-v2-cloud-worker.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C34 | [application/src/platform/stdio-v2-connections.ts](application/src/platform/stdio-v2-connections.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C35 | [application/src/platform/stdio-v2-continuations.ts](application/src/platform/stdio-v2-continuations.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C36 | [application/src/platform/stdio-v2-leases.ts](application/src/platform/stdio-v2-leases.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C37 | [application/src/platform/stdio-v2-no-start.ts](application/src/platform/stdio-v2-no-start.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`nullable`, `options`, `shape` |
| C38 | [application/src/platform/stdio-v2-operation-admission.ts](application/src/platform/stdio-v2-operation-admission.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`parse` |
| C39 | [application/src/platform/stdio-v2-platform-config.ts](application/src/platform/stdio-v2-platform-config.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取 |
| C40 | [application/src/platform/stdio-v2-results.ts](application/src/platform/stdio-v2-results.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`nullable`, `options`, `parse`, `shape` |
| C41 | [application/src/platform/stdio-v2-services.ts](application/src/platform/stdio-v2-services.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取 |
| C42 | [application/src/platform/stdio-v2-worker-store.ts](application/src/platform/stdio-v2-worker-store.ts) | Platform边界／PG记录／预算／租约或响应的校验与字段值读取；直接成员：`options`, `parse`, `shape` |
| C43 | [application/src/stdio-v2-management-rpc.ts](application/src/stdio-v2-management-rpc.ts) | 共享传输、模型工具或schema组合；直接成员：`refine`, `safeParse` |
| C44 | [application/src/stdio-v2-model-tools.ts](application/src/stdio-v2-model-tools.ts) | 共享传输、模型工具或schema组合；直接成员：`parse` |
| C45 | [application/src/stdio-v2-operation-contracts.ts](application/src/stdio-v2-operation-contracts.ts) | 共享传输、模型工具或schema组合；直接成员：`parse`, `shape` |
| C46 | [client-account/src/client/account-api.ts](client-account/src/client/account-api.ts) | Client输入／响应校验、配置／路由值与页面预算；直接成员：`parse` |
| C47 | [client-account/src/trusted/AccountManagementSection.tsx](client-account/src/trusted/AccountManagementSection.tsx) | Client输入／响应校验、配置／路由值与页面预算 |
| C48 | [client-account/src/trusted/http-client.ts](client-account/src/trusted/http-client.ts) | Client输入／响应校验、配置／路由值与页面预算；直接成员：`changePassword`, `create`, `currentPasswordInvalid`, `executionActive`, `lastAdministrator`, `limit`, `list`, `login`, `logout`, `me`, `modelNotAuthorized`, `models`, `notEmpty`, `passwordInvalid`, `receipt`, `remove`, `requestConflict`, `resetPassword`, `revisionConflict`, `update`, `usernameConflict` |
| C49 | [client-extension-center/src/client/StdioV2Panel.tsx](client-extension-center/src/client/StdioV2Panel.tsx) | Client输入／响应校验、配置／路由值与页面预算；直接成员：`parse` |
| C50 | [client-extension-center/src/client/stdio-v2-api.ts](client-extension-center/src/client/stdio-v2-api.ts) | Client输入／响应校验、配置／路由值与页面预算；直接成员：`parse`, `refine` |
| C51 | [client-extension-center/src/client/stdio-v2-state.ts](client-extension-center/src/client/stdio-v2-state.ts) | Client输入／响应校验、配置／路由值与页面预算；直接成员：`parse`, `shape` |
| C52 | [connector-runner/src/stdio-v2-digest.ts](connector-runner/src/stdio-v2-digest.ts) | 规范JSON的domain digest／approval HMAC；直接成员：`parse` |
| C53 | [connector-runner/src/stdio-v2-dispatch.ts](connector-runner/src/stdio-v2-dispatch.ts) | dispatch schema及原permit／owner值比较；直接成员：`parse` |
| C54 | [connector-runner/src/stdio-v2-runtime.ts](connector-runner/src/stdio-v2-runtime.ts) | 共享传输、模型工具或schema组合；直接成员：`options`, `parse` |

## 119个运行导出逐项记录

当前具名运行使用均建议未来按`peer-required`实施；SAFE补丁已停止作为实施建议，当前策略未改变。Z／F未建议的原因见共享状态证据；Host次数为0的项不新增策略条目，以免违反unused分类约束。account每项均可由façade的`export *`被整体暴露；这种无界导出仍保持拒绝，不用35个schema／值的枚举冒充收窄过的源码。

### M1：`@power-evolve/contracts/account`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `ACCOUNT_PAGE_PATH` L9 | P：`'/account'` | 0／不加；*仍拒绝 | C12:129 | 无 |
| `ACCOUNT_PASSWORD_FRAGMENT` L11 | P：`'password'` | 0／不加；*仍拒绝 | 无 | 无 |
| `ACCOUNT_PASSWORD_MIN_BYTES` L13 | P：`12` | 0／不加；*仍拒绝 | C12:170; C48:118 | M1:47,108 |
| `ACCOUNT_PASSWORD_MAX_BYTES` L15 | P：`256` | 0／不加；*仍拒绝 | C12:170; C48:119 | M1:45,47,109 |
| `ACCOUNT_MAX_PAGE_ITEMS` L17 | P：`100` | 0／不加；*仍拒绝 | C12:169 | M1:77,102,107 |
| `ACCOUNT_MAX_MODELS_PER_USER` L19 | P：`16` | 0／不加；*仍拒绝 | C12:169; C47:181 | M1:61,108 |
| `ACCOUNT_ROUTES` L21 | R：字符串字段的可变记录 | 0／不加；*仍拒绝 | C03:71; C11:19,23,24,38,39,45,46,47,48,49,50,51,52,53,54,55; C48:105,109,130,140,152,165,172,177,180,190,203 | 无 |
| `accountRole` L29 | Z：`z.enum` | 0／不加；*仍拒绝 | C08:13 | M1:60,67,79,86,92 |
| `accountAudience` L31 | Z：`z.enum` | 0／不加；*仍拒绝 | C08:117 | 无 |
| `accountUserId` L35 | Z：`identifier.transform`；brandString变换返回原始字符串 | 3／当前未分类；拟具名peer | C08:13,123; C10:21,22; C12:203,232; C17:74,112; C18:62,122; C20:34; C23:65; C24:40; C26:613; C27:20,25,95,196; C29:54,63,65,76,80,121; C35:21,26,111,165,238; C36:11; C37:24; C40:20,26,32,34,100,148,188; C42:23,29,35,84,87,125,154,203,208,234,275,279 | M1:66,70,86,92; M7:124,125,178 |
| `accountNewUsername` L43 | Z：`z.string` | 0／不加；*仍拒绝 | C10:22 | M1:60 |
| `accountNewPassword` L45 | Z：`z.string` | 0／不加；*仍拒绝 | C10:23 | M1:73,121 |
| `accountBearerToken` L50 | Z：`z.string` | 0／不加；*仍拒绝 | C08:116 | M1:97 |
| `accountLoginRequest` L52 | Z：`z.object` | 0／不加；*仍拒绝 | C11:12,40; C19:594; C48:130 | 无 |
| `accountEmptyRequest` L54 | Z：`z.object` | 0／不加；*仍拒绝 | C03:37; C11:12,13,45,46,47,48 | 无 |
| `accountModelSelection` L56 | Z：`z.object` | 0／不加；*仍拒绝 | 无 | M1:61 |
| `accountCreateRequest` L59 | Z：`z.object` | 0／不加；*仍拒绝 | C11:13,50; C48:165 | 无 |
| `accountUpdateRequest` L65 | Z：`z.object` | 0／不加；*仍拒绝 | C11:13,51; C48:172 | 无 |
| `accountTargetMutationRequest` L70 | Z：`z.object` | 0／不加；*仍拒绝 | C11:14,52,53; C48:177,180 | 无 |
| `accountChangePasswordRequest` L72 | Z：`z.object` | 0／不加；*仍拒绝 | C11:15,54; C48:203 | 无 |
| `accountListRequest` L76 | Z：`z.object` | 0／不加；*仍拒绝 | C11:13,49; C48:152 | 无 |
| `accountReceiptRequest` L82 | Z：`z.object` | 0／不加；*仍拒绝 | C11:15,55; C48:190 | 无 |
| `accountValue` L85 | Z：`z.object` | 0／不加；*仍拒绝 | C12:43 | M1:97,100,102,116 |
| `accountCapabilitiesValue` L91 | Z：`z.object` | 0／不加；*仍拒绝 | C03:115; C12:128; C46:107 | 无 |
| `accountLoginValue` L96 | Z：`z.object` | 0／不加；*仍拒绝 | C12:115; C48:130 | 无 |
| `accountMeValue` L100 | Z：`z.object` | 0／不加；*仍拒绝 | C12:141; C48:105 | 无 |
| `accountListValue` L102 | Z：`z.object` | 0／不加；*仍拒绝 | C12:194; C48:153 | 无 |
| `accountModelCatalogValue` L104 | Z：`z.object` | 0／不加；*仍拒绝 | C12:166; C48:109 | 无 |
| `accountMutationKind` L113 | Z：`z.enum` | 0／不加；*仍拒绝 | 无 | M1:116 |
| `accountMutationReceipt` L115 | Z：`z.object` | 0／不加；*仍拒绝 | C12:64,69 | M1:119,124 |
| `accountMutationValue` L119 | Z：`z.object` | 0／不加；*仍拒绝 | C48:173,180,203 | M1:121 |
| `accountSecretMutationValue` L121 | Z：`accountMutationValue.extend` | 0／不加；*仍拒绝 | C12:221,239; C48:167,177 | 无 |
| `accountReceiptValue` L124 | Z：`z.object` | 0／不加；*仍拒绝 | C12:330; C48:190 | 无 |
| `accountLogoutValue` L126 | Z：`z.object` | 0／不加；*仍拒绝 | C48:140 | 无 |
| `ACCOUNT_ERROR_CODES` L129 | R：字符串字段的可变记录 | 0／不加；*仍拒绝 | C08:58,68,69,78,87,116,122,131,136; C09:27,33,43,45,49; C11:43; C12:47,62,83,86,87,223,226,229,309,310,373,381,384,400,403; C48:45,46,47,48,49,50 | 无 |

### M2：`@power-evolve/contracts/execution-resolution`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `resolutionExecutionId` L12 | Z：`z.uuid`；brandString变换返回原始字符串 | 0／不加unused条目 | 无 | M2:27,35,42,52 |
| `resolutionRequestId` L14 | Z：`z.uuid`；brandString变换返回原始字符串 | 0／不加unused条目 | 无 | M2:27,32,42 |
| `resolutionSessionId` L16 | Z：`z.uuid`；brandString变换返回原始字符串 | 0／不加unused条目 | 无 | M2:38,42,52 |
| `executionIdentityFingerprint` L18 | Z：`z.string` | 0／不加unused条目 | 无 | M2:28,69 |
| `resolvedExecutionState` L20 | Z：`z.enum` | 0／不加unused条目 | 无 | M2:44 |
| `resolutionTarget` L23 | Z：`z.literal` | 0／不加unused条目 | 无 | M2:27,33,36,43,52 |
| `executionResolutionRequest` L26 | Z：`z.object` | 2／当前未分类；拟具名peer | C13:159; C15:69 | 无 |
| `executionResolutionStatusRequest` L32 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:68; C15:36 | 无 |
| `executionResolutionInspectRequest` L35 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:67; C15:30 | 无 |
| `executionResolutionsListRequest` L38 | Z：`z.object` | 3／当前未分类；拟具名peer | C03:66; C13:94; C15:25 | 无 |
| `executionResolutionReceipt` L41 | Z：`z.object` | 1／当前未分类；拟具名peer | C13:46 | M2:57,79 |
| `executionResolutionItem` L51 | Z：`z.object` | 0／不加unused条目 | 无 | M2:65,69 |
| `executionResolutionsList` L64 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:290; C13:104 | 无 |
| `executionResolutionInspection` L68 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:293; C13:146 | 无 |
| `executionResolutionStatus` L79 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:296; C13:198 | 无 |
| `EXECUTION_RESOLUTION_ROUTES` L82 | R：字符串字段的可变记录 | 2／当前未分类；拟具名peer | C03:70; C15:24,29,35,63,65,67 | 无 |
| `EXECUTION_RESOLUTION_APPROVAL_ROUTES` L88 | R：字符串字段的可变记录 | 1／当前未分类；拟具名peer | C15:62,64,66,68 | 无 |

### M3：`@power-evolve/contracts/file-download`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `FILE_DOWNLOAD_MAX_FILES` L6 | P：`1` | 2／当前未分类；拟具名peer | C16:42; C19:97 | M3:16 |
| `FILE_DOWNLOAD_MAX_URL_BYTES` L8 | P：`6000` | 1／当前未分类；拟具名peer | C02:25 | M3:45,84 |
| `FILE_DOWNLOAD_CONTENT_PATH` L10 | P：`'/api/powerEvolve/workspace-download'` | 2／当前未分类；拟具名peer | C02:25,114; C03:379 | M3:52,83 |
| `FILE_DOWNLOAD_PLATFORM_PATH` L12 | P：`'/files/download'` | 2／当前未分类；拟具名peer | C02:115; C19:485 | 无 |
| `FILE_DOWNLOAD_MAX_FILE_BYTES` L14 | P：`32 * 1024 * 1024` | 2／当前未分类；拟具名peer | C02:122; C16:155 | M3:16,61; M4:7 |
| `FILE_DOWNLOAD_MAX_SOURCE_BYTES` L16 | P：`FILE_DOWNLOAD_MAX_FILES * FILE_DOWNLOAD_MAX_FILE_BYTES` | 2／当前未分类；拟具名peer | C16:42; C19:98 | M3:49,50 |
| `fileDownloadPath` L26 | Z：`z.string` | 2／当前未分类；拟具名peer | C04:98,140; C17:21 | M3:36; M4:46,81; M7:44 |
| `fileDownloadPrepareRequest` L39 | Z：`z.object` | 3／当前未分类；拟具名peer | C03:40; C16:90; C19:829 | M3:41 |
| `fileDownloadContentRequest` L41 | Z：`fileDownloadPrepareRequest.extend` | 2／当前未分类；拟具名peer | C02:35; C16:90 | M3:57 |
| `fileDownloadView` L43 | Z：`z.object` | 2／当前未分类；拟具名peer | C03:166; C16:172 | 无 |
| `fileDownloadUrl` L81 | F纯：URLSearchParams／UTF-8长度计算 | 3／当前未分类；拟具名peer | C02:114; C03:169; C16:97 | M3:59 |

### M4：`@power-evolve/contracts/office-preview`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `OFFICE_PREVIEW_MAX_INPUT_BYTES` L7 | P：`FILE_DOWNLOAD_MAX_FILE_BYTES` | 1／当前未分类；拟具名peer | C04:138 | M4:90,105 |
| `OFFICE_PREVIEW_MAX_OUTPUT_BYTES` L9 | P：`8 * 1024 * 1024` | 0／不加unused条目 | 无 | M4:70,82,91,111 |
| `OFFICE_PREVIEW_ROUTES` L11 | R：字符串字段的可变记录 | 2／当前未分类；拟具名peer | C04:119,145,152,156,179; C19:609,611,613,615,617 | 无 |
| `officePreviewErrorCode` L37 | Z：`z.enum` | 2／当前未分类；拟具名peer | C04:52; C24:34,46 | M4:66,117 |
| `officePreviewPrepareRequest` L45 | Z：`z.object` | 2／当前未分类；拟具名peer | C04:35,36; C24:41,43 | M4:52 |
| `officePreviewSourcePrepareRequest` L52 | Z别名：`officePreviewPrepareRequest`同副本别名 | 3／当前未分类；拟具名peer | C04:141; C19:612; C24:42,168 | 无 |
| `officePreviewRefRequest` L54 | Z：`z.object` | 2／当前未分类；拟具名peer | C19:614,616; C24:211,268 | M4:57 |
| `officePreviewCancelRequest` L56 | Z：`z.union` | 2／当前未分类；拟具名peer | C19:618; C24:231 | 无 |
| `officePreviewGenerationView` L61 | Z：`z.object` | 2／当前未分类；拟具名peer | C04:121; C24:145 | 无 |
| `officePreviewJobView` L63 | Z：`z.object` | 2／当前未分类；拟具名peer | C04:145,152,179; C24:46,314 | 无 |
| `officePreviewContentView` L79 | Z：`z.object` | 2／当前未分类；拟具名peer | C04:155; C24:280 | 无 |
| `officePreviewLimits` L89 | Z：`z.object` | 2／当前未分类；拟具名peer | C22:20; C24:32 | M4:106 |
| `officePreviewJobSchema` L103 | Z：`z.object` | 2／当前未分类；拟具名peer | C23:65,91,92,199; C24:35,36,40,41,45,192,618 | 无 |
| `officePreviewResultSchema` L109 | Z：`z.object` | 1／当前未分类；拟具名peer | C24:51,651 | 无 |
| `officePreviewFailureSchema` L115 | Z：`z.object` | 1／当前未分类；拟具名peer | C24:34,646 | 无 |

### M5：`@power-evolve/contracts/stdio-management`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `stdioManagementLimitsV2` L8 | Z：`z.object` | 3／当前未分类；拟具名peer | C28:38; C34:46; C39:15 | M5:17,99 |
| `stdioPublicConfigV2` L14 | Z：`z.discriminatedUnion` | 1／当前未分类；拟具名peer | C43:76,78; C50:68 | 无 |
| `stdioActionSchemasV2` L28 | F副本：parse预算副本后返回局部Zod对象 | 1／当前未分类；拟具名peer | C43:59; C50:56 | 无 |
| `stdioManagementSchemasV2` L93 | F副本：parse预算副本后返回局部Zod对象 | 4／当前未分类；拟具名peer | C28:40; C34:47; C41:76; C43:58; C49:76,114,123; C50:55; C51:201 | 无 |

### M6：`@power-evolve/contracts/stdio-mcp-json`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `stdioCanonicalJsonV2` L33 | F纯：调用内预算快照／栈／WeakSet／token缓冲 | 5／当前未分类；拟具名peer | C06:32; C07:12; C25:1103,1181; C38:48,68; C45:61,73; C52:12; C53:45,46,62; C54:177 | M7:66,68,93,187,188,197,198 |

### M7：`@power-evolve/contracts/stdio-mcp`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `stdioDigestV2` L40 | Z：`z.string`；brandString变换返回原始字符串 | 12／当前未分类；拟具名peer | C05:13; C27:17,126; C28:131; C30:22,24; C31:15; C34:66,92,153,154; C35:20; C37:24; C38:27,28,31,32,33; C40:17; C42:22; C45:27,32,36; C52:23,45 | M5:49,117; M7:41; M8:67,90 |
| `stdioLimitsV2` L49 | Z：`z.object` | 15／当前未分类；拟具名peer | C25:23,1100; C27:52; C28:38; C29:91; C30:50; C31:41; C32:45; C34:45; C35:57; C38:39,113; C39:14; C40:53; C42:65; C44:46,89; C45:35,53; C53:42,78; C54:83 | M5:16,34,99; M7:88,175,180,274; M8:33,63 |
| `stdioJsonV2` L65 | F捕获：返回Zod对象；闭包捕获调用者预算 | 16／当前未分类；拟具名peer | C21:49; C27:69,92,133,161,171,222; C28:57,119; C29:157; C30:109; C31:78; C32:142,144,200; C34:69; C35:77,250,254; C37:40; C38:111,118; C40:65; C42:112,126; C43:46,61; C44:91; C45:67,76,84; C50:57,58; C53:43 | M5:38,100; M7:78,201,286; M8:47,80 |
| `stdioObjectV2` L77 | F捕获：返回Zod对象；闭包捕获调用者预算（经stdioJsonV2） | 5／当前未分类；拟具名peer | C25:1128; C30:111; C32:203; C44:95; C45:55 | M7:90,176,184; M8:36,40 |
| `stdioCatalogV2` L87 | F副本：parse预算副本后返回局部Zod对象 | 2／当前未分类；拟具名peer | C34:151; C45:55; C52:32 | M7:177; M8:38 |
| `stdioInvocationV2` L108 | Z：`z.object` | 5／当前未分类；拟具名peer | C27:93; C29:158; C40:128; C42:113; C45:34 | M5:105; M7:180 |
| `stdioTargetV2` L110 | Z：`z.discriminatedUnion` | 0／不加unused条目 | 无 | M7:114 |
| `stdioCheckRequestV2` L114 | Z：`z.object` | 6／当前未分类；拟具名peer | C19:708; C28:57,119; C34:65,70; C43:148; C45:31,32; C49:119; C50:129; C51:88 | M5:47,48,72,102,103 |
| `stdioReceiptRequestV2` L116 | Z：`z.object` | 6／当前未分类；拟具名peer | C19:707; C29:356; C33:181; C34:278; C43:137; C50:121; C51:149 | M5:102 |
| `stdioActionRequestV2` L118 | Z：`z.object` | 9／当前未分类；拟具名peer | C01:161,162; C05:13; C19:637,700,701; C27:171,222; C29:246,288,355; C30:19; C36:77; C43:169,179; C50:149,157; C51:160,177 | M5:46,113; M8:12,66,89 |
| `stdioApprovalRequestV2` L120 | Z：`z.object` | 2／当前未分类；拟具名peer | C19:638; C29:303 | 无 |
| `stdioScopeV2` L123 | Z：`z.discriminatedUnion` | 5／当前未分类；拟具名peer | C25:1099; C28:83; C30:86; C38:88; C45:35 | M7:179,229 |
| `stdioCloudDeploymentV2` L129 | Z：`z.object` | 4／当前未分类；拟具名peer | C28:17; C30:50; C38:41; C39:17 | M7:137,140 |
| `stdioDeploymentV2` L137 | Z：`z.discriminatedUnion` | 2／当前未分类；拟具名peer | C25:1099; C45:35 | M7:180,229 |
| `stdioExecutorImageV2` L139 | Z：`z.discriminatedUnion` | 4／当前未分类；拟具名peer | C25:1173; C34:152; C38:28; C45:37 | M7:183,230 |
| `stdioImageMatchesDeploymentV2` L149 | F纯：普通字段的精确字符串比较 | 2／当前未分类；拟具名peer | C25:1176; C45:63 | M7:196,236 |
| `stdioDiscoveryOriginV2` L157 | Z：`z.object` | 0／不加unused条目 | 无 | M7:192 |
| `stdioCallOriginV2` L159 | Z：`z.object` | 0／不加unused条目 | 无 | M7:193 |
| `stdioExecutionRefV2` L162 | Z：`z.discriminatedUnion` | 6／当前未分类；拟具名peer | C05:13; C27:124; C30:63,192; C31:43; C37:23; C42:94 | M5:47,114; M7:228,253,277; M8:66,89 |
| `stdioTaskSchemasV2` L170 | F副本：parse预算副本后返回局部Zod对象 | 9／当前未分类；拟具名peer | C27:55; C28:41; C29:98; C30:137,147; C31:43; C35:58; C38:116; C40:55; C42:71 | M5:56,117; M7:275 |
| `stdioCaptureV2` L219 | Z：`z.discriminatedUnion` | 1／当前未分类；拟具名peer | C25:1141 | M7:230,246 |
| `stdioPreparedV2` L228 | Z：`z.object` | 8／当前未分类；拟具名peer | C29:78,176,186; C31:78; C32:144,200; C35:112; C37:23; C38:118; C40:35,192; C42:126 | M8:91,93 |
| `stdioApprovalBindingV2` L242 | Z：`z.object` | 3／当前未分类；拟具名peer | C29:53,78,265; C40:36; C42:127 | M7:251 |
| `stdioExecutorOwnerV2` L245 | Z：`z.discriminatedUnion` | 2／当前未分类；拟具名peer | C29:83,329,356; C40:40; C53:60; C54:83 | M7:253; M8:65,92 |
| `stdioStartPermitV2` L251 | Z：`stdioApprovalBindingV2.extend` | 3／当前未分类；拟具名peer | C29:83,135,393; C40:40; C42:152 | M7:261,277 |
| `stdioStartAuthorizationV2` L261 | Z：`z.object` | 2／当前未分类；拟具名peer | C29:378,407; C53:44 | 无 |
| `stdioDispatchV2` L269 | F副本：parse预算副本后返回局部Zod对象 | 4／当前未分类；拟具名peer | C29:397,414; C35:141; C40:162; C42:166; C53:28,43 | 无 |

### M8：`@power-evolve/contracts/stdio-runtime`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `stdioWorkerIdV2` L10 | Z：`z.uuid`；brandString变换返回原始字符串 | 4／当前未分类；拟具名peer | C19:437; C33:62; C36:77; C42:236,325 | M8:13 |
| `stdioActionLeaseV2` L12 | Z：`z.object` | 5／当前未分类；拟具名peer | C29:242,350; C35:212; C36:21,68,104; C40:95; C42:350,375,388,403,419,442,482,490,504,525,543,564 | 无 |
| `stdioOutcomeV2` L28 | F副本：parse预算副本后返回局部Zod对象 | 1／当前未分类；拟具名peer | C38:117 | M5:57; M8:69 |
| `stdioRuntimeViewV2` L58 | F副本：parse预算副本后返回局部Zod对象 | 4／当前未分类；拟具名peer | C27:56; C32:227; C35:59; C40:54 | 无 |
| `stdioCloudStopEvidenceV2` L88 | Z：`z.object` | 4／当前未分类；拟具名peer | C27:182; C32:236; C35:135; C40:66 | 无 |

### M9：`@power-evolve/contracts/storage`

| 符号／定义行 | 类型／实际来源 | Host次数／建议 | 外部运行消费者及行 | 内部运行引用及行 |
|---|---|---|---|---|
| `bindingWorkspaceId` L8 | Z：`z.uuid`；brandString变换返回原始字符串 | 1／当前未分类；拟具名peer | C14:11 | M7:124 |
| `bindingGeneration` L10 | Z：`z.number` | 2／当前未分类；拟具名peer | C14:13; C16:132 | M7:125 |
| `storageRelativePath` L12 | Z：`z.string` | 1／当前未分类；拟具名peer | C12:396 | M9:17 |
| `workspaceStorageTarget` L17 | Z：`z.object` | 1／当前未分类；拟具名peer | C14:10 | M7:125 |

## 历史SAFE补丁与collector模拟（不应用）

历史补丁仅拟在`SAFE_HOST_DEPENDENCY_EXPORTS`增加13个具名项，不改`DUPLICATE_SAFE_PACKAGES`、peer表、通配符、checker阈值或发现范围。三个route记录必须保持已核对的只读使用；7个primitive和3个纯函数不依赖跨副本对象身份。account的具名`accountUserId`属Z而未建议；其他Account值虽有相对façade消费者，也不把它们添加为当前collector并未发现的具名表项。[façade源码](application/src/account-contracts.ts)第2行的`export *`保持一条拒绝。

| 正式Host导出分类结果 | 原策略 | 仅在内存加入建议 |
|---|---:|---:|
| Contracts未分类occurrence | 242 | 215（214个Z／工厂occurrence＋1个`*`） |
| Connector Runner未分类 | 24 | 24 |
| 官方导出未分类 | 52 | 52 |
| 总未分类 | 318 | 291 |
| policy integrity | 0 | 0 |

模拟时间为2026-10-09 10:07:58 +08:00。复用正式`readPackageDependencyState`与`collectHostDependencyExportPolicyViolations`，合并官方facts与产品当前受管Host facts，并在内存复制策略加13项；差集为27条、新增0条。源策略摘要在模拟前后相同，受保护的Contracts、brand、消费者、manifest与collector输入在该次读取期间稳定。模拟之后其他员工继续修改消费者文件，故本表消费者行号另取前述更新的源码快照；两次具名Contracts符号集与次数一致，不能把这种一致称作整个仓库已冻结。集成者应用建议前须以其最终输入重跑。

正式策略禁止自动新增SAFE例外，并要求明确人工审查和PR专门标题。本任务没有该授权；主控任务复核不是人工SAFE授权。旧补丁只作证据保留，不能用于正式global表或当作cloud SAFE追加。新方案只追加具体peer-required并保留原SAFE／duplicate-safe字段与全部未知失败。

## 命令、证据与检查范围

私有证据目录为`/Users/jingchao/agent_work/private/employee6-exports-20261009`（0700）。脚本只读目标源码并写私有副本／日志；唯一写入产品仓库的文件是本审计和建议patch。命令均在目标迁移仓库执行，后续统一直接调用现有Node／tsx runtime，不触发pnpm workspace修复。

| 命令／证据 | 实际结果 |
|---|---|
| `node node_modules/tsx/dist/cli.mjs …/discover.mts`及`discover-current.mts` | 九模块、210显式声明、119运行／91类型；74具名Host symbol＋1个`*`，242次Host导出使用；完整位置见`inventory-current.json` |
| `node node_modules/tsx/dist/cli.mjs …/trace-consumers.mts` | 301文件、54外部运行消费者、588个外部运行表达式引用；别名／相对façade／内部组合全映射，无未解析项，trace期间输入未变；`consumers.json`及`consumer-source-snapshot.json` |
| `node node_modules/tsx/dist/cli.mjs …/prepare-copies.mts` | 两份物理Contracts／brand／Zod副本，只在私有目录；`prepare-copies-direct-node.log` |
| `node …/copy-probe.mjs` | 111 schema组、19值、3纯函数及预算／realm探针通过；`copy-probe-report.json`、`probe-fixtures.json`、`copy-probe.log` |
| `node …/zod-shared-state-probe.mjs` | config／registry共享、二次导入重置locale、同metadata id覆盖均实证；`zod-shared-state-report.json`，原错误假设及修正见日志 |
| `node node_modules/tsx/dist/cli.mjs …/simulate-policy.mts` | 正式collector内存模拟13项／27差集，保留291次失败，未新增integrity错误；`policy-simulation.json`／日志 |
| `git apply --check products/power-evolve/employee6-export-policy-proposals.patch` | exit 0；只做dry run，未应用 |

早期`pnpm exec tsx`在并发manifest整理期间启动了pnpm自动install子进程；发现后按PID／父进程身份只终止本审计启动的wrapper及child，未终止主控的独立`--lockfile-only`进程。`prepare-copies.log`保留这段记录，最终副本由直接Node命令成功准备。没有把该次异常执行算作探针成功，也没有依据并发修改声称全仓锁文件始终未变。

本地探针没有真实PG、Worker、Kubernetes、gVisor、镜像、外部模型调用或浏览器多bundle运行；不是完整安全审计或迁移验收。员工3已同步独占范围、13项／27差集、Zod共享状态反例、保留的失败与并发输入限制。旧354报告是修改前启动且有稳定性失败的快照；员工3已提供主控整理后的实际dependencies报告，其字段与输入变化见下文，本审计不重复旧354当作当前数。

## Manifest整理后的实际依赖报告

员工3提供的`/var/folders/rw/j_ygzn_x7qx_c3mqrwq1rcwr0000gn/T/pe-cloud-check-iWeRWF/dependencies.json`来自2026-10-09 10:07:22–10:07:48 +08:00执行；已完整读取结构字段，并将原`dependencies.json`与`report.json`复制到私有证据目录的`post-manifest-report/`，摘要与SHA见`post-manifest-summary.json`。这是主控应用三个manifest后的实际报告，不以旧354代替。

| 实际结构字段 | 结果 |
|---|---:|
| importErrors | 0 |
| sectionErrors | 0 |
| requiredSingletonErrors | 0 |
| privateRangeReview | 0 |
| policyIntegrityErrors | 0 |
| privateExports | 266（Contracts242＋Connector Runner24） |
| officialExports | 52 |
| dependencies lane失败 | 318 |

这确认原36条section／range诊断已在该次报告中消失，318条导出分类仍失败，13项建议尚未应用。该报告同时有两个独立`input-stability`失败：`application/src/platform/safe-posix.ts`和`deploy/employee4-start.test.mjs`在检查期间改变。dependencies的318条不包含这两个输入变化诊断；整体`report.json`状态为failed，不能签整仓冻结或把零section解释为完整依赖／生产验收通过。

## 最终交付文件验证与并发输入

2026-10-09 10:55:40 +08:00的两份独占文件验证通过：正式Markdown链接、单段单行、119符号行、13候选、结尾／空白与补丁dry run均零诊断；Contracts九份源码、策略及collector摘要保持一致。日志为`artifact-validation.json`、`artifact-validation.log`及`proposal-apply-check.log`。验证仅覆盖本次交付文件，没有宣称全产品检查通过。

同次验证记录0个消费者在表中源码快照之后又变动；2026-10-09 10:16:45 +08:00的比较中，忽略注释／空白后仍有15份消费者的token序列不同（`consumer-token-comparison.json`）。因此不能将并发改动全称为文档改动，也不能把表中行号冒充最终冻结源码位置。该轮旧快照已归档到私有`consumer-snapshot-101057/`，当前119行与消费者索引已按冻结后的新快照刷新。本审计保留可复核的源码文本／SHA与测试快照；实际实施应验证下述103项peer、声明和提供者闭包。

## 最新实施方案：cloud具名PEER与共享协议提供者

剩余215是旧13项SAFE**内存模拟**后的数字；旧补丁没有应用，实际报告仍是Contracts242次未分类。无需SAFE的方案可同时处理这215次以及原27次候选：先把当前74个具名导出设为cloud-only peer-required，再收窄account façade，形成103个实际具名导出，并为Application匹配Contracts peer＋dev和正式运行时提供者。**只有分类、源码桥接、manifest与真实实例验证一起完成，才能把Contracts分类归零当作有效的实施结果。** 本轮只交付方案与虚拟证据，不修改冻结的Application／Contracts或真实2＋2进程。

### 范围隔离：不修改官方global policy

正式`readWorkspacePackageManifests`只发现apps／packages／vendor，不含products。把旧13项放进global SAFE表后，official-only collector实证新增18条integrity错误：五个产品子路径provider不存在、13个具名导出unused。因此该补丁既没有SAFE授权，也不适合正式global发现范围。相同问题也会影响写入global的产品PEER项；正确位置是独立cloud策略，不扩大官方glob。

员工3已确认产品`dependencyReport`有两处必须一致使用cloud overlay：生成product facts的`peerRequiredHostDependencies`，以及合并official＋product facts后的正式export collector。product section规则读取前者决定peer-dev，不能只给后者贴标签而隐藏manifest问题。建议接口为`dependencyReport(root, corpus, policy = PACKAGE_DEPENDENCY_POLICY)`；原默认仍保持原策略，cloud调用点显式传cloud overlay。**官方state始终用原`PACKAGE_DEPENDENCY_POLICY`读取**，再与product facts合并，用包含产品名的workspaceNames作校验。

cloud overlay只补充`peerRequiredHostExports`，复用官方原SAFE表及duplicate-safe列表，保留现有官方PEER项。追加必须是实际product Host引用、已知runtime导出的具名值；拒绝`*`、side-effect、无用项、重复项、与SAFE重叠、未知provider，以及替换原SAFE／duplicate-safe内容。原官方collector继续检查组合结果，云侧额外检查追加项在product facts真实使用。当前源码只适用74项；103项必须与下述30个具名重导出同步实施，不能提前把29个新增名写成unused分类。

### 具名facade、manifest与provider闭包

当前[account桥接](application/src/account-contracts.ts)的runtime `export *`不能被任何SAFE／PEER表项合法分类。冻结后消费者追踪仍确认Application实际使用30个account运行名，包含已有具名`accountUserId`及29个新表项；把桥接改为这30个显式runtime re-export，并以`export type *`保留编译期类型。type-only星号由正式collector排除，不是runtime星号豁免。虚拟源码保存于私有`proposed-account-facade.ts`，从未写入生产文件；更改后的import／typecheck必须在正式实现阶段验证。

Application的`@power-evolve/contracts`从dependencies移动至**匹配的peerDependencies＋devDependencies，范围均workspace:~**。这一步是正式section规则的真实要求，而非可选说明。为了把Connector内的二次Contracts／Zod导入也接到相同提供者，普通库Connector应采用Contracts peer＋dev；Contracts的Zod及必要的Connector Zod边也应采用明确provider／peer继承或等价安装闭包。普通库不受Cordis managed Host section分类，这些边的生产声明与物理解析仍须单独检查，不可因为没有section诊断而漏掉它们。

Host／Platform bundle或应用安装根必须生产声明并安装一个明确的Contracts provider和受控Zod版本；不得依靠dev依赖或自动peer安装。正式Profile设置`autoInstallPeers: false`，只有manifest里的peer不会凭空创建provider。Profile runtime resolution的entries必须包含该provider及正确declarer／版本，并包含全部相关linked importer根；仅链接Host／Platform bundle目录不能假定其兄弟Application／Contracts／Connector源码目录自动处于linked scope。对本地工作区可显式记录这些直链；打包镜像则用完整安装闭包使全部入口解析到相同物理文件。

Application直接使用Zod时，现有正式managed规则要求第三方Host runtime依赖保持dependencies-only。虚拟把`Application.zod`也移至peer＋dev实证新增一条dependencies-only失败，**不建议以改写正式规则消除它**。低改造成本方案保留Application的Zod生产依赖，用锁定的安装／镜像闭包和实际模块URL／对象身份检查，保证它与Contracts／Connector选中同一Zod实现。如果要严格由peer转发每次Zod使用，则需新增workspace validation-provider入口，并迁移Application的直接Zod调用、类型与错误处理，重新审查新导出；这是更大的源码与API改造，不属于一次manifest搬移。

### 正式resolver的独立实例质量证据

调用现有[installRuntimeInterception](../../packages/boot/app-boot/src/profile-resolution/resolver.ts)而非自造resolver，在六个独立Node进程、私有provider／消费者fixture中测试。使用没有仓库paths alias的独立tsx配置，解析路径实际指向私有fixture的编译MJS。第一轮受仓库tsx paths干扰的尝试已判无效，原失败日志保留为`peer-fixture-invalid-tsx-alias.log`，不计入最终结果。所有fixture、生成配置与运行日志只写私有目录，不修改或调用真实Profile。

| 独立场景 | 两消费者共用schema／Zod构造器 | 119导出中共享的105个对象／函数引用 | 结论 |
|---|---|---:|---|
| consumer具名peer＋正确provider entry＋linked scope | 是 | 105 | 正式resolver可覆盖consumer包根同位置的物理开发副本，接到指定provider |
| 缺provider映射 | 否 | 0 | peer名称不能代替实际provider表 |
| 缺consumer peer | 否 | 0 | 普通dependencies继续采用本地副本 |
| consumer不在记录的linked root中 | 否 | 0 | 映射存在也不能假设全部源目录都被拦截 |
| App peer，但嵌套helper是普通依赖且携带私有Contracts | App／另一consumer共享；helper不共享 | 主消费者105，helper脱离 | 每条实际传递路径都要检查；只改App不足 |
| 同一helper也声明Contracts peer | 是，helper也共享 | 105，helper共享原schema | 传递peer在正确resolver范围内能接回provider |

14个primitive在两种布局下值均一致，不据此证明实例身份；105个引用涵盖88个静态schema、12个函数和5个record。共享factory函数仍按每次调用创建不同schema，原预算对象的可变捕获仍存在；同一个provider不把工厂产物变成包级singleton，也不替调用者冻结配置。六个场景同时验证了这一行为，未把factory状态当作SAFE。

只读现有built观察中，Application、Contracts和Connector三个Node锚点的Contracts路径相同，分别在require和ESM条件下的Zod路径也各自相同；现有Node输出保留bare Contracts／Zod外部导入。然而Zod的require入口为index.cjs、ESM入口为index.js，**同一包目录／版本不等于同一模块对象**。协议调用链应固定ESM入口，并把同进程其他CJS／mini入口、加载顺序及全局config写入纳入闭包检查。此观察没有构建新产物，也不是对实际运行四个Profile的hook状态或镜像的证明。

接受实现时应在一个全新隔离的正式启动进程中，从所有实际Host入口、Platform入口、Contracts内部、Connector helper及worker路径记录resolved URL／realpath／版本，并实际比较schema、factory和Zod构造器身份。刻意加入私有副本、遗漏peer、遗漏linked root及版本冲突的负例应拒绝；生产安装不携带dev依赖。每个Node isolate各自拥有provider，2Host＋2Platform不需要跨进程对象相同；HTTP／Runner边界传原始JSON及版本化值，继续按111探针范围理解序列化，不把它当shared-memory。

单实例不阻止之后的`z.config`修改或metadata id冲突。部署必须明确全局配置的初始化／更新拥有者，完成受支持入口加载后设置配置，禁止未经审查的再次配置／schema注册／重复id写入，并保留构造器／URL及元数据负例。Provider版本／目录变更需要整进程重启；正式resolver replace不清除已加载模块，还会拒绝保留项换目录／版本。不能以热换provider或URL query cache-busting宣称同一实例。

### Bundle方案的保证范围与代价

| 结构选择 | 能提供的保证 | 代价／必须解决的限制 |
|---|---|---|
| Node具名peer＋正式resolver＋安装闭包（优先） | 当前源结构大部分可保留；同isolate协议路径共享provider；正式section规则仍执行 | 移动App Contracts声明，补生产provider和传递peer／linked roots；固定入口／版本；对全部真实路径做身份及负例验证 |
| Node单次构建的闭合协议graph | 同一次build里的入口共用一个协议chunk，能以元数据／artifact manifest约束模块数量和URL | 当前tsdown是unbundle且生产依赖external，并不是闭合graph；独立多次bundle或codeSplitting:false会再次复制。仍需与外部框架Zod统一入口／配置，固定整代chunk、禁止混代／单chunk热换，并重新验证所有多入口产物 |
| workspace validation-provider转发全部Zod使用 | App不再直接选择Zod；协议schema和Zod API都归提供者所有 | 新runtime API、迁移大量直接Zod调用／类型／instanceof和构建配置，再审查新增导出；不能只靠peer字段完成 |
| 浏览器共享protocol Client模块 | 同一页面的两个Client从正式ModuleLoader取同一factory／schema，而非各自内联 | 需真正可加载的Client provider及inject／ModuleLoader映射，改两个Client的alwaysBundle规则并验证CSP／jitless初始化、加载顺序及资产闭包；Node peer不影响浏览器bundler |

现有Contracts的两个browser产物以及两个Client产物都内联各自Zod，并写共享globalThis config；普通`dsh.bundle.patch`只是插件配置组合，**不等于JS模块闭包或schema去重**。独立trusted账户文档／iframe可各自有隔离provider，JSON跨realm不能依赖schema引用。当前具名Host分类只覆盖Node面，不能把Contracts分类0延伸为浏览器同页面已共享、完整2＋2已验收或所有未知导出已处理。

### 同一正式规则下的只读结构模拟

| 虚拟分支 | Contracts未分类 | 总未分类 | integrity | section |
|---|---:|---:|---:|---:|
| 当前源码／原策略 | 242 | 318 | 0 | 0 |
| 当前源码＋cloud 74具名peer，manifest原样 | 1（runtime星号） | 77 | 0 | 1（App Contracts须peer＋dev） |
| 同上，App Contracts虚拟匹配peer＋dev | 1 | 77 | 0 | 0 |
| façade虚拟收窄30名，仍只有旧74 peer | 29（新名未分类） | 105 | 0 | 0 |
| façade虚拟30名＋cloud 103 peer＋匹配App peer／dev | 0 | 76 | 0 | 0 |

全部分支用同一个cloud overlay同时生成product peer facts与正式组合export collector；SAFE表／duplicate-safe列表与官方原对象相同。最后76次仍为Connector24＋官方52，保持失败；peer标签不代替上述运行闭包证据。虚拟facade把1个无界导出替换成30个具名引用，不能把这种新增的29项当作旧诊断差集作弊。当前生产源码、manifest及策略始终原样，没有把103项提前写入现有表。

### 103项具名PEER的具体候选集合

以下是**收窄façade后的**候选，包含现有74项与29项新增account名。当前源码应用103项会产生unused问题，因此需要与façade源码变化同步；纯值也按整个协议provider共享这一明确产品约束选择peer，不声称它们自身有不可复制的对象身份。原13 SAFE一项也不写入新SAFE表。

| 具体子路径 | 当前具名数 | 收窄后具名数 | 收窄后的具名PEER列表 |
|---|---:|---:|---|
| `@power-evolve/contracts/account` | 1 | 30 | `ACCOUNT_ERROR_CODES`, `ACCOUNT_MAX_MODELS_PER_USER`, `ACCOUNT_MAX_PAGE_ITEMS`, `ACCOUNT_PAGE_PATH`, `ACCOUNT_PASSWORD_MAX_BYTES`, `ACCOUNT_PASSWORD_MIN_BYTES`, `ACCOUNT_ROUTES`, `accountAudience`, `accountBearerToken`, `accountCapabilitiesValue`, `accountChangePasswordRequest`, `accountCreateRequest`, `accountEmptyRequest`, `accountListRequest`, `accountListValue`, `accountLoginRequest`, `accountLoginValue`, `accountMeValue`, `accountModelCatalogValue`, `accountMutationReceipt`, `accountNewPassword`, `accountNewUsername`, `accountReceiptRequest`, `accountReceiptValue`, `accountRole`, `accountSecretMutationValue`, `accountTargetMutationRequest`, `accountUpdateRequest`, `accountUserId`, `accountValue` |
| `@power-evolve/contracts/execution-resolution` | 10 | 10 | `EXECUTION_RESOLUTION_APPROVAL_ROUTES`, `EXECUTION_RESOLUTION_ROUTES`, `executionResolutionInspectRequest`, `executionResolutionInspection`, `executionResolutionReceipt`, `executionResolutionRequest`, `executionResolutionStatus`, `executionResolutionStatusRequest`, `executionResolutionsList`, `executionResolutionsListRequest` |
| `@power-evolve/contracts/file-download` | 11 | 11 | `FILE_DOWNLOAD_CONTENT_PATH`, `FILE_DOWNLOAD_MAX_FILES`, `FILE_DOWNLOAD_MAX_FILE_BYTES`, `FILE_DOWNLOAD_MAX_SOURCE_BYTES`, `FILE_DOWNLOAD_MAX_URL_BYTES`, `FILE_DOWNLOAD_PLATFORM_PATH`, `fileDownloadContentRequest`, `fileDownloadPath`, `fileDownloadPrepareRequest`, `fileDownloadUrl`, `fileDownloadView` |
| `@power-evolve/contracts/office-preview` | 14 | 14 | `OFFICE_PREVIEW_MAX_INPUT_BYTES`, `OFFICE_PREVIEW_ROUTES`, `officePreviewCancelRequest`, `officePreviewContentView`, `officePreviewErrorCode`, `officePreviewFailureSchema`, `officePreviewGenerationView`, `officePreviewJobSchema`, `officePreviewJobView`, `officePreviewLimits`, `officePreviewPrepareRequest`, `officePreviewRefRequest`, `officePreviewResultSchema`, `officePreviewSourcePrepareRequest` |
| `@power-evolve/contracts/stdio-management` | 4 | 4 | `stdioActionSchemasV2`, `stdioManagementLimitsV2`, `stdioManagementSchemasV2`, `stdioPublicConfigV2` |
| `@power-evolve/contracts/stdio-mcp` | 24 | 24 | `stdioActionRequestV2`, `stdioApprovalBindingV2`, `stdioApprovalRequestV2`, `stdioCaptureV2`, `stdioCatalogV2`, `stdioCheckRequestV2`, `stdioCloudDeploymentV2`, `stdioDeploymentV2`, `stdioDigestV2`, `stdioDispatchV2`, `stdioExecutionRefV2`, `stdioExecutorImageV2`, `stdioExecutorOwnerV2`, `stdioImageMatchesDeploymentV2`, `stdioInvocationV2`, `stdioJsonV2`, `stdioLimitsV2`, `stdioObjectV2`, `stdioPreparedV2`, `stdioReceiptRequestV2`, `stdioScopeV2`, `stdioStartAuthorizationV2`, `stdioStartPermitV2`, `stdioTaskSchemasV2` |
| `@power-evolve/contracts/stdio-mcp-json` | 1 | 1 | `stdioCanonicalJsonV2` |
| `@power-evolve/contracts/stdio-runtime` | 5 | 5 | `stdioActionLeaseV2`, `stdioCloudStopEvidenceV2`, `stdioOutcomeV2`, `stdioRuntimeViewV2`, `stdioWorkerIdV2` |
| `@power-evolve/contracts/storage` | 4 | 4 | `bindingGeneration`, `bindingWorkspaceId`, `storageRelativePath`, `workspaceStorageTarget` |

### 实施顺序与尚未完成的验证

实施者先在隔离checkout／安装根补cloud-only具名PEER适配及其拒绝测试，明确official state仍读原策略；随后把显式façade、103名追加及App Contracts peer＋dev作为同一变更复核。Host／Platform安装根显式提供协议包，Connector及Contracts补传递共享路径，Node build显式external协议依赖并验证包产物和类型。正式安装／镜像stage再生成闭包清单、运行resolver正负例与全新Profile／Worker身份检查；只有该阶段通过后才考虑替换运行实例。本轮维持已运行的2＋2与冻结源码，不执行这些生产动作。

私有新证据为`/Users/jingchao/agent_work/private/employee6-peers-20261009`（0700）：`cloud-peer-simulation.json`包含各分支、global18条错误和App.zod改peer的新失败；`cloud-peer-additions.json`是103名数据；`proposed-account-facade.ts`只在私有目录；`peer-fixture-report.json`／六份日志记录正式resolver与105引用测试；`current-built-observation.json`保存现有产物SHA及parent-aware require／ESM解析。第一轮无效tsx alias日志单独保留。仍没有做新正式build／安装、浏览器共享Client provider、真实2＋2重启或最终镜像闭包验收，不把这些任务标成完成。

## 本轮peer方案交付检查与输入限制

新方案的Markdown链接、单段单行、119个逐符号行、旧补丁13项计数与dry run检查通过；六个独立resolver进程均覆盖119个运行导出和105个对象／函数引用，cloud结构模拟保留所有真实section和未分类失败。原SAFE补丁SHA仍为`46df2f4b544ac169d319e6116005e9518bcb73b4add5f3f09d6b73340b89e803`，没有将其替换成已获批建议。

本轮开始记录的153个保护文件中，最终出现三处外部输入变化：`application/src/trusted-account-ui.ts`、`application/src/host/browser-auth.ts`、`application/src/platform/native-preferences.ts`。它们不在54个直接Contracts运行消费者中；更新后的消费者快照随后零漂移，九份Contracts源码、策略／collector及manifest／原patch均未变化。`peer-plan-validation.json`保留这三条输入变化，所以整组保护输入校验未通过，不能签整仓冻结。员工6没有写入这些文件，也没有操作正在运行的2＋2；实际正式实现与最终冻结验收仍由集成者完成。
