# S2 原生 DSH 云工作区与产物试用

固定产品提交：`836476e1bf`（`power-evolve/native-cloud-client`）。官方 DSH 基线为 `dsh-v0.1.7-rc.2` / `477b4f4205`。本试用使用独立 `native-s2` PG 卷、私有配置、POSIX 工作区和 k3s 命名空间 `pe-shared-host-native-s2`；PG schema 为 10。S1 的 `native-s1` 环境及数据未迁移或修改。

## 直接试用

1. 打开 <http://127.0.0.1:19181/login>，从本机私有文件 `~/.config/power-evolve/shared-host-native-s2/users.json` 读取 Alice 或 Bob 的试用密码。登录后进入原生 DSH Web <http://127.0.0.1:19180/native/>。请勿把密码或模型密钥发送到聊天或提交到仓库。
2. 在左侧新建两个云工作区，分别新建会话。给第一个会话发送字面 `hi`；这个流程只需模型与 PG，不启动沙盒。
3. 在第二个工作区的会话上传文本文件，要求 Agent 调用 `cloud_exec` 创建 `README.md`、执行 `git init`、提交文件。首次执行才按需创建该会话的云沙盒。回到第一个工作区，再创建并提交另一个文件；两个工作区的 Git 历史分别保留。
4. 从原生文件栏选择 `README.md` 并发布为产物，在右侧“产物”栏预览、下载。随后修改工作区源文件，再下载已发布产物；其内容与 SHA-256 应保持不变。沙盒回收后，工作区源文件和 Git 历史仍保留。
5. 用独立浏览器登录另一个账号，创建工作区并重复上传、Git 和发布。两人的工作区、会话、文件与产物互不可见。刷新页面或重启服务后，已完成对话和产物仍可访问。

主机、平台、受控测试 API 分别监听本机 `19180`、`19181`、`19182`；PG 只监听本机 `18473`。静态 Web 是本切片的独立构建快照。运行状态、服务日志、测试日志和不含凭据的验收材料在 `.artifacts/power-evolve/native-s2/`。使用同一环境变量管理本试用环境：

```sh
export PE_TRIAL_NAME=native-s2 PE_DATABASE_PORT=18473 PE_HOST_PORT=19180
export PE_PLATFORM_PORT=19181 PE_TARGET_PORT=19182
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷、私有配置和工作区文件。试用环境不承载生产数据。

## 实测证据

- Alice 与 Bob 在两个原生浏览器会话中分别新建两个云工作区。Alice 的两个工作区产生不同的 Git HEAD：`9c0b7db`、`46ca35e`；Bob 的第二个工作区为 `971f2c1`。字面 `hi` 完成时，命名空间中没有 Pod 或 Sandbox。真实 DeepSeek 对话与真实 k3s Agent Sandbox 编程均通过。
- Alice 发布的第一版 `README.md` 为 42 字节，SHA-256 为 `7e030fa9af00d348ea0336f7992bbb65f028831cd3247b9987473c313565e35d`；源文件随后修改，已发布下载仍为原始字节。Bob 的 `bob.txt` 产物为 19 字节，SHA-256 为 `7a2223d45687b57644ffca23008266412334bb3bf85d4b4167994aa6e92ea0a3`。重复发布同一请求 ID 返回原产物，改用该 ID 发布不同路径被拒绝为 409。
- Bob 读取 Alice 的 Session 文件、列举 Alice 工作区产物、预览／下载 Alice 产物、从 Alice Session 发布，以及在 Alice 工作区新建 Session 均被拒绝为 404；Alice 读取 Bob 产物同样为 404。同一用户的另一个工作区会话也不能读取或发布不属于该会话工作区的文件。
- Alice 两个会话之间切换云沙盒时，平台记录旧 Pod 的精确 UID 和 `KUBELET_STOPPED` 证据，再启动新 Pod；文件和 Git 历史保持。Alice 与 Bob 同时执行 `cloud_exec` 时，k3s 中有两个不同 UID 的 Running Pod，两个对话分别返回预期输出。重启 Host 和平台后，原生浏览器刷新仍显示历史与 Bob 的产物。
- `pnpm run test:power-evolve` 35/35、`pnpm run check:power-evolve`、`pnpm run test:power-evolve:web` 及 `pnpm run build:power-evolve:web` 通过。客户端及应用包经 `npm pack --dry-run` 检查包含编译产物、原生 Web 资产和安全文件 helper。PG、POSIX、Git、Pod 快照与截图见 `.artifacts/power-evolve/native-s2/qa/`；自动回归中的模型／执行替身与上述真实服务验收分别记录。

## 已知边界

本试用在单机 k3s 和独立共享存储卷上验收。多节点 POSIX 一致性、生产网络出口、平台多副本和容量上限属于 S7。S1 试用数据没有在本切片执行原地迁移；V8–V10 迁移已有回归，正式升级前仍需对实际备份演练。工作区文件安全 helper 需要 Python 3.9+，每次文件操作启动短进程；高并发性能需在 S7 测量。桌面功能保留 S1 已验收状态，当前开发优先推进云端。
