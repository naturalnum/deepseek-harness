# 原生 DSH Web 云端对话试用

本试用固定在 `power-evolve/native-cloud-client` 分支的 `b07fd4ce15`。上游基线为官方 `dsh-v0.1.7-rc.2`（`477b4f4205`），数据库 schema 为 7。它使用独立的 `native-cloud` 试用数据，不读取其他切片的 PG 卷。

## 直接试用

1. 打开可信平台登录页：<http://127.0.0.1:19061/login>。
2. 从私有文件 `~/.config/power-evolve/shared-host-native-cloud/users.json` 读取 `alice` 和 `bob` 的测试密码。请勿把密码贴到聊天或提交到仓库。
3. 登录后会进入原生 DSH Web：<http://127.0.0.1:19060/native/>。新建会话并发送 `hi`，等待真实 DeepSeek 模型回复。
4. 继续问“我刚才说的第一句话是什么？”，刷新页面，确认两轮历史仍在。
5. 用另一个浏览器会话登录另一个账号，确认只看到该账号的会话。两个账号共用同一个 Host 进程。

当前试用的 Host、可信平台和本地受控 API 分别监听 `19060`、`19061`、`19062`；PG 监听 `18461`。日志位于 `.artifacts/power-evolve/native-cloud/{host,platform,api}.log`。

本机重启与停止应用进程：

```sh
export PE_TRIAL_NAME=native-cloud PE_DATABASE_PORT=18461 PE_HOST_PORT=19060
export PE_PLATFORM_PORT=19061 PE_TARGET_PORT=19062
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

上述 `stop` 保留试用 PG 数据卷。模型配置和测试密码仅保存在 `~/.config/power-evolve/shared-host-native-cloud/`，权限为当前用户可读。

## 已验收及当前范围

完整仓库构建、真实 PG 集成测试 16/16、原生 Web 静态测试 2/2 和本地负载均衡 WebSocket 测试 1/1 通过。真实浏览器验证了两个账号的模型对话、追问、刷新历史和会话隔离。本环境在两次对话后有 2 个会话、0 个沙盒实例、0 次云执行。

这版原生 Web 接入只开放会话对话。文件、编程执行、桌面执行、技能和插件页面仍待后续纵切面接入；本试用未配置云沙盒。`session/follow` 和 `workspace/follow` 目前轮询可信平台，尚未据此做高并发容量承诺。原生 rc.2 客户端加载器仍需要该页面 CSP 允许 `unsafe-eval`；后续需在升级或替换加载机制时收紧。
