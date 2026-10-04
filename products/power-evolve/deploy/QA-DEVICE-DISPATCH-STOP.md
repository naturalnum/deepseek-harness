# Device 派发与停止记录验收

2026-10-04，集成代码固定为 `128db1cad1592b6febf2b430e221ea7eb1004e3e`。本轮实现[原生桌面复用约定](../DESKTOP-COMPLETION.md)的 Device 前置协议，未交付 Electron 适配器或安装包。官方桌面两子树与 [`baseline.json`](../baseline.json) 的固定基线一致，继续复用其窗口、生命周期、IPC、OS 选择和打包机制。

## 实际验证范围

| 验证 | 结果与依赖 |
| --- | --- |
| [共享协议校验](../application/tests/device-execution-contracts.test.ts) | 3 项通过；拒绝原身份替换、运行中停止观察及不完整清理回执 |
| [精确 Docker 身份](../application/tests/device-owned-container.test.ts) | 14 项通过；Docker CLI 为替身 |
| [公开 Worker 生命周期](../application/tests/device-worker-recovery.test.ts) | 15 项通过；真实文件、native flock、HTTP 和冷 OS 子进程，Platform／Docker 为替身；Root 联测原 12 项与新增 3 项，隔离实现树也完成全组 |
| [V28→V29 迁移](../application/tests/device-execution-schema.test.mjs) | 1 项通过；真实临时 PG，旧输出与实际已排队续接保留，不补造派发、容器或停止身份 |
| [Platform 协议](../application/tests/device-execution-protocol.test.mjs) | 9 项通过；真实临时 PG，容器身份为合成数据；覆盖冻结超时、进程围栏、登记一次许可、撤销受限回报、未知占用及跨会话目录准入 |
| [既有 Device 切片](../application/tests/slice5.test.mjs)及[账号撤销](../application/tests/account-execution-revocation.test.mjs) | 各 1 项通过；真实 PG／文件，容器观察为合成数据；账号仅运行 Desktop 用例 |
| [构建后的 Device Profile](../application/tests/device-profile-lifecycle.test.mjs) | 2 项通过；真实 DSH CLI／native flock，拒绝竞争启动及初始化失败后再启动；未配对或执行命令 |
| [真实 Docker 协议](../application/tests/device-real-docker-protocol.test.mjs) | 4 项通过；真实 PG、Docker、Git、私有文件和公开 Worker；HTTP 测试路由调用实际 Device／Task 服务，注入响应丢失，无真实模型、Host、Electron或完整 Platform Profile |

真实 Docker 使用已有本机 ARM64 镜像 `pe-release-cloud-runner:7e2c0067e1-arm64`，实际镜像 ID 为 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`，没有拉取或重建镜像。四个场景分别证明 Git／标记写入一次、登记响应丢失不启动命令、撤销后只留下 START 字节而没有 END，以及领取响应丢失后原进程重试且标记只写一次。停止事实进入 PG 后核对精确 ID、终态与唯一续接，再核对容器和 Journal 清理；另一个用户的 Device 不能回报该执行。

Application 类型构建、受影响源文件 lint／导出 JSDoc、双语记录、20 项文档门禁及正常提交检查通过。真实 Docker 测试未指定镜像时会跳过；在不存在 PG 配置的目录下验证了 4 项跳过，此结果不计作基础设施通过。初次旧 slice5 默认配置仍指向已停的 `127.0.0.1:18432`，连接失败；指定现有测试 PG 配置后实际通过，没有为此重启旧数据库或迁移固定试用。

## 复验入口

先运行 `pnpm exec tsc -b products/power-evolve/application/tsconfig.json`。PG 测试配置通过 `PE_PRIVATE_DIR` 指向含 `database-url` 的私有目录；新协议测试也接受 `PE_TEST_DATABASE_URL`。测试仅新建并删除随机命名的测试库。真实 Docker 用例另显式设置 `PE_DEVICE_TEST_IMAGE` 为已安装镜像，再运行 `node --test products/power-evolve/application/tests/device-real-docker-protocol.test.mjs`。不要把密钥或数据库 URL 写入命令记录。

## 保留限制

同一存活进程可重试其已落盘的领取意图；冷进程遇到尚未取得派发回复的领取意图仍要求核验，不创建或启动命令。未知副作用即使已有停止观察，也保留平台占用且不自动续接。可信 Device 人工结案、跨 Device／重叠物理目录协调、描述符相对文件访问、本机 Office／技能／连接器、Electron 三处适配及离源码 ARM64 安装包仍须继续交付。本轮 Device 回执由已登记的设备身份提供，不代表独立 OS／Docker 认证。

测试结束后仅保留原 PG 容器和原 k3d 节点；测试容器、Profile 子进程、临时库及临时目录均由各自持有者清理。[Cloud 固定试用](../TRIAL-CLOUD-EXECUTION-RESOLUTION.md)保留原镜像、数据和 schema，本轮没有部署 V29 到该试用。
