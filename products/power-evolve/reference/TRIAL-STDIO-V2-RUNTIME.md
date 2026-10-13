# 通用 STDIO 的 SDK 执行与完整停止验证

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

## 范围

2026-10-07，SDK dispatch 与云 runtime 分别集成于 `68bc648aa8`、`9e7d8f44d3`。Root 将可信库打包并接入现有 Sandbox Runner；Runner 源码 SHA 为 `1e4e925f733b6e48286cdf7dd481b0c0f5bacdafd4d3c3ffe21aa76ec2d91201`。本记录验证私有执行层，不代表平台持久 worker、结果入库、真实 Kubernetes 捕获或原生双用户流程完成。此前审批及捕获范围见[环境准备验证](TRIAL-STDIO-V2-PREPARATION.md)。

## 实际结果

- 两位工程师分别完成 SDK dispatch／真实 spawn 身份与云 runtime，一位工程师独立源码审阅；Root 集成和操作真实资源。SDK 合成 peer 回归 43/43；最终受影响 dispatch 与 runtime 在 Root 集成验证 28/28。授权报文、生命周期 callback 和停止确认替身均明确标注，不视作真实平台授予许可。
- [实际 Docker 测试](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/application/tests/stdio-v2-runtime-docker.test.mjs) 1/1 通过。测试从本机 ARM64 镜像 `pe-report-worker-o6:math-r5`、实际 config ID `sha256:6ab86131170ca8d502f2fa20c197b2c8af71d8e7592a133137b2f12c129c8bd6` 构建测试独占的增量镜像。无网络、只读根、受限 CPU／内存／进程数，原 root PID1 命令保持不变；独立 root 控制客户端在容器内通过真实 loopback HTTP 调用 Runner，控制令牌通过 stdin 传入，不放入 Docker argv。
- 实际 SDK 服务以 UID/GID1000 运行，仅接收 HOME／PATH／LANG，字面特殊参数未进入 shell，无法读取 root 所有的 Linux 私有卷令牌。完整两页目录、initialize 扩展、原始 schema／metadata、结果扩展及转义 NUL 完整保留。并发同请求与 false 回执重试仅查询，trace 显示一次启动和一次工具调用；同 ID 改动完整 dispatch 冲突。
- 原命令与通用工具互斥，旧命令运行时仍可查询已结束的通用请求。程序新建独立进程组的后代后，Linux helper 实际清理全部 UID1000 写者，进程列表确认无存活用户写者才发布完成。丢回复保留实际调用及可能产生效果的事实，不重放；取消、运行中 SIGTERM 及原容器 PID 清零通过。Root 受影响旧 Runner 回归 12/12，通过实际本地 HTTP／Bash，Linux UID 隔离另由 Docker 覆盖。
- 严格 Application 构建与 Sandbox 库打包通过，库 SHA 为 `d7356f2277c429c2a26c9720a761984dcce1bb43100b81d78713ab4c7b27818f`，大小约 916 kB。此次 Docker 验证采用增量测试镜像；完整发布 Dockerfile 的新增库复制步骤已接入，但本轮没有重建其整个 Office 工具链。

首次夹具尝试发现 Docker 默认地址池已耗尽；改用无网络容器及容器内真实 HTTP，避免新增共享网络。另一尝试发现 Mac 文件 bind 的所有权语义不能证明 Linux root 私有令牌：测试中的 UID1000 曾读到受控 QA 令牌。最终夹具改为由独立 root 子容器在 Linux volume 内创建 0400／root 所有的令牌，再只读挂载；最终拒绝读取实测通过。原失败日志保留，没有将失败标记成通过。

## 证据与剩余接线

Root `.artifacts/stdio-v2-runtime/docker-final.log` SHA 为 `9bb609d2a3804d00e559abd4641b5b486989ceebfefed7d02e3176f30bb0d194`；`integrated.log` 为 `3dfd39ea101ec0796243263e2f88fcbef41fba588ee20f361a878423a142e637`；`legacy-runner-final.log` 为 `8c6eed8e4f93ab66a9c3bf5be3b7ac25e47e2bc3cf6c2f084eeb7bfc4af09d23`。同目录保留打包、失败及稳定试用状态记录；工程师工作树保留候选提交、精确 SHA 与只读审查。测试独占的容器、镜像标签、私有卷及目录已准确删除，未清理其他项目资源。

平台路由必须独立认证执行者，取得原始 PG 一次许可并保持 live capture；不能将本轮生成的 QA 许可或镜像 DTO 当成授权证据。仍需接通 Cloud worker／Device 原 journal、真实部署 pin 与 Node GET 权限、call 原子受理、完整结果／停止事实持久化、目录启用与唯一续接，再做原生两用户 discovery／call 验收。查询凭据不会重新授予启动许可，完整停止未确认时不得释放写者。旧 O6 R8 试用仍为 `83e46b3`／schema 33，Host 与 Platform ready，未启用新 STDIO 路由。
