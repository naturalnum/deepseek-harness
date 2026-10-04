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

## 浏览器与原生权限

同一部署中的 Host 与 Platform 共用一个持久 Electron Session。分区由两个 Origin 派生，不同 loopback 端口的部署不共享 cookie。产品 userData 默认使用独立 `PowerEvolve` 应用目录；仅开发可用的 `--data-dir` 不能覆盖安装包存储。

仅当前所属 Host 主 frame 的 `/native/` 文档获得键盘、快捷键、语言和主题同步。每次原生请求都检查当前窗口、主 frame 和准确 Host URL。Platform 和预览 frame 不获得产品原生桥。音频请求还要求当前所属 Host 文档、主 frame 的纯音频请求及 macOS 麦克风授权；其他权限拒绝。

主窗口导航仅允许配置的原生 Host 及 Platform 登录、账户和审批页。返回 Host 根地址时规范到 `/native/`。可信 Platform 链接请求新窗口时改为所属窗口内导航；拒绝其他 popup、外部目标和 webview。重定向和应用显式加载使用同一固定部署许可。阻止重定向时不会自动打开系统浏览器。

## 实现与验证

[主装配](src/main.ts)使用上游无启动副作用的[装配接口](../../../apps/desktop/src/assembly.ts)和 [Preload 装配](../../../apps/desktop/src/preload-assembly.ts)。主 ESM 模块注册就绪工作，不在顶层等待 `app.whenReady()`。它不启动本机 Agent 或 Device Profile。[打包](tsdown.config.ts)拒绝 Electron 与 Node 之外的 bare import；沙盒 CommonJS Preload 使用更小的运行时导入清单。

`pnpm run test:power-evolve:desktop` 执行源码配置和参数检查。真实 Electron 许可测试使用构建后的适配器并明确要求 `PE_DESKTOP_ELECTRON`；缺少运行时会报告 skip。其 loopback HTML 服务验证原生 IPC 和导航，不替代实际原生 DSH、PG 或模型验收。剩余 Device 与安装包工作见[桌面补齐约定](../DESKTOP-COMPLETION.md)。

## 已知限制

这是 Cloud 载体源码切片。Device 进程所有权、本机授权桥、签名安装／更新、原生侧栏浏览器与安装包运行时闭包分别保留验收步骤。源码启动和上游包 smoke 不能证明 PowerEvolve 安装包已交付。用户控制的外部打开能力尚未接入，外部文档链接保持阻止。
