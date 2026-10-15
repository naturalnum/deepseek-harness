# 云端部署工具

[English](README.md) | 中文

## 摘要

通过具名 DSH Profile 渲染并启动 Host 和 Platform。备份已停写的当前云端数据，并恢复到独立空库与新目录。恢复数据保持停服，运维人员使用新数据库和存储路径创建部署后，另行验证业务就绪。

## 目录

- [Profile 生命周期](#profile-lifecycle)
- [Linux 镜像](#linux-image)
- [Office 解析器运行时](office-runtime/README.zh.md)
- [备份与恢复](#backup-and-restore)
- [验证](#verification)

<a id="profile-lifecycle"></a>
## Profile 生命周期

`start.mjs` 接受 `host|platform|native-runtime`、私有部署 JSON 路径及可选 `--render`。部署字段为 `mode`、`privateDir`、`dshHome`、`hostOrigin`、`platformOrigin`、`platformInternalUrl` 和 `rows`；rows 只能覆盖现有 bundle row ID。租户角色还要求 Platform 选定的 `runtimeIdentity: {userId,runtimeId,generation}`。`mode` 为 `https` 或仅回环地址的 `local-http`。路径必须为规范绝对路径，Host 和 Platform 使用不同 origin。

所有者标记将 Profile 绑定到仓库、角色和部署文档摘要。修改该文档须使用新的独立 `dshHome`。旧标记、无关 Profile、缺少精确停止证据的 ready 文件、仍活跃的旧 PID 或复用 PID 均被拒绝。`--render` 获取与启动相同的排他预留。

租户 Profile 的持久状态绑定到账户。每个池代次在 `runtime-incarnations/<runtimeId>` 下使用独立的启动预留、ready 文件和进程记录；完整原生 Profile patch 和 package 依赖持续保留。只重新绑定账户运行时、公共 origin 和 Web 服务控制行。Platform 保留原 Pod 的精确停止证据后才能准入下一代。维护中的 base 和 Web bundle 提供完整原生组合与预设。

启动器持有私有持久预留，直到观测到精确 DSH child 退出。SIGTERM 和 SIGINT 在检查进程出生身份后转发给该 child；非零退出和意外 signal 仍是失败。崩溃或生命周期未完成会保留预留。运维修复前须对账该私有记录及全部原写者；工具不会接管身份不确定的锁，也不会按端口杀进程。

<a id="linux-image"></a>
## Linux 镜像

`cloud-image-context.mjs <checkout> <new-context>` 在 checkout 外创建原先不存在的 context。工具要求固定官方 `dsh-v0.2.1-alpha.1` tag，且 HEAD 包含该基线，并记录两者版本及每个复制文件的 SHA。context 排除宿主依赖、生成产物、私有输入和 Desktop 应用源码。复制期间源码改写会使构建输入冻结失败。私有 context 保持 0700；即使调用者使用仅所有者掩码，复制的源码目录仍为 0755，文件仍保留声明的源码模式。导出的源码 manifest 为 0644。native entry 的 `lib/` 产物排除在 context 外，由 Linux 构建生成。 Runtime 镜像导出 `/opt/power-evolve/sandbox-payload`，包含源码 Dockerfile 和 Runner 文件、打包后的 STDIO 库、完整原生执行 worker 目录，以及同一 Linux 阶段构建的官方 Node PTC 进程模块。将该目录复制到独占的 Sandbox 镜像 context，并在部署配置中固定其 registry digest。

使用 `docker build --no-cache --tag <owned-image> <new-context>` 构建该 context。Dockerfile 通过 digest 固定 Node 和 PG 工具，使用签名 Debian snapshot、kubectl 发布校验和及冻结 pnpm lockfile。Linux 编译生成原生 flock addon、CLI、云端应用和 Web 资产。应用通过其真实 package 文件清单导出，缺少任何支持的相邻版本的 bootstrap SQL 或 manifest 会使导出失败。运行文件位于 `/opt/power-evolve`，入口通过具名 CLI Profile 启动 `start.mjs`。

其他运行时包使用 npm 的包文件选择规则，包括 `files` glob、嵌套忽略规则，以及没有 `files` 时的默认选择。选择过程离线执行，禁用包生命周期脚本，并使用独立 npm 配置。资源路径及符号链接不得越出源包；声明的图标和 bundle patch 必须是选中的普通文件。现有 `node_modules` 链接原样复制，不跟随目标。输出目录必须为空。该规则保留声明的 preset、语言文件和模板，无需目录白名单；它不会构建缺失的运行时产物。

使用 `host|platform <private-deployment-json>` 参数运行独立 Host、Platform 容器，分别挂载独立可写 `dshHome` 和只读凭据目录。默认 UID/GID 为 1000。Host 仅接收 worker token，Platform 接收自己的数据库及 provider 凭据。共享 PID namespace 时须使用不同服务 UID，防止通过另一个进程的 root 访问文件。备份时将六个存储根及两个已停止 Profile 目录挂载到同一 Linux PID namespace，并使用能够保留实际 UID/GID 的进程。

[Office 运行时指南](office-runtime/README.zh.md) 定义独立 runsc handler、启动网络隔离、RuntimeClass、NetworkPolicy、PVC 和私有解析器配置。在 Platform 启用 Office 转换前，须先落实该指南的节点要求。

Platform 为每个账户分配独立的 gVisor Runtime Pod，使用只读镜像、UID 1000、移除的 capabilities，且不投射 service account。只挂载现有 home 存储下该账户的 `.native-runtime` 目录及其独有的可撤销 Runtime bearer。数据库、模型、Kubernetes 和共享 worker 凭据留在 Pod 外。工作区执行使用独立的权限约束 Pod。原生 RPC 和多路流经过共享 Host 及持凭据的 Platform service proxy；账户进程复查 broker 凭据及原浏览器账户。 固定的 init container 将账户 Secret 条目复制为内存卷中仅所有者可访问的普通文件，Runtime 以只读方式挂载这些文件。就绪检查要求匹配所选 Runtime 身份、代数及 `ready: true`。

<a id="backup-and-restore"></a>
## 备份与恢复

`backup.mjs` 接受 `create|restore` 和一个绝对私有配置 JSON 路径。配置字段为 `format: 1`、`bundle`、`postgres`、`roots`、`profiles` 和 `nativeIntentKeyFile`。`postgres` 必须包含 `urlFile`、精确 `database` 和 `role`；可选 `tools` 指定绝对 `binDir`，或明确属于运维人员的 `container` 及其 `host`、`port`。Node 与 libpq 必须连接相同服务代次、数据库和角色，psql、pg_dump、pg_restore 必须与服务主版本一致。凭据只进入私有文件和 child 环境；失败诊断私有保存于 URL 文件旁。

`roots` 必须指定六个目录：`privateConfig`、`workspaces`、`homes`、`skillPackages`、`attachments` 和 `officeCache`。本切片要求各根物理独立，并使用两个独立 Profile 目录。私有配置和附件条目须仅所有者可访问；可写数据保留实际所有者和权限。来源 Profile 目录须包含本启动器的 Host、Platform 停止证据。备份纳入全部选定条目，包括空目录、旧技能版本、原始附件、孤儿字节、未发布对象和崩溃 staging。保留硬链接关系和符号链接文本，不跟随符号链接。私有配置和附件根禁止符号链接。

`nativeIntentKeyFile` 必须指向选定 `privateConfig` 根内 Platform 实际使用的 journal key。key 必须是权限为 0600 的常规文件，内容为 32 字节的规范无填充 base64url，可带一个末尾换行。备份在完整私有清单中记录其相对路径、大小和 SHA。恢复要求使用相同相对路径和原文件字节；更换 key 会使保留请求无法解密。重绑定恢复后的 Platform 时须保留此 key。

创建时预留两个已停止 Profile，拒绝其他数据库连接及活跃或不确定执行记录，并使用导出 PG 快照生成全表核对清单和 custom dump。仅接受当前 `cloud-native` Schema 14 列清单。两张临时 presentation 表 `pe_native_presentations` 和 `pe_native_presentation_entries` 必须为空；存在行时拒绝，不删除。dump 保留全部 当前全部表、canonical events、定义和 sequence，包括不可变 native input facts、执行 frame 和版本二 turn receipt 和保留的 native intent 记录。prepared 状态的保留 intent 会阻止备份；committed 和 abandoned 记录仍保留在 dump 中。原生前台执行的请求、终态结果、精确停止身份及首次停止原因均保留；活跃取消和 stopping 挂载阻止备份。定义核对清单包含非内部 trigger 定义和启用模式。Schema 6 试用数据升级前须使用原版本备份工具；旧备份包保持不变。`expires_at > clock_timestamp()` 的 native writer 会阻止备份；released（`expires_at IS NULL`）和 expired writer 行保留完整身份、token 摘要、epoch 和到期时间。备份不删除 writer 行，不重置 epoch。工具不转换 Schema 47，也不修改旧备份。已有 bundle 被拒绝，失败且未发布的 staging 保持私有供检查。

恢复在写入前验证 Schema 14 清单摘要、全部文件清单、权限及归档 journal key，再拒绝来源重叠、来源同名库、非空库和已存在目标路径。空库预检通过普通部署角色运行，包含函数、schema、外部对象、大对象、订阅及本库设置。custom dump 在一个事务内恢复，随后比对每张表的全部行、schema 定义、sequence 和选定文件。任何文件根恢复前，两张临时 presentation 表仍须为空，且不得存在 live native writer；恢复保留全部 writer tombstone，不重放 presentation。恢复失败会保留停服的部分目标供检查。

Profile 副本和私有配置属于归档快照，保留来源所有者、路径及数据库 URL。恢复不启动应用，也不自动重绑定凭据或存储。证据明确写入 `readinessChecked: false` 和 `profilesRequireRebinding: true`。使用已审阅目标配置渲染新的具名 Profile，再独立验证新任务及完整同版本系统。

<a id="verification"></a>
## 验证

定向 Node 测试使用真实进程、当前 built DSH Profile、私有临时目录、普通 PG 角色和独立数据库。PG 测试要求 `PE_TEST_DATABASE_URL_FILE`，并自行创建独立 libpq 工具容器，不操作现有数据库容器。提供该环境变量后，运行 `node --test products/power-evolve/deploy/employee4-start.test.mjs` 和 `node --import tsx/esm --test products/power-evolve/deploy/employee4-backup.test.mjs`。这些检查覆盖部署与数据恢复切片。[交接记录](EMPLOYEE4-HANDOFF.md)保留带日期的切片结果，包括覆盖率失败；[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)记录当前候选的同版本资格及 M5 状态。

`node --import tsx/esm --test products/power-evolve/deploy/employee4-schema3-backup.test.mjs` 独立检查 Schema 14 数据消费者，使用自建 PG 容器和普通来源／目标角色。它验证 Schema 2–13 拒绝、临时行保留、live writer 拒绝、released 和 expired writer tombstone 的完整 epoch、全部 当前全部表 dump 与恢复，以及在文件恢复前拒绝临时行或 live writer。七张 native input、frame 和版本二 receipt 表均包含持久夹具行；恢复后 input facts 的不可变检查仍生效。它通过当前 `initializeDatabase` 正式初始化，并拒绝 `PE_NATIVE_*_DDL` 覆盖变量。Profile 目录只包含归档夹具字节；本测试不验证正式 Profile 启动或恢复后业务任务。可选 `PE_SCHEMA12_BACKUP_EVIDENCE_DIR` 接收私有结果。

镜像验收测试要求 `PE_TEST_CLOUD_IMAGE` 指向带唯一 tag 且具有匹配 `org.power-evolve.employee4` 所有者 label 的镜像，`PE_IMAGE_BUILD_MANIFEST` 指向包含其 context 路径的私有 JSON。在该 JSON 中设置 `coldBuild: true`、新 UUID `id` 和尚不存在的仓库外 `context`，由源码测试执行 no-cache 构建。运行 `node --test products/power-evolve/deploy/employee4-image.test.mjs`；可选 `PE_IMAGE_EVIDENCE_DIR` 接收私有诊断；Docker 默认地址池不可用时，`PE_IMAGE_TEST_SUBNET` 指定独占子网。打包收据从已解包 Application 产物导出的 Platform 数据库模块读取 schema 版本，并要求该版本及全部前代的 SQL 和 manifest。提供冻结的 `PE_CLOUD_COVERAGE_INPUT` 时，分别记录 build、pack 和服务的实际 Linux 路径／源码字节。测试创建独立 PG 角色、容器和卷，验证实际 Linux flock、Profile 退出，并通过普通部署角色恢复全部行和文件。缺失镜像输入会失败，未成功的恢复 stage 保持私有供检查。
