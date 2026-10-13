# 私有存储与工作区绑定

V27 将稳定的 Workspace 身份与物理目录分开。`pe_storage_spaces` 保存用户归属和不可变 `root_key`；物理根仍位于既有受管理的工作区目录之下。`pe_workspace_bindings` 选择空间中的规范相对目录，`pe_workspaces.binding_generation` 保存绑定代次。Session 的 Workspace ID 保持不变，挂载槽代次另行保留。

迁移把每个旧 Workspace 登记为同 ID、同 rootKey 的 legacy space，绑定相对根并置为 ready；不创建或移动物理目录。旧文件变更回执补代次 1，旧活动挂载和 Sandbox 记录补完整绑定快照。`schemaV27` 由平台迁移入口执行；旧库恢复使用升级前备份，不对 V27 降级。

## 选择与文件访问

每用户另有懒初始化的个人空间。普通对话创建的 provisioning Workspace 元数据不出现在缺失列表；首次文件访问可完成其持久初始化。原生新建工作区默认在个人空间创建独立目录，也可选择已有非空目录，保留文件及 Git 历史。创建回执保存最初 title/target，后续换绑不会改变该请求的去重身份。

空间列举、目录分页和显式 mkdir 只访问用户拥有的空间，不创建 Sandbox。分页游标绑定空间和父目录，不能授予访问权。mkdir 先保存稳定请求意图；若目录已经创建而响应或事务未完成，重试对账同一目录，不覆盖其内容。其他 Workspace 在同一空间的相同、祖先或后代绑定根返回 `409 workspace_storage_overlap`。

FileService 与存储服务共用 SafePosix。访问以描述符验证 rootKey、绑定目录和每个相对分量，不跟随链接，不读取特殊文件。只有 provisioning 根和显式目录创建允许 mkdir；ready 根或绑定丢失时返回 503，不自动重建。缺失状态仍进入原生工作区元数据，普通对话和 Session 列举可继续读取。

原生工作区 list/baseline 只读取元数据，不探测物理目录。显式 `workspaceBindingsMissing` RPC 检测丢失并更新绑定状态，恢复弹窗调用该入口；文件操作仍验证当前绑定及目录。

文件读取在账户和绑定锁内固定目录及代次。发布可传入已有 PoolClient，避免嵌套账户锁。下载的 `readBytesInWorkspace` 可接收预期代次；变代返回 `409 file_binding_changed`。文件写回执保存绑定代次，同请求在换代后拒绝重用。

## 持久恢复

恢复请求固定 requestId、Workspace、预期代次和目标。锁顺序为账户用户、Workspace、挂载槽及 Sandbox。仍有 queued、starting、running、cancelling 或 uncertain 执行时要求先取消；reserved、unknown 或不完整身份拒绝当作无写者。接收记录与 recovering 状态在返回回执前提交，恢复请求 ID 可在刷新后的缺失列表中读取。

恢复成功的原子提交清空 Workspace 的当前恢复请求引用，历史请求回执保持不变。缺失列表只在 recovering/blocked 状态返回当前请求 ID；其他状态返回 null，包括旧 V27 记录残留的已完成请求引用。

轮询显式接收 worker identity 和租期。每次续租和提交检查请求、owner、epoch、有效期、原停止目标及当前 Workspace 的恢复请求 ID；调用方已持锁时复用其 PoolClient。free/no_writer 在 PG 内核验挂载代次和无活动实例；Pod 目标交给注入的停止服务，要求精确旧 Pod UID 和 kubelet 停止证据。证明持久化后重新验证目录、归属、重叠及代次，原子换绑并递增代次。

失败保存 blocked 回执并保留恢复 fence。同请求重试继续原目标和已有证明；blocked 状态可用新请求选择替代目标，旧 worker 无法越过新请求提交。绑定状态变化更新时间进入原生 baseline.updatedAt，沿既有 follow 刷新。

## 验证

专项入口为 `node --import tsx/esm --test products/power-evolve/application/tests/s2-storage-bindings.test.mjs`。它使用既有 PG 的独立临时库、真实描述符文件操作和真实本机 Git，测试迁移、缺失拒绝、归属、分页、mkdir 中断、重叠、代次、持久回执及租约竞争。Pod 停止回调是明确的基础设施替代；生产 UID1000、kubelet 证明、原生双用户浏览器及备份读回由集成验收提供。
