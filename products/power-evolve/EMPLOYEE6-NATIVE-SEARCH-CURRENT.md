# 员工6：官方 SQLite current 搜索交接

2026-10-09。当前新搜索独立验收为 **27通过、0失败、0pending**，包括1项公有原生API证明、24项真实PG current搜索与边界测试、2项真实PG活动查询取消／deadline观测。scoped noEmit类型检查和正式mapped typed lint为exit0；官方product JSDoc collector无诊断。此结果不重算旧root24／员工6旧9，也不代表整个迁移、冷构建Profile或浏览器验收。

生产修改仅为 [native-session-search.ts](application/src/platform/native-session-search.ts)。caller、Host、Platform配置、manifest、project references、lock与正式Profile集成由root负责；员工6未修改官方包、持久化DDL或运行中的原Host／Platform。

## 官方语义与快照

每次搜索创建独立公有 `Context`、`SessionStore` 和 `SqliteSessionQueryEngine`，注册catalog的公有message projections，使用 `path: ':memory:'` 与 `openAt: 'first-search'`。服务只接纳本次授权PG快照的日志；没有Agent或SessionPersistence，也没有持久化SQLite文件。所有生产import走公有包出口。

PG事务为REPEATABLE READ／READ ONLY。按owner分页，在完整日志恢复前核对真实物理事件数、JSON UTF-8字节、最大单条大小、dense seq范围与metadata watermark；正文按256条读取并再次校验序号／字节。负计数、缺失／尾随事件、虚假byte metadata和失效surface均显式失败。

官方provider内部调用公有canonical document builder，以 `type=user/message|assistant/message` 和 `surface=current` 过滤，然后使用原生FTS5、每Session最强命中、原生全局排序、原生snippet与nextCursor。没有自定义匹配计数、排序或snippet实现，也不会在额度耗尽后返回局部成功或伪造 `hasMore=false`。

实际验证包括shadowed替换与反序surface端点、block trim／换行连接、assistant嵌入tool-call、reasoning排除、最强事件、match count／长度／时间／Session UUID／seq排序，以及Unicode code-point snippet额度和ellipsis。NUL／astral／lone-surrogate原PG JSON字节在搜索前后保持一致；索引规范化和Unicode61匹配遵从官方provider，不能把旧substring行为等同新FTS语义。

`SessionStore.prepare(...eventState:'detached')` 恢复时可能增加仅内存的结构性end-seed标记。独立公有API的 `readSession()` 加上canonical document builder验证恢复前后可搜索documents完全相同；PG原字节也经真实数据库比较。`Context.fiber.dispose()` 被完整await，官方close负责其搜索队列、就绪操作与内存数据库的收尾。

## fork cut的证据边界

当前PG header contract仅持久化 `isSeeded` 与 `parentSession` 等元数据，没有独立 `inheritedEventCount` 字段。此实现读取完整日志最后一个 `session/end-seed` 的 `inherited:true` 标记作为cut，并通过公有restore构造验证。它拒绝seeded无标记、unseeded有标记及非法runtime／surface。

真实PG测试覆盖一个cut与包含祖先cut的多个标记；嵌套fork选择最后cut，并证明同一日志换成unseeded header会拒绝。多个祖先标记是原生合法历史，不能一概拒绝。没有独立PG cut元数据时，不能宣称已与另一个持久化cut来源交叉比对。

## 全局工作额度与取消

调用方必须提供三个EventLimits与六个search字段：`searchResultLimit`、`searchSnippetChars`、`searchDeadlineMs`、`searchMaxSessions`、`searchMaxEvents`、`searchMaxBytes`。三个全局corpus额度累计整个owner快照，包括空与不命中的Session。byte额度指原JSON UTF-8语料，不是RSS数值承诺；日志、canonical documents和内存索引均受此有限语料规模约束。

| 失败条件 | HTTP／code |
| --- | --- |
| trim后空白、NUL、超过500 UTF-16 code units | 400 `native_search_invalid` |
| 调用方abort | 499 `native_search_cancelled` |
| 操作deadline或PG statement timeout | 504 `native_search_timeout` |
| corpus或单历史／单事件额度耗尽 | 503 `native_search_budget_exceeded` |
| 物理计数、字节或seq不一致 | 500 `native_history_gap` |
| header、native事件或surface无效 | 500 `native_history_invalid` |
| 无效／缺失显式limits | 500 `native_search_config_invalid` |
| 连接或官方provider异常 | 503 `native_search_unavailable` |

deadline从pool acquisition起计。已获得的独占client在abort／deadline时销毁，等待其pending query与end后移除listener；每条PG工作前将剩余deadline设为事务内statement_timeout。node-pg公有类型没有可取消的pool acquisition，因此超时／取消后仍排队的connect在稍后获得client时立即销毁；真实PG池耗尽测试等待了该late client的remove。

公有node-pg接口不能保证abort立即停止服务端SQL。下面是独立活动查询观测：blocker只锁定测试自己的隔离数据库，直到后端停止后才释放。

| 实际case | 观察relation等待 | 调用拒绝 | 后端独立观测停止 |
| --- | --- | --- | --- |
| abort，deadline1000ms | 25.45ms | 499，27.85ms | 1012.31ms，absent；调用返回时仍active |
| deadline400ms | 12.92ms | 504，404.74ms | 412.33ms，absent |

这些是一次实测，后续重复观测另存独立JSON。后台上界来自剩余statement_timeout，不等同立即服务端quiescence。原生fold、FTS索引及SQLite同步步骤不能硬抢占；corpus额度限制其输入规模，并在同步步骤前后检查deadline。未增加pg私有字段或额外管理连接权限假设。

## 固定源与验证记录

| 文件 | SHA-256 |
| --- | --- |
| native-session-search.ts | `7ddf67b05413390fea646ee0d1503c31aa59e0f926017b14164ad508481b870e` |
| employee6-native-search-current.spec.ts | `243d9bf7e1dd22ae4e47b17e339f6da883b2e8764817641efbca87970438aa09` |
| employee6-native-search-current-provider.spec.ts | `0c81e032742465880bc8c33be33a06ea0b735fb03e763cbd7731a5363df999ea` |
| employee6-native-search-current-cancel.spec.ts | `8c39a968cc357503c6c174a488219f3645e1a1f880c7c4a9458a43e0fa92fa02` |

新的三份测试在 [current](application/tests/employee6-native-search-current.spec.ts)、[provider](application/tests/employee6-native-search-current-provider.spec.ts) 与 [cancel](application/tests/employee6-native-search-current-cancel.spec.ts)。测试命令：

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url PE_EMPLOYEE6_SEARCH_EVIDENCE_DIR=/Users/jingchao/agent_work/private/employee6-native-search-current-20261009 node node_modules/vitest/vitest.mjs run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee6-native-search-current.spec.ts products/power-evolve/application/tests/employee6-native-search-current-provider.spec.ts products/power-evolve/application/tests/employee6-native-search-current-cancel.spec.ts --reporter=json --outputFile=/Users/jingchao/agent_work/private/employee6-native-search-current-20261009/tests-owned-final.json
```

私有证据目录 `/Users/jingchao/agent_work/private/employee6-native-search-current-20261009` 为0700。关键文件为 `tests-owned-final.json`、`types-frozen.log`、`lint-owned-final.log`、`jsdoc-second.json`、`final-inputs.json`、`office-assertion-preservation.json` 与各次 `pg-active-*.json`。首次错误runner选择、provider hit字段适配错误、首次lint失败和类型剥离loader失败仍分别保留；不将这些失败改写成通过。

root另外授权了两个旧owned fixture的当前静态修补。旧corruption fixture只追加7个required limits，未改断言；旧Office fixture修复style与四个由实际service写参产生的JSON字段重新接纳类型，原断言与fault路径保留。数字test label改为等义模板的受影响2项实际通过，此次filter另外12pending未重算。原件在 `before/`，历史root24、旧员工6 search9与Office前轮验收保持各自原始证据；当前六个owned源／fixture的静态质量与SHA另列于 `final-inputs.json`。
