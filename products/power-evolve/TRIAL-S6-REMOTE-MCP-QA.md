# S6 通用远程 MCP：集成验收记录

## 状态与范围

此记录描述通用 Streamable HTTP MCP 的原生客户端验收，不替代 [S6 固定连接器试用](TRIAL-S6-FINAL-QA.md)。本轮尚未冻结可交付版本；真实模型在已有会话新增工具后的协议适配仍待修复并复验。原 [S8 稳定试用](TRIAL-S8-NATIVE.md)保持独立。

本轮代码包含原生 Session 快照 `fbed71b517`、客户端错误提示 `2ba48cf1fd`、复用 PG 的试用启动器 `90ce5c2caf`、标准 SDK schema 适配 `beaafce507`，以及输出验证接线 `b36070fb4c`。官方 DSH 基线仍以 [baseline.json](baseline.json) 为准。

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

真实模型 MCP 调用尚未完成：Bob 在已有 `hi` 的会话中启用 MCP 后，平台返回 403，原生界面显示 `AUTH`。原生日志的当前工具定义与 PG 固定选择一致；进一步代码核对表明，DSH Flash 会为后加入的工具生成 `defer_loading: true` 和工具变更块，而平台的原校验拒绝该元数据，也未向模型派生固定的工具变更 beta header。实际 `pe_mcp_actions` 仍为 0，没有执行远端工具。该失败不计为真实 MCP 调用验收通过。

## 本机环境与恢复

私有配置位于 `~/.config/power-evolve/shared-host-s6-mcp-browser`，其中 `trial-env.sh` 仅保存环境选择及文件路径，账号和模型凭据保存在同目录的私有文件中。数据库 `pe_mcp_browser_20260930` 使用已有 `pe-s6-mcp-dev-postgres` 容器的 32961 端口，与 S8 的数据库、文件根及 schema 分开。

从本开发仓库执行以下命令管理临时环境；该环境用于未完成的验收，不是稳定试用入口。`stop` 关闭本轮四个 Node 进程，保留独立数据库与文件；不会停止共享 PG 容器。

```sh
source ~/.config/power-evolve/shared-host-s6-mcp-browser/trial-env.sh
node products/power-evolve/scripts/trial.mjs up
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs stop
```

启动后的 Host 为 `http://127.0.0.1:19650/`，可信平台为 19651，受控便签目标为 19652，合成 MCP 目标为 19653。日志及原生静态资源快照位于 `.artifacts/power-evolve/s6-mcp-browser/`。本轮资源清理后四个临时服务均已停止；修复就绪后再启动。使用原生界面登录 `users.json` 中的独立测试账号，凭据不要复制到验收记录或聊天中。

下一项验收为同一原生会话的“先 hi → 启用 MCP → 提出动作 → 可信审批 → 真实模型续接第二工具”，随后覆盖拒绝、编辑／禁用和继续对话。通过后补充实际结果、恢复证据与固定版本；当前不宣称 S6 通用连接器完成。
