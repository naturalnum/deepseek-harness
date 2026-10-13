# S4 原生 DSH 云端个人技能试用

固定产品版本：Git tag `power-evolve-native-s4-trial`（开发分支 `power-evolve/native-cloud-client`）。官方 DSH 基线为 `dsh-v0.1.7-rc.2`。本试用使用独立 `native-s4` PG 卷、私有配置、POSIX 技能库和 k3s 命名空间 `pe-shared-host-native-s4`；PG schema 为 11。S1–S3 的试用数据和运行环境不受影响。

## 直接试用

1. 打开 <http://127.0.0.1:19201/login>。从本机私有文件 `~/.config/power-evolve/shared-host-native-s4/users.json` 读取 Alice 或 Bob 的试用密码；不要把密码或模型密钥发送到聊天或提交到仓库。登录后进入原生 DSH Web <http://127.0.0.1:19200/native/>。
2. 点击左侧“技能”。Alice 已有“文稿校对”，Bob 已有“代码梳理”。搜索技能、打开“查看详情”阅读说明；两个账号的清单互不相同。
3. 新建会话，询问本人的技能步骤与识别码。Alice 的试用说明含 `ALICE_S4_SKILL`，Bob 的含 `BOB_S4_SKILL`；真实模型回复应只引用本人的说明。
4. 在技能页停用一项技能，再新建会话发送普通消息。停用只影响新受理的任务；重新启用后新任务又可选择它。可以用“安装技能”添加一份自己的**文本说明**，刷新页面或重启后仍能看到。

Host、可信平台、受控测试 API 分别监听本机 `19200`、`19201`、`19202`；PG 只监听本机 `18475`。运行状态、日志、原生 Web 静态快照和不含凭据的验收材料在 `.artifacts/power-evolve/native-s4/`。使用同一环境变量管理该试用环境：

```sh
export PE_TRIAL_NAME=native-s4 PE_DATABASE_PORT=18475 PE_HOST_PORT=19200
export PE_PLATFORM_PORT=19201 PE_TARGET_PORT=19202
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷、私有配置和技能文件。试用环境不承载生产数据。

## 实测证据

- 两个独立原生浏览器会话在“技能”页分别安装并读取不同说明。Alice 与 Bob 的真实 DeepSeek 回复分别包含 `ALICE_S4_SKILL` 和 `BOB_S4_SKILL`。Bob 从本人浏览器直接请求 Alice 的技能 ID 返回 404；Alice 的技能不出现在 Bob 清单。
- PG 中最初两条已完成操作分别固定了 Alice、Bob 的技能摘要。Alice 在界面停用后，下一条已完成操作的 `skill_selection` 为空；重新启用后状态修订为 3。技能说明、普通对话期间 `pe_sandbox_instances` 为 0，k3s 命名空间没有 Pod。
- Host 和平台重启后，原生浏览器刷新仍显示两人的历史及各自技能和状态。截图、PG 与 k3s 核对材料在 `.artifacts/power-evolve/native-s4/qa/`。
- `pnpm run check:power-evolve`、`pnpm run test:power-evolve:web`、`pnpm run build:power-evolve:web` 通过；后端 39/39 测试通过，原生 Web 打包为 36 个客户端模块、231 个静态文件。`npm pack --dry-run` 确认扩展中心客户端编译产物及 Web 静态资产均在发布包中。自动回归的模型替身与上述真实模型试用分别记录。

## 已知边界

本片只安装最多 8 份个人**文本技能说明**；旧版扩展市场、ZIP／`.skill` 包导入、技能代码执行、卸载和插件页尚未迁入。S5 接入可执行技能的云沙盒路径，S6 接入插件与连接器。共享 Host 没有挂载原生全局 `skill-filesystem`，技能内容由可信平台按用户授权读取；当前 `revision` 是启停状态修订，不是内容升级版本。多节点 POSIX、生产网络出口、容量和故障演练属于 S7。桌面端保持 S1 已验收状态，当前开发只推进云端。
