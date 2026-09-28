# 原生 DSH Web 云端编程试用

本次试用的产品代码固定于 `power-evolve/native-cloud-client` 分支的 `826aa021c0`；官方 DSH 基线为 `dsh-v0.1.7-rc.2`（`477b4f4205`），PG schema 为 7。它使用独立的 `native-exec` PG 卷和私有配置，不读取 `native-cloud` 对话试用数据。

## 直接试用

1. 打开可信平台登录页 <http://127.0.0.1:19071/login>。从本机私有文件 `~/.config/power-evolve/shared-host-native-exec/users.json` 读取 Alice、Bob 的随机试用密码；不要粘贴到聊天或提交到仓库。
2. 登录后在原生 DSH Web <http://127.0.0.1:19070/native/> 新建会话，发送 `hi`。右侧“文件”标签应立即显示 `/workspace` 空目录；此时不应创建执行沙盒。
3. 在同一会话中要求实际调用 `cloud_exec`：创建一个 Python 文件，运行它，初始化 Git 并提交。等待可信执行结果回到对话。文件标签应自动出现该文件，点击后可在原生预览中读取内容。
4. 在另一个浏览器会话中以 Bob 登录，重复步骤 2–3。Bob 的文件树应只显示自己的文件；Alice 的会话 ID 和文件通过平台文件接口访问会被拒绝。

本机重启与停止应用进程：

```sh
export PE_TRIAL_NAME=native-exec PE_DATABASE_PORT=18462 PE_HOST_PORT=19070
export PE_PLATFORM_PORT=19071 PE_TARGET_PORT=19072
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷和用户文件。Host、可信平台、受控测试 API 分别监听 19070、19071、19072，PG 只监听本机 18462。日志在 `.artifacts/power-evolve/native-exec/`。k3s 命名空间为 `pe-shared-host-native-exec`；平台使用命名空间限定的身份管理 Agent Sandbox。真实模型配置、测试密码、Kubernetes 凭据均在私有配置目录，不进入仓库。

## 实测记录

- 真实浏览器中，Alice 的既有会话从 `hi` 进入云编程任务，平台按需启动沙盒，运行 `hello.py` 并提交 Git；原生右侧文件标签列出 `.git` 和 `hello.py`，代码预览显示 `print("hello power evolve")`。
- Bob 先发送 `hi` 时文件目录为空、沙盒数为 0。随后在原生页面要求编程，`bob.py` 运行输出 `bob isolated`，Git 提交成功；文件树自动更新，预览显示 `print('bob isolated')`，无需刷新。
- PG 与 POSIX 工作区核对：Alice、Bob 各有 2 个会话和 1 个沙盒记录；两个 Python 文件分别只存在于自己的工作区，两个 Git HEAD 分别为 `dc21f338c2cdf1563af13e1bf6a2962ee9434a30` 和 `bec2582cfb6bb330c5c29b00b783d6f7b824e031`。
- `pnpm run test:power-evolve` 的 22 项测试通过，包含真实 PG 下的原生文件 RPC、跨用户拒绝和会话事件。`pnpm run check:power-evolve` 通过。自动回归使用确定性模型和受控执行替身；上述浏览器试用使用真实 DeepSeek 模型、k3s、Agent Sandbox 与共享 POSIX 文件。

当前原生界面已接入文件列表和预览；上传、编辑、下载、桌面执行目标、设置、技能及插件页面仍需后续切片。文件预览受 2 MiB 上限约束。会话事件、文件变更与工作区更新目前采用有界轮询，不能据此宣称大规模连接容量。共享文件系统的路径检查仍需在生产部署前进一步加固。
