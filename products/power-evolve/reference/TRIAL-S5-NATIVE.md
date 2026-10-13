# S5 原生 DSH 云端可执行技能试用

固定产品版本：Git tag `power-evolve-native-s5-trial`（分支 `power-evolve/native-cloud-client`）。官方 DSH 基线为 `dsh-v0.1.7-rc.2`。本试用使用独立 `native-s5` PG 卷、私有配置、POSIX 工作区／技能库和 k3s 命名空间 `pe-shared-host-native-s5`；PG schema 为 12。S1–S4 的试用环境保持独立。

## 直接试用

1. 打开 <http://127.0.0.1:19211/login>。从本机私有文件 `~/.config/power-evolve/shared-host-native-s5/users.json` 读取 Alice 或 Bob 的试用密码；不要把密码或模型密钥发送到聊天或提交到仓库。登录后进入原生 DSH Web <http://127.0.0.1:19210/native/>。
2. 打开左侧“技能”。Alice 的 `s5-alice-report` 和 Bob 的 `s5-bob-report` 均为已启用的 1.0.0 技能包。查看详情、版本和说明；也可通过“安装技能”导入自己的 ZIP（包内需有 `SKILL.md`）。安装和阅读说明不会创建沙盒。
3. 点击本人技能的“试用技能”，在打开的原生会话中明确要求运行包内的 `scripts/report.sh`。确认发送前的草稿命令是自己的技能路径；Agent 会通过 `cloud_exec` 按需创建云沙盒。试用包分别打印 `ALICE_S5_EXECUTED`、`BOB_S5_EXECUTED`，并在 `/workspace` 写出文本文件。
4. 打开右侧“工作区文件”预览生成的 `s5-alice-report.txt` 或 `s5-bob-report.txt`，点击“发布为产物”，在产物入口下载。刷新页面后技能列表和产物仍可见。另一个账号不能列出或直接下载本人的技能与产物。
5. 新开会话发送 `hi`，或停用本人技能后再次新开会话发送 `hi`。两种普通对话均不创建执行沙盒；停用影响新受理任务的技能选择。需要继续试用时可重新启用。

Host、可信平台、受控测试 API 分别监听本机 `19210`、`19211`、`19212`；PG 只监听本机 `18476`。状态、日志、原生 Web 静态快照和脱敏验收记录位于 `.artifacts/power-evolve/native-s5/`。在仓库根目录运行：

```sh
export PE_TRIAL_NAME=native-s5 PE_DATABASE_PORT=18476 PE_HOST_PORT=19210
export PE_PLATFORM_PORT=19211 PE_TARGET_PORT=19212
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷、私有配置、工作区和已发布的包。试用环境不承载生产数据。启动异常时先看 `.artifacts/power-evolve/native-s5/{host,platform,api}.log`，再用同一环境变量运行 `restart`；不要清空试用卷来绕过迁移或恢复错误。

## 实测证据

- 两个独立浏览器会话通过原生“技能”页各自上传 ZIP，真实 DeepSeek 会话分别调用云端执行。PG 中两条执行均为 `succeeded`，输出包含各自的 `ALICE_S5_EXECUTED`、`BOB_S5_EXECUTED`；各自产生独立工作区文件，并发布为 18 和 16 字节的产物。两人的技能版本和文件在平台重启后仍可读。
- k3s Pod 只读挂载该用户的包目录 `/opt/power-evolve/skills`；在 Bob 的 Pod 中无法看到 Alice 的摘要目录，也不能修改 Bob 的包文件。Bob 从本人会话读取 Alice 技能及产物内容均返回 404。空包说明 ZIP 在原生页面显示明确错误，已有列表未变化。
- Alice 在启用和停用技能后各发送一次 `hi`；任务均完成，后者冻结的技能选择为空，期间没有创建新的沙盒。执行用的两个 Pod 已空闲回收，PG 状态为 `deleted`，文件与产物仍保留。脱敏 PG 摘要和浏览器截图见 `.artifacts/power-evolve/native-s5/qa/`。
- `pnpm run check:power-evolve`、`pnpm run build:power-evolve`、`pnpm run test:power-evolve:web`、`pnpm run build:power-evolve:web` 通过。后端测试串行执行 45/45，通过真实临时 PG 检查上传票据、同 ID 重试、不可变版本、拒绝坏包／符号链接／超限包、撤销、沙盒挂载与旧 Pod 隔离。原生 Web 构建为 36 个客户端模块、231 个静态文件。自动测试的模型替身与上述真实模型试用分别记录。

## 已知边界

本片验证云端技能包，桌面适配暂缓。技能撤销阻止后续任务自动选用；通用 `cloud_exec` 对同用户已挂载的旧包字节没有逐脚本撤销控制。单机试用的 Host 与平台使用同一 Unix UID，不能作为生产级进程失守隔离证据；正式部署需分离运行身份、存储访问权及网络策略。多节点 POSIX 一致性、平台多副本、生产出口和容量属于 S7。S6 下一步接入原生“插件”页与受控连接器。
