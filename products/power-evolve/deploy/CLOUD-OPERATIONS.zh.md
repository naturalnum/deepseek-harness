# Schema 6 部署、备份恢复与回退

2026-10-13，Asia/Shanghai。适用当前 `cloud-native` Schema 6／82 表、核心框架、MCP 与 `builtin.pdf`。延期功能的数据库、文件及技能历史完整保留。执行前须以[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)中的实际候选和检查结果为准。

此前固定 Main 的真实模型 M5、完整恢复和同 CID 正常重启已获 Root 接受。接口目录同步后的最终 Main 已通过原三项产物检查和一次完整八项业务回归，产品运行源码 312 份及原恢复／启动脚本保持原值，整体迁移仍待 CI 和交付收口。固定版本及分项限度见[验收记录](../TRIAL-CLOUD-MIGRATION-ACCEPTANCE.md)。准确部署引用和日常操作指南单独私有交付，公共入口沿用[部署说明](README.zh.md)的 `start.mjs`／`backup.mjs`，不引用个人机器脚本。

正式恢复必须使用检查点绑定的不可变镜像ID；实际已测镜像记录在集成进度与原验收收据中。下段记录2026-10-11前一候选的专项结果；2026-10-12核心试用实例的实际放行及操作引用以最新集成进度和私有交接指南为准。前一候选的正式备份与独立恢复均退出0；82表、六根、两份归档Profile与原journal key核对一致。核对后才重绑定并启动目标；恢复后的Home环境复用、MCP及PDF生成／原生预览／跨账号隔离已有实际结果。同镜像正常重启后原用户／会话和PDF回读一致，无新增执行或模型操作；最终正常停机与82表停写检查通过。该同镜像完整恢复结果已通过独立审查。原完整源码用例2544项通过，但逐文件覆盖门禁仍失败；正式产物10份／23项复验通过。这些专项结果不表示M5完成，后续源码修改须绑定新的候选验证。

下列命令、路径和JSON均为参数模板，未作为本文示例执行。操作人员须替换为已审阅部署的实际引用。账号、token、数据库URL、kubeconfig与密钥内容保存在私有文件中。

## 操作前固定的输入

交接检查点记录匹配的源码／补丁清单、锁文件与构建 manifest、正式镜像完整 ID、Schema 1–6 SQL／manifest、部署文档摘要、Profile 所有者与出生身份，以及停写后的数据库和文件清单。官方基线为 `dsh-v0.2.1-alpha.1`，其 `deploy/baseline.json` 是上游祖先记录，产品运行检查点还须绑定本轮实际镜像与数据。

Host、Platform 使用独立具名 Profile 和独立 `dshHome`。部署文档使用现有字段 `mode`、`privateDir`、`dshHome`、`hostOrigin`、`platformOrigin`、`platformInternalUrl`、`rows`；rows 只能覆盖已有 bundle row ID。修改部署摘要时使用新的独立 `dshHome`，不能把归档 Profile 的 owner／ready／锁改写为新目标。

本轮 Linux 组合为 Platform `1000:1000`、Host `1001:1001`、备份 anchor `0:0`，共享 PID namespace；不同服务 UID 隔离凭据，anchor 具备保留实际 UID/GID 的权限。服务只挂载其各自需要的私有凭据。首次激活生成的 `extensions` 和 `.staging` 若属本次拥有、经清单确认完全为空的启动目录，可在正常停机并核对精确身份后，仅非递归映射这两个目录至运行UID／GID，保持0700；保存前后清单，其他六根内容／权限／链接不变。该具名例外不能推广为业务树递归chown。

两份实际 Profile、六根、备份 bundle、配置及 PG 工具须从该组合看见一致的物理路径与进程身份；不能把 Mac 停止 JSON 移入 Linux 当作停止证明。若使用已有 Linux 路径／所有权适配，检查点保留原始快照、已审阅映射及适配后的清单，相等结论只适用于收据绑定的来源和目标。

| 根字段 | 必须保留的内容 |
| --- | --- |
| `privateConfig` | 私有凭据配置、签名／加密材料及原 journal key |
| `workspaces` | 工作区文件、权限及实际持久内容 |
| `homes` | 用户 Home 与持久文件 |
| `skillPackages` | 所有实际包、历史版本及持久内容，不按当前 PDF catalog 裁剪 |
| `attachments` | 原字节、孤儿文件、未发布对象与 crash staging |
| `officeCache` | 已持久化的 Office／PDF 缓存 |

备份与恢复目的路径的父目录须预先创建并保持私有。恢复后的运行准备还须核对实际挂载：服务以普通UID挂载整个父目录时，该UID必须能够遍历父目录。本轮Platform整体挂载工作副本的execution父目录，使用1000:1000／0700；只设置本次新建父目录的所有者，六根、源实例和备份归档的内容及权限继续按原清单保留。

六根物理独立，并与两个归档 Profile 分开。保留文件字节、UID/GID、mode、空目录、同根硬链接及 symlink 文本，且不跟随 symlink；私有配置与附件根禁止 symlink。原 journal key 必须在 `privateConfig` 内，是原有0600常规文件；恢复和重绑定保持其相对路径及全部字节，不生成替代 key。

## 当前 Sandbox／PVC 部署前置

前一候选的恢复目标首次Home执行因自有Runner namespace缺少 `power-evolve-runner` ServiceAccount进入 `mount_creation_unconfirmed`。补齐最小、无RBAC、`automountServiceAccountToken:false` 的服务账号后，既有控制器和Cloud worker正常推进原请求至成功，没有重新提交原执行。原失败保留；该配置遗漏说明启动服务前必须核对以下资源。

| 资源／输入 | 当前实际要求 |
| --- | --- |
| 自有 Runner Namespace | 与 Platform sandbox 配置的 namespace 一致；SA、PVC及生命周期创建的 Sandbox／Service／Secret 均使用该目标范围。 |
| `power-evolve-runner` ServiceAccount | PVC 模式固定使用此名称，须存在于同一 Runner namespace；`automountServiceAccountToken:false`。补齐该资源不为 Runner 新增 Role／RoleBinding，也不承继 Platform 的权限。 |
| 既有2个PV／2个PVC | 按原清单核对各自 claimRef／volumeName／namespace 和 Bound 状态。实际 `volumeClaimName` 对应正确目标数据；Workspace、Home、Skill subPath 和节点可见路径必须指向恢复后的同一字节，并具备实际运行所需权限。 |
| Sandbox CRD与控制器 | 现行客户端创建 `agents.x-k8s.io/v1beta1` Sandbox；集群须已有 `sandboxes.agents.x-k8s.io` CRD及工作的 Agent Sandbox controller。 核对控制器可用副本及节点 DiskPressure／调度限制；节点 Ready 不表示控制器可调度。只有 CR 对象被受理不证明其 Pod 已创建或 Ready。 |
| `gvisor` RuntimeClass与节点运行时 | Cloud Sandbox 固定 `runtimeClassName:gvisor`；可调度节点须具有该 class 对应的真实 gVisor／runsc 与 shim 配置。RuntimeClass 对象本身不安装节点运行时。 |
| Platform控制通道与Runner镜像 | 使用 Platform 已有受控 Kubernetes 凭据、权限与网络访问创建／读取上述资源；Runner SA不获得该控制身份。Runner镜像来自现有 sandbox配置，在相应节点可拉取或已加载，不把应用镜像当作Runner镜像。 |

现行 PVC Sandbox 分别以 `workspaces/...`、`homes/...`、`skill-packages/...` subPath 挂载工作区、Home和只读技能；动作token由 Platform 的既有生命周期生成独立 Secret挂载，Pod仍不自动挂载 ServiceAccount token。PVC Bound、Platform健康200或两份 Profile ready都不能替代真实 CR／Pod、挂载及业务结果。原准备PV是本机 hostPath／Retain组合，`ReadWriteMany`声明不证明跨物理节点共享。

旧来源提交的正式部署 renderer 已列出 Namespace、PV／PVC及 Runner SA，且将 RoleBinding绑定到 Platform 身份；它是此处资源要求的对照来源。旧模板的两个 namespace／NFS／生产网络要求不能整包照搬为当前本机恢复配置，也不将旧 preflight结果计作本轮通过。

以下为既有 ServiceAccount字段的占位示例，未执行、未另存为部署脚本；实际只使用已审阅的自有namespace，保留既有权限范围。是否已实际补齐及后续对账结果由原操作收据确认。

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: power-evolve-runner
  namespace: replace-with-owned-runner-namespace
automountServiceAccountToken: false
```

若 Platform实际启用 Office parser，另按现有 `deploy/office-runtime/README.md`配置独立 `pe-office-offline` RuntimeClass、节点离线handler、parser缓存PVC及对应NetworkPolicy。它不能替代 Cloud Sandbox的`gvisor`；本段不要求为延期的Word／Excel／PPT另增业务验收。

## 部署与恢复的12个操作点

1. **核对已冻结来源。** 读取现有停写检查点和来源保全记录，确认实际产品、镜像、Schema、密钥与文件根相互匹配；保留原工程、原库和原文件。来源复制／Linux 适配的已完成结果使用其原清单，不重做或覆盖原始数据。
2. **核对 Linux 布局及私有引用。** 按已有部署记录确认自有 Runner namespace、固定 Runner SA、PV／PVC绑定、Sandbox CRD／控制器、gvisor运行时及网络，并确认六根、普通部署角色、PG 工具主版本、TLS 与具名 Profile 路径；配置只引用私有文件，Host 不接收 PG／provider 凭据。
3. **准备正式 Profile。** 使用已审阅部署文档渲染新的 source Profile，或复用同一摘要且具备确切停止证据的已有 Profile。`--render` 也获取排他预留；活跃、不确定或 PID 已复用时停止操作并对账。
4. **按既有顺序启动 source。** Platform 就绪后绑定既有真实 MCP peer，再启动 Host。每个服务在其独立监督容器中运行，记录实际 owner、ready、生命周期及出生身份。健康响应和 ready 文件只表示服务准备状态，不能据此推断 Sandbox Pod可创建或 Home业务通过。
5. **核对 source 普通只读回读。** 本轮 source 一次激活后，按既有记录读回原历史与业务事实；随后按第6—8点正常停止 Host／Platform／peer并执行 backup／restore。target的正常停止／重启由第12点记录。
6. **正常停止 Host。** 先核对确切容器、镜像、Profile owner 和 launcher／child 出生身份，再向该 launcher 转发 SIGTERM，等待监督进程实际退出。保留容器及 lifecycle，不能按端口或裸 PID 停止其他服务。
7. **等待原执行自然结算或完成既有对账。** 通过当前服务事实核对 Runner、Pod、挂载及外部效果已达到可停写状态；不删任务／writer 行、不强制 lease 过期、不伪造停止证明，不重放结果不明的动作。
8. **正常停止 Platform 并核对停写。** 精确发送 SIGTERM 并等待退出；在保留的同 PID namespace anchor 中确认两个 Profile 的 owner／部署摘要匹配、lifecycle 已停止、真实退出已观测、记录中的父子 PID 均不再存在。PID 复用或身份不确定阻止备份。其他副本及外部 Pod 的停止须由其既有证据证明，两份 Profile 不替它们背书。 所有服务正常停止且连接关闭后，再执行原 `requireQuiescentDatabase`；运行中的连接池会使预检拒绝，不能放宽守卫或终止未知连接。
9. **正式创建备份。** 由当前 `backup.mjs create` 核对 Schema 6／82表、全部停写条件和普通 PG 身份，使用新 bundle 路径，保存正式退出码、manifest 摘要及不可变数据／文件清单。
10. **恢复到独立空目标并先核对。** 用普通部署角色连接不同来源库名的空目标；目标六根及两个归档目录必须尚不存在且与源物理不重叠。正式 restore 完成后核对82表的行／定义／sequence、六根／两归档目录以及原密钥；未核对一致前不启动目标。
11. **准备具名工作副本并重绑定目标 Profile。** 先保存第10点的完整等值收据，再仅在已授权、具名的目标工作副本上记录必要的部署身份适配。归档配置保留旧 owner、路径和 PG URL，不能直接启动。用已审阅目标部署另行绑定目标 PG、存储、origin、现有 MCP endpoint 及对应私有文件，保留原 journal／签名／加密材料，使用新的 active `dshHome`。按 Platform→MCP peer→Host 顺序启动，记录正式 Profile与健康结果；后续发现身份适配需要时仍以已保存的完整等值收据为基线，另记适配范围与结果。
12. **完成既定恢复后业务出口。** 在目标上验证当前范围要求的双用户新对话、Cloud／MCP、PDF／Home、读回及正常重启，引用其实际用户流程收据。本轮业务、正常重启及最终停写已有实际结果，该同镜像完整恢复结果已通过独立审查；失败和未运行项按原事实保留，不能用数据恢复、ready 文件或旧专项结果填为 PASS。没有新增验收矩阵。

## 还原等值后的具名工作副本身份适配

正式 restore先按原UID/GID、mode、字节和链接完成82表／六根／Profile的完整等值核对，保存原收据与清单。部署身份适配发生在此后、已授权的具名目标工作副本上，单独记录before／after及范围；源、备份和数据库保持原值。适配后的工作副本不反向替换原等值基线或备份。

本轮只对一个具名PDF owner取得以下适配，不能推广到其他用户或所有目录。`<package-publish-root>`取现有正式配置及六根映射中的实际包发布根，`<userid>`取已审阅具名owner；这些是占位引用，不包含实际私有路径。

| 目标工作副本中的目录 | 本轮已授权身份变化 | 权限 |
| --- | --- | --- |
| `<package-publish-root>/<userid>` | mutable发布父目录，UID/GID由`0:0`映射为`1000:1000` | 保持0755 |
| `<package-publish-root>/<userid>/sha256` | mutable发布父目录，UID/GID由`0:0`映射为`1000:1000` | 保持0755 |

`sha256/<archiveDigest>`及其`skill`目录属于immutable digest树，保持原0555；文件保持原0444。immutable目录／叶子的UID/GID、字节、摘要和链接关系均保留，不递归chown，也不修改immutable叶子。整个该owner包树的比较只允许上述两个mutable父目录的UID/GID变化；部署身份适配不会修改skillloader源码。

定位依据是现行`packageUserRoot`对两个已存在父目录仍调用`realDirectory`的chmod，以及实际所有权元数据和原读取失败；现有收据未捕获EPERM syscall，不能将该源码推断当作syscall证据。原失败继续保留。适配后，该具名owner普通skillsRead返回200，原2517字节／d108…摘要保持；随后独立新PDF为30766字节，本人读取与下载同SHA。同镜像Linux原生预览、关闭重开与第二账号对已知文件四个入口的拒绝已取得结果；target正常停止／重启、旧会话及PDF回读和最终停写已取得结果，该同镜像完整恢复结果已通过独立审查。

## 正式命令与配置模板（未执行）

Profile 命令在对应正式 Linux runtime 中使用。Platform 与 Host 各自运行在独立服务容器；下面两条启动命令不能在同一前台 shell 中串行等待。镜像 Dockerfile 的入口已经是 `node products/power-evolve/deploy/start.mjs`，其容器参数分别为 `platform <absolute-private-deployment.json>`、`host <absolute-private-deployment.json>`；容器与挂载使用已有经审阅部署，不另造启动脚本。

```sh
# 在各自服务 runtime 中仅渲染（占位示例，未执行）
node /opt/power-evolve/products/power-evolve/deploy/start.mjs platform "/absolute/operator/platform-deployment.json" --render
node /opt/power-evolve/products/power-evolve/deploy/start.mjs host "/absolute/operator/host-deployment.json" --render

# Platform 服务的独立入口（占位示例，未执行）
node /opt/power-evolve/products/power-evolve/deploy/start.mjs platform "/absolute/operator/platform-deployment.json"
# Host 服务的另一独立入口（占位示例，未执行）
node /opt/power-evolve/products/power-evolve/deploy/start.mjs host "/absolute/operator/host-deployment.json"

# 从对应 ready 文件和受控网络确定健康 base URL（占位示例，未执行）
curl --fail --silent --show-error "<platform-health-base-url>/health"
curl --fail --silent --show-error "<host-health-base-url>/health"
```

Platform `/health` 返回其实际 Schema 和功能可用状态；本轮须核对 schema6 与启用的 MCP／PDF 依赖。Host `/health` 返回其服务及活动统计。保存真实响应，不能只把进程存在或某个HTTP200算为完整功能验收。

以下仅适用于已核对所有者和出生身份、PID1 为正式监督启动器的自有服务容器。Host 停止后先完成第7点，再停止 Platform；`docker wait` 后仍须核读持久生命周期和 PID 消失事实。不使用带超时自动 SIGKILL 的 `docker stop` 代替这条正常停止路径。当前启动器在正常停止后保留历史ready；下一次启动先核对stopped生命周期、owner、退出结果及旧父子出生身份已消失，再自行移除旧ready。停机观察器应验证这些事实及锁释放，不能要求ready提前消失或手工删除它。

```sh
# 占位示例，未执行；逐步核对，不整块直接运行
docker kill --signal=TERM "<owned-host-container>"
docker wait "<owned-host-container>"
# 在这里完成原执行对账和自然停写核对
docker kill --signal=TERM "<owned-platform-container>"
docker wait "<owned-platform-container>"
```

备份配置示例只展示公共字段，不是可直接运行的部署配置。配置与 URL 引用文件须为仅所有者可访问的常规文件；PG URL 内容不放入 JSON 或命令。`database`／`role` 必须与实际连接一致；模板中的路径和数据库名均须替换。

```json
{
  "format": 1,
  "bundle": "/absolute/checkpoint/new-backup-bundle",
  "postgres": {
    "urlFile": "/absolute/operator/source-postgres-url",
    "database": "source_db",
    "role": "deployment_role",
    "tools": {"binDir": "/usr/local/bin"}
  },
  "roots": {
    "privateConfig": "/absolute/source/private-config",
    "workspaces": "/absolute/source/workspaces",
    "homes": "/absolute/source/homes",
    "skillPackages": "/absolute/source/skill-packages",
    "attachments": "/absolute/source/attachments",
    "officeCache": "/absolute/source/office-cache"
  },
  "profiles": [
    "/absolute/source/host-home/profiles/power-evolve-cloud-host",
    "/absolute/source/platform-home/profiles/power-evolve-cloud-platform"
  ],
  "nativeIntentKeyFile": "/absolute/source/private-config/<original-key-relative-path>"
}
```

restore 配置保持同一 `format:1` 和既有 `bundle`，将 PG 引用换成独立空目标，并将六根及两个归档目录全部换成尚不存在的目标路径。`nativeIntentKeyFile` 更换根目录后仍保留原相对路径。URL 文件、bundle、来源根和目标根之间也须通过实际物理路径不重叠检查；同名来源库即使位于另一服务器也被拒绝。Node、libpq 必须访问同一服务代次／数据库／角色，PG 工具主版本与服务一致。

```sh
# 自有同 PID namespace anchor；占位示例，未执行
# 本轮 anchor UID0 只为保留文件原有 UID/GID；PG 仍使用普通部署角色
docker exec --user 0:0 "<owned-backup-anchor>" node /opt/power-evolve/products/power-evolve/deploy/backup.mjs create "/absolute/operator/source-backup.json"
docker exec --user 0:0 "<owned-backup-anchor>" node /opt/power-evolve/products/power-evolve/deploy/backup.mjs restore "/absolute/operator/target-restore.json"
```

`create` 只接受新 bundle；`restore` 不接收旧 Schema 转换或自动启动参数。 来源产品 Schema 37 的转换另需独立停写 cut、匹配原密钥、完整来源库存与物理停止证明，经签名 maintenance 和普通消费者验证；本次 Schema 6 全量等值恢复不证明旧 Schema 生产迁移完成。备份只包含其来源停写终点，后续恢复目标的新任务须另建备份。成功恢复返回 `allRowsVerified:true`、`allFilesVerified:true`，同时仍是 `readinessChecked:false`、`profilesRequireRebinding:true`；另行保存第11／12点的实际结果。

## 停写、失败保留与回退

正常停写需要两张临时 presentation 表为空、prepared retained intent 为0、服务端时钟下 live native writer 为0，并满足 `backup-postgres.mjs` 的全部 `requireQuiescentDatabase` 条件。该条件覆盖原 operations、Cloud、Connector／MCP／STDIO／保留的 SSH、挂载、Sandbox 和 Office 任务；功能延期不允许丢弃其未决历史。除正式备份连接外，源 PG 不得有其他连接。已 released／expired 的 writer 和 committed／abandoned 的请求保留原身份、epoch、时间和字节，不能删行让预检变绿。物理 Pod／Runner 停止仍须核对其既有事实。

非空目标在写入前拒绝：普通部署角色检查表外对象、函数、schema、扩展／外部对象、large object、subscription 与本库设置；目标路径也须不存在。此拒绝不是让操作人员清空现有目标的指令。正式工具在写文件前再次核对恢复后的 Schema、临时表、live writer 与全表 census；创建失败保留未发布 staging，恢复失败保留停服的部分目标和私有诊断。

遇到权限不足、PID／owner 不确定、输入漂移、密钥不符或 restore 非零退出时，保留原源、bundle／partial、失败目标、生命周期及错误记录，先定位并走既有对账。不删除锁或 ready 文件强行重用，不把 partial／dump 手工标成成功，不对原业务树整体 chown 或修改密钥以绕过核对。需要再次恢复时使用新的独立空目标及匹配检查点。

回退单位是停写后匹配的代码／正式镜像、配置／密钥及数据库／六根／Profile 检查点。先停止并对账当前写者，再恢复独立目标、核对、重绑定并按匹配版本启动；旧代码不得直接连接已升级库。数据库恢复不能撤销已发生的外部调用或文件副作用，必须保留原动作、停止与结果不明事实，继续既有对账；不能把恢复当作重放授权。本轮没有执行回退，也没有证明旧Schema bundle可由当前工具恢复。

## 相关文件与验收状态

日常操作参照[部署说明](README.zh.md)、[Profile启动器](start.mjs)、[生命周期监督器](lifecycle.mjs)、[备份恢复工具](backup.mjs)及[数据库预检](backup-postgres.mjs)。Office parser前置见[Office运行时说明](office-runtime/README.zh.md)。

[迁移方案](../CLOUD-MIGRATION-PLAN.md)拥有交付范围；[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)记录当前候选、实际检查及尚未完成的事项；[上游补丁索引](../TRIAL-DSH-UPSTREAM-PATCHES.md)记录必要SDK改动与移除条件。恢复的等值核对、恢复后业务和完整质量门禁分别保留其实际结果，失败或未运行项不能互相替代。
