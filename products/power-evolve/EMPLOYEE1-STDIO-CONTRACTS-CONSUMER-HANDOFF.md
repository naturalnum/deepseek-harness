# Employee1 STDIO Contracts consumer handoff

2026-10-09：只新增四份员工1测试/辅助文件，覆盖 stdio-management 与 stdio-mcp 的真实公开消费者。最终 115/115 案例通过，0 fail、0 skip；官方映射 typed lint 与完整 TestHost 源类型检查通过。逐文件 lines/statements/functions/branches 四项 100% 原门槛仍失败，组合测试与覆盖率命令 exit 1，保留五条门槛错误，不计作整个 Contracts 或 Cloud 验收通过。

| 新增文件 | 案例 | 实际消费者 |
| --- | --- | --- |
| [Host management](contracts/tests/employee1-stdio-management-host.spec.ts) | 52 | 原认证 HTTP → Typert → StdioManagementRpcV2 → RuntimeScope；完整配置及所有连接/动作管理方法。 |
| [Platform management/preparation](contracts/tests/employee1-stdio-management-platform.spec.ts) | 30 | StdioConnectionServiceV2.list/receipt 与 StdioCloudPreparationV2.capture；真实持久记录解析及绑定校验。 |
| [Runner start/lifecycle](contracts/tests/employee1-stdio-mcp-runner.spec.ts) | 33 | parseStdioStartV2、validateStdioStartV2 与 StdioCloudRuntimeV2.start/get/cancel/close/busy。 |
| [独立 wire 辅助文件](contracts/tests/employee1-stdio-consumer-fixture.ts) | — | 手写原始 task、catalog、invocation、permit 和 JSON domain digest；没有用 schema.shape 生成案例。 |

Host 案例保留空 argv、中文、字面 shell 字符及原始 SDK 扩展字段；UTF8 标签和完整请求/回复字节数均有有效精确上限及一字节越界拒绝。分页有页数上限、最大安全 offset+limit 及越界拒绝。错误配置、私有字段、替换回执、task/action/session/connection/revision/phase 不一致、terminal/outcome/noStart 不一致均通过原认证 wire 消费；错误不重投、没有部分 task 输出或新启动权限。

Platform 案例对保存配置及 management request/receipt 使用独立 JSON digest，原五种 purpose 都从公开 receipt 读取；配置、catalog、digest、时间及回执绑定错误形成回滚或只读拒绝。Preparation 对原 task/execution/session/mount/writer 执行实际解析和比对，精确 runtime image、manifest 和 architecture 不一致不返回 Prepared；有效 Prepared 不含 token 或 permit，也不证明执行或停止已经发生。

Runner 在实际开始入口拒绝更改的原 task、catalog、descriptor、frozen limits、image、同 action/task/prepared/execution permit、approval epoch 及授权回复。fresh false、过期或 cold-instance 回复不建立 entry，不调用 cwd/driver/cleanup；原 execution 的重复 false 回复只读取已有事实。取消在执行任务及异步 cwd 检查前阻止驱动；独立 cleanup=false 保留 unknown、原预约及 busy，不把 direct-child close 或 cancellation 当作完整 writer stop。

| 两份冻结协议源码 | Lines | Statements | Functions | Branches |
| --- | --- | --- | --- | --- |
| [stdio-management](contracts/src/stdio-management.ts) | 100% (39/39) | 97.91% (47/48) | 100% (9/9) | 96.15% (25/26) |
| [stdio-mcp](contracts/src/stdio-mcp.ts) | 98.85% (86/87) | 98.11% (104/106) | 100% (25/25) | 96.36% (53/55) |

剩余原始位置保存在 [未覆盖 statement/branch 记录](../../.artifacts/employee1/stdio-contract-consumers/remaining-coverage.json)。management 第 40 行是完整 JSON 校验后的重复 guard：本批 Host 消费者先使用相同 byte/depth/node 预算拒绝，不能在这个入口再触发内层拒绝；这只说明本批入口，不声明 builder 对其他入口不可达。mcp 第 154 行 fallback 和 Prepared 第 233–234 行 kind 不一致分支，在当前协议所有参与项只有 Cloud 的闭合枚举中不可达。没有引入违反这些静态接口的同进程值、忽略标记、覆盖门槛变更或生产重构来填分支。

真实资源仅为自有 loopback HTTP、原 Host/Typert/RuntimeScope 载体和自有临时文件；全部在 fixture 结束时释放。Platform 回复、PG query/rows、Sandbox 观测、cwd authorization、stdio driver 与独立 UID cleanup 都是明确的 unit 替身；公开 pg 构造器只解析 application 的已声明依赖，没有连接数据库。未执行真实 PG 锁/隔离/提交、Kube、runsc、stdio 子进程、独立 UID 退休、browser UI 或端到端部署验收。只禁止无关 Scheduler 后台 claims，保留所测公开载体和消费者。

检查使用实际 application/tests/tsconfig.json → tsconfig.power-evolve.test-host.json，36 个依赖引用，四份新增文件都是程序根；没有用产品 lib/types 代替 source，官方映射配置及 root lint 源一致。具体程序输入与类型结果见 [源程序登记](../../.artifacts/employee1/stdio-contract-consumers/source-program.json)、[源类型检查](../../.artifacts/employee1/stdio-contract-consumers/types-stable-final.log) 及 [最终机器记录](../../.artifacts/employee1/stdio-contract-consumers/final-proof.json)。

行为与覆盖率证据为 [最终 115 案例记录](../../.artifacts/employee1/stdio-contract-consumers/test-final.json)、[原命令日志和五条门槛错误](../../.artifacts/employee1/stdio-contract-consumers/test-final.log)、[原覆盖率映射](../../.artifacts/employee1/stdio-contract-consumers/coverage-final/coverage-final.json) 与 [最终 typed lint](../../.artifacts/employee1/stdio-contract-consumers/lint-final.log)。首轮自己的类型/style 诊断、修复日志和 101/110 案例覆盖率失败记录均留存；最终结果单独登记。

四份新增文件和消费输入 SHA 保存在 [冻结登记](../../.artifacts/employee1/stdio-contract-consumers/freeze.json)。已有 Office/download 四测试、旧五份 Host 测试/辅助文件、Office 原冻结源码、协议生产、shared config、Manifest 与锁文件保持原样；未重跑既有 132 案例、旧五文件行为或 Office/runtime/CI。此次只新增这两个模块的消费者证据，不增加既有物理验收通过数。
