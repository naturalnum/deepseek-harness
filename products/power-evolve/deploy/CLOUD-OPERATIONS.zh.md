# 当前原生云端部署、备份恢复与回退

本指南适用于 `cloud-native` Schema 12／89 表、共享 Host 与可信 Platform，以及按账户分配的完整原生 gVisor Runtime。部署资格和实际验收结果见[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)与[验收记录](../TRIAL-CLOUD-MIGRATION-ACCEPTANCE.md)。本文命令和路径均为参数模板，使用前替换为已审阅部署的实际私有引用。

## 固定部署输入

检查点绑定已提交源码、锁文件、构建 manifest、不可变应用镜像 ID、Runtime 和 Sandbox registry digest、Schema 1–12 SQL／manifest、部署文档摘要、Profile 所有者与进程出生身份。官方祖先为 `dsh-v0.2.1-alpha.1`；[baseline.json](baseline.json)不替代当前运行版本及其数据检查点。

Host 和 Platform 使用不同的具名 Profile、`dshHome`、服务 UID 和私有挂载。只有 Platform 接收数据库、provider、Kubernetes 和存储权限。每个账户 Runtime 使用自身可撤销 bearer、独占持久原生 Profile 与逐代启动记录；账户代码在 gVisor 中运行。Runtime 镜像与独立执行 Sandbox 镜像分别固定 digest，不能互换。

通过 [cloud-image-context.mjs](cloud-image-context.mjs) 在仓库外冻结源码，并执行真实 Linux 冷构建。从该应用镜像导出完整 `sandbox-payload`，在独占 context 构建 Sandbox，保留源码、导出文件和镜像的关联清单。源码存在、健康 200、Profile ready、PVC Bound 与 RuntimeClass 对象均不能替代真实执行和停止证明。

部署 JSON 字段、私有配置及镜像入口见[部署工具](README.zh.md)。改变部署文档摘要须使用新的独立 `dshHome`；不得改写归档 Profile 的 owner、ready 或锁。账户持久 Profile 由原生 Loader 管理，Runtime 代次只重绑定准入身份与控制配置，不重置用户插件及设置。

## 存储与 Kubernetes 前置条件

| 输入 | 要求 |
| --- | --- |
| 自有 Namespace | 与 Runtime pool 及执行配置一致；不复用其他部署的对象或权限。 |
| `power-evolve-runner` ServiceAccount | 在执行 Namespace 内存在，`automountServiceAccountToken:false`；不授予 Platform 的控制权限。 |
| PV／PVC | 核对 claimRef、volumeName、Namespace、Bound、节点实际路径、subPath 与目标字节；本机 hostPath／Retain 的 `ReadWriteMany` 不证明跨物理节点共享。 |
| Sandbox CRD／控制器 | `agents.x-k8s.io/v1beta1` Sandbox 可由真实控制器推进至实际 Pod；检查可用副本、节点资源与调度状态。 |
| gVisor | 节点实际配置 runsc／shim，并可运行 `runtimeClassName:gvisor`；保存实际容器运行时证据。 |
| 控制与网络 | Platform 使用其受控 Kubernetes 身份；账户 Pod 不投射 ServiceAccount token、数据库或 provider 凭据。按实际访问路径核对账户鉴权与网络约束。 |
| Office parser | 启用时另满足[离线解析器指南](office-runtime/README.zh.md)；其 RuntimeClass 不替代执行 Sandbox 的 `gvisor`。 |

六个持久根物理独立，并与两个归档 Profile 分开。备份纳入全部条目、空目录、旧技能版本、孤儿附件、未发布字节和 crash staging；保留实际 UID/GID、mode、同根硬链接及 symlink 文本，不跟随 symlink。私有配置及附件根禁止 symlink。

| 根字段 | 保留内容 |
| --- | --- |
| `privateConfig` | 凭据配置、签名／加密材料及原 journal key |
| `workspaces` | 项目文件、权限和持久内容 |
| `homes` | 用户 Home、账户 `.native-runtime` Profile 与持久文件 |
| `skillPackages` | 实际技能包、全部历史版本与持久内容 |
| `attachments` | 原始字节、孤儿文件与 crash staging |
| `officeCache` | 已持久化的 Office／PDF 缓存 |

`nativeIntentKeyFile` 指向 `privateConfig` 内实际使用的 0600 常规 journal key。恢复和重绑定保留其相对路径及全部字节，不生成替代 key。服务普通 UID 必须能够遍历其实际挂载父目录；只能对已授权、具名工作副本记录必要的所有权适配，不能递归改写业务树或 immutable digest 树。

## 从运行实例取得停写检查点

1. 固定当前应用、Runtime、Sandbox 和实际配置，保存全部 Host／Platform 副本、外部 peer、账户 Runtime 与执行 Pod 的准确身份。保留原数据、工程和镜像。
2. 停止新业务受理，先核对准确容器、Profile owner、部署摘要和 launcher／child 出生身份，再向其正式监督入口发送 SIGTERM。逐个等待 Host 自然退出。
3. 等待已受理执行自然结算或通过既有对账流程处理。未知外部效果只对账，不重发原输入；不删任务／writer 行，不强制 lease 过期，不伪造停止证明。
4. 正常停止每个 Platform，并保存生命周期、真实退出码、锁释放和准确父子进程消失事实。保持原 PID namespace anchor，直到停止核对与备份完成。若 PID 复用、身份不确定或显式关闭失败，停止交接并处理原问题。
5. 独立核对原账户 Runtime 与执行 Pod 的准确 UID、原容器终止状态及持久 stop proof。CLI 退出 0、Cordis dispose 或接受取消不能代替物理停止。保留 failed／unknown 事实，确认已受理运输与资源回收均结束。
6. 关闭全部同库服务连接后，由正式备份工具执行当前 Schema 和 `requireQuiescentDatabase` 检查。未停止的 native process／Runtime instance、活动 interactive grant、live writer、临时 presentation、prepared intent、活跃或不确定执行以及其他数据库连接均阻止备份。按原流程对账，不能放宽守卫或终止未知连接。
7. 使用新的私有 bundle 路径创建备份，保存退出码、manifest 摘要、全表清单、六根、两个归档 Profile 和原 journal key 的核对结果。失败的私有 staging 保留供检查。

当前启动器在正常停止后保留历史 ready。再次启动时，它自行验证 stopped 生命周期、owner、退出结果及旧父子出生身份消失后移除旧 ready；运维人员不能手工删除 ready 或锁来替代该核对。

## 独立恢复与重新部署

1. 使用检查点绑定的不可变镜像运行匹配版本的恢复工具。来源和目标为不同库名、不同普通部署角色；目标库为空，六根及两个归档目录尚不存在且物理不重叠。
2. 正式恢复核对 Schema 12 清单、全部 89 表行、定义、非内部 trigger 模式、sequence、六根、两归档目录和原 key。released／expired writer tombstone 及原 epoch 保留，历史输入、执行 frame 与 receipt 不重放。
3. 等值核对完成前不启动应用。恢复结果的 `readinessChecked:false` 与 `profilesRequireRebinding:true` 表示仍需部署验证。
4. 保留恢复快照，在另一个具名工作副本上重绑定目标 PG、存储、公共 origin、内部 Platform 地址、Namespace、PVC、固定镜像和 peer。账户 Pod 中的 Platform 地址必须实际可达，不能把 Pod 的 localhost 当作共享 Platform。
5. 渲染新的 Host／Platform 具名 Profile，按 Platform、实际 MCP peer、Host 顺序启动。核对所有副本的正式生命周期、Schema 和健康响应。
6. 在恢复目标上完成两个用户的新任务，检查模型、原生设置、插件／Skills、执行、MCP、PDF／Home、原会话读回及跨用户拒绝。按本轮验收范围检查多副本、断线和原执行停止，不能用夹具恢复结果替代业务出口。
7. 正常停止并用同一固定镜像重启，核对原账户、设置、会话及文件字节，确认未新增旧输入或外部效果重放。保存实际访问入口与部署后结果。

## 从旧 Schema 升级及回退

当前工具只备份和恢复 Schema 12。仍运行 Schema 6–11 的实例，先用该实例原不可变镜像中的匹配工具，在正常停写后生成原版本 bundle，再用同版本工具恢复到独立空目标。保留旧源、旧 bundle 和旧镜像；当前工具不能把旧包解释为 Schema 12。

在已核对等值的独立工作副本上，使用当前应用执行其支持的相邻迁移，并核对当前 Schema 12／89 表及业务出口。Schema 1–12 已提交 SQL／manifest 保持原值，不直接改版本标记，也不覆盖旧 checkpoint。

回退使用保留的旧镜像及其匹配数据，或从旧 checkpoint 恢复出的另一独立目标。不得让旧代码连接已升级的 Schema 12 库，也不执行降级。切换前先准确停止新实例并对账全部原执行；新版本产生的数据保持保全，回退不宣称它们已进入旧库。

## 正式入口模板

下面路径均为占位参数，未作为本文示例执行。容器入口已经是 `node products/power-evolve/deploy/start.mjs`；Host 和 Platform 在独立服务 runtime 中运行，不在同一前台 shell 串行等待。

```sh
node /opt/power-evolve/products/power-evolve/deploy/start.mjs platform "/absolute/operator/platform-deployment.json"
node /opt/power-evolve/products/power-evolve/deploy/start.mjs host "/absolute/operator/host-deployment.json"
```

仅在已核对准确服务身份、PID1 为正式监督启动器时使用以下停止模板。`docker wait` 后仍须核对生命周期与准确 PID 消失，不用限时自动 SIGKILL 替代正常停止。

```sh
docker kill --signal=TERM "<owned-host-container>"
docker wait "<owned-host-container>"
# 完成原执行对账后，再停止对应 Platform。
docker kill --signal=TERM "<owned-platform-container>"
docker wait "<owned-platform-container>"
```

备份 JSON 的公共字段及逐项约束见[备份与恢复](README.zh.md#backup-and-restore)。配置和 URL 引用为仅所有者可访问的常规文件，账号、token、URL 及 key 内容只存私有文件。备份 helper 须看见六根、两份真实停止 Profile 和一致的原 PID namespace，且能够保留实际 UID/GID；PG 始终使用普通部署角色。

```sh
node /opt/power-evolve/products/power-evolve/deploy/backup.mjs create "/absolute/operator/source-backup.json"
node /opt/power-evolve/products/power-evolve/deploy/backup.mjs restore "/absolute/operator/target-restore.json"
```

## 结果与限度

源码检查、镜像构建、执行、业务、停止及独立恢复分别保留实际收据，并绑定同一候选。已失败或未运行项保留原事实；历史通过不替代当前改动的验证。逐文件 100% 覆盖率不足及旧 Schema 37 全链路欠账按[已确认方案](../CLOUD-MIGRATION-PLAN.md)记录原范围、阈值与 FAILED 结果；新系统行为失败、隔离问题、数据丢失、恢复失败和未知副作用重放继续阻止交付。
