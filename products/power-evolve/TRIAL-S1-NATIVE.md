# S1 原生 DSH 云端组合试用

固定产品提交：`e4578a0eb1`（`power-evolve/native-cloud-client`）。官方 DSH 基线见 `baseline.json`，为 `dsh-v0.1.7-rc.2` / `477b4f4205`。本环境使用独立的 `native-s1` PG 卷、私有配置、POSIX 工作区和 k3s 命名空间；PG schema 为 7。Web 静态快照与该提交的构建产物一致。桌面功能暂时冻结，云端是下一阶段的交付主线。

## 直接试用

1. 打开 <http://127.0.0.1:19171/login>。从本机私有文件 `~/.config/power-evolve/shared-host-native-s1/users.json` 读取 Alice 或 Bob 的试用密码，不要把密码或模型密钥发到聊天或提交进仓库。登录后进入原生 DSH Web <http://127.0.0.1:19170/native/>。
2. 新建会话，只发送字面 `hi`，再问一句追问，刷新页面确认两轮都在。此过程不应创建执行沙盒。
3. 上传一个文本文件，在右侧原生文件栏预览、编辑、保存并下载。预览和下载应显示保存后的字节；这些文件操作不创建执行沙盒。文件变更订阅采用轮询，保存后预览最多可能延迟约 2 秒更新。
4. 在同一会话要求 Agent 运行 `cloud_exec`：读取刚编辑的文件，创建并运行一个小 Python 程序，使用 Git 提交。首次实际执行时才创建 Agent Sandbox；稍后回到对话和文件栏，可看到命令结果、文件及 Git 历史。
5. 用独立浏览器会话登录另一个账号，重复上述操作。两人的工作区、会话和文件互不可见。生成中的轮次会显示原生“停止生成”；点击后可继续在同一会话提问。

运行状态与日志位于 `.artifacts/power-evolve/native-s1/`。当前 Host、可信平台、受控测试 API、桌面设备分别监听本机 `19170`、`19171`、`19172`、`19173`；PG 只监听本机 `18472`。重启或停止此独立试用环境时使用相同配置：

```sh
export PE_TRIAL_NAME=native-s1 PE_DATABASE_PORT=18472 PE_HOST_PORT=19170
export PE_PLATFORM_PORT=19171 PE_TARGET_PORT=19172
export PE_DEVICE_ENABLED=1 PE_DEVICE_PORT=19173
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷、私有配置与工作区文件。真实模型、集群凭据和试用密码只在本机私有目录；试用环境不承载生产数据。

## 实测证据

- Alice、Bob 各自全新原生浏览器登录，完成 `hi`、追问、文件上传／编辑／下载和真实 DeepSeek 云端编程。字面 `hi` 与文件阶段各自的 Sandbox 记录均为 0；云命令按需启动真实 k3s Agent Sandbox。Alice 新 Git HEAD 为 `1a2a32f9`，Bob 为 `bf4a09da`；双方文件只存在于各自工作区。
- 有效本人令牌读取会话和文件为 200；跨用户会话快照、文件列表、文件读取和取消请求均为 404。真实浏览器刷新后对话仍在，Host 和平台分别重启后持久数据仍可访问。
- 原生 Stop 可见并能取消真正仍在生成的轮次：独立慢模型试用中，PG 记录 `failed/turn_user`，持久 `turn/end` 为 `aborted/user`，同会话续问完成。真实 DeepSeek 快速自然结束的竞态中，操作终态与持久轮次均为 `completed`；超出 token 上限时两者也一致，随后可续问。
- S1 相关真实 PG 回归 24/24 通过，包括跨 Host 取消、租约围栏、重复受理、崩溃恢复、云端与桌面执行边界；`pnpm run check:power-evolve` 通过。新会话导航聚焦测试 64/64、相关 Web 用例 1/1 通过；真实原生浏览器中，即时选择本地执行的 3 个 Session 均正确受理到本地。自动回归中的模型替身与上述真实模型试用分别记录。
- 最终资源、静态资产指纹、PG 计数及 k3s 快照见 `.artifacts/power-evolve/native-s1/s1-final-resource-snapshot-e4578a0eb1.json`；浏览器截图在同目录。取样时两用户、5 个 Session、343 个事件、29 个操作、9 次成功云执行，3 个沙盒实例已回收，1 个仍就绪；工作区与 Git 内容保留。

全量 Web replay 测试尚未完成：补装 Playwright 浏览器后，测试 worker 在首个无关用例中持续重启；受影响的导航聚焦测试、相关 Web 用例和真实浏览器回归已分别通过。生产部署仍需 S2–S7 的多工作区、产物、扩展中心、多副本、共享存储一致性、隔离加固与容量验收。
