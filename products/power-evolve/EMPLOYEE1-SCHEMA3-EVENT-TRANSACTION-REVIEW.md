# Employee1 schema 3 and event transaction review

历史私有归档引用：以下 `.artifacts/employee1` 路径和原记录名称保留为文本；当前 checkout 不提供这些收据，本轮当前验收未使用它们。原历史结果、失败与验证限度继续保留。

2026-10-09：独立只读审查未发现本次新增 schema 3、邻接升级循环或事务内事件追加的 P1 生产正确性缺陷。current 真实 PG 记录为 17/17、0 fail、0 pending、3 个测试文件；本次代码审查范围占 11 个案例（database 9、native-event-transaction 2），另 6 个是已有 employee5-events-fairness 案例，不扩大本次代码审查范围。v2→3 在 DDL 完成后失败的 P2 回滚验收缺口已对应当前 SHA 关闭。

v1/v2 的四份 SQL/manifest SHA 与原冻结和 current PG 输入一致。v3 只新增 pe_native_presentations 与 pe_native_presentation_entries，manifest 从 71 张表增加到 73 张，未删除旧表或改变旧列。[邻接升级](application/src/platform/database.ts) 在一个 transaction 和 advisory lock 内检查旧 manifest、逐级执行 DDL、更新版本并检查新 manifest；没有分层独立提交。

[普通角色后段失败案例](application/tests/database.spec.ts) 在保留旧表 SELECT/REFERENCES 权限后允许 CREATE，但撤销 pe_schema 的 UPDATE。当前真实 PG 拒绝的 SQLSTATE 为 42501，message 精确指向 pe_schema；升级回滚后原 version 2、原 user 字段全部不变，两张新表均不存在。重新授予 UPDATE 后并发初始化升级至 3，再次初始化不改变结果。该案例区分第一条 DDL 前的 CREATE 权限拒绝与 DDL 后段拒绝，不用旧 17 案例的 SHA 代替当前结果。

[appendInTransaction](application/src/platform/events.ts) 使用传入的同一 client 写入 pe_events、推进 pe_sessions 计数并执行 checkpointNativeProjections，没有另开事务；传入 row 的 counters 在 checkpoint 完成后才推进。[两个真实 PG 案例](application/tests/native-event-transaction.spec.ts) 验证两次有序 append 和完整 prefix 重试、事务外未提交 events 不可见、提交后的 events/watermark/checkpoint 对齐，以及后续手工 throw 后三者全部回滚。手工 throw 表示后续步骤失败；它不是实际 presentation publisher 或增量流执行证据。

授权和最后 lease fence 是调用方的明确职责：调用方在同一事务中取得当前授权和 account/Session locks，并在提交前执行最后 grant fence；appendInTransaction 自身不认证、不重新检查最终 lease，也不拥有 commit/rollback。主线程把实际 assistant store 的末段 fence 交给员工7，本审查没有读取或验收尚未接入的增量流。现有 append wrapper 仅入口 authorized 一次，这两个 primitive 案例不能计作完整 assistant 发布或最终 fence 验收。

另保留既有 manifest 检查的限制：assertManifest 只检查表/列名成员，不验证列类型、PK、FK 或 CHECK。当前成功初始化不等于已执行“同名同列但约束损坏”的拒绝测试；这是既有检查设计的限制，本次没有发现 v3 SQL 新引入的此类损坏。

current 证据位于 Git 外本机目录 /Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-assistant-v1：[结果摘要](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/result-current.json)、[17 个案例](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/current.json)、[原运行日志](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/current.log)、[运行前输入](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/inputs-current-before.json) 与 [运行后输入](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/inputs-current-after.json)。526 个递归仓库输入 SHA、程序成员前后稳定，0 missing imports，当前 10 份审查源文件与该 current 记录全部匹配；外部 node_modules 的 24 份模块 bytes、emitted lib/declarations、Profile 和部署闭包不在此输入冻结内。旧 result.json/after.json 及其输入、日志独立保留。

四份 root source/tests 的最终 source 类型检查及 mapped typed lint 由主线程登记为 exit 0，[最终质量记录](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/quality-final.json)、[最终类型日志](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/types-source-final.log) 及 [最终 lint 日志](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/lint-final.log) 路径均已核对，两份日志为空。本审查未重复运行类型检查。两份 runtime 的 [JSDoc 结果](../../../power-evolve-migration-evidence/private/root-native-assistant-v1/jsdoc-current.json) 为零问题。lint-current.log 是保留的修复前诊断，不能记作 exit 0；审查员另对当前四文件执行一次无 fix 的同配置、同 source 程序 mapped typed lint，独立得到 exit 0，本次 lint 日志（`../../.artifacts/employee1/schema3-event-review/mapped-lint.log`） 为空。两项质量命令的完整 compiler declaration/runtime 依赖闭包未单独冻结；以上只限定四文件及两份 runtime JSDoc，不声明 whole quality 或 coverage 通过。

本批不验收 publisher/epoch/ordinal/cache 生命周期、lease 到期或撤销后的最终 assistant-store fence、真实 Host/Profile、image/deployment、跨 Host 增量流或整个 Cloud；这类证据仍需各自消费者和实际集成运行。本审查未编辑 root 代码、运行 PG 写操作或重跑旧用例，只新增自有交接及 机器审查记录（`../../.artifacts/employee1/schema3-event-review/final-proof.json`）。先前四份 STDIO 消费者测试/辅助文件 SHA 全部保持冻结。
