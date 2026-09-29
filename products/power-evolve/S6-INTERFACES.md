# S6 云端插件与连接器接口

S6 在已有原生 DSH Web 扩展中心中增加“插件”入口。可信平台拥有连接器配置、凭据、授权、审批和执行状态；共享 Host 只注册可信产品工具并转发明确列出的非秘密字段。客户端的凭据正文直接提交到可信平台，不能经过 Host RPC。`application/web` 不增加产品页面。

## 第一条端到端路径：受控便签

已有 `trial_notes_list` 和 `trial_notes_append` 分别验证受控只读 API 与独立审批的写入。原生插件页增加“受控便签”卡片，可查看本人启用状态、跳转可信审批页，并启停本人使用权。平台从现有逐用户 `pe_connector_permissions` 判断能力授权，另存逐用户插件启用修订；两层均允许时才能调用。平台在每次实际读取、申请写入和批准后派发前检查当前状态。

浏览器通过 Host 的 `pluginsList` 请求平台 `POST /plugins/list {}`，返回 `{items:[{id:'notes',title:'受控便签',category:'tools',kind:'builtin',enabled,revision,requiresApproval:true}]}`。通过 `pluginsNotesSetEnabled` 请求平台 `POST /plugins/notes/set-enabled {requestId,expectedRevision,enabled}`；平台只使用已验证的当前用户身份，重复 `requestId` 和相同正文返回原结果，不同正文返回冲突，过期修订返回冲突。响应是同一条目。Host 不接受用户 ID，也不持有 PG 连接。

此路径的真实浏览器验收包括两用户互不影响、停用后 API 拒绝、普通查询无沙盒、待审批写入由可信平台确认或拒绝、同 ID 重试，以及 Host／平台重启后的状态与结果恢复。现有审批页继续使用独立的 approval 身份；Agent 凭据不能批准。

## 已接通的个人 MCP 路径

原生“插件”页现可让每位用户安装、启停和测试一个平台预设的只读 Streamable HTTP MCP 连接。地址、Bearer 和工具名由平台配置，用户只能提交名称与连接 ID；Host 不接触凭据。任务受理时把连接 ID 和修订固定到 `pe_operations.mcp_selection`，工具调用时平台再次核验操作归属及当前启用状态。停用立即阻止后续调用；普通 MCP 查询不创建执行沙盒。双用户真实模型调用、停用后的新任务、平台与 Host 重启恢复已有浏览器验收。此固定连接仅验证受控远程 MCP 的第一条路径，不等于任意个人 MCP 或整个 S6 完成。

## SSH 与进程型 MCP 的下一条路径

进程型 MCP 的首版现使用固定、只读的 `whoami` STDIO 进程预设。用户可在原生插件页独立安装和启停连接；任务受理记录连接 ID 与修订，后续调用重新核验当前授权。共享 Host 仅转发原生工具调用 ID 和固定的连接元数据；可信平台先在 PG 受理，再在专用短时 Runner Pod 中启动镜像内置 MCP 服务。Pod 不挂载用户文件，NetworkPolicy 禁止全部出口，Runner 在允许调用前验证对独立健康禁止目标的实际连接被拒绝。结果或不确定状态持久保存，并向原会话排入一次结果消息。平台重启后只按 Pod UID、Runner 实例和调用摘要查询已提交派发意图；状态缺失时不重放。两个用户的真实 k3d Pod 调用、账户隔离、出口拒绝和同 ID 重试由 `connector-runner/deploy/qa-stdio/run.mjs` 验收。当前预设不接收任意用户命令、包或凭据，不能代表任意个人 STDIO MCP 已完成。

旧版原生插件页的 MCP／SSH 是本片的迁移来源，不装载到共享 Host 的 DSH MCP Client。个人连接的安全元数据可经 Host 列举；Bearer、Header、密码、私钥与口令只经短时有效且绑定用户、请求 ID 和长度的票据直接提交平台，平台接收后计算带密钥摘要并以独立密钥加密保存不可变凭据版本。密码及其摘要不能经过 Host，以免低熵密码被离线猜测。密码最多 4096 字节；同一安装请求 ID 重试也必须直传密码，由平台核对带密钥摘要后返回原结果。保存、更新、启停和检查均有修订或稳定请求 ID；任务受理固定获授权连接与凭据版本，撤销阻止新的派发。

远程 HTTP MCP 需限制协议、端点、重定向、DNS 与出口。STDIO MCP 和 SSH 使用独立、短时的云端 Connector Runner，不能复用带用户工作区挂载和任意命令入口的编程沙盒。Runner 不挂载用户文件、技能包或平台密钥，不接收长期凭据，也不能通过通用 `cloud_exec` 参数传输连接凭据；平台只为单次授权调用下发短时能力。SSH 需要明确目的地白名单和已确认的服务器主机密钥。专用调用先持久受理，再以稳定调用 ID 查询 Runner 状态；重启或超时必须对账，结果不明时不盲目重放。具有外部副作用的 MCP／SSH 调用由可信平台保存确切动作，并由独立审批入口确认。

第一版 Runner 协议只提供带一次性控制令牌的 `GET /health`、`POST /calls` 和 `GET /calls/{callId}`。调用正文严格区分 `ssh.inspect`、`ssh.authenticate`、`ssh.execute`，包含稳定调用 ID、请求摘要、目的地、超时和输出上限；凭据仅在认证或执行调用正文中传送，不能进入 Pod 描述、环境变量或日志。同一 Runner 中，同 ID 同摘要只返回已有状态，异摘要拒绝；Runner 重启后由平台通过 Pod UID 与 Runner 实例 ID 识别状态丢失并标记不确定。平台在发出 `POST` 前先查询 `GET`，且在 Runner 证明出口策略生效前不下发凭据或用户进程代码。Runner 镜像无通用命令 HTTP 入口，非 root、只读根文件系统、无 ServiceAccount 和用户文件挂载。

平台工作者只领取其实现的调用类型。SSH 认证工作者只领取 `ssh.authenticate`；独立执行工作者只领取经审批的 `ssh.execute`。任务受理固定连接及凭据修订，Agent 只提交一条确切命令；可信平台以 AES-GCM 保存命令，并要求独立审批身份核对原文、目标和带密钥的动作指纹。批准后才创建执行调用。首次带凭据派发时再次锁定连接，停用先提交则阻止派发；已提交派发意图只按 Pod UID、Runner 实例和摘要查询，绝不重发。命令、口令和结果明文不进入 `pe_ssh_calls`，有界结果只向原会话续接一次。真实双用户 k3d 审批执行路径由 `connector-runner/deploy/qa-ssh/run.mjs` 的可选独立数据库验收模式检查。

SSH 连接的停用与首次凭据派发在平台数据库中串行化：派发事务锁定连接并复核启用状态、连接修订与凭据版本，之后才向 Runner 发送凭据。停用先提交时，已受理的旧调用以 `ssh_connection_changed` 失败并清理 Runner 资源。

派发结果持续无法确认时，调用保留 `uncertain`，不会重发。超过 Runner Pod 的最长存活期后，工作者最后查询一次状态，再删除 Pod、Service、Secret 和 NetworkPolicy；即使资源已清理，界面仍显示远端效果未知。

当前 k3d 的实测发现：`NetworkPolicy` 已创建时，极短命 Pod 曾在策略规则追上新 Pod 前连接到未允许地址；存活更久的同配置 Pod 则被拒绝。证据保存在试用输出的 `qa/connector-network-policy-probe.txt`。因此不能以策略对象存在或 Pod 就绪作为出口隔离证明；应在 Runner 接收敏感调用前主动探测禁止目标并要求其被拒绝，同时完成允许目标和未允许目标的实际连接验收。若目标集群无法可靠满足这一关口，停止发放连接凭据。

S6 固定试用版只有在 MCP／SSH 的真实云沙盒调用、双用户隔离、失败与恢复均有证据后才标记完成。第一条便签路径单独提交和测试，不能以其通过代替整个 S6。生产集群网络出口策略和多节点部署仍属于 S7 发布验收。
