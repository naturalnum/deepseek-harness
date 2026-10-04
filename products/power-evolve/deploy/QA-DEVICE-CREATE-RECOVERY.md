# Device 创建回执前的真实进程崩溃验收

## 永久封存与迟到清理

2026-10-04，集成代码固定为 `dbfdbfefec32ef64d7389237848bcff703d01305`。构建后的[真实 PG／Docker 协议测试](../application/tests/device-real-docker-protocol.test.mjs)全部 9 项通过、0 跳过，约 37.6 秒；此前定向执行两个 `actual Worker death` 场景也全部通过。复用现有 PG、Docker 及[冷领取验收固定的 ARM64 镜像](QA-DEVICE-CLAIM-CLOSURE.md)，没有创建新集群、镜像或常驻服务，也没有迁移 V28 Cloud 固定试用。

两个场景都由实际 Node 子进程启动公开 Worker，在原 Docker 创建调用前或真实 create 返回后、receipt 落盘前等待。父进程核验原 journal 与 PG 后用 SIGKILL 结束子进程并等待 `close`。同一私有根启动替代 Worker，它带原请求、进程及派发获得唯一永久 no-start 回执；PG 的容器登记、启动授权、停止记录和命令结果仍为空，原命令标记不存在。替代 Worker 不 create/start 原命令，清理后原会话续接恰好一次，新 Git 任务 create/start 各一次且标记仅写一次。

创建后场景核验真实原容器仍为 `created`，替代 Worker 删除准确 ID。创建前场景先保存 missing 清理记录，关闭并重开 Worker，确认磁盘记录保留。新 Git 命令实际运行并持有新写入槽时，测试用原 create 参数注入一个真实迟到容器；Worker 删除该原身份容器，新的 slot 字节及 PG running 状态保持不变，原执行的迟到 register 被平台永久拒绝。迟到容器属于明确故障注入，不声称原 Docker CLI 或 daemon 在 SIGKILL 后继续完成。原子进程内及注入的 create 不计入父 Worker recorder，容器、PG 和文件断言分别核对其事实。

contracts/application 构建及四份 Device 源码测试的严格类型检查通过；Worker、共享写入协调和持久清理三份源码回归共 84 项通过，使用真实 FS、原生 flock、OS 子进程和 loopback HTTP，Docker／Platform 为替身。独立审查发现并修复目录 fsync 失败后的重试缺口，故障回归先 4/4 失败、后 4/4 通过；已有记录复用前重新同步，同步持续失败保留 journal 和原槽。平台既有登记查询的真实 PG 11 项在接口提交 `a99566bb9f7cc68a3b2b11fcd9b235aa2177f44b` 通过；本轮未重复执行，完整 Docker 回归覆盖其集成路径。

真实测试还覆盖正常 Git、冷领取／封存回执丢失、登记回执丢失、运行中撤销、存活进程领取重试、两用户／Device 重叠目录协调和显式二进制传输。HTTP fixture 使用真实 Device、Task、File 及审批处理实现，没有启动完整 Platform Profile、共享 Host、模型或 Electron；这组证据不代替原生客户端纵切片或桌面安装包验收。失败及结束路径等待所属子进程／Worker，按原准确容器身份清理临时资源。

复验先构建 contracts/application，设置私有 PG 配置与已有 `PE_DEVICE_TEST_IMAGE`，执行 `node --test products/power-evolve/application/tests/device-real-docker-protocol.test.mjs`。缺少镜像导致的 skip 不算验收。一次 missing 查询不能构成停止证明；已发放启动权限但没有停止事实、运行中或外来身份，以及旧记录缺少固定身份，仍保持受阻。

## 初始创建后崩溃验收（历史记录）

2026-10-04，代码固定为 `f8c4253fa25b8f3fc6affc9467203c678408e56d`。定向执行[真实 PG／Docker 协议测试](../application/tests/device-real-docker-protocol.test.mjs)中的 `actual Worker death` 场景，1 项通过、0 项跳过，最终运行约 4.7 秒。已有七项真实场景的证据仍由[冷领取封存验收](QA-DEVICE-CLAIM-CLOSURE.md)保存，本轮没有重复执行或声称通过新增后的八项全集。

### 执行与观测

使用实际 Node 子进程启动构建后的公开 Worker，并调用真实 Docker 创建容器。测试包装器在 Docker create 返回后、Worker 保存 receipt 前等待；父进程核验 journal 为 `claimed`、没有 receipt，Docker 原容器为 `created`，PG 还没有 container receipt，然后用 SIGKILL 结束该 Node 进程并等待其 `close`。

同一私有目录启动替代 Worker；它按原 name、镜像和 owner labels 找回原不可变 ID，登记该容器并保存 `Running:false`、`Status:created` 观察，结果进入 `uncertain`。审批入口核验原停止事实后结为 `closed_unknown`；Worker 删除准确容器、清空 journal，原会话续接计数为一。随后新的 Git 任务 create/start 各一次、标记文件只写一次，并完成 journal 与容器清理。原任务的禁止标记文件始终不存在；恢复没有 start 或重放原命令。

原 create 在实际子进程内执行，不计入父进程的 Docker 命令 recorder；原容器身份、PG 未登记状态和 SIGKILL 都独立断言。Recorder 只证明替代 Worker 没有 create/start，以及新任务各调用一次。HTTP fixture 使用真实 Device、Task、File 与审批处理实现；没有完整 Platform Profile、共享 Host、模型或 Electron。

### 环境与检查

复用[冷领取验收固定的 ARM64 镜像](QA-DEVICE-CLAIM-CLOSURE.md)、现有 PG 与 Docker，不创建新集群、镜像或常驻服务。测试创建独立临时数据库和私有目录，结束时等待所属子进程与 Worker，按准确容器身份清理；未迁移 V28 Cloud 固定试用。最终测试文件的 `node --check`、文档真实链接／段落／末尾换行、`git diff --check` 和正常提交 hooks 通过。独立定向 lint 命令没有匹配该 `.mjs`，不作为其 lint 已通过的证据。

复验前构建 contracts 与 application，然后设置私有数据库配置和已有 `PE_DEVICE_TEST_IMAGE`，执行 `node --test --test-name-pattern='actual Worker death' products/power-evolve/application/tests/device-real-docker-protocol.test.mjs`。缺少真实镜像的 skip 不算验收。

### 当时未覆盖范围

本例是已找到原容器的冷恢复，仍按既有登记、停止和独立未知结案流程处理；不能据此声称恢复从未发放启动许可。`claimed` 无镜像、有镜像但暂未发现容器、迟到 Docker create 及已捕获本地槽的永久 no-start 退休仍需完整实现与验收。一次容器缺失不能当作停止证明。Electron 的三个产品适配器和安装包继续按[官方桌面复用约定](../DESKTOP-COMPLETION.md)推进，尚未交付。
