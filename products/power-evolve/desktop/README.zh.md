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

[安装资源读取器](src/installed-config.ts)校验主进程选择的资源目录下固定 `power-evolve-desktop.json`。Node、CLI、Python、文件辅助脚本及 Device Bundle 必须解析到该目录内部，ASAR 条目被拒绝。Worker 时序明确配置，Runner 使用本机已有的不可变镜像 ID。读取器从既有私有产品 userData 目录派生不含版本号的 Device 状态路径。主入口接线及 Profile 准备仍待完成；这个读取器本身不启用安装模式启动。

## 浏览器与原生权限

同一部署中的 Host 与 Platform 共用一个持久 Electron Session。分区由两个 Origin 派生，不同 loopback 端口的部署不共享 cookie。产品 userData 默认使用独立 `PowerEvolve` 应用目录；仅开发可用的 `--data-dir` 不能覆盖安装包存储。

仅当前所属 Host 主 frame 的 `/native/` 文档获得键盘、快捷键、语言和主题同步。每次原生请求都检查当前窗口、主 frame 和准确 Host URL。Platform 和预览 frame 不获得产品原生桥。音频请求还要求当前所属 Host 文档、主 frame 的纯音频请求及 macOS 麦克风授权；其他权限拒绝。

主窗口导航仅允许配置的原生 Host 及 Platform 登录、账户和审批页。返回 Host 根地址时规范到 `/native/`。可信 Platform 链接请求新窗口时改为所属窗口内导航；拒绝其他 popup、外部目标和 webview。重定向和应用显式加载使用同一固定部署许可。阻止重定向时不会自动打开系统浏览器。

## 实现与验证

[主装配](src/main.ts)使用上游无启动副作用的[装配接口](../../../apps/desktop/src/assembly.ts)和 [Preload 装配](../../../apps/desktop/src/preload-assembly.ts)。主 ESM 模块注册就绪工作，不在顶层等待 `app.whenReady()`。仅 Cloud 启动不创建本机 Profile；明确的开发 Device 配置启用独立本机进程。[打包](tsdown.config.ts)拒绝 Electron 与 Node 之外的 bare import；沙盒 CommonJS Preload 使用更小的运行时导入清单。

`pnpm run test:power-evolve:desktop` 执行源码配置和参数检查。真实 Electron 许可测试使用构建后的适配器并明确要求 `PE_DESKTOP_ELECTRON`；缺少运行时会报告 skip。其 loopback HTML 服务验证原生 IPC 和导航，不替代实际原生 DSH、PG 或模型验收。剩余 Device 与安装包工作见[桌面补齐约定](../DESKTOP-COMPLETION.md)。

## 已知限制

[冻结所属 Device 试用](../TRIAL-DESKTOP-OWNED-DEVICE.md)具有两个用户、Git 读回、重启及运行中退出的实际原生 DSH、Profile、模型、PG 和 Docker 证据。其独立运行时位于源码树外，仍使用开发配置。原生 OS 目录选择、安装配置／Profile 准备、`.app` 装配、签名／更新及原生侧栏浏览器分别保留交付步骤。源码启动和上游包 smoke 不能证明 PowerEvolve 安装包已交付。用户控制的外部打开能力尚未接入，外部文档链接保持阻止。
