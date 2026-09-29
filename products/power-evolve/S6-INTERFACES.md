# S6 云端插件与连接器接口

S6 在已有原生 DSH Web 扩展中心中增加“插件”入口。可信平台拥有连接器配置、凭据、授权、审批和执行状态；共享 Host 只注册可信产品工具并转发明确列出的非秘密字段。客户端的凭据正文直接提交到可信平台，不能经过 Host RPC。`application/web` 不增加产品页面。

## 第一条端到端路径：受控便签

已有 `trial_notes_list` 和 `trial_notes_append` 分别验证受控只读 API 与独立审批的写入。原生插件页增加“受控便签”卡片，可查看本人启用状态、跳转可信审批页，并启停本人使用权。平台从现有逐用户 `pe_connector_permissions` 判断能力授权，另存逐用户插件启用修订；两层均允许时才能调用。平台在每次实际读取、申请写入和批准后派发前检查当前状态。

浏览器通过 Host 的 `pluginsList` 请求平台 `POST /plugins/list {}`，返回 `{items:[{id:'notes',title:'受控便签',category:'tools',kind:'builtin',enabled,revision,requiresApproval:true}]}`。通过 `pluginsNotesSetEnabled` 请求平台 `POST /plugins/notes/set-enabled {requestId,expectedRevision,enabled}`；平台只使用已验证的当前用户身份，重复 `requestId` 和相同正文返回原结果，不同正文返回冲突，过期修订返回冲突。响应是同一条目。Host 不接受用户 ID，也不持有 PG 连接。

此路径的真实浏览器验收包括两用户互不影响、停用后 API 拒绝、普通查询无沙盒、待审批写入由可信平台确认或拒绝、同 ID 重试，以及 Host／平台重启后的状态与结果恢复。现有审批页继续使用独立的 approval 身份；Agent 凭据不能批准。

## 已接通的个人 MCP 路径

原生“插件”页现可让每位用户安装、启停和测试一个平台预设的只读 Streamable HTTP MCP 连接。地址、Bearer 和工具名由平台配置，用户只能提交名称与连接 ID；Host 不接触凭据。任务受理时把连接 ID 和修订固定到 `pe_operations.mcp_selection`，工具调用时平台再次核验操作归属及当前启用状态。停用立即阻止后续调用；普通 MCP 查询不创建执行沙盒。双用户真实模型调用、停用后的新任务、平台与 Host 重启恢复已有浏览器验收。此固定连接仅验证受控远程 MCP 的第一条路径，不等于任意个人 MCP 或整个 S6 完成。

## SSH 与进程型 MCP 的下一条路径

旧版原生插件页的 MCP／SSH 是本片的迁移来源，不装载到共享 Host 的 DSH MCP Client。个人连接的安全元数据可经 Host 列举；Bearer、Header、密码、私钥与口令只经一次性绑定用户、请求 ID、长度及摘要的票据直接提交平台，平台以独立密钥加密保存不可变凭据版本。保存、更新、启停和检查均有修订或稳定请求 ID；任务受理固定获授权连接与凭据版本，撤销阻止新的派发。

远程 HTTP MCP 需限制协议、端点、重定向、DNS 与出口。STDIO MCP 和 SSH 使用独立、短时的云端 Connector Runner，不能复用带用户工作区挂载和任意命令入口的编程沙盒。Runner 不挂载用户文件、技能包或平台密钥，不接收长期凭据，也不能通过通用 `cloud_exec` 参数传输连接凭据；平台只为单次授权调用下发短时能力。SSH 需要明确目的地白名单和已确认的服务器主机密钥。专用调用先持久受理，再以稳定调用 ID 查询 Runner 状态；重启或超时必须对账，结果不明时不盲目重放。具有外部副作用的 MCP／SSH 调用由可信平台保存确切动作，并由独立审批入口确认。

S6 固定试用版只有在 MCP／SSH 的真实云沙盒调用、双用户隔离、失败与恢复均有证据后才标记完成。第一条便签路径单独提交和测试，不能以其通过代替整个 S6。生产集群网络出口策略和多节点部署仍属于 S7 发布验收。
