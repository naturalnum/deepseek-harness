# S2 文件与产物补齐

范围来自[完整性审计](PARITY-AUDIT.md)。复用旧 PowerEvolve 的文件选择、下载、产出行、内联操作和工作区流程，适配当前原生 DSH；不另建前端。账号固定试用保持独立。四项缺口分成三组端到端流程，每组完成实际双用户验收再集成下一组。

A 组已通过[双用户原生浏览器下载验收](TRIAL-S2-BATCH-DOWNLOAD-QA.md)。B 的文件扫描、平台核验、条件发布和原生客户端产出行已集成，真实双用户验收进行中，尚未固定交付；当前须闭合内联操作及脱离原进程组的子进程清理。C 尚未实现和验收，待 B 通过后集成。

| 顺序 | 用户流程 | 直接涉及入口／可信模块 |
| --- | --- | --- |
| A 批量文件下载 | 原生 Files 多选 → 准备 → 浏览器下载原文件或 ZIP → 字节核对、隔离及取消重试 | Host、文件插件、Platform；T01/T04 |
| B 对话产物 | 真实命令完成 → 每轮产出行／内联文件操作 → 显式发布及不可变下载 → 刷新重试 | Host、产物插件、Platform／Runner；T02/T04/T06 |
| C 工作区绑定恢复 | 选择已有私有存储 → 创建会话 → 缺失绑定恢复 → 旧写者停止证明、重启及备份读回 | Host、云工作区插件、Platform／Runner；T02/T04/T06 |

B 须先固定平台核验的产出事实及其回合归属；受理回执、模型文字和 stdout 中的路径均不是已生成文件的证据。C 须先固定存储归属、绑定代次和回执；现有 Session 的工作区 ID 保持不变，未取得旧 Pod 停止证明不得重绑。两组实现时分别补全接口约定，不以 A 完成代替整个 S2 完成。

## A 请求与下载行为

浏览器安全的字段验证由 `@power-evolve/contracts/file-download` 共同维护。`filesDownloadPrepare` RPC 接收 `{ sessionId, paths }`；路径为相对于 `/workspace` 的规范文件路径，顺序保留、不得重复。返回 Session、Workspace、文件数、文件名、MIME、源字节数、响应字节数、元数据摘要和同源下载 URL。单文件下载原字节，多文件下载保留相对目录的 ZIP。

Host 内容入口为 `GET /api/powerEvolve/workspace-download`，转到 Platform 的 `GET /files/download`。查询只含 Session、路径集合和摘要；不携带凭据或物理目录。准备和下载都重新认证并核验 Session 归属；Host 只传递当前浏览器身份及有界请求、响应，文件读取和 ZIP 生成属于 Platform。无新沙盒、数据库表或持久副作用；只读准备请求可安全重复。

摘要由平台按所选路径、大小和内容 SHA-256 生成，不是授权令牌。GET 重新读取并校验整个准备清单，源变化则返回 `409 download_changed`；流式输出时再次核对每个文件字节。流开始后源变化或断连会中止响应，不交付完整 ZIP。它不承诺多文件的原子时间点快照；不可变发布继续使用既有产物服务。

协议最多 100 个文件、URL 最多 6000 UTF-8 字节，每个文件保留现有 2 MiB 上限。Platform 默认一次最多 32 个文件、源字节总量 32 MiB、单副本最多 4 个传输／单用户 2 个、60 秒超时，均为显式可配项。并发上限是每 Platform 副本的资源界限，不宣称集群全局限额。元数据准备也占槽；取消后底层读取实际结束才释放。逐文件读取及 ZIP 分块输出，禁止汇总整个 ZIP 到 Host 或浏览器内存。

无效输入／路径返回 400，未认证为 401，越权 Session／不存在文件为 404，源变化为 409，条数／大小／URL 超限为 413，传输繁忙为 429，超时为 504。响应使用 attachment、no-store、nosniff；浏览器原生下载负责传输进度与取消，产品控件可取消准备。取消或失败后重新准备并下载，本组不提供断点续传。

## A 并行所有权

| 所有者 | 文件与职责 |
| --- | --- |
| 集成者 | 共享 contracts、Host／Platform 路由与装配、所有 Profile、package.json、锁文件、构建入口；真实双用户验收与固定交付 |
| 文件客户端执行者 | `client-workspace-files/src/client/` 与相应测试；原生 Files 最小行前／工具栏插槽及其测试和文档。复用旧选择状态与 DownloadControls，以被查看 Session、tab、root 定位，关闭 tab 清理。 |
| 平台执行者 | 新 `application/src/platform/file-downloads.ts`、`download-zip-stream.ts` 与定向测试；通过现有 FileService／SafePosix 读取，不自行解析存储根。接口为 `FileDownloadService(pool, files, limits)` 的 `prepare(user, request, signal)` 和 `open(user, request, signal)`；open 返回 `{ view, body }`，body 为 Web ReadableStream。 |
| 联测执行者 | 新批量下载 Host／Platform／PG 组合回归；越权、输入、摘要变化、取消、背压、超时和两副本可重试路径。不得改路由或共享配置，由集成者接线。 |

所有执行者使用隔离分支，禁止在固定试用 checkout 改代码。仅运行相关检查，复用既有 PG 的独立临时库，不新增 Docker 容器或改固定试用数据。共享热点文件只由集成者修改。

## B 文件事实与条件发布

Runner 在命令前后有界扫描 `/workspace` 的常规文件，报告能比较的新建及内容变化版本。扫描以执行用户身份运行，不携带 Runner 凭据；不跟随链接，不读取特殊文件。扫描的范围、资源上限和不完整原因明确返回。候选是执行区间的观察，不能证明命令是唯一写入者；日志文字和路径提及不能代替观察。扫描失败不改变命令本身的退出结果，也不触发命令重放。

平台通过 Session 所属 Workspace 的 FileService 重新读取候选，核对大小和 SHA-256；拒绝越界、链接、缺失和变化的内容。核验后的 `verifiedFiles` 与执行终态、唯一续接消息在同一数据库事务保存。旧 Runner 或旧结果没有观察时标示不可用。原生 Session 日志格式不变。

`executionFiles` RPC 接收 `{ sessionId, executionIds }`，对应平台 `/executions/files`，一次最多查询 20 个执行。平台核验整组归属，返回 Workspace、执行 ID、持久工具 callId、执行状态和已存文件版本。客户端按原调用回合展示，使用被查看 Session 查询，不从全局当前会话取身份。后续续接轮可通过平台来源的执行 ID 关联内联文件操作。运行中的执行可查询状态；刷新后从持久记录恢复，查询不创建沙盒。

点击文件是显式发布操作，`artifactsPublish` 的可选 `expectedRevision` 绑定所展示的文件摘要。源内容变化返回 `409 artifact_source_changed`，不得静默发布新版本。同一请求 ID 的 Session、路径或预期摘要不同，返回 `409 request_id_conflict`；已经成功的相同请求返回原不可变产物。数据库 V26 为产物请求保存可空预期摘要，已有请求保持空值；恢复旧版须使用升级前备份，不对新库降级。

集成者维护共享协议、数据库迁移、执行结果接线、路由与 Profile；客户端执行者迁移 `client-artifacts` 的每轮行和内联动作；平台执行者维护文件核验查询及条件发布；Runner 执行者维护扫描与进程生命周期。各组独立提交后再集成。B 的出口是两个用户运行真实编程任务，看到各自已核验产出、点击发布下载并核对字节，同时验证源修改拒绝、重复发布、刷新恢复和跨用户拒绝。

## A 验收出口

两个用户各自从原生 Files 勾选文本、二进制、中文文件及不同目录下的同名文件，下载后核对条目、字节及目录。切换可见会话不改变原 tab 的归属，关闭 tab 清理选择。Bob 篡改 Alice 的 Session／路径请求被拒绝；重复准备安全，源变化拒绝，取消准备／传输后能重试。真实 PG 和文件参与核对，沙盒资源数量不因下载增加。自动测试中的 HTTP／文件替身单独标明，不能替代这组浏览器验收。
