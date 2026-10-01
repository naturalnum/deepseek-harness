# S2 沙盒存储绑定

[English](README.md) | 中文

## 摘要

私有存储变化时，已有 Session 可以保留 Workspace 身份。平台在恢复期间阻止新写者，并在变更绑定前要求捕获的旧 Pod 已停止的证明。

## 目录

- [挂载身份](#mount-identity)
- [准入与观察](#admission-and-observation)
- [恢复停止证明](#recovery-stop-proof)
- [验证](#verification)
- [开发备注](#dev-note)

## 挂载身份 {#mount-identity}

[SandboxManager](../src/platform/sandbox.ts) 使用平台拥有的完整[存储绑定](../src/platform/workspace-binding-types.ts)。Workspace 身份保持稳定；存储代次与挂载槽代次分别标识不同变更。槽与实例在预留、就绪、复用和停止期间保存同一绑定快照。

PVC 挂载使用 `workspaces/<rootKey>/<rootRelativePath>` 作为 kubelet `subPath`。QA hostPath 挂载只使用已登记的 `workspaces/<rootKey>` 根目录；相对目录放入 `subPath`，空路径时省略。平台根据所属元数据推导根目录。Sandbox 模板和实际 Pod 都必须保留完全一致的 Workspace、Home、Skills、token 与临时目录挂载。

## 准入与观察 {#admission-and-observation}

任何 recovering 或 blocked Workspace 都会阻止其所有者的新 Sandbox 预留与命令派发。准入依次锁定账号、Workspace、挂载槽和实例。Kubernetes 请求在这些 PostgreSQL 事务之外执行。

恢复 worker 在隔离期间负责写者清理。空闲候选选择排除已隔离所有者，使其他所有者的空闲写者可以回收。空闲回收器在账号锁内复核所有权；已开始停止 Pod 的回收器会在每次清理变更和最终释放前重新核验恢复所有权与捕获的 stopping 槽。

[ExecutionService](../src/platform/executions.ts) 通过 `observeReady` 观察已捕获的 Pod 与 Runner 身份；观察时不初始化存储。恢复隔离期间仍可查询状态和取消。新命令 POST 必须在派发前调用 `assertDispatchAllowed`。旧 Runner 上缺失执行记录不能授权通过 blocked 绑定重放命令。

## 恢复停止证明 {#recovery-stop-proof}

`stopForRecovery` 只处理持久请求捕获的目标。空闲目标要求挂载代次未变化且无存活实例。Pod 目标要求捕获的 Session、Pod UID、Runner 身份和挂载代次一致；仅有 Pod 404 不能释放挂载槽。

管理器在移除 finalizer 前持久保存 kubelet 停止证据与旧身份。槽和实例在释放后保留证据，使重启的恢复 worker 能核验同一已停止写者。租约回调在事务外验证请求；管理器已持有账号锁时，回调复用所传客户端。存储服务负责租约验证和最终绑定代次更新；参见[存储恢复](../../S2-STORAGE-BINDINGS.md)。

## 验证 {#verification}

[绑定测试](s2-sandbox-bindings.test.mjs) 在隔离 PostgreSQL 数据库上验证挂载篡改、代次变更、准入隔离、捕获写者不匹配、停止证明缺失、租约过期、证据保留及旧执行观察／取消。[交接回归](s2-mount-handoff.test.mjs) 保留现有串行写者与挂载检查。

一个组合用例使用实际 FileService 与 StorageBindingService worker 接入 SandboxManager。它验证捕获 Pod 的停止、持锁客户端内的租约检查、绑定代次更新、Git HEAD 字节保留，以及同一 Session 挂载替换目录。

共享[测试环境](sandbox-binding-fixture.mjs) 替代 Kubernetes 并提供 FileService 适配器。这些测试验证管理器决策与持久身份，未验证真实 kubelet subPath 行为。真实集群挂载和原生浏览器验收属于 C 组合验收。

## 开发备注 {#dev-note}

非权威验收跟踪：C 组合验收记录真实集群挂载与浏览器结果。
