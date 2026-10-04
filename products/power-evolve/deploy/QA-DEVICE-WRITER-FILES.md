# Device 写入协调与文件访问验收

2026-10-04，集成代码固定为 `2591bc98c6`，完成 [Device Bundle](../device/README.md) 的共享写入槽与描述符文件访问。此次没有启动 Electron、真实模型或共享 Host，也没有替换 Cloud 固定试用；结果属于 Device 协议验收，不代表完整桌面产品交付。

## 实际验证

| 验证 | 结果与依赖 |
| --- | --- |
| [写入协调](../application/tests/device-writer-coordinator.test.ts) | 8 项通过；真实文件、native flock 与 OS 子进程；覆盖锁 inode、父进程死亡、等待意图、未知占用及精确结算 |
| [本机文件 helper](../application/tests/device-local-files.test.ts) | 11 项通过；真实 Python／文件／flock；覆盖根身份、链接、非普通文件、2 MiB 限制、仅创建、超时、父死持锁和 `.src` 资源定位 |
| [公开 Worker 恢复](../application/tests/device-worker-recovery.test.ts) | 20 项通过；真实私有文件、Python、native flock、HTTP 和冷 OS 子进程，Docker／Platform 为替身；覆盖跨 Device 等待重启、未知执行结案、传输互斥、旧授权及目录替换 |
| [构建后的 Device Profile](../application/tests/device-profile-lifecycle.test.mjs) | 2 项通过；真实 DSH CLI 和 native flock；验证竞争初始化与失败后再启动，未配对或执行命令 |
| [既有 Cloud POSIX helper](../application/tests/s2-safe-posix.test.mjs) | 3 项通过；真实文件与 Python，覆盖快速目录替换及 helper 失败；共享 helper 的导入入口保持无 stdin 副作用 |
| [真实 PG／Docker 协议](../application/tests/device-real-docker-protocol.test.mjs) | 分组覆盖 6 个通过场景；真实临时 PG、Docker、Git、公开 Worker 和实际 Device／Task／File 服务，HTTP fixture 注入回执丢失；没有完整 Platform Profile、Electron 或模型 |

真实 Docker 使用已有 ARM64 镜像 `pe-release-cloud-runner:7e2c0067e1-arm64`，镜像 ID 为 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`。前四个场景核验 Git 只写一次、登记回执丢失不启动、撤销后精确停止并等待可信结案、领取回执丢失沿用原进程重试。新增两用户场景明确在本机授权祖先／子目录：第二 Device 持久处于 waiting，PG 尚无派发进程或容器，第一写者确认停止并结算后才执行，最终两次命令各有独立容器和唯一续接。文件场景核对二进制实际字节、重复导入不覆盖、云端产物读回及另一用户越权拒绝，PG 没有产生桌面执行记录。

初次联测暴露了 fixture 的重复授权 ID、过早读取尚未写出的 journal、PG 派发字段名及错误码预期错误；均修正对应 fixture／断言后聚焦重跑通过。撤销用例改为等待精确容器实际移除，PG 接受停止报告不等于本机清理已经完成。只读复查确认 waiting 与可能已经领取的 claiming 分开；关闭时分别尝试释放共享锁与私有锁，保留关闭错误及未决记录。

Application 类型构建、三个源测试的严格类型检查、受影响源文件与测试 lint、导出 JSDoc、双语记录及 20 项文档门禁均通过。测试只使用已有 PG 与 Docker 节点，临时库、容器、Profile 子进程及目录由其测试持有者清理，没有启动新集群或重建镜像。

## 复验入口

先运行 `pnpm exec tsc -b products/power-evolve/application/tsconfig.json`。源码测试以 `node --import tsx/esm --test` 运行三个上述 `.test.ts` 文件；构建后的 Profile 和 Cloud helper 使用 `node --test` 运行对应 `.mjs` 文件。真实协议显式设置 `PE_DEVICE_TEST_IMAGE` 为已安装镜像、`PE_PRIVATE_DIR` 为含 `database-url` 的私有配置目录，再运行 `node --test products/power-evolve/application/tests/device-real-docker-protocol.test.mjs`。未指定镜像的跳过不算真实验收，凭据和数据库 URL 不写入记录。

## 剩余范围

共享写入槽在一个 OS 用户的协作 Profiles 之间串行所有项目；不同 OS 用户、未升级的 Device 和外部 OS 应用不受其协调。变更协调根必须先停止并对账旧写者。Docker 的 Mac 目录挂载仍通过受信 OS 路径；创建／启动前重新核验根身份，不声称阻止同权限外部应用在检查间隙替换路径。没有完整停止事实的冷领取仍要求核验，不能自动释放占用或重放命令。

当前记录不验收 Electron 的 Cloud carrier、Device process、Local Device bridge，亦不验收离源码安装包、签名、公证、Linux 真机、本机技能／Office／连接器和生产多物理节点。其实施顺序与完成条件继续由[桌面复用约定](../DESKTOP-COMPLETION.md)控制。
