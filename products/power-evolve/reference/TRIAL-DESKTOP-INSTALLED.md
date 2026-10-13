# Mac ARM64 安装模式固定试用

本版是源码目录外的实际 `PowerEvolve.app`，使用原生 DSH 页面、包内 Electron／Node／CLI／Device／Python和独立应用数据目录。共享 Host、可信 Platform、PG 与 Docker 保持外部资源；云端登录、历史和 `hi` 不启动 Device，首次打开本机授权时才准备并启动正式 Device Profile。本版未做产品签名或公证。

当前组合试用见[Mac 安装版与云端 Office](TRIAL-DESKTOP-OFFICE.md)。本页保留 R3 的固定范围；其空闲后台已停止，数据和启动器保留，可按下文重开。

## 固定版本与验收范围

应用位于 `/Users/jingchao/.local/share/power-evolve/trials/desktop-installed-20261005-r3/PowerEvolve.app`，产品 ID 为 `com.powerevolve.desktop`，版本为 `0.1.0`／`20261005.3`。桌面实现固定源码 `b958cc6e9728fc04729d3b9b0d00bcf82da0e456`；CLI／Device 及后端的独立包闭包固定源码 `471bba29508cc253b701caf08f3ebdf163f013a5`，沿用[所属 Device 快照](TRIAL-DESKTOP-OWNED-DEVICE.md)。Electron 为 44.0.0、Node 为 22.22.1、Python 为 3.12.14；这些运行文件均在应用内，不依赖源码运行器。

`Contents/Resources/power-evolve-assembly.json` SHA256 为 `bb52571567961920a8e37da1dd6a32e80b4af9ccb0c88f06963ce722106a32ff`，34,070 个文件的清单摘要为 `541fb8ad86f132d55e029231b17040c471ab0b32122418c1f4ac4d1e3328aff6`。装配器核对物理资源、包闭包、文件字节／权限／别名和应用身份，以排他重命名发布新目录。运行时读取固定描述符，不接受开发配置、数据目录或 Device 选择参数。

| 实际安装版验收 | 结果 |
| --- | --- |
| 安装模式 | 真实 Electron 报告 `isPackaged=true`，使用包内资源及默认产品 userData；没有替换这些安装事实 |
| 系统打开 | macOS LaunchServices 直接打开 `.app`，无开发参数或调试开关；出现原生 helper／renderer，零 Device 子进程，空闲退出确认 |
| 云端对话 | 两账号各完成真实模型 `hi`，PG 中零云执行和桌面执行；启动云页面不创建本机子进程 |
| 首次本机授权 | 自动准备稳定私有 Profile，启动包内 Node 与 CLI；配对和目录授权走独立本机窗口，Cloud 只获得设备／目录标识和标签 |
| 本机编程 | 实际 Git 初始化、Python `add(2,3)==5`、Git 提交；执行成功／0，平台确认容器 `Running=false`，原会话唯一续接 |
| 升级与重开 | 使用已有 userData 从 R2 升到 R3；设备身份、授权和会话保留，新进程读回仓库、Python 结果和原提交，无旧命令重放 |
| 用户隔离 | Bob 本人历史 200、Alice 历史 404，Bob 设备列表为空；Cloud 设备清单不含本机绝对路径 |
| 退出与文件 | 编程及重开后正常退出，所属 Device OS 进程已结束；真实业务后完整安装清单核对通过 |

本机 Runner 使用已存在的不可变镜像 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`。安装配置明确指定 Device 命令搜索目录为 `/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`；Docker CLI 和本机 daemon 是外部依赖，不包含在包内。首次 R2 编程因 Finder 的系统 PATH 找不到 Docker，在启动前被永久封存；R3 先保留并对账原状态，再受理新的任务，未重放失败命令。配置读取不探测 Docker，也不运行用户登录 shell；其他机器应按实际 Docker 安装位置重新装配。

安装组合证据在本仓库私有 `output/playwright/desktop-installed-20261005-r3/`。首次 Profile／配对及无 Profile `hi` 的 R2 证据在相邻 `desktop-installed-20261005-r2/`；R3 保存原配对回执的完整字节及摘要，明确记录其来自 R2。安装配置源码回归 16/16、生产 main 的真实 Electron 安装分支回归 8/8、装配器临时文件系统回归 12/12 均通过且无跳过；这些回归的 CLI 协议或 Mach-O 文件头使用替身，不能替代上表的实际 Profile、PG、模型和 Docker 验收。

## 启停与试用

1. 执行 `~/.local/share/power-evolve/trials/desktop-owned-device-20261004-r3/node/bin/node ~/.local/share/power-evolve/trials/desktop-owned-device-20261004-r3/backends.mjs start`。`status` 查询状态；`stop` 只停止本版验证过身份的 Host／Platform，保留数据。入口为 Host `http://127.0.0.1:20980/native/`、Platform `http://127.0.0.1:20981/login`。
2. 双击上述 `PowerEvolve.app`，或执行 `open ~/.local/share/power-evolve/trials/desktop-installed-20261005-r3/PowerEvolve.app`。登录使用本机 0600 文件 `~/.config/power-evolve/desktop-installed-20261005/users.json` 中的 `installed-alice`／`installed-bob`，勿分享该文件。应用当前保留 Alice 登录；切换账号通过原生账号菜单退出登录。
3. 新建会话说 `hi`；随后打开 Alice 的 `desktop-installed-20261005` 工作区查看实际任务历史。本机授权通过菜单或执行位置区域打开；已授权项目可选择后只读检查 `calculator.py`、运行 Python 断言并查看 Git 提交。Bob 看不到 Alice 的设备或会话。
4. 用原生应用菜单退出，再打开同一应用；授权、仓库和历史保留。回收执行容器不删除项目。安装数据默认在 `~/Library/Application Support/PowerEvolve/`，Device Home、private journal 和跨进程写入槽均在该私有根下，不随应用版本迁移或清理。
5. 后端日志见[所属 Device 试用](TRIAL-DESKTOP-OWNED-DEVICE.md)的日志与配置位置；实际项目位于本仓库 `.artifacts/device-materials-integration/desktop-installed-20261005/alice/project/`。启动失败时保留 Profile、journal 与写入槽，查明依赖和状态后重开，不删除执行记录来绕过恢复。

R1／R2 失败候选、已完成的独立 Device 快照和正式云端 V28 均保留；当前不运行旧候选应用。不要同时启动另一个相同产品 userData 的版本或占用本版 Device 端口 `21091`。

## 尚未验收或完成

本轮本机目录通过实际授权页面输入；Mac 锁屏期间尚未完成原生 OS 目录对话框的真人选择／取消。运行中退出的真实停止证据仍归[所属 Device 试用](TRIAL-DESKTOP-OWNED-DEVICE.md)，本轮安装版没有重做该场景。[原生四格式及产物预览](TRIAL-NATIVE-PREVIEW-O3.md)具有独立浏览器试用，后续[安装应用组合](TRIAL-DESKTOP-OFFICE.md)具有实际 App 证据；本页 R3 没有重新验证 Office 或持久 Home 写入。产品签名、公证、更新发行、原生侧栏浏览器、Desktop 报告和通用本机进程连接器继续按[桌面约定](DESKTOP-COMPLETION.md)推进。生产 HTTPS 和独立物理多节点保留各自验收范围。
