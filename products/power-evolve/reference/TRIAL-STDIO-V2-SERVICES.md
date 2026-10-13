# 通用 STDIO 服务实现验证

## 范围

2026-10-07，集成源码固定于 `1120d59e19`。连接管理、原子发现受理和独立审批／一次许可已实现；本记录是服务验证，不是原生客户端或执行器试用交付。原 O6 R8 试用继续使用 `83e46b3` 和 schema 33，Host／Platform 状态读回均为 ready，活动 Office job 为 0。

## 结果

- 真实隔离 PG 与私有 POSIX 测试 15/15：两个真实登录身份、不同凭据用途、并发请求去重、跨用户拒绝、发现不创建 Agent Operation、原任务／执行／回执一起提交、不同 Session 的容量竞争、准确 Device／目录／enrollment／部署绑定、独立审批和首次授权竞争。配置失效、DB 时钟过期及审批拒绝不产生新许可；尚未停止的原执行继续占用容量。
- 首次许可和派发记录已提交但回复丢失后，新服务实例查询仅返回 `grantOnce:false`；不同授权请求 ID 也不能再次取得 true，新的执行者身份被拒绝。该故障通过真实 PG 提交后注入回复丢失验证，没有执行用户程序。
- 连接与授权合成回归 43/43；Cloud capture 原事务复用及受影响的原捕获回归 75/75。授权捕获、Kubernetes、镜像和停止事实使用明确的替身，不代表真实资源或停止证明。
- 严格 Application 构建、Root 新接口／受理源码的导出 JSDoc、定向 lint、两个 README 翻译配对及正常提交 hooks 通过。独立审查发现拒绝后容量提前释放的问题，修复后真实 PG 回归通过；原初审及失败 fixture 日志保留。

## 证据

Root 的 `.artifacts/stdio-v2-services-real-pg-writer-capacity.log` 保存最终真实 PG 结果，SHA 为 `6dc31ea5db6b8a4839cbaedba69fe1f1ac1b2d88d87723c61acc4aae3e8a0fad`。`.artifacts/stdio-v2-integrated-synthetic-services.log` 保存 43 项服务回归，`.artifacts/stdio-v2-caller-client-capture.log` 保存 75 项捕获回归；构建、JSDoc、试用状态及先前失败日志位于同一忽略目录。独立工程师工作树保留候选源码、正常 hooks 与审查的完整 SHA。

## 未完成的链路

通用管理／检查／审批路由、原生既有插件页接线、Agent Operation 的完整工具选择与 call 受理、Cloud／Device worker、一次许可的实际消费、结果与完整停止闭合、目录发布和唯一续接仍需完成。许可服务要求独立认证的执行器入口和私有实时 capture 适配器；浏览器或 Host 不能提交资源观测来获得许可。

Cloud capture 接收授权事务 client 时，全部 PG 检查复用原连接，避免另起事务等待已有账户锁。此路径发生错误后不自行提交 quarantine；编排器必须先让原事务回滚，再持久化 quarantine，并保留原 writer。这段实际失败编排、允许单一 Node GET 的 RBAC、部署镜像配置，以及两用户真实 discovery／call 和原生结果展示仍未验收。通用 STDIO 未在现有试用 Profile 中启用。
