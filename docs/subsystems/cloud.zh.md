# 云端账户集成

[English](cloud.md) | 中文

[云端包导航](../../packages/cloud/README.zh.md)列出按需装配的部署组件。本参考说明它们共享的 runtime 输入；激活前提由各包 README 持有。这些组件不增加另一套 Session 实现。

<a id="account-identities"></a>
## 账户身份

runtime 包持有[账户身份及生命周期类型](../../packages/cloud/pe-cloud-runtime/src/types.ts)。`AccountId` 标识经过认证的数据库账户。`OwnerEpoch` 保留 PostgreSQL 十进制值，不转换为 JavaScript number。`InstanceId` 标识一次服务进程启动，`OperationId` 标识其处理责任可能超过请求生命周期的实际工作。

`AccountBinding` 是单个账户图的不可变可信输入。它的 lifetime signal 属于该图；取消调用者的等待不会取消图的生命周期。`AccountUse` 借用原生 Context，在调用原生工作前立即检查当前准入，并且只释放这次借用。两者都不接受浏览器 JSON 输入。

`AccountStorageKey` 是服务端派生的稳定目录键。`AccountLayout` 包含共享账户数据和进程本地可重建索引的不可变绝对地址；地址不证明目录存在，也不授予文件权限或配额。`AccountMountInput` 将该布局与精确图 binding、当前进程身份及原生 `LaunchEnvironmentSnapshot` 组合。runtime 先派生账户与项目候选地址，再由 files 核验或准备；默认项目资格和登记仍由原生 Workspace 负责。

私有原生启动适配在挂载一个原生 root Include 前，安装独立的 `ProfileContext`、启动环境和账户 binding。port 准备使用实际安装的同一个 binding。准备结束后，适配器先复查该生命周期，再将控制权交回原生 boot；调用者停止等待后，boot 与销毁仍持有实际 Promise。原生树挂载完成后，仍须通过工厂的 provider、保存及暴露清单审核，才能服务账户。

<a id="actual-work-and-capacity"></a>
## 实际工作与容量

runtime 根只登记两类必需参与者：`files` 和 `execution`。登记属于调用者的 Cordis effect，在该 effect 销毁时撤销。重复登记和缺少参与者都会使装配容量预留失败。

`ParticipantReceipt` 记录账户、epoch、参与者和证据。confirmed 收据没有待完成 operation id。unknown 收据保留待完成工作及原因；请求到期或等待失败不能证明实际工作已经停止。

本地装配和排空预留限制并发工作。装配工作结算只释放操作槽；账户驻留槽持续预留，直到拥有者在实际清理后释放。这些预留不领取数据库 owner，也不证明账户 ready。

files 根预建固定 worker 池。单账户排空保留共享池；根关闭时，worker 实际退出且持有结果释放后，才撤销服务与参与者。API 配置保存收据另行通过实际 Promise 跟踪已准入的原生写入及必要应用。配置保存不增加第三个排空参与者，失败或未解决的保存不能证明账户图 clean。

<a id="native-adapters"></a>
## 原生适配

云端请求一致性使用 [access 持有的请求类型](../../packages/cloud/pe-cloud-access/src/types.ts)。客户端账户和代际字段表达预期，不是认证凭据。原生 HTTP、流和控制器适配保留原来的传输消息及原生 Session 状态。

端点清单不会把内部 Session 适配器接入原生派发。当前原生 owner 路径跳过 remote-access policy，因此开放 Session 方法还需要接入云端项目与 Preset 校验，在原生副作用之前执行。公开 Controller 薄适配正在验证；如需增加原生扩展，先审查契约。实际派发链通过消费者验证前，账户准入继续关闭。
