# 原生活动转次取消专项记录

2026-10-09，Asia/Shanghai。范围是原生 `session/cancel` 保留排队输入的行为，官方依据为 [Session 控制器](../../packages/api/session-controller/src/commands.ts)的 `agent.cancel(..., { keepInbox: true })`。此记录不认证停止全部后归档、输入插队、队列编辑、正式 Profile 或全产品质量。

## 当前实现

Host 原生请求转发至 `/native/sessions/cancel`，Platform 调用 [TaskStore.cancelActive](application/src/platform/tasks.ts)。它在当前账号凭据和 Session 锁内选择正在运行的转次或仍有活动 STDIO 执行的调用链，不选择普通排队输入。没有活动工作时仍返回确认。原产品 `/sessions/cancel` 可选择最早排队输入；两入口使用显式模式共享持久取消逻辑。

## 实际验证

| 检查 | 实际结果 | 验证范围 |
|---|---|---|
| 修复前原方法的原生预期 | 5项，4通过、1失败、0跳过 | 直接调用当时原生 Host 使用的旧 TaskStore 方法，真实 PG 中闲置停止改变首个排队输入；不是 HTTP 与 PG 合并入口重现 |
| [新增 PG 用例](application/tests/native-session-cancel.spec.ts) | 5项通过 | 两个排队输入及原回执完全保留且可依次执行；活动转次取消及完成／中止结算；空闲确认；他人、缺失、错配和撤销凭据拒绝 |
| [原队列用例](application/tests/employee5-task-admission.spec.ts) | 12项通过 | 原产品取消语义及账号容量、分页、选择冻结的既有断言保留 |
| [独立 Host 用例](application/tests/employee7-native-cancel-wire.spec.ts) | 6项通过 | 实际 Host HTTP 与 RuntimeScope 转发新路径、入站拒绝及错误传播；Platform 行为明确为替身，不认证其数据库状态 |

合并运行23项全部通过、0失败、0跳过。递归解析三个根测试的仓库源码、所属清单、配置、锁及数据库资产共442项，前后文件集合和 SHA-256 没有变化，缺失解析项为0；27个外部模块文件及物理 node_modules 内容不在该摘要范围。该 PG fixture 使用可创建隔离数据库的试验管理员，不是普通角色导入验收。

私有原始日志、修复前源码、JSON 测试结果、输入摘要及 `result-v1.json` 保存在 `power-evolve-migration-evidence/private/root-native-cancel-v1/`。实际命令为锁定 Vitest 的 `run --config vitest.power-evolve.cloud.config.ts`，选择上述三个测试文件，并通过 `PE_TEST_DATABASE_URL_FILE` 引用私有地址；原失败日志保留。

## 验收限度

该23项版本之后，Host 增加了搜索信号透传，员工7提取了公共测试 fixture。当前四根测试联合运行33项全部通过、0失败、0跳过：保留原5项 PG 和12项队列断言，使用当前6项停止及10项搜索通道用例。递归输入445项、0缺失、前后0变化；27个外部模块文件仍不在摘要范围，原始文件为 `after-current.json`、`inputs-current-before.json`、`inputs-current-after.json` 和 `result-current.json`。搜索通道验证入站500 UTF-16边界、错误映射及 HTTP 取消传播，其 Platform 仍是替身，不证明真实 PG 搜索或后台立即终止。

两个闭包均不包含 Platform 路由入口、构建产物或正式部署，因此新 Platform 路由尚需实际 Profile 验收。后续四文件源码类型专项退出0，映射 lint 仍有未关闭诊断；本记录没有逐文件覆盖率或全量质量通过结论。[集成进度](TRIAL-CLOUD-MIGRATION-STATUS.md)列出完整剩余工作。
