# 员工6：native 搜索独立审查

本轮发现并复现了负数 `event_count` 静默返回空结果的缺陷；主线程已补拒绝并用真实 PG 回归。修正后的独立9项全部通过：8项验证官方搜索语义边界，1项通过真实搜索函数和事务执行无连接元数据负例。当前修复保留 native 的 raw text、最新物理消息和 updated_at 排序，不构成官方 `surface=current`、ranked search 或完整搜索 parity。

## 已关闭的缺陷与输入

[searchSession](application/src/platform/native-session-search.ts) 的旧循环直接使用 `event_count`。合法同ID header配负值时，不读取任何事件并成功返回空结果；PG 的 int32 类型保证整数，但当前表没有非负 CHECK。员工6的 [独立负例](application/tests/employee6-native-search-review-corruption.spec.ts) 实际得到 `{ items: [], hasMore: false }`，按预期拒绝断言失败。主线程另用真实 PG 保存负值，复现同一失败，并在 searchSession 开头加入 `<0` 时返回500 `native_history_gap`；没有新增 DDL。

本次只读生产与共享源码、主线程测试及其证据；员工6只新增两份独立测试和本报告，没有 install、build、Git add／commit、真实 PG／集群操作或 Profile 启动。最终独立检查窗口为2026-10-09 12:16:15至12:16:38 +08:00。下列输入在该窗口稳定，与主线程冻结的两个生产SHA一致；这不是全仓库冻结。

| 输入 | SHA-256 |
|---|---|
| native-session-search.ts | `ad75b4ad623bd8e3cf92fdacb6202e2950c81658638f4df5414751affdf7aebf` |
| native-session-commands.ts | `c34f4ad63f1ee192ac43da3c79d203613173ec9205a75a8e13f6a84264ba79d7` |
| 主线程 native-session-search.spec.ts | `3b7b999650af07acabc086e18800210bdab55745001df6e91e824383db2f20e3` |
| employee6-native-search-review.spec.ts | `b89114cded81fd6cd177cf80a44913e94a22ec86fb28c7ecb105b74b07546af3` |
| employee6-native-search-review-corruption.spec.ts | `9421ea97f9a185d6210ffe34d878df1e6467adac5f66c7e179aeab9a8bebdfc1` |

## 官方语义与兼容修复的边界

官方 [ApiSessionList.search](../../packages/api/session-controller/src/list.ts) 明确传入 user／assistant 类型和 `surface=current`，并再次检查返回hit的类型、surface、授权可见ID及去重。新 native 实现以PG owner条件选会话，然后扫描原始事件；这是本轮明确保留的兼容范围。

| 维度 | 官方实现／API | 当前 native 修复 |
|---|---|---|
| surface | canonical fold 后仅 current；替换掉的旧消息排除 | raw-history text，仍可能命中 shadowed 消息 |
| assistant 字段 | `data.message.content` | 已修正使用同一正式 wrapper |
| 文本提取 | [extractSessionEventText](../../packages/session-query/session-query/src/extraction.ts) 忽略 reasoning，trim并换行连接block，还包含message内 tool-call 的name／arguments | 只检查各个 text block，保留原文本；不自动扩大到tool-call或跨block连接匹配 |
| 字面查询 | 官方 text filter 使用安全 `iu` 正则并允许空白变化；SQLite search 是经过转义的FTS短语 | JavaScript lowercase substring，空白和特殊符号逐字匹配 |
| 单会话选择 | 具体SQLite provider按 strongest event 排名 | 最新 matching 物理消息；同消息多个block取首个匹配block |
| 跨会话排序 | SQLite按match count、document length、time和ID等稳定排序 | updated_at降序、UUID升序 |
| 查询输入 | 官方UI route拒绝空白、NUL和超过500 UTF-16 code units；具体provider还有自身规范化 | native wire允许trim后的空串并返回空结果，最大1000 UTF-16 code units；本轮没有迁移该契约 |
| 读取对象 | 官方服务 live-preferred，持久化读取还承担完整逻辑日志恢复 | 当前PG repeatable-read提交快照，没有完整 live／cold query-service composition |

官方搜索服务是受信任的 Context 内基础设施，不提供 caller authorization；直接调用它不能替代PG tenant约束。ApiSessionList的可见集合还要求header有cwd，而产品普通header schema不含cwd，不能直接接入该UI搜索适配器并期待同样结果。

[buildSessionEventRecords／buildSessionEventSearchDocuments](../../packages/session-query/session-query/src/documents.ts) 内部调用官方 [foldSurface](../../packages/core/session/src/surface.ts)，要求完整、连续、从seq 0开始的日志。`parseEvents` 可用于绝对seq的批次，因为 [validateStoredEvents](../../packages/session/session-persistence/src/storage-contract.ts) 做 event-local vocabulary／message／surface metadata 校验；它不验证替换端点当时是否仍在surface，也不证明全局引用关系成立。

replacement范围按当前surface位置解释，不能按物理seq数值区间解释。独立用例从 `[0,1,2]` 替换前两个节点得到 `[3,2]`，随后合法地用 `startSeq=3,endSeq=2` 替换整个surface。逆向自制数值区间屏蔽会误判这一合法历史。本轮没有实现这种算法。

## 可复用官方 API 的有界方案

当前兼容修复可以继续复用 event-local `parseEvents`，在每批读取后核对物理seq、JSON seq和应有行数。若改用官方 `extractSessionEventText`，必须显式接受上表中的trim、连接block与tool-call扩大语义；不能把它当作与旧text-only SQL等价的替换。保留text-only时，这个选择应留在native consumer。

若要增加正确的 current 过滤，可按会话逐个处理，在同一只读快照内先拒绝超过实际配置history事件数／字节预算的记录，再载入该会话的完整连续日志并调用官方 `buildSessionEventRecords`。其current seq集合可以用于原text-only选择；若采用官方语义文本，则用 `buildSessionEventSearchDocuments` 加官方type／surface过滤。处理完一个会话后释放日志和文档，再处理下一个。

这一方案把峰值限制在一个明确受配置配额约束的会话，而不是全部会话历史；它仍须加载该会话完整历史，内存、解码和fold成本是O(该会话日志)，不能宣称O(256)。会话元数据的event_bytes不能单独作为可信内存证明：完整读取仍须核验实际序列、编码字节与配置预算，并拒绝损坏或超额数据。当前“不加载完整历史”的要求若保持，就应继续明确推迟current支持；现有官方API没有可直接复用的256条反向独立fold。

长期 ranked search 可评估官方 `SessionQueryEngine` 后端或持久派生查询索引。官方两个search方法是抽象接口，没有现成PG实现；其 exact read／filter方法仍需完整日志。派生索引需由canonical fold生成surface和语义文档，并明确owner隔离、append／replacement失效、fork前缀、索引版本、revision与cursor一致性；它也有首次回放全日志的成本。该方向超出本轮授权，不能在当前切片偷偷新增DDL或安装SQLite provider。

64会话页、256事件批次和 resultLimit+1分别约束单批数据与结果数量，不限制整个tenant需要扫描的会话数量或总CPU／I/O。多次快速SQL仍可能维持较长repeatable-read事务；单statement timeout不能替代整次operation deadline。完整方案还需要deadline／工作预算及AbortSignal传播，在预算或取消时明确失败，不能把未扫完的结果包装成 `hasMore=false`。这些边界由主线程继续决策，本轮不声称已接受。

## 独立证据与真实 PG 证据

[8项官方边界测试](application/tests/employee6-native-search-review.spec.ts)验证 shadowed排除、surface顺序与反序seq端点、局部chunk无法独立fold、失效replacement引用、unknown required／ignorable记录、assistant特殊Unicode、官方tool-call提取和空白灵活匹配。它直接读取官方helper实现，是源码语义证据，不是已安装query provider或完整native runtime的验收。

[第9项负watermark测试](application/tests/employee6-native-search-review-corruption.spec.ts)使用实际 `searchNativeSessions`、实际事务函数及未连接的Pool／Client，query响应由实例适配器提供。修复后断言500、rollback、connection release和error listener脱离；没有实际PG连接。PG整数类型保证的fraction／非safe-int值没有被人为加入该数据库案例。

最终执行命令：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee6-native-search-review.spec.ts products/power-evolve/application/tests/employee6-native-search-review-corruption.spec.ts --reporter=json --outputFile=/Users/jingchao/agent_work/private/employee6-native-search-review-20261009/accepted-test-report.json
```

结果9／9通过、无pending。两份独立文件的noEmit TypeScript诊断各为0；该单独程序的导入图另有102项诊断，未运行完整项目typecheck。官方规则映射到products后的源码直读lint退出0。这些结果不替代正式build、包依赖闭包、Linux／Profile或浏览器接受。

私有证据位于 `/Users/jingchao/agent_work/private/employee6-native-search-review-20261009`，权限0700，包含 `accepted-test-report.json`、`accepted-typecheck.log`、`mapped-lint-source-direct.log`、`accepted-input-before.json` 和 `final-validation.json`。负watermark修复前失败保存在 `corruption-before-report.json`／log，对应观察到的旧helper SHA为 `d69844bec46c6eb35a4a51bed28a1074638711822151eec11e79b1d288a00152`；after遵循主线程公布的 `native_history_gap` 错误契约，旧断言副本也保留。

最初一项独立测试错误地要求JSON对象键序相同，另有工厂fixture多传 `source.kind` 的类型错误；修正后的断言保留结构与特殊字符确值，不把这些fixture错误记作生产缺陷。公共query包入口在这份私有Oxlint程序中产生error-type诊断；最终直接导入同一官方helper源码后通过，两个阶段日志均保存，未修改共享入口或生产清单。

主线程自己的 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-search-v1` 是另一路真实PG证据。只读核对其 `before-negative-watermark.json` 为筛选负例1失败、13pending；不能算成功验收。其 `after-tests-v4.json` 为24／24、无pending，`result-v4.json` 明确source coverage仅覆盖新search文件，并保留 `wholeNativeSearchParity=false`。员工6没有执行或代替这一真实PG运行。
