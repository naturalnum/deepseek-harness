# S6 通用远程 MCP：集成验收记录

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

## 状态与范围

此记录描述通用 Streamable HTTP MCP 的原生客户端验收，不替代 [S6 固定连接器试用](TRIAL-S6-FINAL-QA.md)。两个账号已用真实 DeepSeek 完成多连接、同名工具选择、可信审批和连续工具调用；当前 V23 数据已备份、恢复到独立数据库，并通过恢复后的原生客户端重新登录与连接检查。MCP 已固定为可按需启动的独立试用快照，启停方式见下节。原 [S8 稳定试用](TRIAL-S8-NATIVE.md)保持独立。

本轮代码包含原生 Session 快照 `fbed71b517`、客户端错误提示 `2ba48cf1fd`、复用 PG 的试用启动器 `90ce5c2caf`、标准 SDK schema 适配 `beaafce507`、输出验证接线 `b36070fb4c`、原生工具变更协议适配 `6ed3f15307`，以及历史检查状态修复 `52010b8b4c`。官方 DSH 基线仍以 [baseline.json](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/baseline.json) 为准。

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

### 多连接、授权与检查终态

以下复验使用连接元数据适配 `6d4bc1f11a`、标准 SDK 附加目标 `f6cde3ebe6`、认证拒绝修复 `3f9143bf13` 和取消提示修复 `9819336753`。表内模型调用均为真实 DeepSeek；远端商品和报价数据仍为合成测试数据。

| 检查 | 实际结果 |
| --- | --- |
| 同名工具选择 | Alice 同时启用两个连接，均公布 `lookup_item`。模型按用户指定的“请求头报价”连接查询 pencil；独立审批显示匹配的连接 ID、配置及凭据版本，远端只记录该连接的一次调用。 |
| 跨会话持久授权 | Alice 在可信入口授予该版本工具持久许可；新会话的 notebook 查询复用许可且返回 7 CNY。撤销后再查询 pencil 重新等待审批，拒绝后原会话停止，远端调用数不增加。 |
| Bob 两个连接 | Bob 新增无需认证的公共连接，与自己的 Bearer 连接同时启用。一次任务分别查询 notebook，两个动作各审批一次；模型比较私有 11 CNY 和公共 7 CNY，远端各调用一次。Bob 页面不显示 Alice 连接。 |
| 凭据编辑与认证失败 | Alice 将自定义头改为错误凭据，实际检查显示“远端拒绝认证”；重新编辑为有效凭据后成功发现 2 个工具。401／403 不再被 SDK 后续清理覆盖成取消。 |
| 空目录、超时、删除 | Bob 临时连接合法返回 0 个工具；改用慢响应目标后检查超时。删除临时连接后列表消失，最终两个账号各保留两个连接。 |
| 运行中取消 | PG 确认检查已进入 `running`、租约 epoch 为 1 后，从原生页面取消。最终持久状态为 `cancelled`，界面显示“检查已取消”，不再保留取消中的提示。另一次较早点击已错过超时，不计作取消证据。 |
| 拒绝和去重 | 使用新登录凭据验证：各自列表 2 项；跨用户启停 404，伪造用户字段 400，Agent 审批入口 401，跨用户审批 404；重复已完成动作的相同决定返回 200，远端总调用数维持 8。 |
| 持久记录 | 8 条成功、2 条拒绝、10 条 `remote_mcp_result` 续接全部完成；2 条许可已撤销；执行沙盒为 0。此前诊断误用 `source='platform'` 的空查询结果已按真实来源字段修正。 |

两用户仍使用同一浏览器依次重新登录；这不作为两个同时独立浏览器上下文的证据。实际产品协议拒绝使用新登录身份直接调用 Host／Platform，未从浏览器存储提取令牌。

`multi-connection-evidence.json` 保存 PG 与远端调用元数据，`multi-connection-protocol-evidence.json` 保存授权拒绝及去重结果。`alice-header-selection.png`、`persistent-revoked.png`、`bob-two-connections.png`、`auth-denial.png`、`empty-catalog.png`、`check-timeout.png` 和 `check-cancelled-fixed.png` 保存对应原生界面；旧 `check-cancelled.png` 记录修复前的残留提示，不用于通过声明。

### 当前备份、恢复与部署验证

在 `87c6ec4fc0` 上，两个应用均停止时，使用现有 PG 执行 `backup-trial.mjs create` 和 `restore`，均设置 `PE_TRIAL_DATABASE=external`、`PE_BACKUP_PG_CONTAINER=pe-s6-mcp-dev-postgres`、`PE_BACKUP_KEEP_STOPPED=1`。备份位于 `~/.config/power-evolve/backups/s6-mcp-browser-v23-20260930-final`；恢复目标为独立数据库 `pe_mcp_restored_20260930` 和 `~/.config/power-evolve/shared-host-s6-mcp-restored`。

恢复核对通过：51 张 public 表逐行一致，414 个文件／符号链接及文件模式一致，6 个连接凭据版本可用恢复密钥解密；8 条成功、2 条拒绝和 10 条已完成续接均保留。恢复的私有 MCP 目录为 0700，密钥文件为 0600。schema 为 23→23；恢复脚本保持应用停止，之后另行启动复验，不将两次操作之间的人工检查时间报为可用 RTO。实际记录见 `backup-restore-evidence.json`；备份操作方法和失败边界见 [S7c 备份说明](TRIAL-S7C-BACKUP.md)。

恢复后的 Host／Platform 健康接口均返回 200。Bob、Alice 依次全新登录原生页面，各自读到原会话及两条私有连接；Bob 原报价比较、Alice 跨会话许可及撤销后的历史均可读。用恢复后的 Bearer 和自定义头凭据分别发起新的真实 SDK 发现，两项检查成功并各发现 2 个工具；未重新执行历史动作，远端工具调用为 0，恢复库仍是 8 成功／2 拒绝且无执行沙盒。此项没有重新发起模型任务。截图为 `restored-bob-history.png`、`restored-alice-history.png`、`restored-bob-connection.png` 和 `restored-alice-connection.png`。验证后四个临时进程及测试 PG 已再次停止。

本轮定向证据：备份及 POSIX 回归 34/34 通过，使用真实既有 PG、独立临时库和 CLI dump／restore；未启动模型或远端工具。TLS／HTTP 受控传输、配置和原生 PG 组合 30/30 通过，其中组合模型为确定性替身。部署渲染及预检 6/6 通过；application 类型检查、客户端类型检查、扩展中心 bundle 和 36 模块 Web 组装通过。原生 MCP 两个 Session 快照已录制并回放，工具描述包含可恢复的连接标签。

部署适配 `1d49d2c2ef` 为 Platform 单独投影 MCP 配置、密钥及可选 CA，并按明确 origin／IP／端口生成出口规则；运行时与预检要求部署配置启用严格 origin 模式。上述本地检查不证明真实集群的 Secret 挂载、CNI 出口或生产 TLS 可达性；这些仍归 S7 物理部署验收。

## 固定试用快照

固定提交为 `bddb027682b223276f02e48c601596ca1117fda9`，本地标签为 `power-evolve-native-s6-remote-mcp-trial`。独立 checkout 位于 `/Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-mcp`，使用恢复库 `pe_mcp_restored_20260930`、schema 23 和私有目录 `~/.config/power-evolve/shared-host-s6-mcp-restored`。构建产物与 workspace 链接均属于该 checkout；原生静态资源逐文件核对哈希，开发分支后续变更不改变这份快照。

以下为本机已验证命令，可从任意目录执行。控制器检查固定提交、源文件状态、运行产物和容器身份，启动时自动更新 PG 的动态映射端口；不会创建容器或镜像。它是本机快照辅助文件，不是通用部署入口。

```sh
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-mcp/.artifacts/power-evolve/s6-mcp-restored/snapshot-tools/fixed-trial.mjs start
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-mcp/.artifacts/power-evolve/s6-mcp-restored/snapshot-tools/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s6-stdio-mcp/.artifacts/power-evolve/s6-mcp-restored/snapshot-tools/fixed-trial.mjs stop
```

试用步骤：

1. 执行 `start`，打开 `http://127.0.0.1:19650/`；从上述私有目录的 `users.json` 在本机安全读取 Alice／Bob 测试登录信息，不复制到聊天或文档。
2. 登录 Alice，打开已有会话，查看查询结果及授权撤销历史；进入“插件 → 远程 MCP”，应显示自己的两个连接。
3. 退出后登录 Bob，查看原会话 11／7 CNY 的双连接比较及自己的两个连接；不应看到 Alice 的清单。
4. 如需新任务，指定本人连接查询 notebook；需要确认时在独立可信入口 `http://127.0.0.1:19651/approval` 登录同一账号审核。此步骤使用真实模型，合成 MCP 目标只返回测试商品数据；先前完整调用证据见上文，本次固定快照复验只重新登录、读取历史和清单。
5. 用完执行 `stop`。四个试用进程正常关闭；共享测试 PG 无其他客户端时随之停止，数据库和文件保留。有其他客户端时保留 PG，本轮以一个真实 PG 连接验证了该分支。

本次固定 checkout 的四角色健康启动、两用户原生登录及界面读取、持有共享 PG 客户端时保留数据库、释放后正常停库均已验证。证据、截图和日志位于该 checkout 的 `.artifacts/power-evolve/s6-mcp-restored/`，其中 `freeze-evidence.json` 记录结果，`snapshot-tools/preparation.json` 记录产物哈希。当前默认停止此快照以降低笔记本负载；稳定 S8 页面及数据库继续保留，闲置 k3s 集群按需启动。启动异常可先查看日志，再运行 `status`；控制器拒绝未知进程时应核对 PID 和端口归属，不能盲目终止。

## 本机环境与恢复

私有配置位于 `~/.config/power-evolve/shared-host-s6-mcp-browser`，其中 `trial-env.sh` 仅保存环境选择及文件路径，账号和模型凭据保存在同目录的私有文件中。数据库 `pe_mcp_browser_20260930` 使用已有 `pe-s6-mcp-dev-postgres` 容器，与 S8 的数据库、文件根及 schema 分开。该测试容器使用动态映射端口，重启后必须按 `docker port pe-s6-mcp-dev-postgres 5432/tcp` 核对私有 `database-url` 和 `trial-env.sh`；不能沿用旧端口。此次重启由 32961 变为 32962，修正配置后完成备份恢复。

从本开发仓库执行以下命令管理临时环境；先启动上述测试 PG 并核对动态端口。该环境用于未完成的验收，不是稳定试用入口。`stop` 关闭本轮四个 Node 进程，保留独立数据库与文件；不会停止共享 PG 容器。

```sh
source ~/.config/power-evolve/shared-host-s6-mcp-browser/trial-env.sh
node products/power-evolve/scripts/trial.mjs up
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs stop
```

启动后的 Host 为 `http://127.0.0.1:19650/`，可信平台为 19651，受控便签目标为 19652，合成 MCP 目标为 19653。日志及原生静态资源快照位于 `.artifacts/power-evolve/s6-mcp-browser/`。临时服务只在验收时启动，用完执行 `stop`，保留数据库、文件和独立的 S8 稳定试用。使用原生界面登录 `users.json` 中的独立测试账号，凭据不要复制到验收记录或聊天中。

开发环境与上述固定快照共用端口，不能同时启动。后续按 [连接器验收次序](S6-CONNECTOR-COMPLETION.md#验收次序)完成 SSH 私钥、编辑删除、普通命令与故障对账；MCP 快照不代表 S6 通用连接器全部完成。
