# 本机冷重建

本入口恢复一个已经正常交接、备份并真正重启的原 carrier，不创建环境、格式化磁盘、重新分配域或清空业务记录。真实两次冷重建、启动链与模型/界面验收尚未完成，组件检查不能代替这些证据。

## 原件与存储

`captureRecoveryRoot` 读取原六文件实际 bytes、UID/GID/mode、稳定文件身份和原 `profiles/cloud/node_modules` 链接或实际缺失。缺文件、读期间变更、普通目录冒链接或旁路目标已有不同链接均拒绝。原凭据由原 credentials-local 来源与解析器管理，不生成空值或复制其他账号秘密；空 mutable profile、BOM、CRLF 和未改字段保留。

副本写入后，原采集器重新完整读取六文件及链接，对照实际 bytes、UID/GID/mode 和链接身份；文件系统静默忽略 chown 等元数据操作时即拒绝保存成功，不把稍后的 check 当作写入结果。失败保留原件和旁路文件。

`mapRecoveryConfiguration` 从当前 JSON insert 结构定位十二个确切字节范围：三个哈希、监听主机/端口、内部地址、两份数据库主机/端口、公开入口和 SDK lifecycle 地址。重复键、重复条目、缺字段或范围不匹配拒绝。新地址须来自本次拓扑实测；plan 和两层配置哈希来自本次真实测量及新文件，原件不覆盖。

`captureRecoveryStorage` 保存原 provisioner 十一 ext4 域的实际 UUID、原 loop、backing inode、文件系统几何、根权限与有效挂载选项。传入实际 installAnchor/app PID 时，还捕获确实依赖的产品只读 loop 和 arena backing 父盘；不存在的支持盘记为空，不按旧实例猜路径。恢复按产品盘、父盘、arena、十个子域排序，仅对缺失步骤接回原号并挂载，已就绪跳过。原号占用、重复 backing、inode/UUID/权限/exec 策略不符或结果未确认均停止。只检查不写任何域。

产品类型由实际挂载确定。原 ext4 全根 loop 保留原 UUID、backing、原号和块设备只读要求。原 V3 的产品目录 self-bind 须有唯一独立只读挂载、与父挂载对应的实际 source/root/device/filesystem、受保护目录的 dev/inode/UID/GID/mode，且基础与应用 namespace 的产品挂载一致、没有额外子挂载。只读 bind 不报告块设备只读，普通目录或不明来源仍拒绝。

loop 的 backing 身份使用内核给出的设备号和 inode，与原受保护镜像文件的实际身份核对；原设备号、UUID、只读位及零 offset/sizelimit 同时保留。原 namespace 消失后，`losetup BACK-FILE` 的显示路径可能改变，显示路径不代替 backing 身份。整数列从原始文本读取，避免 JSON 数字精度丢失。 carrier 缺少其他已绑定 loop 的设备节点时，只在自己的 `/run` 新建 0700 目录与 0400 临时设备别名，用原 `losetup --list` 两次只读查询 backing 设备号和 inode；offset/sizelimit/只读位从原号 sysfs 前后读取并与初次枚举对照，核 sysfs 设备号及别名身份后只删除自己创建的别名。原 `/dev`、其他实例挂载和 backing 不改写；无法确认的 loop 仍拒绝，跨号重复 backing 检查不跳过。

再次快照可显式给出 `supportSnapshotDirectory`，引用同一 resource 的原受保护快照。当前原存储检查通过后，沿其已验证产品盘、arena 父盘的规范镜像路径重捕实际身份。未给引用时，`BACK-FILE` 仅作初次定位候选；显示路径不可达或物理身份不符仍拒绝，不扫描或猜测其他路径。

V3 self-bind 还要求显式原 `productManifest:{path,sha256}`：Root 从受保护原件核正常清单，调用原 `collectManagedFiles` 比较全部已安装产品文件，并保存实际 anchor、SOURCE-PACKAGE、PRODUCT-ASSEMBLY 及原产品文件校验模块的 pins。cold 后先核同一目录身份和产品 pins，再仅对缺失 self-bind 做原 bind/remount readonly 并复核全部事实；已有挂载冲突、字节漂移或未知步骤均停止。inspector 校验器 SHA 必须同时等于实际捕获值和本次宿主控制源码，并再次核真实来源、两侧挂载和产品 pins。外部 `allow/verified` 布尔量不能代替这些观察。SDK 后端、PG 和 typed/physical 收尾继续由原 owner 及正常机制负责。

## Linux 私有阶段

`recovery.mjs` 在原 carrier 的 Linux Root 基础挂载环境运行，输入为 Root 所有、0600 的 `pe-cloud-cold-recovery-input/v1` 文件，参数只带实际文件引用和 SHA256。导入与 `--help` 不做环境 I/O。

```sh
node deploy/local/recovery.mjs snapshot --input /absolute/private-input.json --sha256 ACTUAL_SHA256
node deploy/local/recovery.mjs check --input /absolute/private-input.json --sha256 ACTUAL_SHA256
```

`snapshot` 使用新的 `snapshotDirectory`、原 `storageOwnerPath/launchInputPath` 和实际 `applicationPid`。只接受原 cloud CLI、UID2000 和独立 namespace；保存原六文件、原链接、权限和实际 hashes，并 pin 原 profile 引用的 native helper。私密副本在 `files/`，元数据在 0600 `metadata.json`，持久化文件和目录。这个配置副本不替代正常停机后的 PG dump 和账号数据备份。

快照还记录本 carrier 内处于原应用 mount namespace、或实际持有该 namespace FD 的进程 PID/startTicks/namespace 身份。重建前逐个回读，原生命周期仍在或未知均拒绝。外部 owner 的 FD、SDK 与 typed/physical 收尾继续由正常停机审计确认；本观察不宣称全内核引用已清空。

产品为 V3 self-bind 时，输入另带实际正常产品清单的受保护路径和 SHA；源码或公开配方不构成实际挂载证明。`snapshot/publish` 返回本次实际产品挂载证据，宿主 inspector 使用该来源重新观察；旧 loop 平台仍按原块设备检查判断。

`check` 对照原存储、六文件、链接、原进程身份和 mountinfo，结果只能是资源观察与 `smokeStatus:not-run/ready:false`。`prepare/publish` 仅供持原操作锁的宿主恢复入口调用，不是独立发布或资格入口。

`prepare` 还使用新的 `operationDirectory/budgetMs/addresses`；它要求 PID1 startTicks 确实改变、快照内原 namespace 引用进程的生命周期均已结束，且无另一原应用或原 launcher。内核可在旧生命周期结束后复用 namespace inode 数字，数字相等不单独否定 cold，数字不同也不能代替 PID1 与原引用终态证据。在公开输入及原资产 pins、私密来源检查通过后，准备独占的输入和 FD3/4/5 文件、接回原存储，并返回原 launcher 的 positional argv；此时未启动应用。`publish` 观察原 Docker exec 的真实 prepared PID/namespace/实测 plan，要求新 private namespace 与当前 parent PID1 namespace 不同，再创建原 HOME 目录，以旁路 writer 保留原六文件/链接，核原 FD4 inode 后只写一次原七字段 ready。原 launcher 自行执行 seal、全部原断言和 UID/caps/NNP/seccomp drop，最终 exec 原 dsh cloud CLI。两阶段通过同一 Linux kernel monotonic deadline 关联，不能续期；普通应用重启仍被拒绝。

FD4 发布前，`recovery-validation` 从实际 captured installAnchor 解析同组已安装产品，调用原 `parseRootDeploymentInput`、`parseStorageDeploymentPlan`、`parseCredentialsDocument` 和原六个 Loader Config；核三槽 plan、产品 anchor、plan/deployment/profile 哈希、原凭据路径、共享 base、provider/environmentVersion 引用。它不重写 bytes、不重新生成秘密，原 parser/schema 的拒绝只留下固定无秘密诊断并停止 ready。宿主只接受该实际校验完成后返回的 `inputsValidated:true`；此标记不是 Native/SDK 资格或完整恢复成功。

## 宿主恢复入口

原 launcher 已运行、发布结果需要复核时，可显式执行 `node deploy/local/recovery-local.mjs verify-started --input 原宿主私密JSON --sha256 原SHA`。入口只接原失败锁记录的唯一 launcher，要求原宿主进程终态；核同一容器与活 exec，再只读核原 control、ready、measurement、sealed 日志和实际六文件绑定。它不重做 prepare、create/start 或 publish，沿原生命周期保留 namespace，然后核 401 与完整原冒烟，通过才结束原锁。本次有限观察预算用于复核已经完成的发布，不延长原准备期限或旧业务操作。

续行在原锁同 inode、原 SHA 回读后，以 `wx` 原子认领与该 operation 绑定的独占 claim；已有 claim 不自动接管，原锁以 O_NOFOLLOW 打开并重核。发生失败保留原锁及 claim 的具名责任；成功在原记录持有当前续行身份后归还 claim，再按原完成流程结束操作锁。

进程枚举用原 `/dsh-tools/node24` 读取 `/proc` 条目。短进程在枚举后退出时，仅在读取和 PID 目录回读均为 ENOENT/ESRCH 时返回空条目；权限或其它错误仍拒绝。所选应用的 PID/startTicks/namespace 与完整产品实测继续由原 inspector 核对。

### 明确结束尚未启动的失败准备

`node deploy/local/recovery-local.mjs retire-prelaunch --input 私密处置JSON --sha256 SHA256` 只归档已经终态、尚未创建 launcher 的失败准备锁。输入为 `pe-cloud-retire-failed-preparation/v1`，含原宿主输入路径及 SHA、原 operation、锁的 device/inode、调用线名和不超过 60000ms 的本次观察预算。入口核原宿主 PID 已结束、原精确容器与所有已知 exec 终态；Linux 实测旧 carrier/reference 生命周期结束，只有原初始进程，原目录仍仅有 input 与空 journal/log/measurement/ready 文件。任一来源、进程或发布结果未确认仍保锁。

通过后保留原同 inode 锁的归档和实际观察回件，fsync 并回读，再移除原操作锁名；不改 PG、SDK、数据、原阶段目录或任何 ready/资格状态，不宣称资源已释放。修复后以新独立输入、operationDirectory 和预算发起正常恢复，不能重放原未知请求。

```sh
node deploy/local/recovery-local.mjs --input /absolute/private-local.json --sha256 ACTUAL_SHA256
```

输入为当前用户所有、0600 的 `pe-cloud-cold-recovery-local/v1` 文件。它包含实际 `dockerPath/socketPath/container/containerId/imageId/resourceId`、carrier 内的 `nodePath/rootEntry/rootInput/rootInputSha256`、本机 `workDirectory/stateDirectory/logDirectory`、总 `budgetMs/url/line`，以及 `smoke.credentialsPath/account/continueSession/continueMarker` 引用。这些身份来自实际原件，不能猜测。`stateDirectory` 是该 workDirectory 的 `local-state`；新交接实例无需伪造旧 latest。原生 latest 若存在，必须原 verified/release 已确认；旧 verify-intent/12、pending 或 operation.lock 均不能绕过。

宿主入口持既有候选 reservation 和独占 `operation.lock`，实际核 Engine 中的原 CID/Image，再调用 Root prepare。它直接创建并启动一次 Engine exec，使原 launcher 最终 dsh 与该 exec 保持同一 PID，随后调用 Root publish、原 inspector 和 lifecycle 独立 keeper。现有产品块设备、进程身份、namespace 和关闭预算检查保留。原 401、宿主 `deploy/smoke/check.mjs` 实际退出0及最终原进程仍一致后才报告 `ready:true`。模型只使用目标原账号经正常产品入口配置的自有模型；无模型 Native 证据与完整 smoke 分列。

Root publish 从原已捕获并核 pin 的 `scripts.steps.path` 返回 `appCheckPath`，宿主 inspector 观察并保持该原脚本路径，供原 lifecycle 使用。原脚本可以位于 `/opt/dsh-features/` 下的实例子目录；不会以旧实例顶层脚本替换它。既有 inspector 调用的默认路径保留，恢复输入 schema 不增新字段。

若实际 Engine 在一个已运行、自有 backend 内，`via` 明确给该 backend 的 `container/nodePath/relayEntry/socketPath/dockerPath`。薄 relay 复用同一 bounded transport；需正常安装公开控制源码，不创建新 Engine、端口转发或复制秘密。它不解决该目标尚缺的产品/Root/Native 资格。

## 取消、超时与责任

所有宿主步骤共享原截止时间/取消信号；Linux publish 不能重置 prepare 的单调时钟预算。创建出的每个 exec ID 在发 start 前写入私密原操作锁。取消、超时、seal/smoke 失败或未知结果停止依赖步骤，保留原锁、原 exec、新 namespace、原数据及私密日志，不重放、不强杀、不清理或提前释放 SDK 分配。只有实际成功，所有本机 child/socket/transport 真实关闭且原锁 inode 仍匹配，才删除本次锁；不改写 native latest 或发布“verified”回执。

`recovery-transport` 只连接显式本机 socket/container；Docker CLI 也固定到同一 socket。Engine 请求限该容器创建 exec、读取该容器元数据/top、指定 exec start/inspect。完整 stdout/stderr/HTTP 输出受上限约束，错误不含命令、配置、凭据或底层正文。取消对本机客户端只发送一次 SIGTERM，`close()` 等待实际本地关闭；客户端或 socket 关闭始终不证明远端 exec/业务分配已经结束。
