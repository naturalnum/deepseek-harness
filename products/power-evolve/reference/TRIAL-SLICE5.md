# 切片 5 试用指南

本切片把本地设备接入共享宿主和可信平台。每条消息选云端或已授权的本地项目。`hi` 不启动执行环境；`cloud_exec` 按需创建 Agent Sandbox，`desktop_exec` 由本机设备在仅挂载所选目录的临时 Docker 容器中执行。云端和本地文件只通过本机界面的明确操作传输，不自动同步。

## 准备与启动

依照[切片 4 指南](TRIAL-SLICE4.md)安装 Node 22.19+、pnpm 11、Docker、k3d、Agent Sandbox 控制器和 gVisor，并准备命名空间 `pe-shared-host-slice5` 及其受限平台凭据。将 `~/.config/power-evolve/shared-host-slice5/sandbox.json` 的 `workspaceRoot`、`localRoot` 和 `nodeRoot` 都指向同一持久卷下的 `pe-shared-host-slice5` 子目录；镜像可复用 `pe-shared-host-slice4-runner:s4-2ffb04551212`。在同一私密目录提供 `model.env`，其中配置真实 DeepSeek 密钥。不要提交或发送这些文件。

```sh
pnpm install --frozen-lockfile
pnpm run build
export PE_TRIAL_NAME=slice5 PE_DATABASE_PORT=18436 PE_HOST_PORT=18892
export PE_PLATFORM_PORT=18893 PE_TARGET_PORT=18895 PE_DEVICE_ENABLED=1 PE_DEVICE_PORT=18894
export PE_SECOND_DEVICE_ENABLED=1 PE_SECOND_DEVICE_PORT=18896
pnpm run power-evolve:trial up
```

网页对话：<http://127.0.0.1:18892/>；可信登录与审批：<http://127.0.0.1:18893/login>、<http://127.0.0.1:18893/approval>；Alice 本机设备页：<http://127.0.0.1:18894/>；同机双用户试用时 Bob 的第二设备页：<http://127.0.0.1:18896/>。本机试用账号在私密的 `~/.config/power-evolve/shared-host-slice5/users.json`，不要把密码复制到聊天中。第二设备仅用于同机并发验收；普通单设备试用可省略 `PE_SECOND_DEVICE_ENABLED` 与对应端口。

1. Alice 登录网页，打开“设备”，生成配对码。在本机 Alice 设备页输入配对码并授权一个已有项目目录。Bob 在独立浏览器会话和第二设备页做同样操作。各自的对话“执行目标”只应出现自己的设备和目录；目录绝对路径只在本机设备页显示。
2. 两人分别选自己的本地项目，让 Agent 实际调用 `desktop_exec` 创建一个文本文件并读取它。平台先返回受理回执，随后在原会话追加执行结果。核对设备页选择的两个目录、网页输出和 PG 的 `pe_desktop_executions`；一人不能看见另一人的设备、命令或文件。
3. 在 Alice 设备页“手动传输文件”中，把本地文件复制到一个新云端路径，再从该云端路径复制到另一个新本地路径。核对字节和摘要一致。在 Bob 网页“文件”中不应出现 Alice 的云端文件。再次复制到已存在目标应拒绝覆盖。单文件上限 2 MiB。
4. 选择云端目标，沿用切片 4 的 Git、测试、取消及沙盒回收试用。切回本地目标时，云端 `/workspace` 与本机容器 `/workspace` 是不同目录；界面中的目标选择决定命令路由。
5. 尝试设备离线：先停止对应设备进程，再发送本地任务。任务应在可信平台保持排队；重启原设备后才开始。取消排队任务应不写文件。运行中断后，设备查询本地容器及持久日志，结果无法确认时标为 `uncertain`，不自动重放写命令。
6. 在 Bob 的云端“设备”面板撤销项目目录。本机设备页应移除该目录，旧目录编号不能再读取云端文件或受理命令。重新在本机授权同一路径会得到新的编号。

试用结束前等待运行命令退出，再执行 `pnpm run power-evolve:trial stop`。`status` 和 `restart` 使用同一组环境变量。日志在 `.artifacts/power-evolve/slice5/`；停止脚本不删除 PG 卷、私密设备凭据、POSIX 工作区或尚未回收的云沙盒。平台 `/health` 报表结构版本 `7`。

## 验证与数据边界

`PE_PRIVATE_DIR="$HOME/.config/power-evolve/shared-host-slice5" pnpm run test:power-evolve` 使用独立临时数据库运行确定性回归。真实试用已从两个浏览器账号和两个本机设备执行命令：Alice 输出 `/workspace`、`verified` 且退出码 0；Bob 输出 `bob verified` 且退出码 0。Alice 的本地文件经过本机到云端再返回本机后，两个本地文件的 SHA-256 相同。第一次受理的 Alice 命令遇到设备错误后被报告为 `uncertain`，未重放；修复后新会话的命令才开始执行。该故障记录保留在试用库中。

离线实测中，Bob 的命令在设备停止时保持 `queued` 且没有本地文件，重新连接后成功且只写入一次。另一条排队命令在网页取消后保持 `cancelled`，设备恢复后仍未创建文件；撤销目录后，本机设备页同步移除了授权记录。

本切片使用独立空 PG 数据库；平台可将已有版本 `6` 迁至 `7`。迁移真实数据前先停止写入，同时备份 PG、POSIX 工作区和设备私密状态。旧程序不能直接读取新表，回滚须一并恢复这些备份。稳定的切片 4 试用在另一检出目录、端口、数据库和命名空间，未迁移。

当前本机设备凭据为软件令牌；还没有硬件证明、生产 TLS 接入或跨操作系统用户的服务隔离。设备本机路径检查尚未使用逐层目录描述符，可写目录中的并发符号链接变化仍需加固。云端 POSIX 服务也保留切片 4 指南所述路径竞态。`uncertain` 命令会占用该会话的执行槽，须先人工核对结果；目前可以在新会话继续工作，原会话的人工结案入口待后续切片完善。本机网页属于设备 Profile，完整桌面应用界面尚在后续产品工作中。
