# S6 原生插件与连接器预览试用

本预览基于官方 DSH `dsh-v0.1.7-rc.2` 与 PowerEvolve 产品提交 `f626a2dd77`，使用独立 PG、私有配置和 k3d Connector Runner 命名空间。此环境验证 SSH 登录检查及固定只读进程型 MCP；受控便签与固定只读 HTTP MCP 已在各自独立试用中验收。SSH 命令的独立审批与执行仍在开发，S6 尚未封口。

## 直接试用

1. 打开 <http://127.0.0.1:19361/login>，从本机私有文件 `/Users/jingchao/.config/power-evolve/shared-host-native-s6-combined-c1/users.json` 读取 Alice 或 Bob 的试用密码。登录后打开原生 DSH Web <http://127.0.0.1:19360/native/>。
2. 在左侧“插件”中查看本人的 SSH 连接与进程型 MCP。分别以两个账号进行操作；每人的连接和调用状态只对本人可见。SSH 密码由浏览器直传可信平台，Host 不接收密码。
3. 对 SSH 连接执行“检查登录”。此操作会按需创建专用 Runner Pod，核对主机密钥和出口策略后尝试认证，不运行远端命令。刷新页面后检查状态仍可查看。
4. 启用固定进程型 MCP，在云会话中要求 Agent 调用 `mcp__stdio__whoami`。镜像内 MCP 进程在另一专用 Runner Pod 中执行，返回当前账号 ID，结果续接到同一会话；普通 `hi` 不需要此 Pod。
5. 如需验证拒绝路径，可从另一个账号尝试访问对方连接，或使用错误的 SSH 主机指纹。跨用户请求返回 404；错误指纹在密码派发前失败。

Host、可信平台、受控 API 与 PG 分别使用本机端口 19360、19361、19362、18533。试用名为 `native-s6-combined-c1`，k3d 命名空间为 `pe-connector-qa-2406fd01`。在仓库根目录运行以下命令管理此独立试用，停止后 PG 数据与私有配置保留：

```sh
export PE_TRIAL_NAME=native-s6-combined-c1 PE_DATABASE_PORT=18533
export PE_HOST_PORT=19360 PE_PLATFORM_PORT=19361 PE_TARGET_PORT=19362
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-native-s6-combined-c1
export PE_SSH_ENABLED=1 PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs stop
node products/power-evolve/scripts/trial.mjs up
```

日志与脱敏试用记录位于 `.artifacts/power-evolve/native-s6-combined-c1/`。不要在聊天、日志或仓库中复制私有密码及模型密钥。

## 实测证据

- 两名用户分别从原生插件页安装 SSH 连接，密码仅发送到平台上传接口。两条新 `ssh.authenticate` 调用成功；刷新后按原调用 ID 恢复，跨用户访问返回 404。错误指纹使无凭据的预检查失败，非白名单目标在上传前被拒绝。完成态同请求 ID 重试时，相同密码得到原结果、不同密码得到 409，连接与凭据修订不变。
- 两名用户各自通过真实 DeepSeek 会话调用固定进程型 MCP，Runner 使用不同 Pod 并返回各自账号 ID。PG 确认结果消息进入原会话，浏览器刷新和整套试用进程重启后仍可读取连接修订、调用状态和会话记录。
- SSH 与进程型 MCP 的 Pod、Secret、Service 和 NetworkPolicy 在调用结束后均已清理。复跑入口为 `scripts/qa-ssh-browser.mjs` 与 `scripts/qa-stdio-browser.mjs`；前者还验证密码未进入 Host。真实 k3d Runner 的出口拒绝与双用户隔离分别由 `connector-runner/deploy/qa-ssh/run.mjs` 和 `connector-runner/deploy/qa-stdio/run.mjs` 验证。
- 产品构建、原生 Web 构建、后端串行回归 63/63、Runner 8/8、扩展中心 API 19/19 与页面 24/24 通过。后端并行回归曾使耗时的文件符号链接竞态测试超过单测 60 秒；该测试单独运行及完整串行回归均通过。

## 当前边界

这是一份 **S6 预览**。SSH 只检查登录，不能从 Agent 会话执行远端命令；进程型 MCP 只允许镜像内固定的只读 `whoami`，不接收用户提供的进程命令、包或凭据。此试用未启用通用编程沙盒或个人 HTTP MCP；此前 S5 和 S6 便签／HTTP MCP 的独立试用仍保留。正式多节点共享存储、平台多副本、生产出口策略、容量及备份恢复属于 S7。
