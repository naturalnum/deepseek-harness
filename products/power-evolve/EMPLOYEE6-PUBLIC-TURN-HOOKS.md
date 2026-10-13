# 员工6：公开回合准备与 pending 唤醒候选

本批通用 Core API 与验证已完成。新增 `Agent.onBeforeTurn()` 和 `Agent.wakePending()`，不带产品授权、grant、DB 或 outbox 策略。产品 Coordinator、continueSession、原生队列控制及最终正式产物验收由 root 后续接入；本报告不认证这些产品能力完成。证据冻结时间：2026-10-09T06:48:16.593210+00:00。

## 公开行为

`onBeforeTurn(listener)` 按注册顺序准备候选 turn，仅在存在注册时等待。执行位置在 durable `turn/start`、输入 claim、prompt 与工具组装之前；没有 hook 的旧同步打开与 claim 时机保留。注册由 Agent scope 拥有，调用者可用 `ctx.effect()` 拥有 disposer。重复 callback 的注册各自独立，移除幂等；准备期间新增的注册延后到下个 turn，被移除的注册跳过。listener 必须响应 signal 并完成清理，不得等待同一 Agent 的 `whenIdle()` 或处置。

准备失败通过 `agent/error` 报候选 turn、step 0，不写 phantom turn 边界，保留未 claim 输入；driver 容纳失败，`whenIdle()` 在静止后兑现。取消遵循 `keepInbox`。修复准备后可用 `wakePending()` 恢复原消息 ID，无需添加新输入。异步准备期间的业务输入编辑与投递互斥由产品 Coordinator 管理。

`wakePending()` 不插入、替换或重定向消息；空 inbox 无操作，活跃 driver 正常排空，maintenance 与非 disposed 的已取消 activity 按原机制保留 wake，disposed activity 保持 pending 停放。后续显式 idle wake 可以重试。

## 文件与候选摘要

| 文件 | SHA-256 |
|---|---|
| [Agent 公共类型](../../packages/core/agent/src/runtime-types.ts) | `f82789a66c11cce6e4ce43a9fe4445c760c5b3c21662de756564d99c06d711a5` |
| [AgentLoop 实现](../../packages/core/agent-loop/src/agent.ts) | `0e1d7bbb6e62f1c6326f5b3a3b96c177904f7eff82517bbc399ad7d4d8aaa3dc` |
| [专属公开测试](../../packages/core/agent-loop/tests/employee6-before-turn.spec.ts) | `32d773d928d8bd9f0d68a1368f662ac5875313a895c2c15da41247a3e8ab46dd` |

同步更新了 Agent / AgentLoop 双语 README 与 sidecar、architecture 双语流程、Core 子系统类型镜像及[升级指南](../../docs/upgrade-guide/v0.2.1-alpha.1/agent-turn-preparation/guide.md)三件套。实现、测试与配套文档共 51 个改动文件：16 个本批文件，35 个机械消费者修复；本交接报告另计。完整文件和摘要见私有 `owned-files-final.json`，本批净差异见 `owned.patch`，Core 最小 API / 测试差异另见 `core-public.patch`；差异按开工备份生成，不将共享树的其他改动归入本批。

35 个既有测试文件中的 41 个实际 Agent 替身仅增加两个空方法。移除这两项后，整个文件 AST 与开工备份一致；没有改动旧测试注册、输入、断言或添加类型断言逃逸。证明和准确文件清单见 `consumer-preservation-final.json` 与 `verify-consumers.mjs`。root 已批准该机械修复范围。最后对 238 个直接 Agent 注解候选文件的完整对象结构审计补入两个返回 helper；它们的原套测试 12/12 与 scoped lint 通过，最初 33 文件的证据另存 v1，未覆写。

## 实际验证

准确 QA 命令、工作目录、退出码与耗时另存 `qa-commands.json`。所有后续 QA 使用 `pnpm_config_verify_deps_before_run=error` 和直接 Node 工具入口，未运行 record / refresh。下表按实际执行范围计数；没有全库单元、覆盖率或正式产品端到端通过的声明。

| 检查 | 结果与范围 |
|---|---|
| 新公开接口真实 Agent + scripted LLM | 15/15；无 hook 同步时机、三输入三个 turn、异步顺序、失败原 ID 恢复、user / disposed 取消、维护 wake、作用域卸载与每回合组装前交接 |
| 既有 core Agent 与 loop Agent / cancel / contract | 114/114；与新增 15 项同一次 `public-final.json` 运行通过 |
| 既有 resume | 首批 16 通过、31 因缺 native binary 失败；root 构建当前 binary 后原套 47/47，通过记录 `resume-post-native.json` |
| TypeScript SDK 原 max-tokens-continue | 1/1，24 个过滤 pending 不计通过；`sdk-typescript-post-native.json` |
| Python SDK 原 account-provider-signout | 1/1，非 skip；`sdk-python-post-native.log` |
| 额外两处消费者原套 | 12/12，`consumer-final-extra.json`；两文件 scoped lint exit 0 |
| 直接源码类型程序 | 0 diagnostics，461 源码文件与 545 声明文件；Core 和修复消费者解析源码，vendor 解析其已构建公开声明，`type-closure-final.json` |
| 官方 scoped lint | 两个生产文件和新增测试 exit 0，`lint-final.log` |
| 文档 | 468 类型镜像、5 组指定配对、1732 文件段落、公开 JSDoc、8 项预算通过；1710 文件链接通过，最后指南链接修改另用官方 helper 检查 0 错误 |

两 SDK 使用原 `dsh --profile sdk` 启动与原 fixture / expected。私有 tsx 配置将公共别名解析到当前源码，native 公共子入口使用已有编译 wrapper；私有 preload 只验证公开 `AgentRegistry.enter()` 收到的真实 Agent 有这两个方法并原样转发，不注册 hook 或修改消息、请求、事件。TypeScript 实际 Agent 进程加载 1039 个模块，Python 加载 1029 个；两者都记录到上述同 SHA 的 `packages/core/agent-loop/src/agent.ts`。认证范围是源码驱动的 SDK 默认 profile 流程；重新打包的发行产物由 root 统一验证。

## 冻结证据与环境记录

私有证据根为 `/Users/jingchao/agent_work/private/employee6-public-turn-hooks-20261009`。`type-closure-final.json` 与 `type-closure-snapshot/` 保留实际 TS 程序递归源码和声明；`sdk-runtime-closure-final.json`、两个 SDK import trace 和 `sdk-runtime-snapshot/` 保留实际 Agent 进程的 Node resolve / load 闭包及原字节。`supporting-inputs-final.json` 与副本覆盖 341 项清单，包括 package / profile 配置、SDK fixture、native C / TS 源码、JS / d.ts wrapper、当前 binary；私有 QA 配置与 helper 另记摘要。

root 使用本迁移树 `build:native-system --host-addon-only` 构建当前 macOS ARM64 `system.node`，exit 0；没有复制只读旧树 binary。root 构建记录在 `power-evolve-migration-evidence/private/root-native-assistant-v1/native-host-build.log`。本批未构建或改写 native 源码、SDK expected、产品 Runtime / Store / DDL、共享 manifest / 配置，也未 Git add / commit 或操作运行中的 2 Host + 2 Platform。

早期失败完整保留：新增测试首轮用错 create 参数，次轮用错公共事件字段，修正后达到 15 项；类型命令和 vendor 严格配置的失败均未当成源码通过。SDK 前三轮失败、resume 初批缺 native binary 失败以及指南链接 / pairing 错误命令均保留，后续成功记录使用独立文件，没有覆盖旧失败。

第三轮 `pnpm exec vitest` 意外触发 workspace 隐式 install 与 postinstall，报告耗时 17.4 秒，整条命令 20216 毫秒；该轮 Vitest startTime 是 `2026-10-09T06:00:55.581000+00:00`，命令精确起点没有采集。员工6当时未采 lock 的前 SHA，不回填推测值；准确命令、原输出与时间锚点在 `implicit-install-command-history.json` 和 `implicit-install-incident.json`。已立即告知 root 并改用直接工具入口。root 对照 immutable v5 确认 lock 只含 application attachment 从 runtime 转 dev 的归属变化，随后串行完成 offline frozen install、禁用 scripts；root 第一份窗口备份当时已是隐式 install 后版本。

最后验证窗口中 12 项共享配置 / lock 摘要前后完全一致，lock SHA 为 `c15629b43ab7d7355947d6de2a613b3d8c162be61feeb9722e7a9434fb7591c1`。原搜索六件源码 / 测试与搜索报告、旧架构审计报告共 8 项冻结摘要不变。本批类型、SDK 实际加载、消费者、共享文件和受保护文件漂移检查均为 0，见 `freeze-validation.json`。这些模块证据不替代 root 的产品接线、持久控制恢复与全量同版本验收。
