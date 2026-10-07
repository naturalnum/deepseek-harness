# 通用 STDIO discovery 的 no-start 结案验证

## 范围与版本

2026-10-08，源码固定于 `7462845dbaec94cadb2b2bdc29d5badbaac7f2da`，schema 36。两位工程师分别实现存储服务和 Cloud worker 接线，一位独立源码审阅；Root 负责 schema、Sandbox 资源围栏、串行集成与真实 PG 验证。本记录补齐[内部 Cloud worker](TRIAL-STDIO-V2-WORKER.md)的派发前 discovery 取消，通用 STDIO 产品 Profile 仍未启用。

## 验证结果

- 当前动作租约、Cloud 执行镜像租约、原用户／Session／配置和完整任务共同约束资源写入。申请挂载、保留 UID、Ready 捕获及前一会话环境交接，在同一 PG client 和固定锁序下进行提交前后检查。取消或过期后的旧动作不能继续分配或释放写者。
- 未签发启动许可的 discovery 可以持久结案。没有原环境记录时保存 `unallocated`；准确 Ready 身份保留为 `ready_retained`；创建预留只在槽位和实例都保存匹配的原 Pod／Sandbox UID、generation、binding 及停止证据后保存 `creation_stopped`。资源事实不明时保持预留并等待对账。
- 结案回执独立于实际 Runner 结果。准备记录、原审批决定、Ready 槽位和实例保持原字节；不生成 SDK 结果或停止事实。数据库拒绝修改或删除原回执，并拒绝对已结案动作再保存启动许可或实际结果。V34／V35 原记录字节和启动迁移兼容性通过受影响回归。
- 实际 PG 并发结案只生成一份原回执。取消在资源事务持锁期间确实等待，资源写入收敛后仍不把未知创建当成已停止。Worker 在结案真实提交、返回回复被人为丢弃后，只读回原记录一次，没有环境准备、审批、启动、Runner 查询或结果写入。
- 结案后的新 discovery 可重新受理。旧 epoch、跨用户字段、缺少停止证明或两份证明不一致均拒绝；历史回执在租约释放后仍能读回，不能据历史回执获得新执行许可。

## 检查与证据

Root 严格 Application 构建、定向合成回归 102/102、真实 PG 44/44、lint、导出 JSDoc、双语配对、语法／空白和正常提交 hooks 通过。102 项由存储／Worker／资源围栏的 67 项及原 Sandbox 事务的 35 项组成；PG 44 项由新增结案与 Worker 组合的 7 项及受影响 schema／服务／租约的 37 项组成。

日志和源码摘要位于 `.artifacts/stdio-v2-no-start/SUMMARY.json`。新增实际 PG 日志 `pg-no-start-worker-final.log` 的 SHA 为 `b09972614bdcdb60ba421e2a3d60eb39d74ab874e06cbcbec9e7ff8ea5e204f7`；受影响 PG 日志 `pg-affected-final.log` 为 `afca2d6aa6418e164546c6e882537e1780d9c86da26b1f7f6ccf80b51eb8f1b6`。独立审阅核对了最终源码 SHA。失败记录保留：首轮锁测试的夹具实例名不符合 Sandbox 管理器命名要求，修正夹具后真实锁测试通过；旧 schema 版本夹具和工具命令修正另见摘要，不把失败算作通过。

本轮没有启动常驻测试服务或升级既有试用。临时 PG 数据库和 POSIX 根已清理；Docker 仍只有既有试用 Platform、PG 和本机 k3d 三个运行容器。原 O6 R8 试用保持独立 `83e46b3`／schema 33，Host 和 Platform ready。

## 未覆盖的范围

PG、身份、文件绑定、持久化和 Worker 使用实际实现；Pod、镜像及停止观测是明确替身，资源请求竞争使用受控异步门。丢回复发生在真实事务提交后的测试返回处，未模拟物理 PG 网络断连。本轮未运行真实 Kubernetes 创建／清理、原生浏览器或真实模型，不据此声明跨用户物理环境隔离或产品纵切面完成。

call 的 no-start 结案明确拒绝，直至具备原会话唯一续接。同一纵切面继续完成 call 原子受理与续接、Device journal、真实部署 pin／Node 权限和原生管理／审批入口；两用户原生 discovery／call、取消及故障恢复通过后，才启用通用 STDIO Profile。
