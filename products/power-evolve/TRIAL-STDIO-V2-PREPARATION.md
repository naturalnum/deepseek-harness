# 通用 STDIO 私有执行环境捕获验证

## 范围

2026-10-07，适配源码固定于 `18570dfe30`。Cloud 与 Device 的 Prepared 组装器已集成到开发分支，未启用通用 STDIO 试用入口。本记录证明捕获及审批事务的行为，不代表用户程序执行、结果停止闭合或原生两用户 discovery／call 验收。此前服务范围见[服务验证](TRIAL-STDIO-V2-SERVICES.md)。

## 实际结果

- 真实隔离 PG 与私有 POSIX 验证共 15 个场景，Node 测试 16/16。新增场景通过真实授权事务调用 Cloud 组装器和 SandboxManager：两个独立数据库连接串行取得同一不可变准备记录；Pod spec 变化拒绝首次许可；回滚后另起事务持久化 quarantine，原槽位、Pod 身份及执行预留仍保留。Kubernetes Pod、Node、镜像和健康响应使用明确替身，未验证真实集群捕获。
- [实际 Docker 测试](application/tests/stdio-v2-device-capture-docker.test.mjs)使用已在本机的 `pe-report-worker-o6:math-r5` ARM64 镜像，仅创建一个从未启动的私有容器。两次完整捕获一致；Config／HostConfig／Path／Args、镜像、容器身份、只读根、无网络及两处挂载读回准确，换成错误物理源被拒绝。测试未启动用户程序，最后通过准确容器 ID 普通删除，私有测试目录已清理，无残留测试容器。
- 首次真实 Docker 验证发现同一容器的 Mounts 数组顺序会交换，导致审批摘要变化。修复只在摘要副本中按唯一 Destination 排序完整挂载条目；原观察及所有其他数组保持原样，字段变化仍被拒绝或改变摘要。原失败和字段差异日志保留，修复后实际 Docker 1/1 通过。
- 集成适配器替身回归 84/84，严格 Application 构建通过。共享观察入口的定向替身回归为 Cloud 32/32、Device 13/13。两位工程师使用独立工作树，第三位按准确提交独立源码审阅；真实 PG、Docker 及集成由 Root 执行。

## 证据与后续

Root `.artifacts/stdio-v2-real-pg-private-preparation.log` SHA 为 `51078b5e8361a0962e1d7fc3aeea98aba46a5af354a47efec12d5dd01e76fb85`；`.artifacts/stdio-v2-device-real-docker-capture-final.log` SHA 为 `fb3b796ca79b27cd0f7892ef3078823a20afa3c3269235aca3dfe55df4a4e19f`。同目录保留两次失败、字段差异、84 项回归、构建及试用状态日志；工程师工作树保留候选和独立审查的完整 SHA。

仍需将这些适配器接入独立认证的执行器路由和 worker。Cloud 必须在原执行记录中先捕获资源身份，调用失败后先回滚再隔离；Device 必须从原 journal／受控目录和已认证进程取得私有输入，并检查创建命令和安全策略。实际集群镜像／Node GET 权限、启动许可消费、工具 call 受理、结果及完整停止证明、唯一续接和原生页面仍未验收。原稳定 O6 R8 试用保持 `83e46b3`／schema 33，未切换到本版。
