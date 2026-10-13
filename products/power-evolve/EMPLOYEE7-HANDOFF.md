最新独立单位：[Host generation 首批交接](EMPLOYEE7-HOST-GENERATION-HANDOFF.md)。最终 70／70、两新 source 四项 100%、专项1177输入0漂移；仅辅助模块，不是最终 Coordinator／队列 parity。

# 员工7 Skills／报告技能独立验证交接

## Session writer lease 新三文件已交付并冻结

[writer接口、schema4注册和结果](EMPLOYEE7-NATIVE-WRITER-HANDOFF.md)：新三文件及SQL/manifest提案已封存，独立45/45（44真实PG＋1wire）、两新模块四项100%、正式专项typed lint＋type-check及完整TestHost tsc均退出0，发现/JSDoc通过。本人明确三文件的正式ambient类型程序实际读取684项全部匹配、诊断0；宽Host的1083记录有5项员工5并发漂移，完整保留并明确broadProgramInputAcceptance=false。原reader／Store六文件不变，未为这些宽漂移继续扩大复验。schema4只在独立数据库显式装载私有SQL；正式注册和claim排除livewriter的补丁已检查可应用、未应用。Root可按冻结源码及提案串行接入正式initialize/schema4/声明，再无私有DDL复验；API、epoch/tombstone、两处claim资格检查和串行改动列表见独立交接，当前不称迁移/Profile或全量cloud验收。

## 正式 Client typed lint 配置补丁待 root 应用

[程序选择诊断](EMPLOYEE7-CLIENT-LINT-DIAGNOSIS.md)已完成：--tsconfig 未进入安装的 Go typed 后端，最近的 application/tests/tsconfig.json 只有 Host 面，Client spec 被判为 unmatched。建议把该文件改为 files=[]、引用正式 TestHost／TestClient 的 solution 配置。只覆盖这个配置、继续读取真实冻结源码的独立诊断中，两面分别选中正式程序，typed lint＋type-check均退出0，36项typed规则及诊断开关完整保留。可应用补丁与真实程序／请求／前后1066项0漂移证据在 employee7/client-typed-lint-diagnosis-20261009；共享文件未改，当前未改后端的正式 Client lint仍退出1，root应用补丁后应在无adapter条件下复验。此诊断未使用先前Client字节镜像，未改六个冻结源码、manifest、lock、规则或断言，未运行行为测试或安装依赖。

## 同切面 reader 已交付并冻结

本批三个文件是 `application/src/platform/native-assistant-read.ts`、`application/tests/employee7-native-assistant-read.spec.ts`、root追加授权的 `application/tests/employee7-native-assistant-read.client.spec.ts`。reader 最终 SHA-256 为 `a96e2ed19d773efa37f7bc7be7049014b69c537f1d92248aa6ddaa62a8c2c9b4`；另两文件摘要见本批 `owned-freeze.json`。先前协议／Store／60项Store测试三个冻结文件完全未变，摘要复核在 `prior-freeze-check.json`。

导出 NativeAssistantRead、NativeAssistantReadRow、NativeAssistantReadLimits、NativeAssistantPosition、NativeAssistantOpening、NativeAssistantContinuation 及 strict JSON parser nativeAssistantPosition。构造器为 `NativeAssistantRead(presentationLimits: NativeAssistantLimits, readLimits: NativeAssistantReadLimits)`；`open(client: PoolClient, row: NativeAssistantReadRow): Promise<NativeAssistantOpening>` 返回 `{baseline:SessionAssistantStreamBaseline,position:{epoch,publisherId,ordinal}|null}`；`after(client,row,position:NativeAssistantPosition|null,cursor:number,limit:number): Promise<NativeAssistantContinuation>` 返回 `{kind:'next',position,cursor,frames:非snapshot的官方SessionFollowFrame[]}` 或 `{kind:'reopen'}`。row 为 `{sessionId:SessionId,header:SessionHeader,eventCount:number,leaseEpoch:number}`。caller 先认证租户，再在同一连接/事务持有 Session FOR SHARE；helper 仅追加 presentation FOR SHARE，不另开事务、不接grant。锁顺序 Session→presentation；finish/TTL 清理归root。

opening baseline 保留原实际 revision、完整 compact prefix 及官方 branded attempt；已持久化 settlement 而尚无end时隐藏activeAttempt。after 在真实ordinal顺序中转发 canonical event 与官方start/chunk/end，不创造SessionEvent；旧重复event引用推进ordinal但不重发。正常 TTL／lease／running operation／epoch／publisher／ring eviction 变化返回reopen；未知future cursor／同publisher future ordinal（即使TTL已过）／native gap／坏receipt或cache拒绝503。canonical缺失或预算违规亦明确终止；native event的Unicode和可选metadata原样保留，PG原始JSON是唯一权威。读取最后重新核对PG clock，实际presentation锁等待和canonical表锁等待跨TTL已覆盖。

readLimits独立字段及建议默认：maxOpeningBytes=8MiB、maxBaselineChunks=1,048,576、maxPacketItems=256、maxPacketBytes=4MiB、maxCanonicalBytes=8MiB。各值必须正安全整数；opening最低512，完整前缀超过独立opening预算时整体503；packet最低max(maxItemBytes,maxEventBytes)+512，canonical最低maxEventBytes。packet字节／项数截取可推进的原始ordinal前缀，opening不截短active stream。opening预算只包含helper的baseline/position，完整snapshot envelope总预算仍由root负责。

root拟定 `NativeSessionRead.opening(user,request,reader)` 同TX返回 `{snapshot:官方snapshotFrame,position}`、`presentationAfter(user,id,cursor,position,reader)` 以及新 `/native/sessions/open`、`/native/sessions/presentationAfter` 路径与此helper一致。assistantStream:true时新generationopening带baseline，kind:reopen正常结束当前generation，由官方Client再次opening；assistantStream:false可继续canonical路径。旧metadata读取不决定该helper分支；root显式传入独立readLimits。最终行为验收使用以上完整SHA后执行即可，员工7没有修改root routes/follow/Host、DDL或manifest。

交付轮父专项63/63、0失败/skip/todo：Host60项（59真实PG、1配置/位置parser）；独立Client3项均另起有名筛选的cloud Vitest子进程，执行相同sessionId、attemptId、revision的真实PG settlement切面生成原始JSON，再由公开程序集boot及public ISessions.retain／SessionBinding.eventSource消费。子进程每次仅1项选中，其它未选项数量另存，不替代父专项无skip的63项结果。attempt、message、interrupted三项均显示：opening revision2无active transient；随后genuine committed end revision3及step/end被同一followgeneration消费，durable settlement正好一行，没有duplicate／transient／rebaseline，故不需修改冻结协议。承载层为维护中的RemoteMock，不是实际HTTP/WebSocket、Profile、浏览器或模型证明，没有导入私有 reducer/accumulator。

reader逐文件lines／statements／functions／branches均100%，保留云端四项100%门槛的focused coverage命令退出0。两个独立 source TS程序分别退出0；Host source type-aware lint含type-check退出0；JSDoc无违规，fresh inventory发现三文件且均纳入lint，两个spec均被发现。Client正式路径的oxlint目前不能解析公开程序集subpath，初次失败已保留；同字节Client镜像在真实独立Client tsconfig下type-aware lint含type-check退出0，`client-lint/mirror-equivalence.json`记录SHA及适用的同等规则，仅为诊断证据，不能替代root正式Client source lint。root应声明public client-test-runtime devDependency/source subpath，把 `*.client.spec.ts` 排出Host测试面并纳入Client测试面及引用；root接线后统一重跑正式source/static/coverage gate。

本批证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/assistant-read-20261009-x8iqszag/`：总记录 `report.json`；全量父结果 `tests-delivery.json/log`；reader覆盖 `coverage-delivery/coverage-summary.json` 与 `coverage-final.json`；Host/Client类型 `types-host-delivery.log`、`types-client-delivery.log`；Host lint `lint-host-delivery.log`；Client镜像lint `lint-client-mirror-delivery.log` 及正式失败 `lint-client-first.log`；发现和文档 `discovery-delivery.json`、`jsdoc-delivery.json`；精确新3文件冻结 `owned-freeze.json`，旧3文件核对 `prior-freeze-check.json`；官方Client所消费的PG原包和子进程证据在 `client-packets/`。所有首次启动、排序及夹具错误、覆盖失败均保留，不挪用旧结果。

输入记录 `delivery-inputs-before-full.json`、`delivery-inputs-after-full.json` 与 `delivery-input-comparison.json` 共2515项前后0变化／0新增／0缺失：2292项配置/声明程序/参考源码在2026-10-09 07:32:43.014Z记录，另外223项实际compiler加载的import源码及一方redirected声明取自07:21:06.289Z较早测量 `development-inputs.json`，完整after于07:39:46.593Z记录；不把这两次before测量说成同时采样。root随后自己的接线源码需要新的全量closure，不能把本轮冻结当作rootv6整合验收。

上一Store切片的确切冻结为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/assistant-stream-store-20261009-7g6qspew/owned-freeze.json`；同目录current-fence输入 `current-fence-inputs-before.json`、`current-fence-inputs-after.json` 与 `current-fence-input-comparison.json` 共468项，窗口2026-10-09 06:10:50.963Z–06:12:37.438Z，6项真实fence增量测试及闭包0变化。旧60 Store/6 fence与本63 reader/Client切片分属独立证据，不能相互替代。本批新增membership即本节开头两个spec，复用已有cloud-fixture.ts，无新增共享fixture。

## 官方 Client 正常 end 补充验证

root开始接线后，只读核对并在私有证据目录追加独立公开Client协议验证，未修改本批三个冻结源文件。attempt／message／interrupted三项3/3、0失败/skip/todo；每项复用本批真实PG已经产生的原始opening JSON，连续正常结束session/follow三次，实际打开4个generation，随后消费原PG迟到end及step/end，窗口保持open、durable settlement仍一行、无transient。独立Client类型检查和运行均退出0，结果在 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/assistant-read-20261009-x8iqszag/normal-end/report.json`、`tests.json/log`、`types.log`；after-run摘要保存生成的验证源码/私有配置、公开协议源码及PG JSON输入，不声称这次补充做了before/after闭包冻结。首次checkout外source解析失败的0test报告保留为 `tests-first.json/log`，修复仅在私有配置添加公开source aliases。

官方重开成立前提是本generation已接受opening：RemoteJournalStream把其后正常EOF分类为carrier retry，RemoteStream接受每次新opening会重置attempt，因此连续正常结束能继续重开。opening前的EOF按官方协议是terminal gateway/internal（此项为只读源码核对）；root的generation lifetime/item/byte用例须保留这个区别。本补充没有执行root的新Host follow/HTTP、没有新建PG用例、没有浏览器或模型，不增加原63项product membership或替代root正式跨read/follow与generation预算验收。

## v6 assistant-stream 实现接口与专项结果

实际新文件为 `application/src/native-assistant-records.ts` 与 `application/src/platform/native-assistant-store.ts`。Store 导出 `NativeAssistantStore(tasks, events, limits)`，公开方法 `apply(token, input): Promise<NativeAssistantReceipt>`；receipt 字段为 `{ publisherId, epoch, lastOrdinal, eventCount, revision }`，只在真实 PostgreSQL 事务提交后返回。epoch 取自 TaskStore.authorized；批中 epoch 仅与授权值核对，不授予权限。

批格式为 `{ version: 1, epoch, publisherId, batchId, firstOrdinal, items }`，item 为 `{ type: 'event', event }` 或 `{ type: 'assistant-stream', frame }`。私有 ordinal 从1开始，空 generation 的 lastOrdinal 为0；Agent revision 从1开始，chunk/end index 与 native seq 保持原来的0起。输入 start 没有 startedAfterSeq，Store 从该 ordinal 前已验证的真实 durable cursor 推导。暂存 entries 的 event item 只保留 `{ type: 'event', seq, eventType }`；pe_events 是完整 native history 的唯一权威。last_batch_json 暂存最后一个有界原始批（可含其事件数据），仅用于精确重试比较，不用于 Session 重建，独立受 maxBatchBytes 和 presentation TTL 限制。

公开记录导出包括 NativeAssistantLimits／NativeAssistantBatch／NativeAssistantEntry／NativeAssistantState，及 parseNativeAssistantBatch、createNativeAssistantState、readNativeAssistantState、nativeAssistantBaseline、foldNativeAssistantItem、nativeAssistantBytes、validateNativeAssistantLimits。未知 raw chunk 在公开 expandAssistantStream 中仅验证 lossless JSON object，不能声称其内部字段已获得完整 StreamChunk schema 验证；后续公开 AssistantStreamAccumulator.push 对未知 type 抛出官方 assertNever 错误，已知非 delta 类型的内部 JSON 保持不透明，delta 的 index/text/tool字段由官方 accumulator 校验。没有深导入私有 session-controller accumulator，也没有手写压缩算法。

Store 没有 open/read 方法，root 负责读取端及 Host/Platform 接线。交付轮60项新专项（59项真实PG、1项纯wire解析）全部通过，两个新源码的 lines／statements／functions／branches 均100%，命令连同原有逐文件四项100%门槛退出0，没有降低云端门槛。公开 fold 先检查当前有界队列项，再在同一个外层事务 staged canonical append；后续 frame 必须等待对应原始 event append 成功，末尾 grant/epoch/running/PG clock fencing 失败时原子回滚。交付轮 source类型检查、type-aware lint（含 type-check）均退出0，发现完整，两个模块 JSDoc 无违规。第三轮与交付轮中 root 的 database.ts 在执行期间持续调整回调状态读取、release discard 状态及安全行访问；468项源码/配置/DDL摘要中仅该文件漂移、0缺失，员工7三文件及两个私有检查配置0漂移。因此本交付只冻结自己的实现，不称整个依赖闭包已冻结，root 整合后须统一重验。

证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/assistant-stream-store-20261009-7g6qspew/`，总记录 `report.json`，交付结果 `tests-delivery.json/log`、`coverage-delivery/coverage-summary.json` 与 `coverage-final.json`、`types-delivery.log`、`lint-delivery.log`、`delivery-input-comparison.json`、`discovery.json`、`jsdoc.json`。首轮39项中29通过、10项夹具错误失败；第二轮39行为全通过但覆盖门槛失败；第三轮和交付轮60项及两个模块四项100%均通过，全部中间证据保留。第三轮与交付轮的 root 数据库源码差异已另存，不把历史结果移记到 v5，也不把覆盖过滤称为全量 cloud source 入口。

root 随后固定 database.ts/events.ts；针对该帮助函数变化，追加6项受影响的授权／过期用例全部通过，current source类型检查退出0。468项解析闭包在2026-10-09 06:10:50.963Z至06:12:37.438Z窗口0漂移、0缺失，见 `tests-current-fence.json/log`、`types-current.log`、`current-fence-input-comparison.json`。这是有明确 name filter 的增量重验，另外54项仅未选入本轮，不替代前述无skip的60项完整专项或其覆盖结果。三个末尾fence用例均实际等待 canonical checkpoint 的真实PG锁、观察PG clock超过原lease或presentation期限、释放锁后才收到末尾fence拒绝，并独立核对原始event／count／checkpoint／presentation／ring整体回滚；不是只在 TaskStore.authorized 提前拒绝。

本专项不属于 v5，也不证明真实 Agent 发出首帧、Host 两副本有序 publisher、Platform HTTP、官方 Client 两副本 follow、浏览器或模型输出；这些仍由 root 的 v6 接线和正式试跑负责。新测试仅使用已有 cloudFixture，每项创建并销毁独立数据库；未修改共享服务或三份冻结 wire 文件。

员工3的本轮新增测试 membership 为 `products/power-evolve/application/tests/employee7-native-assistant-store.spec.ts`，没有新增 fixture，复用 `products/power-evolve/application/tests/cloud-fixture.ts`。两个新源码分别为 `products/power-evolve/application/src/native-assistant-records.ts`、`products/power-evolve/application/src/platform/native-assistant-store.ts`。精确SHA-256与三文件0漂移证明在上述证据目录的 `owned-freeze.json`、`delivery-input-comparison.json`；该登记只描述员工7新增项，完整current inventory仍由员工3独立发现，不替代全量成员表。

## 跨 Host assistant-stream 只读方案完成

[独立最小方案](EMPLOYEE7-ASSISTANT-STREAM-PROPOSAL.md)已交付供root下一批实施：Owner的真实Session append与临时frame同一有界serializer/PG事务，原grant/epoch和锁后PG clock fencing，接入Host按统一ordinal转发官方follow类型；原生revision/attempt、真实compact reconnect prefix及terminal提交顺序保持。关键公开API限制写明：emit无法await网络；503 RemoteError不自动重试；有效opening之后正常end才触发官方Client rebaseline；现有mux没有消费ack或挂起send硬截止。硬write预算需root评审当前Gateway补丁的小typed扩展，不能伪称fixed tag已支持。

本轮仅源码/方案审查，未启动测试、模型、PG、Profile或浏览器，未改冻结wire三文件、生产及配置。39项初始记录输入、7项补充输入、20份核心固定tag源码及差异在 `employee7/assistant-stream-proposal-20261009-aknbgfno/`；必要真实用例按source/PG/2+2官方Client/browser分列。下述wire16/16属于上一独立切片，不能当作assistant-stream新增实现验收。

## Native search wire 与共享真实 Host fixture 完成

按新授权提取本人测试夹具为 `application/tests/employee7-native-wire-fixture.ts`，由 cancel/search 两个新测试共用唯一真实 Host server；原 cancel 六项测试正文逐字保持一致。新增 `employee7-native-search-wire.spec.ts` 十项：空串、纯空白、NUL、501 UTF-16 四边界在 Host 拒绝且不发 Platform search；500 UTF-16 emoji 正向及 trim/literal/未知参数拒绝；Platform budget/timeout/cancel 三种失败映射；真实客户端断开后，独占 RuntimeScope 的实际上游 HTTP fetch 在两秒观察上界内关闭，早于其5000ms配置超时。Platform身份、queue、搜索结果及预算结果始终为明确替身，不能称真实PG预算或数据库取消通过。

最终新轮16/16（cancel6＋search10）、0失败/skip/todo，17个记录输入及3个私有配置前后SHA一致。Application直接source tsc、官方映射type-aware lint（另启用type-check）、fresh发现均退出0；helper也实际进入lint范围，scoped source program保留34个upstream/Contracts/Connector引用，无owning Application自引用。本轮只接受这两个测试及helper的专项证据，不替代全量quality/coverage。证据为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/native-search-wire-20261009-krn2hp39/` 的 `tests-delivery.json/log`、`input-comparison-delivery.json`、`types-delivery.log`、`lint-delivery.log` 和 `report.json`。

此前search源码在一轮16/16运行期间变化，该轮manifest漂移原记录完整保留，另起输入后才得到上述稳定轮；原cancel旧path的4失败/2通过、Node解析lint失败、helper的void写法lint失败及首次discovery loader失败均保留，不改写旧结果。只改本人新测试/helper及本人文档，未改生产/共享配置/旧测试/正式Profile或运行服务。51方法审计新增R5：Host搜索入站/错误/HTTP取消有实测；员工6正在整合官方SQLite current/ranked与真实PG总预算/abort证据，最终同一冻结cut和正式运行验收尚待完成。assistant-stream、image、queue/steer、stop-all、Settings/event及NativeFileRead carrier缺口继续保留。

## Native cancel wire 提取前新路径及三文件只读复核

新增独占 `application/tests/employee7-native-cancel-wire.spec.ts` 原六项最终6/6通过，0skip/todo。实际启动原生WebServer、BrowserAgentAuth、RuntimeScope及NativeRemote，使用本人临时目录和两个loopback随机端口；Platform身份、ack及queue是明确替身，员工7未调用PG。首轮旧路径2通过/4失败全部保留；未放宽原断言。queued哨兵/旧路径positive control、cookie/RPC身份、strict参数、撤权/Origin/method拒绝、Platform refusal/strict ack均通过。主线程随后继续search接线导致首个green轮交接时NativeRemote/index漂移，另存原报告，不追认当前输入；对最新摘要重新完整运行六项，`tests-current.json/log`及13输入前后一致为最终证据。

新增文件的最新Application直接source类型检查退出0；fresh云端发现确认source/Vitest/lint均包含，声明无skip/todo/only。专项官方映射type-aware lint仍失败，包含Node builtin模块解析及其派生error-type诊断；不能将tsc0写成lint通过，没有降规则或门槛。私有证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/native-cancel-wire-20261009-s2ut3p6u`。只读对照主线程保存的前三文件：Host新path→Platform严格sessionRequest→cancelActive/current；旧product path→cancel/current-or-queued。公共事务body仅增加queued fallback的mode条件，其余账号/Session锁、running及active-STDIO关联筛选和取消写入与旧body精确一致，未发现本次修复新增明确缺陷。

只读检查root `private/root-native-cancel-v1/after.json`为23/23（新native真实PG5＋旧admission12＋wire6），442输入在root当轮稳定；后续search修改了部分记录输入，不追认此后全源统一通过。本轮23项没有active-STDIO取消case，该分支只认源码保留，不记为新增真实PG回归。员工7最新wire6仍是Platform替身边界，未跑正式Profile/浏览器；assistantStream、image、queue/steer、stop-all及完整search/quality仍未通过。51表已在[独立审计](EMPLOYEE7-NATIVE-PARITY-AUDIT.md)增加R4更新，原89项快照和历史证据保留。

2026-10-09；初始完成[Native Remote parity只读审计](EMPLOYEE7-NATIVE-PARITY-AUDIT.md)：固定官方tag的51方法逐项映射，初始89个输入及21个既有证据前后SHA一致，五组方法集合无遗漏/重复。该初始审计阶段未重跑行为测试；之后授权的cancel六项及R4如上。生产/共享配置/库/已有测试未改。search SQL NUL已由root改为raw-text扫描并有24项固定PG证据，current/ranked语义、整个操作预算/取消及正式运行验收继续由root/员工6处理；不宣称完整native parity或全量quality绿。此前auth9+NUL7的16/16、Skills104及CRC证据保留；未add/commit。

## Native Remote 初始51表及后续R4/R5

独立文件按①当前源码、②已执行真实PG、③具名Profile/Host/Platform/browser、④云端不适用及能力拒绝分别记账，覆盖Session19、Settings5、Workspace11、WorkspaceFiles5、Account11。初始优先缺口包括image/attachment、steer/updateQueue、cancel保留pending、stopActivity停止全部活动归档、搜索、assistant-stream/参数转发/Settings wire错误及事件；cancel由R4修复，Host搜索由R5补充，PG完整搜索及正式验收仍待最终cut。Workspace4项未调用unpin，不能把整文件pass分摊给unpin；官方Account UI有Desktop门控，11个Account Remote均无云dispatch且会拒绝，产品账号PG/auth不能记作这些方法pass。

证据为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/native-parity-review-20261009-jb832w_q/review-result.json`，89输入、10个固定tag定义及21个既有报告/日志SHA均核对。初始审计时root旧搜索轮526输入匹配、NUL旧轮534输入有commands.ts一项变化；后续cancel/SQLite/预算接线已继续改变输入，旧24/44项均不追认为当前统一输入通过。各方法请求/返回/事件/取消及关键SHA见独立审计。本次没有触碰真实PG、运行服务、Profile或既有私有配置。

## Native JSON 新冻结切片独立 review

root 明确冻结的两份当前源码为 native-session-read `96710e0db5515acce8a6e543e4019f21892b157296f259301e527fdeba5f135f` 和 native-projections `0000ad0c8473935efb233906714f39a6c8da050985ae67543376a7ba0705672a`。已只读对照 `private/root-native-json-v1/before/` 和当前源码，差异保存为新证据的 `source-diffs.json`；未发现本次编码／扫描实现新增明确缺陷，旧三个 auth 生产文件／三个 root 测试继续未改。

私有 checkpoint 外层新增严格 version 2 `{version, asOfSeq, stateJson}`，内部仍是原严格 version 1 的 projection state。旧直接 version 1 checkpoint 仍可读及继续推进；新 JSON 文本先经 JSON.stringify，再作为 jsonb 内的普通字符串保存，解码一次后保留 NUL、lone surrogate 和文本字面 `\\u0000` 的区别。native Session V4 和已有事件行不变，没有清洗或重写日志。外层／内部 watermark 不同、future version、缺字段／多余字段／损坏 JSON／错误 state 拒绝。冷读要求 checkpoint 的 asOfSeq 等于 eventCount−1；writer 刻意允许合法落后 checkpoint 从连续历史补齐，未来 checkpoint 或补齐缺口拒绝，不能把所有「落后 checkpoint」都称为写入损坏。

list／adoptBlank 改为用 256 条 seq 区间取出已提交 prefix，经真实原生 parser 在 JS 判断 turn/start，避免 PostgreSQL JSON 提取在合法嵌套 NUL 上失败。每批核对行数、DB seq 和事件内 seq；首个 turn 后停止扫描，属于有界前缀分类，不能证明未扫描 tail 没有 gap。1000 Session 列表上限和既有 page／after／snapshot 逻辑仍保留。NUL 两份 root 原测试已有六项，包括双版本、NUL／lone surrogate 和拒绝；员工7没有改写其断言。

新增 [独占 Native JSON 测试](application/tests/employee7-native-json.spec.ts) 七项，真实 PG／Session／EventStore／NativeSessionRead／TaskStore 验证：

- 256 个含 NUL／lone surrogate 的 title 之后才出现 turn，list 非 blank、adopt 拒绝，after 的首批恰为 256 条，第二批／snapshot 精确保留事件，原 event::text 不变。
- 第二个扫描块缺行、内部 seq 漂移或无效事件分别拒绝，Bob 没有资源可读；用保存的原 PG JSON 文本修复后 blank 分类和所有原事件字节恢复。
- 保存 ASCII 旧 version 1 checkpoint，再在日志中提交 NUL title／inbox 并故意令 checkpoint 落后：冷读拒绝，writer 从实际历史补齐为 encoding 2；title／inbox 保留 UTF-16 字符和字面转义，早先三行 event::text 不改写。
- outer 多余字段、inner future version／多余字段／null 及外内 watermark 错误拒绝冷读和追加；追加事务中的 event_count 与日志均回滚，恢复正确 checkpoint 后同一 suffix 可重试成功。
- 合法落后 checkpoint 的补齐历史缺一行时，推进为 `503 native_projection_gap`，原 checkpoint／event_count／已有日志不变；修复原始行后同一追加成功。

本轮两文件 16／16 PASS，其中原 auth 九项名称全部保留并在新 native-projections 摘要下重跑，新增 NUL 七项；0 failed／skip／todo／only。544 个仓库监控输入和 types-source／oxlint／prepare-checks 三个私有配置前后一致，两个 root 目标与冻结通知一致，报告为 `focused_review_passed`、`inputAcceptance=true`。证据目录 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/native-json-review-20261009-xi6t2dv9`，权限 0700，保留完整前后输入、tests／types／lint／discovery、source diff、root 只读证据检查及总记录。

Application 直接 source 类型检查采用 root 新 source config 的官方基础选项，移除 owning Application 自引用，根为五个相关 Application 生产源码＋两个员工7测试，实际保留当前配置的 34 个 upstream／Contracts／Connector refs，退出 0；没有修改正式 tsconfig、创建 lib 或构建。这个 scoped source program 是本轮新的检查，不复用旧 auth 依赖声明的单 root 结果，也不代替全量官方所有测试的类型门禁。两个文件 fresh official cloudLintConfig 映射 lint 及 inventory／declarationErrors 退出 0。只读查看 root result-v4 的 44 项通过（40 native 相关＋4 Office），没有重跑 root 文件或独立接受 Office。

首轮 12／16 保留：员工7新夹具把 title state 误认为对象，且修复 PG 事件行时重新序列化原 Session 对象改变字段顺序；改为上游实际字符串 state 和保存的原 event::text 后通过，原字节比较保留。首轮 lint 单行长度失败、类型通过及当时无输入变化记录均保留。没有放宽拒绝条件、超时或原门槛，没有修改 production／root 断言。

范围限于源码 API／真实隔离 PG，`sourceAcceptance=false`／`qualityGateGreen=false`。本轮没有新 coverage 执行或四项 100% 新证据；旧 Skills 缺口和旧全量 Test Host 失败不被豁免。root 已明确 native-session-commands.search 的 SQL JSON 提取 NUL 问题待修，该源码只列入观察和未接受范围，不以本轮冷读通过证明 search、全部 NUL 用户路径或完整旧包导入兼容。真实浏览器、TLS、正式产物、Profile 和运行中 2＋2 服务不在本轮证明范围，未停止共享服务。

## Root auth 三文件只读独立 review

后续状态（2026-10-09 03:28 UTC）：主线程通知将修复合法 JSON NUL 的 native-session-read／native-projections 切片，旧三生产／三 root 测试继续冻结。员工7旧监控集合包含 native-projections，当前核对仍为旧摘要 `178e1f3c2dd99b9de69541345ca2e6f9c9b92d7f70e0bf9ba3d1c40bc6524dc6`；native-session-read 未包含在旧集合，不能声称它曾被固定。审计保存在 `auth-review-20261009-_eoewhm_/pending-native-freeze-audit.json`。当前未观测到这两项的运行期失配；后续改动另记报告后失配，保留旧摘要和结果，不倒写成曾有／曾无运行期变化。员工7等待新切片明确冻结通知，再按实际新依赖范围复验；期间不启动新测试或修改冻结源码／root 测试。

对照主线程私有 `root-auth-quality-v1/before/` 的三份源码和当前冻结源码，差异完整保存为 `source-diffs.json`。审查结论限于以下等价改动，没有新增 production finding：

1. `host/browser-auth.ts:40`：split／filter 产生稠密字符串数组，旧数组长度 0／1／大于 1 与新 head／rest 判断逐一对应；无 cookie、单 cookie、重复 cookie 的优先级和错误码保持。Origin、两个带路径边界的前缀、preflight、exchange、clear 和每次 Platform 验证均未修改。
2. `trusted-account-ui.ts:11`：extname 返回字符串，assetExtension 的 string＋Object.hasOwn 检查接受的仍是原七个 MIME key。manifest 路径正则、逐段禁止空／点／双点、要求 index.html、唯一列表、只服务列出的资源和响应隔离头均保留。新 parse 不把未列出或未知扩展名变成 entry-page fallback。
3. `platform/native-preferences.ts:20`：JSON 中「长度恰为 1、元素为 string 的数组」与单 string tuple 接受集合相同；有限代表 JSON 样本另经新 parser／旧长度一 schema 对照。静态 delete 之前仍有同一两字段 guard，因此仅删除 enabled 或 welcomeNoticeVersion，与原动态 delete 相同。真实 PG SELECT 的 0／1 行与 rowCount／首行 guard 对应，缺行继续 404；账户／凭据锁、model grant、lease 判定、append 和 PG 写入未变。

独立新增 9 项使用真实 loopback HTTP adapter、IdentityService／NativePreferences／TaskStore 和 cloudFixture 隔离 PG，未替换 parser、验证器或数据库：cookie 前缀近似值、含坏值的重复 cookie、Origin null／same-site／POST 导航拒绝且不调用真实验证器；两个 Host 同时 exchange 只有一个成功，winner replacement 在两端可读，随后通过真实 logout 撤销，在两端均 401，原票据不复活，Bob 不受影响；额外 manifest 路径／扩展名／非法 JSON 拒绝，合法带查询资源按实际 Platform caller 的 pathname 保留字节／MIME；JSON Settings 的路径、字段、namespace 和 revision 拒绝保持公开错误码／原值；写入真实等待账户锁时撤销／过期凭据或禁用账户均拒绝，不持久化，Bob 仍可写；缺行／跨账户 Session 保持 404，持有 writer lease 时即使模型授权也被撤销仍先返回 native_session_busy，不新增 event 或 preference。

公开错误码核对为 schema `400 invalid_request`、不允许的 mutation key `400 native_settings_rejected`、旧 revision `409 native_settings_conflict`、缺 Session `404 session_not_found`、writer lease `409 native_session_busy`。NativePreferences 的凭据二次检查直接保留 `401 account_unauthorized`；IdentityService authenticate／exchange 才把 401 包装为 `unauthorized`，本次差异没有改变这一点。首轮两项员工7夹具把直接 service 错误码误写成包装后的代码，保留 7／9、两项失败及原输入；仅修正新夹具为既有 ACCOUNT_ERROR_CODES 后通过，没有修改 root 断言或生产错误码。

只读检查了 root 已完成的 `tests-v3.json`／`coverage-v3`：16／16、0 skip／todo，三目标四项逐文件 100%。这属于 root 当时固定依赖输入下的源码专项，员工7没有重跑 root 文件；后来 package／lock 等依赖变化，不能把 v3 的 100% 自动当作新依赖或完整云端 quality 验收。三目标当前摘要仍与 root v3 相同：browser-auth `88c09a921597ea891c8d3851e7152ecbbd723ed0c0e8f3ec57490936b10d0fcf`，trusted-account-ui `d1898ba9c3c998109cef3ff3703e9f0fa94ab39fad0a0bea79c17116fc70cd06`，native-preferences `124b6f4233c1e7ee7d8ca34bc4755ea3338e0c86841194afd1a8146716f8959a`。三个 root 测试也未修改。

新的私有证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/auth-review-20261009-_eoewhm_`，权限 0700，最终以 `review-result.json` 分项结果为准：父轮 9 项通过但五个依赖输入在运行中变化，保留为 `invalidated_by_input_change`；`verified-01` 重跑仍 9／9 PASS，530 个监控输入仅 static adapter `cloud-static.mjs` 变化，整体原报告继续保留失效标记。Vitest 不导入该静态 adapter，除此之外的 529 个监控输入前后及报告后均一致；再在 `static-01` 对新版 official mapper 单独生成配置、执行专项 lint／发现，二者退出 0，其 10 个记录输入前后一致。没有重写原摘要或把任一失效报告改成全部固定通过，`sourceAcceptance=false`／`qualityGateGreen=false`，门槛不变。

官方完整 `tsc -p tsconfig.power-evolve.test-host.json --noEmit --incremental false --composite false` 两次退出 2，诊断来自 `employee5-legacy-import.spec.ts` 引入的新 legacy-import 声明输出缺失及后续类型错误，原日志保留。额外只以员工7文件为 rootNames、保持官方 options／references 的补充 program 退出 0，但实际读取 168 个现有 lib declaration，明确不是独立 source-plane 或全量类型门禁通过。全量类型 program 还包括当前 530 集合外的其他员工测试，不能把其诊断视为全部 program 已固定。没有自行构建、修改其他员工文件或共享门禁。

证据范围必须保留：root 的 IncomingMessage 无 URL 用例只是直接 API 单元测试；HTTPS origin 配置测试仍使用 HTTP listener，只证明 Set-Cookie Secure 等 header 语义，未建立 TLS handshake 或浏览器 cookie 存取／发送。root 和员工7的两 Host listener 都由 adapter 直连真实 IdentityService／隔离 PG，没有启动正式 Host／Platform Profile，不能冒充真实 2＋2 部署、原生浏览器或完整 Profile 验收。本切片只读了 root 私有证据，没有修改其内容或停止共享服务。

## Skills 104 项固定输入历史结果

此前按详细覆盖补充 27 项真实失败／并发／恢复行为，两个完整 Skills 文件最终 104 项全部通过，原 77 项名称全部保留，两项 CRC 回归通过，0 failed／skip／todo；当时 33 个记录输入的前后摘要一致。类型、专项 lint、发现检查均退出 0，逐文件四项 100% 覆盖门槛仍未通过。该轮证据为 `coverage-expansion-20261009-_c0x_kx0/verified-01/report.json`，旧 77 项与 CRC 历史证据全部保留；后续依赖输入修改不改写这份历史记录。

## 覆盖扩展：104 项固定输入复核

从上一轮 `final-freeze-01/coverage/coverage-final.json` 的实际缺口选择能独立验证的行为，增加文件测试 11 项、真实 PG 测试 16 项，现为文件 78 项＋PG 26 项。所有新增用例使用真实组件和自己拥有的夹具，没有替换 parser／文件系统／PG 服务、伪造 catalog 摘要、空断言、skip 或扩大超时。

- YAML 元数据按实际 Unicode code point 验证：80 字符名称、500 个非 BMP 字符说明和允许的内部 tab／CR／LF 精确保留；81 字符名称、501 个非 BMP 字符、1001 字符说明及控制／DEL 字符拒绝，原文件字节不变。
- 已发布包的根符号链接、普通文件根和占据预期资源路径的真实 Unix socket 均拒绝；原树及 socket 不被读取后替换或修复。
- 两个 genuine HTTP 上传在真实 PG 账户行锁上同时等待提交，释放后同一 bearer 只成功一次，另一次为 `401 invalid_upload_ticket`；只有一个版本、一张已消费票据，staging 清空。另两项先确认上传已解包并等待锁，再在同一数据库事务令票据过期或账户禁用，拒绝提交且不消费票据；Bob 的独立上传正常。
- 相同／不同 requestId 的并发内置安装在真实锁等待后均幂等复用一个已验证包，分别绑定一个／两个回执；catalog 投影正确，跨账户和改版本重用回执拒绝，不同回执的第二个 ID 不能被上传占用。
- 模拟发布后 PG 提交前遗留的完整目录可复用，资源 inode 和字节保持；损坏遗留目录为 `503 skill_package_unavailable`，保留损坏字节、不提交、不消费票据。真实 builtin Word ZIP 经普通用户上传后保留 `sha256:` 版本，不可冒领 pinned 版本；preset 保留私有文本名称冲突，真实容量错误继续向调用者返回。
- 真实 fflate ZIP 的压缩数据被破坏且外层上传 SHA256 与坏字节匹配时，Node inflateRawSync 独立确认压缩流无效，上传转换为 `400 invalid_skill_package` 并清空 staging、不提交、不消费票据。
- 在隔离数据库中将已提交 manifest 损坏为超限、非法 JSON、错误 archive、缺少 SKILL.md、不安全路径或 instruction digest 漂移，同时更新存储摘要，当前私有读取仍拒绝；在损坏前已受理的真实 TaskStore grant 也拒绝。磁盘 manifest、原说明和外部 sentinel 保持原字节；恢复原 PG 记录后两种读取均正常。

最终完整含覆盖运行 104／104 PASS、0 failed／skip／todo，Test Host 类型、两个文件官方 cloudLintConfig 专项 lint、inventory／declarationErrors 均退出 0；含覆盖命令退出 1，只因下表仍有 100% 缺口。`report.json` 为 `coverage_failed`，`inputAcceptance=true`、`inputsChanged=[]`、`missingPreviousCases=[]`、`sourceAcceptance=false`。33 个前后固定摘要包含两个测试、cloudFixture、七个目标模块、调用到的账户／TaskStore／identity／file 模块、native Skill provider 源码、锁、TS／Vitest 配置及官方检查脚本；七个目标源码与上一轮明确冻结版本一致。没有运行部署生命周期命令，PG 仅由 cloudFixture 创建／销毁独立随机数据库，未停止运行中的共享服务。

最终证据目录：`/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/coverage-expansion-20261009-_c0x_kx0/verified-01`，权限 0700。包含前后输入、完整 tests JSON／log、types／lint／discovery、官方映射 lint 配置、原始覆盖、逐项 `coverage-gaps.json` 和总记录。父目录保留首轮 98 项检查、104 项含覆盖运行和两次单行 lint 失败，后者报告为 `static_failed`；最终以 verified-01 的静态通过和固定输入结果为准。旧 77 项、CRC 缺陷及混合输入作废证据均未改写。

## CRC 缺陷与修复后独立复核

修复前 `platform/skill-package-extraction.ts` 接受 ZIP 内 CRC32 不匹配的存储文件。最小复现位于 `application/tests/employee7-skill-files.spec.ts` 的 `ZIP rejects CRC-corrupted stored bytes rather than publishing a newly hashed corrupt entry`：用真实 fflate 生成 level=0 的单文件 ZIP，仅翻转正文的一个字节而保留 ZIP CRC；真实 unzipper 解包成功并返回改变后的 SHA256，而预期为 `400 invalid_skill_package`。上传的 SHA256 只能确认收到的 ZIP 字节，不能替代 ZIP 条目校验。主集成者已统一修复生产源码，原拒绝断言未改变；修复前 `test-verified.json/log`、`verified-inputs.json`、`report.json` 和旧覆盖文件完整保留。

本轮新增一个独立 deflated ZIP 用例，原 76 个测试名称全部保留，现为文件测试 67 项＋真实 PG 10 项。新用例用真实 fflate level=6 生成合法压缩流，正文为原 YAML 说明加 128 KiB 字节，先成功提取原 ZIP 并核对实际字节、大小和 SHA256，再仅翻转中央目录 CRC 的一个 bit。local header CRC 和压缩流保持原值，通过 Node inflateRawSync 独立确认未损坏压缩流能精确解出原正文，然后断言真实提取器拒绝为 `400 invalid_skill_package`。原正常压缩、空文件、PG 大资源解压与上传用例全部保留并通过。

在主线程通知 extraction 等价 lint 收尾及源码冻结后，独立重跑两个完整文件，77／77 PASS，0 failed／skip／todo；两项 CRC 回归均 PASS，没有发现新增明确缺陷。Vitest 含覆盖命令退出 1，唯一原因是下表仍不满足逐文件四项 100% 门槛；测试 JSON 明确为两个文件均 passed。Test Host 类型检查退出 0、官方 cloudLintConfig 专项 lint 退出 0、inventory／declarationErrors 检查退出 0。没有启动部署或修改生产实现，没有扩大测试预算。

本轮单独证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/crc-recheck-20261009-xhMhxm`，包含 `inputs-before.json`、`inputs-after.json`、`tests.json/log`、`types.log`、`lint.log`、`discovery.json`、`coverage/coverage-summary.json`、`coverage-final.json`、`coverage-gaps.json` 和 `report.json`。冻结并实际测试的 extraction SHA256 为 `e3e9394b2ca5bdc4abb64c0fa61be4d36b7653208c1cc8576b52c0634e38755d`；测试、cloudFixture、九个目标源码、Vitest／TS 配置、application manifest、pnpm-lock 前后摘要一致，`inputsChanged` 为空，旧 76 个测试名称的 `missingPreviousCases` 为空。Git HEAD 仍为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，工作区内容由这些独立摘要固定。

中断前只保存新用例和空证据目录，未启动新的专项测试进程；恢复时查询具体进程无遗留句柄。首次修复后完整运行在通知冻结的 extraction source 上执行，未与主线程重复运行套件。随后交接 QA 检测到 skills、skill-metadata、tasks 和 database 在测试结束后又被主线程修改，记录在该轮 `handoff-qa.json`；extraction 与两个测试文件摘要未改变，上一轮运行期间的稳定证据继续保留。对更新后源码在独立 `post-lint-01` 目录完成重验，仍 77／77 PASS，Test Host 类型和两个测试文件专项 lint 均退出 0，含覆盖命令仍退出 1；但运行前后 builtin-skills、report-skill-suite、extraction、skills、skill-metadata、tasks 和 database 共七个源码摘要发生变化，该轮 `report.json` 明确为 `invalidated_by_input_change`，不能当作固定输入证据，不把旧版四模块结果直接作为修改后的验收结果。

主线程随后确认批量 application 样式清理已结束，并发来「全部7个目标源冻结」通知。员工7暂停期间没有新开套件；收到通知后，在独立 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/crc-recheck-20261009-xhMhxm/final-freeze-01` 目录完整执行最终 77 项及静态检查。结果为 77／77 PASS、0 failed／skip／todo、两项 CRC 均 PASS；Test Host 类型、两个测试文件专项 lint、发现检查均退出 0。含覆盖命令退出 1，报告状态为 `coverage_failed`，只因四项 100% 仍有缺口；没有行为失败或输入变化。

最终 `inputs-before.json` 与 `inputs-after.json` 记录两个测试、cloudFixture、七个目标模块及额外 tasks／database、Vitest／Test Host 配置、application manifest、锁和官方 lint 配置，全部前后 SHA256 一致。`report.json` 中 `inputAcceptance=true`、`inputsChanged=[]`、`missingPreviousCases=[]`，仍保留 `sourceAcceptance=false`；这里不把覆盖失败转为验收通过。最终 extraction 摘要仍为 `e3e9394b2ca5bdc4abb64c0fa61be4d36b7653208c1cc8576b52c0634e38755d`。当前覆盖、逐项缺口、日志与发现结果均在 `final-freeze-01` 下，原缺陷失败、首轮修复复核及中间混合输入作废证据全部保留。已完成授权的员工3协调，未向主集成者自动发送任务消息。

## 修复前执行记录（历史证据保留）

Node v24.19.0；Git HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，工作区为正在集成的迁移源码。最终两文件 76 项：文件测试 66 项中 65 通过、CRC 回归 1 失败；真实 PG 测试 10 项全部通过。覆盖执行退出 1，原 100% 门槛未降低、未扩大测试预算、未修改失败预期、无 skip／todo／only。最终测试、目标九个源码文件、Vitest 配置、Test Host 配置和 pnpm-lock 的前后 SHA256 一致，`report.json` 的 `inputsChanged` 为空。

`pnpm exec tsc -p tsconfig.power-evolve.test-host.json --noEmit --incremental false --composite false --pretty false` 退出 0，最终日志 `types-verified2.log`。官方 `cloudLintConfig` 生成的临时配置仅存在员工7证据目录，使用 `pnpm exec tsx scripts/run-oxlint.ts --config <employee7>/oxlint.json --tsconfig tsconfig.power-evolve.test-host.json <两个员工7测试文件>` 退出 0，日志 `lint-verified2.log`。只对自己的测试做过 lint 自动格式修正；TS 对数组索引的要求通过显式夹具检查处理，没有 `as unknown` 或新 `any`。

专项命令为 `PE_TEST_DATABASE_URL_FILE=<既有私有连接文件> pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts <两个员工7测试文件> --coverage --coverage.reportOnFailure`，通过七个 `--coverage.include=products/power-evolve/application/src/platform/<文件>.ts` 限定下表诊断源码，`--coverage.reportsDirectory=<employee7>/coverage-verified`，JSON 报告为 `test-verified.json`。该过滤是员工7专项诊断，不是全量云端 source 验收入口；完整 cloud-check source／native-provider／coverage 检查仍必须按最终整合输入执行。

首轮 65 项中 6 失败保留在 `test-first.json/log`：5 项为员工7夹具错误，将非 UUID workerId 修正为 randomUUID 后通过；另 1 项为 CRC 缺陷。中间类型／lint 失败及修复日志均保留；最终静态检查只以上述 verified2 日志为依据。

证据目录：`/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7`，目录权限 0700；总记录 `report.json`，最终输入 `verified-inputs.json`，专项结果 `test-verified.json/log`，覆盖原始数据 `coverage-verified/coverage-summary.json` 和 `coverage-final.json`，每个未覆盖 statement／function／branch 的 ID 与源码位置完整登记在 `coverage-gaps-verified.json/md`。数据库连接仅经 `PE_TEST_DATABASE_URL_FILE` 指向既有私有文件，未记录或打印连接信息；cloudFixture 每项创建并销毁独立数据库和随机临时目录，未操作共享 Docker／k3d，也未触碰真实用户数据。

## 逐文件覆盖缺口

指标按 lines／statements／functions／branches 排列，四项要求均为 100%。以下为最终 `coverage-expansion-20261009-_c0x_kx0/verified-01` 固定输入 104 项专项的实际覆盖；不是与其他员工测试合并后的全量覆盖结果。未覆盖数量对应原始 statement／function／branch 记录，branch 记录可含多个未命中的计数。旧 77 项及更早覆盖原始文件保留。

| 源码 | lines | statements | functions | branches | 未覆盖项数量（statement／function／branch） |
| --- | ---: | ---: | ---: | ---: | --- |
| builtin-skills.ts | 97.01% | 93.75% | 100% | 87.50% | 5／0／6 |
| report-skill-suite.ts | 100% | 95.38% | 100% | 85% | 6／0／9 |
| runtime-skills.ts | 100% | 100% | 100% | 100% | 0／0／0 |
| skill-package-extraction.ts | 97.27% | 94.73% | 100% | 93.93% | 7／0／6 |
| skill-package-manifest.ts | 100% | 98.36% | 100% | 96.87% | 1／0／1 |
| skills.ts | 96.07% | 91.68% | 100% | 86.06% | 42／0／40 |
| skill-metadata.ts | 96.55% | 96.87% | 83.33% | 93.33% | 1／1／2 |

相对旧 77 项，Skills 的行／statement／function／branch 从 89.21%／85.14%／98.30%／75.54% 提升为 96.07%／91.68%／100%／86.06%；metadata 的 branch 从 73.33% 升至 93.33%，manifest 校验的 branch 从 90.62% 升至 96.87%。七模块合计额外覆盖 29 行、36 个 statement、1 个 function、42 个 branch 计数。

`builtin-skills.ts` 的部分 schema／元数据一致性拒绝分支位于固定 catalog 摘要验证之后，不能仅篡改私有副本就到达；没有伪造 catalog 或替换摘要。`skill-package-extraction.ts` 尚缺维护库提供非法 offset、读取期间截断及非预期 stream 建立失败等分支。`skill-package-manifest.ts` 的剩余项为文件通过 stat 后在读取中增长。`report-skill-suite.ts` 尚缺特定 lstat／cleanup／源文件在验证后变化分支。`skill-metadata.ts` 尚缺 watch=false invalidate 回调和 Provider 非 PlatformError 异常转换；真实取消、说明边界和控制字符已覆盖。`skills.ts` 仍缺配置无效、部分内置历史升级／冲突、账户锁后受理记录被破坏、验证与资源打开之间的真实文件竞争等分支。逐项 ID／计数／源码位置完整保留于新的 `coverage/coverage-gaps.json`；这些分析不豁免门槛，由生产拥有者判断是否仍需补真实场景或删除实际不可达分支。

## 证明范围

真实组件为固定九包 catalog、fflate 构造 ZIP、unzipper 解包、官方 DSH FileSystemSkillProvider YAML、真实临时文件与符号链接、SkillService、TaskStore、loopback HTTP IncomingMessage 和 cloudFixture PostgreSQL。测试独立读取实际文件字节／摘要／模式，并查询 PG 元数据。这里的源码专项不证明正式构建产物、真实 Platform HTTP 路由／Loader、原生浏览器、Kubernetes 物理隔离、模型生成或 Word／PDF 实际导出，F11／F12／F13 不能据此整体关闭。

员工3已确认新文件由云端发现和 Test Host 程序自动完整纳入；员工7最终轮执行了 inventory／declarationErrors，两个文件都被 source、Vitest 和 lint 发现，声明无 skip／todo／only，最新记录在 `coverage-expansion-20261009-_c0x_kx0/verified-01/discovery.json`。已完成授权范围内的员工3门槛与冻结协调，没有向主集成者自动发送任务消息。两个测试文件现已冻结；七个目标模块及 33 个记录输入已完整重验，后续仍须取得全量云端检查证据。

## 主集成者待处理

1. CRC 缺陷已在上文固定 source 摘要上独立确认修复；原 stored 拒绝断言和新增 deflated 拒绝断言均已通过，保留全部历史失败证据及两项回归。
2. 按逐项缺口完成真实覆盖或删除实际不可达生产分支，并重新取得逐文件四项 100% 全量证据；员工7没有豁免任何未覆盖项。
3. 继续 F11／F12／F13 的真实 Loader／Platform 路由／原生页面、正式产物、Cloud 执行和 Word／PDF 导出验收；这些尚未由员工7源码专项证明。
