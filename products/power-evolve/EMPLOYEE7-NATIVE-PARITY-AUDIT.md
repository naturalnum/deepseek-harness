# 员工7：当前 Native Remote parity 只读审计

2026-10-09，固定官方 `dsh-v0.2.1-alpha.1` / `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。从该 tag 的五个 `index.ts` / `types.ts` 重读，确认为 Session 19、Settings 5、Workspace 11、WorkspaceFiles 5、Account 11，共51个 Remote 方法。数字与 M0 相同不构成兼容证明；旧16同名 dispatch、旧版本历史 QA 均不计当前 pass。初始51表对应下述89输入快照；后续cancel修复及wire6由R4更新，shared fixture/search wire10由R5更新；官方SQLite/PG语义整合仍归root/员工6，未追认整表完成。本次没有修改生产、共享配置、库或已有测试。

## Search Host wire 后续核对

**R5**：提取本人 `employee7-native-wire-fixture.ts`，cancel原六项正文逐字未改；新增 `employee7-native-search-wire.spec.ts` 十项与cancel6共同16/16通过，0skip/todo。真实Context/WebServer/BrowserAgentAuth/RuntimeScope/NativeRemote及HTTP验证：空/纯空白/NUL/501 UTF-16不发Platform search；500 UTF-16正向、trim和literal原样上送、未知字段拒绝；budget/timeout/cancel失败映射；客户端断开使独占RuntimeScope实际上游HTTP连接在两秒观察上界内关闭，早于5000ms配置超时。Platform身份、queue、搜索结果及预算拒绝为明确替身；不记为真实PG预算、排名或数据库取消通过。

私有 `native-search-wire-20261009-krn2hp39/tests-delivery.json`、`input-comparison-delivery.json` 和 `report.json` 记录最终17输入及3私有配置前后稳定。专项直接source tsc、官方映射type-aware lint含type-check、fresh发现均退出0，helper进入lint。提取前R4的Node解析lint失败及中间search源码漂移、helper lint/loader失败原记录保留。本轮尚无正式Profile/浏览器，未执行覆盖验收，不替代全量source质量门槛；当前PG搜索已转入官方SQLite实现，须以员工6/root最终同一冻结cut另验完整语义。

## Cancel 修复后续核对

提取helper前，独占 `employee7-native-cancel-wire.spec.ts` 原六项在新路径下6/6通过、0skip/todo，13个记录输入前后SHA一致。实际运行Context/WebServer/BrowserAgentAuth/RuntimeScope/NativeRemote和HTTP，Platform身份、queue及ack为明确替身；不把替身queue不变称为真实PG。首轮旧路径4失败/2通过的原证据保留，未放宽六项断言。当轮Application直接source类型退出0、发现退出0；专项官方映射type-aware lint因Node builtin解析/派生error-type诊断失败；R5已另立新输入及专项通过记录，不改写当轮失败。

只读对照root保存的前三文件：native Remote新路径→Platform `sessionRequest`→`TaskStore.cancelActive(...,'current')`；旧 `/sessions/cancel`仍调用 `cancel(...,'current-or-queued')`。公共事务body与旧body除了queued fallback增加mode条件外精确相同：账号锁、actor一致性、Session锁、running优先、真实call-phase STDIO action关联活跃execution及后续链/执行取消保持原逻辑。ordinary queued选择只在旧mode执行。未发现这次cancel修复新增明确缺陷。

**R4**：员工7私有 `native-cancel-wire-20261009-s2ut3p6u/report.json` / `source-review.json`；root `private/root-native-cancel-v1/after.json`只读查看为23/23（native PG5＋原admission12＋wire6），root当轮442输入稳定。新PG5覆盖idle pending/receipt保留、running completed/aborted、empty、owner/revoke；本轮23项没有active-STDIO取消case，因此该分支只认源码保留，不称新的真实PG STDIO回归通过。后续search接线改变部分root记录输入，不能把当轮23追认为此后全部源码统一验收。

## 最可能阻碍验收的五项

1. **图片受理及读回缺失。** Host prompt 只接受 text/file receipt，image 被严格拒绝；`session/attachment` 没有 dispatch，projection 没有官方 `imageLimits`。已执行的 file 上传、模型 reader 和分支继承不能代替 image admission、模型模态检查、durable image 授权读回。
2. **原生 inbox 控制不完整。** `mode:'steer'` 拒绝，`updateQueue` 的 edit/remove/steer 均无 dispatch。初始发现的idle cancel删除queued已由R4所述新路径修复；不能用此修复代替queue/steer完整能力。
3. **stop-all archival 明确未实现。** Platform 对 `stopActivity:true` 返回503 `native_stop_all_activity_unavailable`；false/省略只允许无活跃任务的归档。官方要求停止自身 turn、subagent 后代、background jobs、active schedules 后写入归档，停止请求不必等待完成。现有 refusal 不能充当该能力通过。
4. **搜索完整语义尚未验收。** R1只证明旧raw-text版本；R5补充Host入站、错误映射和HTTP取消实测。当前PG实现已转入官方SQLite current/ranked及总额度/预算，员工6负责真实PG证据；R5使用Platform替身，不能为其完整语义、数据库服务端取消或最终同一产物背书。
5. **表面兼容的 wire/事件仍有缺口。** `assistantStream:true` 只收到 `{revision:0}`，没有 start/chunk/end帧；prompt接受但未转发 `clientTimeZone`、扩展 `clientHints`；Settings的原生conflict/rejected被通用session/conflict、arguments-invalid等代替；全方法请求/stream取消仍无完整实测，后续search专门接线不等于其他方法完成。需要同版本Host+Platform/browser的逐方法负向和取消验证。

## 判读及证据边界

表中 **①** 为当前源码路径，**②** 为实际已执行真实 PG 行为，**③** 为实际具名 Profile+Host/Platform 或浏览器，**④** 为云端不适用且源码具有能力门控/拒绝。它们分别记账，均不代表整方法 parity pass。`—` 表示未找到对应证明；`历史` 表示固定旧产物轮，不能追认为当前全部源码。PG 服务测试不是完整 Remote carrier 的 wire 测试。

- **R1**：`private/root-native-search-v1/after-tests-v4.json`：24/24，具体为 search14、commands4、native-json6；其526输入在初始89项快照核对时匹配，后续cancel/search改动已改变部分输入。只接受raw-text搜索及当轮确实执行的PG行为；结果自身声明 `wholeNativeSearchParity:false`。search.ts单文件100%不覆盖完整搜索语义/产品。
- **R2**：员工7 `native-json-review-20261009-xi6t2dv9/report.json`：auth9+NUL7共16/16、当时544输入稳定，read/projections 两个目标摘要仍匹配。覆盖隔离 PG、真实 HTTP auth adapter、原始 JSON 字节和拒绝/回滚；没有完整 NativeRemote/Profile/browser。此前“search SQL NUL 待修”已被 R1 raw-text 修复更新。root native-json 的44例包含 Office4；534输入目前有 commands.ts 一项变化，不把整轮44追认为当前统一输入通过。
- **R3**：`native-session-integrity-pg.log` 实为7通过/1失败，Workspace4通过可独立辨认；`product-native-source-coverage-bounded.log` 149/149但 coverage退出1；`native-upload-lifetime-pg-final.log`15/15。只作已执行组件行为记录；这些日志没有本次完整源码闭包证明。
- **H1**：[M2命令记录](TRIAL-M2-NATIVE-COMMANDS.md)及实际 PG/browser 留存：创建工作区、真实模型对话、fork、rename、刷新读回、raw search。**H2**：[原生上传记录](TRIAL-M2-NATIVE-UPLOADS.md)：真实浏览器 File/change、上传、reader、fork继承、重启/跨用户拒绝。**H3**：[2+2记录](TRIAL-M3-REPLICAS.md)及 `private/multi-replica-v1/` 原始请求/读回：HTTP create/prompt/page、去重、隔离、未消费排队恢复。它们对应当时正式产物；H3不是浏览器，均没有本次全部输入重建/部署证明。

**取消记号**：`U`=该方法尚未将caller signal传入Platform call，不能证明取消 PG 工作；官方无 signal 的普通写方法也不能据 U 推断已受理写入应该回滚。`S`=stream 的 delay/loop 响应 abort，但正在运行的普通 Platform call 仍依赖 RuntimeScope 超时。`F`=follow 用 abort race 及时关闭消费者，底层 read 未传 signal。`D`=不适用/未启用拒绝，未找到逐方法真实 wire 拒绝实测。search已按R5单独传caller signal，不能将U概括为整个NativeCall没有signal能力。

## Session：19方法

官方定义为 `packages/api/session-controller/src/index.ts` / `types.ts`；当前拥有者为 [Host carrier](application/src/host/native-remote.ts)、[PG read](application/src/platform/native-session-read.ts)、[commands](application/src/platform/native-session-commands.ts)、[search](application/src/platform/native-session-search.ts)、[preferences](application/src/platform/native-preferences.ts)、[TaskStore](application/src/platform/tasks.ts)。请求列省略统一 wire `{request:…}` 包装；list 实际键为 `_request`。

| 方法 | 固定官方请求 → 返回/帧 | ①当前映射及语义差异 | ②真实PG / ③运行证据 | 取消 / ④ |
| --- | --- | --- | --- | --- |
| `list` | 空 request → items summaries | `/native/sessions/list`；1000上限；agentAvailable/running按PG lease；接受cursor但不使用 | R2 list/NUL；H1、H3历史 | U；官方list有signal/yield预算 |
| `search` | query → items/hasMore | R5：Host严格trim/min1/max500 UTF-16/NUL拒绝并传signal；当前commands→官方SQLite临时index，完整PG语义待最终cut | R1旧raw search14；R5真实Host wire10为Platform替身；H1历史 | R5 HTTP→RuntimeScope取消已实测；PG预算/服务端取消另由员工6验证 |
| `create` | workspaceId/cwd/sessionId/agentPreset? → sessionId/preset? | `/sessions/create`或blank adopt；仅workspaceId/sessionId；cwd/preset严格拒绝，不能称吞参 | R2 TaskStore/NUL；H1、H3历史 | 官方无signal；当前U |
| `selectModel` | sessionId/provider/model/reasoningEffort? → selected | `/native/models/select`；仅power-evolve/off；live writer拒绝，未支持活跃Agent原生变更 | preferences5、R2授权/lease PG；H1模型选择历史 | 官方无signal；U |
| `initializeDefaultModel` | 无 → void | 无dispatch；官方Account UI仅Desktop调用该登录初始化，云账号另有持久默认 | — / — | D；Desktop条件门控，wire拒绝未独立测 |
| `modelCatalog` | 无 → default/providers/groups/failures | identity/me+models；固定off，授权模型；failures常量[]，不是多provider失败隔离证明 | 账号PG底层有；本方法wire — | 官方无signal；U |
| `canOpenWorkspacePath` | 无 → boolean | 常量false | — / — | ④云端无Desktop opener；D静态 |
| `openWorkspacePath` | path/action?/application? → opened:true | 无dispatch→invocation-unavailable；不会假返回opened | — / — | ④与canOpen=false配套；D |
| `workspacePathApplications` | path → applications[] | strict请求，返回[]；符合官方canOpen=false分支 | — / — | ④云端无Desktop关联程序；D |
| `rename` | sessionId/title → title/seq | `/native/sessions/rename`；cold event提交；live lease拒绝 | R1 commands4；H1历史browser | 官方无signal；U |
| `fork` | sessionId/atSeq? → sessionId | `/native/sessions/fork`；rpcId作幂等身份；官方buildForkSeed/exact prefix | R1 commands4；H1/H2历史browser | 官方无signal；U |
| `prompt` | sessionId/requestId/queue或steer/content/timeZone? → accepted:true | `/sessions/prompt`；仅queue text/file；images/steer拒绝；timezone/hints未转发 | R2/R3 PG；H2/H3历史 | U；官方admission前检查signal |
| `attachment` | sessionId/attachmentId → image ref/base64 | 无dispatch；file receipt服务不等价 | — / — | 缺失；不能列④ |
| `updateQueue` | sessionId/itemId/edit或remove或steer → accepted:true | 无dispatch；不能用operation cancel代替itemId mutation | — / — | 缺失；不能列④ |
| `cancel` | sessionId → accepted:true | R4更新：`/native/sessions/cancel`→cancelActive，仅running/真实active STDIO；普通queued保留；旧product route保留旧语义 | R4 root真实PG5；独立wire6为Platform替身；③ — | 业务cancel不是HTTP abort；U |
| `page` | Session/subagent address/throughSeq/beforeSeq/window → records/hasMore | `/native/sessions/page`；只session address；subagent严格拒绝；真实窗口读取 | R2，root history23旧轮；H3历史HTTP | U |
| `follow` | address/window/assistantStream? → snapshot/event/assistant-stream | snapshot+after轮询；只session；assistantStream只revision0、无presentation帧 | R2仅snapshot/after PG；完整mux wire — | F；assistant帧缺失 |
| `projections` | sessionId → baseline或null | snapshot maxMessages1取projections；仅title/modelSelection/inbox；缺失Session返回404而非null | R2真实fold/checkpoint PG；③ — | U；缺imageLimits |
| `control` | 无 → baseline/projection增量 | list轮询与JSON比较；同水位快照；不是live event订阅 | PG checkpoint有；该stream wire — | S；未测慢消费者/背压 |

额外 `$events` carrier 不是上述51之一：当前ready/added/removed/status由PG list轮询产生，未发送官方 `api-session/activity` / `api-session/error`。状态变化可能在两次轮询之间丢失；`added`补summary不能自动证明订阅activity/error的调用者等价。没有这五类事件的同版本真实订阅/取消证明。

## Settings：5方法

当前 [native-settings](application/src/host/native-settings.ts) → [NativePreferences](application/src/platform/native-preferences.ts) 只允许 `ui-settings`、`ui-settings-general`。PG锁、revision及严格字段验证确实存在；官方Profile/模型/其他namespace不由这两个namespace代替。官方 `settings/conflict` 需要ns/expected/actual，`settings/rejected`需要ns；当前 [failure映射](application/src/host/native-remote.ts)没有对应分类。官方旁事件 `settings/document-updated(ns,revision)` 未由当前 `$events` carrier 发送，跨浏览器表单刷新不能据写入返回view认定通过。

| 方法 | 固定官方请求 → 返回 | ①当前映射/事件 | ②真实PG / ③运行证据 | 取消 / ④ |
| --- | --- | --- | --- | --- |
| `describe` | 无 → writable/hasDocument/namespaces | 两个真实PG namespace，hasDocument:false；不是M0旧空配置；无独立Settings事件流 | preferences5、R2 PG底层；carrier/browser — | U；其他namespace不构成通过 |
| `update` | ns/patch/expectedRevision? → namespace view | preferences write/update；未知字段严格拒绝；stale错误wire不兼容 | preferences5、R2 HTTP adapter/PG；完整carrier — | 官方无signal；U |
| `replace` | ns/section/expectedRevision? → namespace view | preferences write/replace；仅两namespace、错误差异同上 | preferences5、R2；完整carrier — | 官方无signal；U |
| `mutate` | ns/ops/expectedRevision? → namespace view | 仅一级set/unset、最多32；官方root/嵌套路径不支持，拒绝而非忽略 | preferences5、R2单层路径/锁后撤权PG；carrier — | 官方无signal；U |
| `openSettingsDocument` | 无 → opened:true | hasDocument:false；nativeSettings未知mode返回403，再映射forbidden | — / — | ④云端无Host本地编辑器；D，取消/拒绝wire未测 |

旁接口 `credentials/describe` 恒configured:false/writable:false和 `agentPresets/list` 恒presets:[]不在这51项中：在部署明确不提供该能力时可以表达空目录；当前没有逐能力descriptor/wire证明，不得把这些空结构推为官方Profile凭据/预设完整兼容。

## Workspace：11方法

当前 [Host carrier](application/src/host/native-remote.ts) → [NativeWorkspaceRead](application/src/platform/native-workspace-read.ts) / [layout](application/src/platform/native-workspace-layout.ts)。所有写入保持本人PG状态；directoryPicker相邻接口不计入本表11方法。

| 方法 | 固定官方请求 → 返回/帧 | ①当前映射及差异 | ②真实PG / ③运行证据 | 取消 / ④ |
| --- | --- | --- | --- | --- |
| `create` | path → workspace/created | adopt既有本人云目录；rpcId幂等；无Host物理目录映射 | R3 Workspace4；H1历史browser | 官方无signal；U |
| `initializeDefault` | 无 → workspace或undefined | baseline找/workspace；缺失返回undefined，未执行官方ensure默认注册流程 | baseline PG底层；本方法wire — | U；不能用空值假定初始化完成 |
| `rename` | workspaceId/title → workspace | `/native/workspaces/rename` | R3 Workspace4；③ — | 官方无signal；U |
| `delete` | workspaceId → deleted:true | 注销注册保留文件/历史；重注册恢复 | R3 Workspace4；③ — | 官方无signal；U |
| `insertBefore` | workspaceId/beforeWorkspaceId? → workspaceIds | PG本人完整顺序，anchor验证 | R3 Workspace4；③ — | 官方无signal；U |
| `insertSessionBefore` | workspaceId/sessionId/beforeSessionId? → workspace | PG同Workspace成员/anchor验证 | R3 Workspace4；③ — | 官方无signal；U |
| `archiveSession` | sessionId/stopActivity? → archivedSessionIds | 普通归档；active拒绝；true返回503；活动列表并非官方全部四类 | R3只普通归档/active拒绝；③ — | 缺stop-all；不能列④ |
| `unarchiveSession` | sessionId → archivedSessionIds | PG恢复归档成员 | R3 Workspace4；③ — | 官方无signal；U |
| `pinSession` | sessionId → pinnedSessionIds | PG置顶，archived拒绝 | R3 Workspace4；③ — | 官方无signal；U |
| `unpinSession` | sessionId → pinnedSessionIds | PG移除置顶 | —；Workspace4未调用unpin，不能沿用整文件pass | 官方无signal；U |
| `follow` | 无 → baseline/upsert/remove/order/archived/pinned | 至少1秒baseline轮询；全量upsert及集合差异帧，非registry即时事件 | R3 baseline底层；完整stream wire — | S；瞬时变更/背压/断流未测 |

## WorkspaceFiles：5方法

当前 [NativeFileRead](application/src/platform/native-files.ts) / [FileService](application/src/platform/files.ts) / safe-posix是真实storage调用，不是空文件模拟。但本次未发现直接覆盖NativeFileRead五方法或installNativeRemote/multipart/changes的已执行测试；FileService实测、附件reader或下载服务不等同于这些Remotes。云端路径收敛为本人Session所属Workspace，官方backend原本允许某些workspace外文件读；需要明确云端能力边界。

| 方法 | 固定官方请求 → 返回/帧 | ①当前映射及差异 | ②真实PG / ③运行证据 | 取消 / ④ |
| --- | --- | --- | --- | --- |
| `read` | scopeId/path/range → stat+offset/text/lines/eof | owned+FileService完整读后切行；严格UTF8/NUL拒绝；page字节cap32MiB而非官方默认2MiB | FileService PG/字节历史；NativeFileRead wire — | U；先完整读不是分页IO |
| `readBytes` | scopeId/path/options → stat+offset/Uint8Array/eof | PG/storage→base64，Host multipart bytes codec；baseFile解析；range默认/最大32MiB而非官方默认2MiB | NativeFileRead/multipart —；H2是上传/reader非此方法 | U；先完整读文件 |
| `stat` | scopeId/path → absolutePath/version/bytes? | FileService完整读求SHA；超文件cap时不能仅stat；错误details path空串 | FileService底层PG历史；NativeFileRead wire — | U |
| `list` | scopeId/path → path/entries/truncated | safe-posix超过200条拒绝；恒truncated:false是全量成功分支，非截断证明；官方默认2000可截断，symlink/other处理也不同 | FileService历史；NativeFileRead wire — | U；不是返回假空列表 |
| `changes` | scopeId/path → ready/change(version或absent) | observe后至少2秒轮询；仅目标404变absent，其他错误继续失败；非FS原生watch | observe/真实mux执行证据 — | S；ready仅轮询初始化，未测快速失效 |

## Account：11方法

官方为DeepSeek Account grant、余额/bonus、loopback登录等域。固定tag的 `ui-settings-account.apply` 在没有 `dshDesktop` 时直接返回；当前云端采用 `@power-evolve/client-account` 的settings.launcher及受信任账号HTTP页。当前carrier对下列11项均无dispatch，unary/stream默认映射 `gateway/invocation-unavailable`，没有伪造null/false/空账户。**④仅源码可确认Web/云端不适用及拒绝路径；未找到逐方法真实wire拒绝与官方Desktop门控在当前完整构建中的行为验收。**产品账号生命周期PG、auth9或真实云登录不能记为这11方法pass。

| 方法 | 固定官方请求 → 返回/帧 | ①当前映射 | ② / ③ | 取消 / ④ |
| --- | --- | --- | --- | --- |
| `getState` | 无 → AccountView | 无dispatch | — / — | D；④静态 |
| `getProfile` | client metadata → profile或null | 无dispatch | — / — | D；④静态 |
| `getBalance` | client metadata → balance或null | 无dispatch | — / — | D；④静态 |
| `getUnnotifiedBonuses` | client metadata → batch或null | 无dispatch | — / — | D；④静态 |
| `ackBonusNotified` | accountId/orderId/client → boolean | 无dispatch | — / — | D；④静态 |
| `startSignIn` | client/callbackOrigin/loginSource → AccountView | 无dispatch；产品云登录另一路 | — / — | D；④静态 |
| `cancelSignIn` | attemptId → AccountView | 无dispatch | — / — | D；④静态 |
| `hasRunningAccountTasks` | 无 → boolean | 无dispatch；不返回假false | — / — | D；④静态 |
| `signOut` | client → AccountView | 无dispatch；产品云logout另一路 | — / — | D；④静态 |
| `watchExpiry` | signal → session-expired流 | 无stream dispatch；云AccountSession独立check | — / — | D；④静态 |
| `watch` | signal → AccountView baseline/changes | 无stream dispatch | — / — | D；④静态 |

## 输入固定与交付结论

私有证据：`/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/native-parity-review-20261009-jb832w_q/`。`inputs-before.json` / `inputs-after.json`保存89个所读当前源码/测试/记录输入与10个固定tag定义的SHA256；`evidence-inputs.json`保存21个所读既有报告/日志/原始证据的SHA256；`review-result.json`记录前后漂移、精确51方法集合和既有报告当前一致性。证据目录0700，不含凭据值。本审计不是全部上游/构建依赖闭包。

初始51表的关键SHA256（全文值；完整89项见私有manifest；后续R4的13项及R5的17项摘要见独立报告）：

| 输入 | SHA256 |
| --- | --- |
| `host/native-remote.ts` | `ba51ff9346b6287679677eed9a55599549e32ab57d4f9f11cbbac5326af4470f` |
| `platform/native-session-search.ts` | `ad75b4ad623bd8e3cf92fdacb6202e2950c81658638f4df5414751affdf7aebf` |
| `platform/native-session-read.ts` | `96710e0db5515acce8a6e543e4019f21892b157296f259301e527fdeba5f135f` |
| `platform/native-projections.ts` | `0000ad0c8473935efb233906714f39a6c8da050985ae67543376a7ba0705672a` |
| `platform/native-workspace-read.ts` | `be520696e513ace6c621b2c2a55431aab350a1aecc054e17211c56069fc0e41b` |
| `platform/native-files.ts` | `bbc5e8438737d8c181490fa86f39f7ac82cba020ea651528663189ac4063fe12` |

51方法均有逐行请求/返回/事件/取消去向；已执行PG与历史Profile/browser范围分别标注。**当前完整native parity、搜索parity、完整质量门槛均未通过。**后续需要以最终同一输入及正式产物完成缺失功能、原生Remote wire错误/参数/取消测试、适用浏览器路径与事件流验收；不以同名case、历史执行、拒绝未实现功能或常量空值替代。
