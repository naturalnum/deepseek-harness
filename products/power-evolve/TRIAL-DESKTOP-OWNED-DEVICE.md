# Electron 所属 Device 固定试用

本机开发试用使用官方 Electron 44.0.0 外壳、原生 DSH 页面和正式 `dsh --profile` 启动方式。共享 Host、可信 Platform、PG 与本机 Docker 执行保持独立；显式打开本机授权时才启动所属 Device。本版是源码目录外的独立运行快照，尚不是可安装 `.app`。

## 固定版本与实际证据

初次业务验收固定在 `69cfa9b81a`：两账号真实 `hi` 无执行容器、配对及两个本机项目授权、各自 Git 初始化／Python 断言／提交、重启读回和运行中退出。目录通过实际本机授权页面输入，尚未完成真人 OS 目录对话框选择。

当前独立快照固定源码 `471bba29508cc253b701caf08f3ebdf163f013a5`，包含原生退出提示、native loader 定位和按声明的包解析静态资源的修复。Electron、Node 22.22.1、CLI／Device／Host／Platform 的 644 包闭包以及 Python 3.12.14 均有独立物理文件；安装数据、项目、凭据、PG 与 Docker 保持外部资源。捕获的 28,250 文件共 501,199,324 字节；依赖别名仅指向冻结目录内部。

| 冻结版真实验收 | 结果 |
| --- | --- |
| Host／Platform 与资源 | 正式 Profile 就绪；原生页面、登录页和审批浏览器代码均为 HTTP 200 |
| 两账号重开和 Git 读回 | 原设备授权及不同计算器仓库保留；各一个实际桌面执行、零云执行，停止事实确认、原会话唯一续接 |
| 用户隔离 | 本人历史 RPC 200、另一账号历史 404；Cloud 设备清单不包含本机绝对路径 |
| 运行中退出 | Alice 的实际 sleep 被停止，所属 Node 退出、容器 `Running=false`、执行 cancelled／137、续接一次；Bob 原 Device PID 保持并完成自己的实际任务 |
| 再次打开 | 两账号原生历史回到空闲，未因浏览历史启动 Device |
| 冻结文件 | 真实组合验收后完整文件与别名摘要核对通过 |

冻结目录为 `/Users/jingchao/.local/share/power-evolve/trials/desktop-owned-device-20261004-r3`。`closure/capture.json` SHA256 为 `aaf22447d126bebad7a142b1f8118b56b16fddb8284026b45262fa679b321f14`，外层 `manifest.json` 为 `f072d72406e3d224f201f6464b146079f51cbc9641dfa62111a8de43d255e929`。新组合证据保存在本仓库私有 `output/playwright/desktop-owned-device-frozen-r3/`，原业务证据在 `output/playwright/desktop-owned-device/`，不随源码公开。

独立回归分别覆盖真实 Electron 原生权限检查 13/13、生产 main 退出检查 4/4、搬离相邻目录的实际 HTTP 资源检查 5/5、运行闭包检查 12/12，均无跳过。权限检查的 chooser／Device 对象和退出检查的 CLI／对话框回答是替身；真实组合验收使用实际 Profile、PG、模型和 Docker，只有退出对话框的按钮回答由测试提供。

## 启停与试用

1. 启动后端：执行 `~/.local/share/power-evolve/trials/desktop-owned-device-20261004-r3/node/bin/node ~/.local/share/power-evolve/trials/desktop-owned-device-20261004-r3/backends.mjs start`。`status` 查询状态，`stop` 只停止本版验证过身份的 Host／Platform，保留数据。当前入口为 Host `http://127.0.0.1:20980/native/`、Platform `http://127.0.0.1:20981/login`。
2. 双击冻结目录中的 `start-alice.command` 或 `start-bob.command`。两账号使用不同私有浏览器目录；已有登录过期时，用本机 0600 文件 `~/.config/power-evolve/shared-host-desktop-owned-20261004/users.json` 中相应账号登录，勿分享此文件。
3. 新建会话说 `hi`，应得到模型回复而没有本机 Device 或执行容器。打开已有 `desktop-owned-alice`／`desktop-owned-bob` 工作区的会话，可查看各自实际执行历史。
4. 在执行位置区域打开本机授权。已有设备及项目授权保留；选择本人本地项目，请 Agent 只读检查已有 `calculator.py`、运行断言并查看 Git 提交。成果来自所选本机项目，Cloud 只收到目录标识和标签。
5. 用原生应用菜单退出，再通过同一启动文件重开；授权、Git 和历史应保留。运行中退出会先确认并等待所属 Device；未确认的停止记录会保留并提示，不能据进程退出认定容器已停止。

配置与 Device journal 在 `~/.config/power-evolve/desktop-owned-20261004/` 及对应独立后台私有目录；实际项目仍在本仓库 `.artifacts/device-materials-integration/desktop-owned-20261004/posix/local/`。Host／Platform 日志在 `.artifacts/power-evolve/desktop-owned-20261004/`。不要删除这些数据或同时启动旧版本占用本版端口。正式云端 V28 固定试用保持原入口和数据，本版没有替换它。

## 尚未完成

正式安装模式的可信配置入口、稳定 Profile 准备、ARM64 `.app` 装配及签名／公证／更新继续按[桌面约定](DESKTOP-COMPLETION.md)交付。原生侧栏浏览器、Office 预览、Desktop 报告和通用本机进程连接器尚未完成。已有 Office／持久 Home 证据属于[上一组合试用](TRIAL-DEVICE-MATERIALS-NATIVE.md)，本轮没有重新验证 Home 写入。生产 HTTPS 和独立物理多节点不在本机验收范围。
