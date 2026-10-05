# PowerEvolve 桌面 Cloud 载体

[English](README.md) | 中文

## 概述

在官方 Electron 窗口外壳中打开共享 PowerEvolve 原生 DSH 应用。登录由可信 Platform 处理；对话、历史和产品客户端插件来自部署的 Host。原生键盘、菜单、主题和音频权限复用上游适配器。Cloud 文档不获得本机路径、Device 凭据或命令桥。

## 使用载体

通过 `pnpm run build:power-evolve:desktop` 构建。准备工作区锁文件选择的准确 Electron 版本，将 `PE_DESKTOP_ELECTRON` 指向其可执行文件。执行 `pnpm --filter @power-evolve/desktop run start --config /absolute/deployment.json`；开发可增加 `--data-dir /absolute/private-browser-root` 以隔离试用身份。通过原生应用菜单退出。使用同一部署和数据目录重新启动；浏览器会话过期时重新登录。

部署文件仅包含下面两个 Origin：

```json
{
  "hostOrigin": "http://127.0.0.1:20880",
  "platformOrigin": "http://127.0.0.1:20881"
}
```

HTTP 仅接受数字 loopback 地址。远程 Origin 要求 HTTPS。拒绝凭据、路径、查询参数、fragment、额外字段和相同 Origin。主进程配置独立于 renderer 输入。

## 本机 Device 开发

未打包启动可以增加 `--device-config /absolute/device.json`。这个独立主进程文件选择已经准备的官方 `dsh --profile` 运行时：绝对 `nodeExecutable`、`cliEntrypoint`、`homeDir`、`workingDir`、`profile` 名称及不同的数字 HTTP `loopbackOrigin`。文件明确提供 `startupTimeoutMs`、`requestTimeoutMs`、`quiesceTimeoutMs`、`exitTimeoutMs`、`maxOutputBytes`、`maxMessageBytes` 和 `maxHealthBytes`。[解析器](src/device-config.ts)拒绝环境字段、远程端点和无界预算。安装包启动拒绝这个开发覆盖项。

本机菜单或原生执行位置选择器启动所属 Device 子进程，并在独立、非持久浏览器 Session 中打开已有本机授权页。Cloud 只获得无参数且不返回本机值的打开操作。本机页面获得目录选择器；其处理器在原生对话框前后检查当前所属窗口、frame、准确 Device URL 和子进程代次。子进程重启后加载新的本机文档。配对和目录授权仍是明确的本机操作；凭据、nonce 和路径不经过 Cloud 桥。

[进程适配器](src/device-process.ts)核验所属子进程 PID、每次启动身份、就绪及有界健康响应。私有[生命周期消息](../contracts/src/device-lifecycle.ts)在终止前关闭准入并排空所属操作。退出等待实际子进程退出及本机窗口清理。排空不完整时保留原记录并报告不确定；仅进程退出不能证明执行已停止。退出不会取消 Cloud 任务。

安装启动读取主进程选择的资源目录下固定 `power-evolve-desktop.json`，不接受运行时覆盖。[资源读取器](src/installed-config.ts)要求 Node、CLI、Python、文件辅助脚本和 Device Bundle 位于该物理目录内；ASAR 条目被拒绝。Worker 时序明确配置，Runner 使用本机已有的不可变镜像 ID。Cloud 启动不创建 Device Profile 或子进程。首次打开本机授权入口时，在稳定私有 userData 路径中[准备产品 Profile](src/installed-profile.ts)，保留 Device 身份、journal 与写入锁。后端控制器管理准备、并发打开及派生进程前的取消。拒绝 Home 全局 overlay，以及 CLI 选定的 Device Bundle 与描述符不一致的配置。

描述符版本 1 保留 `appData/PowerEvolve`。版本 2 必填 `stateNamespace`：1–63 个小写字母、数字或连字符，始末必须为字母或数字，选择 `appData/PowerEvolve-<stateNamespace>`。可信安装程序在升级时固定该名称；不同部署或替换数据库时使用新命名空间并重新配对。主进程在创建 Electron Session 前验证所选根为当前用户所有、权限 0700 的物理目录。浏览器状态、Device Home、身份与 journal 分开保存；所有安装命名空间保留既有 `appData/PowerEvolve/device-writers` 协调根，其他安装不能绕过未解决的本机写入者。读取配置不创建状态。

Profile 准备拒绝更改已有可信平台 Origin，也拒绝在 Device 身份或 journal 已存在时重建缺失的产品补丁；这些字节保留原位。此检查不能识别同一 Origin 背后的数据库替换；部署者必须保持命名空间与同一数据库身份绑定。命名空间不能防御以同一 OS 用户运行的其他进程。

安装描述符必填 `device.commandSearchPath`：按顺序列出 1–32 个外部绝对 POSIX 目录名，每项 1–4096 字符。拒绝冒号、反斜杠、C0/DEL 控制字符及 `.` 或 `..` 路径段；允许根 `/` 和末尾斜杠。这些目录选择安装版 Device 子进程的准确 `PATH`，独立于包内 `runtime` 资源。读取配置不探测 Docker 或目录是否可用，也不运行登录 shell。父进程环境、`HOME`、`DOCKER_HOST`、固定解释器与 CLI 保持不变，子进程凭据过滤仍然生效。开发模式使用继承的环境。

## 浏览器与原生权限

同一部署中的 Host 与 Platform 共用一个持久 Electron Session。分区由两个 Origin 派生，不同 loopback 端口的部署不共享 cookie。开发模式默认使用 `appData/PowerEvolve`；其 `--data-dir` 不能覆盖安装包存储。

仅当前所属 Host 主 frame 的 `/native/` 文档获得键盘、快捷键、语言和主题同步。每次原生请求都检查当前窗口、主 frame 和准确 Host URL。Platform 和预览 frame 不获得产品原生桥。音频请求还要求当前所属 Host 文档、主 frame 的纯音频请求及 macOS 麦克风授权；其他权限拒绝。

主窗口导航仅允许配置的原生 Host 及 Platform 登录、账户和审批页。返回 Host 根地址时规范到 `/native/`。可信 Platform 链接请求新窗口时改为所属窗口内导航；拒绝其他 popup、外部目标和 webview。重定向和应用显式加载使用同一固定部署许可。阻止重定向时不会自动打开系统浏览器。

## 实现与验证

[主装配](src/main.ts)使用上游无启动副作用的[装配接口](../../../apps/desktop/src/assembly.ts)和 [Preload 装配](../../../apps/desktop/src/preload-assembly.ts)。主 ESM 模块注册就绪工作，不在顶层等待 `app.whenReady()`。开发运行时文件或固定安装资源仅在明确打开本机授权入口后启用独立本机进程。[打包](tsdown.config.ts)拒绝 Electron 与 Node 之外的 bare import；沙盒 CommonJS Preload 使用更小的运行时导入清单。

`pnpm run test:power-evolve:desktop` 执行源码配置和参数检查。真实 Electron 许可测试使用构建后的适配器并明确要求 `PE_DESKTOP_ELECTRON`；缺少运行时会报告 skip。其 loopback HTML 服务验证原生 IPC 和导航，不替代实际原生 DSH、PG 或模型验收。剩余 Device 与安装包工作见[桌面补齐约定](../DESKTOP-COMPLETION.md)。

## 已知限制

[冻结所属 Device 试用](../TRIAL-DESKTOP-OWNED-DEVICE.md)具有两个用户、Git 读回、重启及运行中退出的实际原生 DSH、Profile、模型、PG 和 Docker 证据。其独立运行时位于源码树外，仍使用开发配置。[安装应用试用](../TRIAL-DESKTOP-INSTALLED.md)已验证实际安装模式、LaunchServices、默认私有数据、Git／Python、重开和账号隔离。[安装应用 Office 试用](../TRIAL-DESKTOP-OFFICE.md)已验证四格式产物预览、本机 Git／Python、显式导出、不可变产物读回和独立安装状态。原生 OS 目录选择、签名／更新及原生侧栏浏览器分别保留交付步骤。用户控制的外部打开能力尚未接入，外部文档链接保持阻止。
