# Mac 安装版原生侧栏浏览器试用

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

本版在真实 ARM64 `PowerEvolve.app` 中启用原生 DSH 侧栏浏览器。共享 Host 承接会话，可信平台核验会话归属，Electron main 决定浏览器分区；普通 Web 不激活这项桌面能力。App、Host 运行文件和验收快照均位于源码目录外，使用新 PG、POSIX 子目录及 k3s namespace；[O4 组合版](TRIAL-DESKTOP-OFFICE.md)停服保留，数据和配置未迁移。

## 固定版本

| 材料 | 固定值 |
| --- | --- |
| App、Host 与 Linux Platform 源码 | `b62399bc281190ce18e0290969ce17ed366880cc`，官方基线仍为 `dsh-v0.1.7-rc.2` |
| App | `~/.local/share/power-evolve/trials/desktop-browser-20261005-o5-r1/PowerEvolve.app`；Electron 44.0.0、Node 22.22.1；实际 `isPackaged=true` |
| App 清单／装配记录 SHA256 | `e506ab537e0ed3906877e7937eb206a75347bfc08af2bb3f35639c8d3ca35a8f`／`300fa4668e2624ccdbf72f8a6becda1b438a8094de969b28ed1c287de96d8918`；34,103 个文件，业务验收后逐项校验通过 |
| Host runtime | `~/.local/share/power-evolve/trials/native-browser-20261005-o5-r1/`；manifest SHA256 `4204ad2f006da02d1d9d01c2d625141f5d63bf156d77ef02a0d71a0a0ec16db7` |
| Platform 镜像 ID | `sha256:12df843f7b4c1fd722811c8ab39a9f4b0df4fa401a67428d56c4b1938698bd98` |
| 数据与执行范围 | PG schema V33；namespace `pe-native-browser-o5-20261005-r1`；共享卷子目录 `o5-browser-20261005-r1` |
| 安装状态 | namespace `browser-o5-20261005-r1`；产品签名、公证未执行 |

## 实际验收

| 真实 App／Host／Platform／模型／PG 场景 | 结果 |
| --- | --- |
| 两账号普通对话 | Alice、Bob 分别实际登录、提交 `hi` 并取得真实模型回复；两个输入均完成，回复在原生页面及 PG 中读回 |
| 普通标签页关闭和重开 | 原 guest 销毁；同一 Workspace 的 Cookie 和 localStorage 保留，重开使用同一分区 |
| 两会话／两工作区 | 同用户同 Workspace 的两会话共享浏览器状态；另一个 Workspace 使用独立分区，初始 Cookie 和 localStorage 为空 |
| 注销及账号切换 | 注销销毁所属 guest，并从实际旧 Session 读回空存储；Bob 初始状态独立，Alice 返回后使用新分区 |
| 跨用户会话 | Alice、Bob 分别请求对方 Session 的原生 browser acquire，均被拒绝 |
| 普通 Web | 真实 Web 登录可使用原生页面，没有桌面 bridge、浏览器引导条目或浏览器标签页 |
| 活跃 guest 退出 | 保留一个真实所属 webview 后正常 `app.quit`；完成清退，所属进程无残留，未强制结束 |
| 无执行环境 | 前后 PG 均为零 Sandbox、零云执行、零本机执行；轮询期间无 Device 子进程；最终 namespace 零 Pod |
| 系统打开 | 实际 LaunchServices 无驱动参数打开固定 `.app`；空闲时没有 Device 子进程，精确进程 SIGTERM 退出。正常应用退出另由上一行的真实活跃 guest 验收覆盖 |

浏览器测试内容由独立临时 HTTP 页面提供；它仅用于真实 Chromium Cookie／localStorage 读写，不代替模型、登录或授权。QA 观察了实际 Session 和 PG，没有替换产品处理器。临时 HTTP、Web 浏览器、观察窗口及 App 均已关闭。

回归另外覆盖授权请求超时、撤权和清理失败后关闭准入、主 frame／IPC 校验，以及 Host／Platform／Device HTTP 和 WebSocket 端点及 loopback 别名拒绝。真实 Electron fixture 共 10 项通过，fixture 的授权 HTTP 服务使用替身；真实 PG 授权与 Host 接线共 13 项通过，其中两项 Host 接线使用受控平台响应。它们与上表的实际安装版验收分别记录。完整 Web 测试未全部完成；访问模式测试的临时停用与配置自动同步冲突已修复，仅改测试文件，独立真实 Web scaffold 连续三次共 18 项通过。安装版保持上述固定源码，测试修正不改变产品字节；这些结果不能视为完整桌面产品验收。

## 启停与试用

1. 执行 `~/.local/share/power-evolve/trials/native-browser-20261005-o5-r1/node/bin/node ~/.local/share/power-evolve/trials/native-browser-20261005-o5-r1/backends.mjs start`。同一命令最后参数改为 `status` 查询，改为 `stop` 正常停止所属服务并保留数据。Host 为 `http://127.0.0.1:21030/native/`，Platform 为 `http://127.0.0.1:21031/login`。
2. 双击固定 App，或执行 `open ~/.local/share/power-evolve/trials/desktop-browser-20261005-o5-r1/PowerEvolve.app`。账号为 `alice`／`bob`；密码只在本机 0600 文件 `~/.config/power-evolve/shared-host-native-browser-o5-20261005/users.json`，勿分享该文件。过期登录重新认证。
3. Alice 选择已有会话或新建会话，发送 `hi`。打开右侧边栏，在“新标签页”中选择“浏览器”，输入一个 HTTP(S) 地址。关闭再打开标签页，同一 Workspace 的站点状态保留。
4. 在另一个 Workspace 打开同一站点，核对其登录状态独立。通过原生账号菜单注销并登录 Bob，浏览器状态也独立。注销后返回 Alice，旧浏览器状态已清除；应用退出后也不会保留这些站点登录。
5. 正常退出应用。后台可保持 ready 供继续试用；不用时通过 `backends.mjs stop` 停服。不要同时打开相同安装 namespace 的第二个 App；旧 O4 需要使用其自己的 App 和后台入口。

私有日志位于 `~/.config/power-evolve/shared-host-native-browser-o5-20261005/frozen-logs-o5-r1/` 及精确 Platform 容器 `pe-native-browser-o5-platform-r1`。原始安装版验收在新 App 试用目录的 `acceptance/browser-first-r1/`，只读证据清单另保存在 `acceptance/frozen-r1/`；运行中的 PG、POSIX 文件和 userData 仍可变化，这不是数据库备份。

## 限制与下一步

此配置的授权请求期限为 5 秒，活动复检每轮完成后等待 15 秒；顺序检查及网络耗时也计入观察间隔，不承诺服务端撤权即时生效。guest 不获得产品凭据、Preload、Node 或设备权限，端点拦截不解析 DNS，也不等同于 OS 网络沙盒。实现及部署语义见[承载器说明](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/desktop/README.zh.md)。

Node 24.19.0 的开发 HMR 定向验收通过；Node 22.22.1 的开发 HMR 在现有 import-without-cache 装载器失败。本版已构建的安装应用和 Host 使用 Node 22.22.1，实际验收通过；两类验收分别记录。

本机进程连接器、Desktop 完整报告、OS 目录对话框真人选择／取消、签名／公证／更新继续按[桌面约定](DESKTOP-COMPLETION.md)推进；生产 HTTPS 和多物理节点仍保留部署验收范围。O4 的 Office／Git 证据属于 O4，本片没有重做这些流程。
