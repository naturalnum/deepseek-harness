# 原生增量流的事务、发布与读取证据

2026-10-09，Asia/Shanghai。本记录分别保存 schema 3 数据库基础、Host 有序发布及 PG 一致切面 follow 的专项输入与结果。下文各批使用独立固定源码，不合并数量，也不将源码专项或模块传输替身作为最终增量流验收。候选 v5 仍为 schema 2，后续实现归入下一候选。

## 变更与恢复界限

当前 cloud-native schema 3 通过 v1→v2→v3 邻接初始化，保留 v1／v2 的 SQL 与 manifest。v3 只增加 `pe_native_presentations` 和 `pe_native_presentation_entries`，完整清单从71表变为73表；原表列不变。临时状态以 JSON text 存储，保留 JSON 中 NUL 与未配对代理项的转义表达。状态记录含 epoch、publisher、连续 private ordinal、最后批次回执和到期时间；条目按 Session／ordinal 排序，并保存事件引用或原生助手帧。它们不能作为历史恢复来源。

`EventStore.appendInTransaction` 复用调用方的同一个 `PoolClient`，发布 canonical event、event count／bytes 和投影检查点；成功后推进该事务持有的 row 水位，以便下一批有序追加。入口 `append` 保留原有行为。新原语不自行开始事务、提交或授权；调用方负责原始 grant 授权和事务末段最终 lease fence。提交前的操作失败会使事件、水位及检查点一并回滚。

固定旧数据 importer 的目标仍为 schema 2；正式 Platform 初始化再邻接升级到3。不能修改旧导入资产，把已验证的 schema 2 镜像或历史恢复证据归给本批。

## 数据库基础切面的真实 PostgreSQL 结果

数据库基础切面运行三份源码测试，17项通过、0项失败、0项 pending：database 9项、native-event-transaction 2项、既有 employee5-events-fairness 6项。递归解析的526项仓库源码、所属 manifest／配置、lock 和显式三代 schema 资产在运行前后摘要与成员集合相同，缺失 import 为0。24项物理 node_modules 模块、生成声明／lib、Profile 和部署闭包未包含在此输入冻结范围内。

普通角色用例实际以 `NOSUPERUSER NOCREATEDB NOCREATEROLE` 登录，而不是管理员连接的标注。先拒绝无 CREATE 的升级；随后允许建表但撤销 `pe_schema` UPDATE，确认在两张 v3 表已经执行建表后精确收到42501／pe_schema 权限错误，整次事务退回版本2、两新表不存在、原用户字段完整。恢复权限后两个并发初始化升级到3并再次重入成功。v1→当前的成功路径也经过三个邻接阶段；v1 在后层失败后的回滚未单独验收。

事件专项在真实 PG 事务内连续追加两批及同批重试，外部连接在提交前看不到新增事件；提交后的事件、水位及投影一致。第二用例在追加后抛出后续呈现错误，验证三类数据一并回滚，随后原有入口仍可成功追加。该手工失败不是过期 grant 的最后 fence 验收。

完整命令使用现有 `vitest.power-evolve.cloud.config.ts`，设置 `PE_TEST_DATABASE_URL_FILE` 指向私有连接文件以及 `pnpm_config_verify_deps_before_run=error`；执行 `vitest run` 指定上述三个文件、JSON reporter 与当前证据目录。未输出数据库连接值或模型凭据。

证据目录：`/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-assistant-v1`。旧 `after.json`／`result.json` 与原输入冻结保留；当前结果使用 `current.json`、`current.log`、`result-current.json` 和 `inputs-current-before.json`／`inputs-current-after.json`，禁止用旧结果替代当前源摘要。

| application 文件 | 当前真实 PG 输入 SHA-256 |
|---|---|
| `src/platform/database.ts` | `a806de82171a0b7cd0476e13f0b14ec2d4b602b5e10910f4eb3f093158bbd563` |
| `src/platform/events.ts` | `505054e6cb8869ad8ab47875e40c6642322ad1b87034ea9b4cd0076bb55d7b92` |
| `tests/database.spec.ts` | `f0594adbb5e6611f07fbf6982c9416ec21a4771ed37962495ba0b21d1f7b8d8e` |
| `tests/native-event-transaction.spec.ts` | `660593f53ba6dc9cec5f856959e3cf80e52925555b4b3c74e723f342d5810ec7` |

四个上述 source／test 的 scoped noEmit 类型命令和 mapped typed lint 最终退出0，分别保留 `types-source-final.log` 和 `lint-final.log`；此前 `lint-current.log` 的未清诊断属于修复前版本。两份 runtime 的官方 JSDoc collector 返回空问题清单。本批没有计算逐文件覆盖率，也不证明全部产品 types／lint／文档／依赖门禁通过。

## 独立审查与待接入工作

员工1只读审查邻接升级、v1／v2不可变资产、同事务事件和检查点及当前真实 PG 证据；没有发现本批新增范围内需要判为 P1 的生产问题。审查指出的 v2→v3 后段失败回滚缺口已由当前普通角色用例补齐。manifest 目前只核对表与列名，尚不验证类型、PK、FK 或 CHECK；73表成功不能据此推断所有损坏约束均被拒绝。

下一步接入员工7的临时状态 store、Host 单一有界有序发布器和同一 PG 切面的 opening／follow；核对最终 lease fence、已提交 canonical end 与帧 end 的一致性、epoch／publisher 切换、环形条目落后后的正常重开、取消、网络不确定回执及背压。正常结束按 epoch 清理，Platform 再清理过期临时状态；备份必须要求两张临时表为空，完整保留所有73表及正式数据，不自动删除或排除表。

员工4已经用独占真实 PG16 和普通 source／target 角色跑通 schema 3 备份恢复专项，包含临时两表非空拒绝和原数据不变；其对应源冻结与最终质量交接由该员工记录。本记录不合并其数量，也不将该专项当作 schema 3 的正式 Profile、真实模型或恢复后新业务通过。

## Host 有序发布与状态生命周期切面

`root-native-publisher-v1/result-verified.json` 固定三份测试的16项通过、0失败／pending：Publisher 5项、状态 release／prune／finish 5项、原生 Agent／Scheduler barrier 6项。647项递归仓库输入在运行前后成员及摘要相同、缺失 import 为0；28项物理外部模块、编译声明闭包、正式 Profile 和部署组合未冻结。11个选定 source／test root 的 strict 类型与 mapped typed lint 退出0，runtime JSDoc 空问题清单；没有计算完整产品逐文件覆盖。对应私有证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-publisher-v1`。

Publisher 在观察时同步入队，原帧及事件共享序号与单一传输泵，计量包含在途批次。身份捕获与旧 reader／model 请求的前后 grant 检查阻止使用替换授权。关闭在首次失败后仍等待在途传输，随后 persistence 以原 token 和准确 publisher UUID 释放；实际 PG 的 frame-only poison 用例验证 release 不会抢先开始。负对照只把 close 变换为旧逻辑，针对该行为的1项确实失败，另4项是过滤而非通过；两份旧启动失败日志也保留。成功关闭与过期 bounded pruning 清理临时数据，finish 最终 PG clock fence 失效会回滚此前操作及临时删除。

Barrier 使用真实原生 Agent／Scheduler、PG 与 HTTP 模块适配器，但模型是 MockAdapter；原4项行为断言保持，增加当前流与旧 reader 两项。员工1的独立审查及22项内存探针属于另一个只读证据范围，不能算成额外真实 PG 用例。该切面的 Platform index 后续已有 follow 接线修改，其历史类型与输入冻结不认证后续完整 index。网络不确定回执重试、实际多副本、慢下行和完整队列尚未由此批关闭。

## PG 一致切面 opening 与 Host follow

`root-native-follow-v1/result-current.json` 保存新增单份测试8／8通过、0失败／pending，528项递归声明 Host resolver 输入前后无变动，缺失 import 为0，24项物理外部模块不在冻结范围。PG 用例验证同一 opening 历史／基线、两个独立 reader 读取原帧与正式事件的次序、准确 release 后重开、损坏状态的一次拒绝、条目及累计字节退役、opening 前后时间预算、另一 owner 的404及完整 opening 字节限额。初始5项结果与修前 header 解析失败保留，不能覆盖为当前8项。该批目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-follow-v1`。

两个 reader 是同一真实 PG 上的独立实例，没有启动两个 Host 进程。Host 通过直接模块 ReadCall 连接 reader；opening 超时用例在真实 PG opening 后，以响应 signal 的定时器模拟传输等待。正式 HTTP／WS、具名 Profile、浏览器、模型和动态 Loader 闭包均不属于本批。Host接线质量批完成后，Root选定六个 source／test 的 strict 类型与 mapped typed lint 均退出0，五个 runtime 的官方 JSDoc 空问题清单；编译声明闭包未独立冻结，不能据此推断全量质量通过。

正常 end 重开的前提是本 generation 已发出 opening：opening 前超时报告504，避免空成功流触发原生协议错误；opening 后达到累计 item／byte／lifetime 或 reader 返回 reopen 则正常结束。私有 publisher position 留在 Host／Platform 读取层，原生 Client 仅见正式 opening、事件和原始 assistant 帧。共享实例锁、publisher／epoch 和原生 revision 次序均有检查。完整配置及失败语义由 [Application README](application/README.zh.md) 拥有。

## Host carrier 回归与正式 Client 检查接线

`wire-result-current.json`另存两份原有native cancel／search HTTP carrier测试16／16通过、0失败／pending，682项输入前后稳定。该回归使用真实Host HTTP服务，但Platform身份、queue、search和回执均为显式替身，不使用PG或WS。它检查新的follow-limit调用参数与两Host文件质量接线后原行为；不能把16项数量与发布切面的16项混为同一批。员工6的两文件AST差异及549项解析输入冻结由其交接拥有：mux opener的校验在Promise微任务内执行，未声称变更前后全部运行时AST相同，也未加入lint豁免。

新增 Client spec 已明确进入 `tsconfig.power-evolve.test-client.json`，从 Host 程序排除，并声明官方 client-test-runtime 与 RemoteMock 直接开发依赖。首段接线切面的正式 TestClient 类型退出0；正式产品 Vitest入口的3项 Client 用例通过，各自确实启动1个真实 PG producer，使用 RemoteMock 传输消费其原始 JSON。618项声明 Client resolver 输入前后稳定，物理外部模块、动态 Loader 和声明闭包不包括在内。结果在 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-client-face-integration-v1/client-result-current.json`；首次漏设必需私有 PG 文件环境的失败保留。其后最小 shared peer 与生产 provider 声明进入新依赖切面，完整TestClient类型再次退出0；不能把首段 manifest／lock 摘要当作后段当前行为证据。最近的测试目录配置改为solution引用正式TestHost／TestClient，解决后端程序发现错误。实际正式源码的无adapter typed lint＋type-check退出0，后端选中TestClient、programs为1、unmatched为0；当前完整TestClient类型也退出0，结果分别为同目录 `lint-client-solution-current.log` 与 `types-client-solution-current.log`。本次未独立冻结全部后端声明闭包，不能将历史解析输入或私有镜像结果扩展为全产品门禁通过。

[员工7交接](EMPLOYEE7-HANDOFF.md)拥有 reader 63项及另3项公开 Client 连续正常 end 证据：后者复用此前 PG JSON、每项实际重开至4个 generation，没有重跑 PG，也没有运行 Root 的新 Host follow。reader 63项、Root Client3项和独立正常 end3项各自有范围，不能相加认证当前全部实现。

公共Gateway发送截止时间及取消修复已经封存：7份原有／新增测试197／197通过（14项新增、183项原有），类型、实际typed lint、JSDoc及对应双语文档检查通过。该批使用真实WebSocket并扣留发送完成回调，不是实际慢网络、PG或正式Profile验收；97项声明runtime解析输入、56份实际加载仓库源码及408项当时编译输入分别记录。产品generation私有计时器在源迭代器停于yield时不能由通用mux直接观察，此时独立发送截止时间负责停滞通道清理。原文件及命令由员工6私有 `employee6-mux-send-boundary-20261009/HANDOFF.md` 拥有。

Root重建正式Gateway引用声明后，新五参数constructor已生成；当前产品原cancel／search的HTTP回归再次16／16通过，682项声明解析输入无漂移，30项外部模块不在冻结范围，Platform仍为显式替身。结果为私有 `root-gateway-send-integration-v1/wire-result-current.json`。该切面的完整TestHost先退出2，仅报告进行中旧图片转换文件的Context生命周期调用错误；员工5改用官方fiber.dispose()后，Root当前完整TestHost命令退出0。产品两个Host运行时和wire fixture的实际无adapter typed lint＋type-check退出0、unmatched为0，两运行时JSDoc空问题清单。这些检查未独立冻结全部编译／后端声明闭包，不认证全量产品质量；原失败日志保留。

剩余验收包括同版本正式 Profile／Web 和2＋2进程、在途回执不确定性、真实下行背压、ring淘汰和副本切换后的完整用户流程，以及队列控制和逐操作 grant 轮换。旧数据完整导出／转换及恢复后的新任务也仍在实施。下一候选须捕获当前schema、源码、依赖及构建资产后验证；各专项通过均不代表迁移完成。
