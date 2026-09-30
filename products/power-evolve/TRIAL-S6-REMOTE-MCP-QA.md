# S6 通用远程 MCP：集成验收记录

## 状态与范围

此记录描述通用 Streamable HTTP MCP 的原生客户端验收，不替代 [S6 固定连接器试用](TRIAL-S6-FINAL-QA.md)。两个账号已用真实 DeepSeek 完成“已有 hi 会话 → 新增工具 → 独立可信审批 → 两个工具自动续接”，但本轮尚未完成全部 MCP 验收或冻结可交付版本。原 [S8 稳定试用](TRIAL-S8-NATIVE.md)保持独立。

本轮代码包含原生 Session 快照 `fbed71b517`、客户端错误提示 `2ba48cf1fd`、复用 PG 的试用启动器 `90ce5c2caf`、标准 SDK schema 适配 `beaafce507`、输出验证接线 `b36070fb4c`、原生工具变更协议适配 `6ed3f15307`，以及历史检查状态修复 `52010b8b4c`。官方 DSH 基线仍以 [baseline.json](baseline.json) 为准。

## 2026-09-30 实际证据

| 检查 | 实际结果 |
| --- | --- |
| 原生 DSH Web、真实 DeepSeek | Alice 和 Bob 分别全新登录并完成 `hi`；退出 Alice 后 Bob 的会话列表和 MCP 清单不包含 Alice 的记录。两次对话均在真实 PG 中完成。 |
| 原生插件页 | 两个账号分别创建使用不同测试凭据的私有连接；凭据通过浏览器直传可信平台。重启 Host 和 Platform 后，Bob 的对话和连接仍可读取。 |
| 标准 SDK 目录 | 受控目标使用 `@modelcontextprotocol/server` 的 `registerTool(z.object(...))`，提供商品查询和报价计算。初次发现因 `$schema` 和数值约束被拒绝；修复后在浏览器发现 2 个工具。目标为合成业务数据，不连接真实商城或执行购买。 |
| 两用户产品协议检查 | 两个清单各返回自己的 1 个连接；Bob 修改 Alice 连接返回 404，伪造用户字段返回 400，Agent 身份访问审批列表返回 401。 |
| 沙盒与资源 | 普通对话和连接管理后，试用 PG 的 `pe_sandbox_instances` 为 0；Docker 保持 3 个运行容器。临时试用复用已有 PG 容器中的独立数据库。 |
| 类型与真实 PG 回归 | `tsc -b products/power-evolve/application` 通过；schema、动作状态机和原生双服务组合共 29/29 通过，包括上下界无效结果、越权、去重、审批拒绝、响应丢失不重放、退出前持久化及两个新 Session 快照。模型和远程目标在该自动回归中均为确定性替身。 |
| 原生客户端构建 | 扩展中心 bundle 和 cloud-web 组装通过；实际浏览器加载 36 个原生客户端模块。错误码定向回归由客户端工作树验证，范围见对应提交。 |
| 启动器 | 外部 PG 模式实际启动成功且未增加容器；配置文件路径未进入 Host 环境。非法数据库模式及空外部数据库配置在启动服务前拒绝。 |

早期 Bob 在已有 `hi` 的会话新增 MCP 后出现两次 403，原生界面显示 `AUTH`。修复后的平台核对原生延迟工具声明与 system 工具引用，并派生固定 beta 请求头；没有转发 Host 自报的 beta，也没有用历史调用授予新动作权限。两次旧失败保留在试用历史中；后续成功发生在原会话。

### 真实模型调用与恢复复验

| 检查 | 实际结果 |
| --- | --- |
| Bob 两步任务 | 浏览器从原 hi 会话提交一次任务。先批准 `lookup_item(notebook)`，模型自动用返回的 `bob-notebook-2026` 提请 `calculate_quote(...,3)`，再批准后显示单价 11、总价 33 CNY。远端分别记录一次调用。 |
| 审批中重启 | Bob 第二步等待审批时，正常停止并重新启动临时 Host、Platform 和两个试用目标。相同指纹、参数和审批记录仍可读取并批准；第一步没有重放。此项是正常重启证据，进程故障和响应丢失另由确定性组合回归覆盖。 |
| Alice 独立链路 | 退出 Bob 的原生及审批登录后，全新登录 Alice；只能看到自己的历史、连接和审批。原 hi 会话完成相同两步任务，得到 `alice-notebook-2026`、单价 7、总价 21 CNY；远端两步各一次。两个账号使用同一浏览器依次登录，不算同时独立浏览器上下文。 |
| 会话许可、撤销与拒绝 | Alice 以会话范围批准查询工具，第二步单次批准。可信界面撤销查询许可后，再请求 pencil，动作重新等待审批；拒绝后原会话自动报告停止。远端没有 pencil 调用，也没有通过新调用重试。 |
| 真实服务协议拒绝与去重 | Bob 审批 Alice 动作返回 404；Bob 修改 Alice 连接返回 404；Agent 凭据访问审批返回 401；伪造用户字段返回 400。重复提交 Bob 已成功动作的相同审批返回原成功记录，远端调用数仍为 4。 |
| 编辑、草稿和禁用 | Alice 编辑名称并保留密钥，草稿检查成功后保存；禁用连接再回原会话聊天成功，没有工具调用或协议错误。旧正式检查误显示当前成功的问题经修复后，浏览器明确显示“当前配置尚未检查”及历史结果；重新正式检查恢复成功。启停编号显示“连接修订”。 |
| 多连接及自定义头 | Alice 保留停用的原 Bearer 连接，新增第二个自定义 Authorization 头连接，成功发现 2 个工具。此第二连接尚未实际调用；Bob 第二连接及双连接同时启用的调用仍待验收。 |
| PG 与沙盒 | 最后一次动作核对为 4 条成功、1 条拒绝，5 条平台来源续接均完成，1 条会话许可已撤销，执行沙盒仍为 0。两次修复前模型失败没有产生远端调用。 |
| 当前代码回归 | 主线 application 类型检查与 12/12 定向测试通过，包含原生 Session／DeepSeekAdapter、PG 准入、实际代理和完整双服务续接；模型及远端响应为明确的确定性替身。客户端类型检查、扩展中心 bundle 和 36 模块 Web 组装通过。历史检查显示修复由独立工作树的 1 项 API、15 项组件用例和中英快照验证，主线另完成真实浏览器复验。 |

本机证据在 `.artifacts/power-evolve/s6-mcp-browser/`：`live-protocol-evidence.json` 保存实际身份拒绝和重复决定结果；`live-pg-evidence.json` 保存动作、续接和撤销元数据；`bob-two-step.png`、`alice-two-step.png`、`stale-check.png` 保存原生界面。合成远端调用日志位于私有配置目录的 `remote-mcp-fixture-calls.jsonl`。真实模型使用 DeepSeek，MCP 目标使用标准 SDK 的合成商品数据；本轮回环 HTTP 不充当真实 TLS 验收。

## 本机环境与恢复

私有配置位于 `~/.config/power-evolve/shared-host-s6-mcp-browser`，其中 `trial-env.sh` 仅保存环境选择及文件路径，账号和模型凭据保存在同目录的私有文件中。数据库 `pe_mcp_browser_20260930` 使用已有 `pe-s6-mcp-dev-postgres` 容器的 32961 端口，与 S8 的数据库、文件根及 schema 分开。

从本开发仓库执行以下命令管理临时环境；该环境用于未完成的验收，不是稳定试用入口。`stop` 关闭本轮四个 Node 进程，保留独立数据库与文件；不会停止共享 PG 容器。

```sh
source ~/.config/power-evolve/shared-host-s6-mcp-browser/trial-env.sh
node products/power-evolve/scripts/trial.mjs up
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs stop
```

启动后的 Host 为 `http://127.0.0.1:19650/`，可信平台为 19651，受控便签目标为 19652，合成 MCP 目标为 19653。日志及原生静态资源快照位于 `.artifacts/power-evolve/s6-mcp-browser/`。临时服务只在验收时启动，用完执行 `stop`，保留数据库、文件和独立的 S8 稳定试用。使用原生界面登录 `users.json` 中的独立测试账号，凭据不要复制到验收记录或聊天中。

下一轮继续 [MCP 验收次序](S6-CONNECTOR-COMPLETION.md#验收次序)中的双用户各两连接及同时启用、同名工具路由、自定义头实际调用、无认证和空目录、删除与凭据编辑、检查取消／超时，以及持久授权的完整试用。还需核对 TLS／DNS 受控传输证据、迁移备份与恢复及发布产物，随后才能固定 MCP 试用版；SSH 完整功能仍在其后。当前不宣称 S6 通用连接器完成。
