---
description: "源自 dsh-remote-server 的账户隔离基础能力，明确云端职责及原生审批行为。"
kind: "package-library"
---

# @deepseek-ai/dsh-remote-server-cloud

[English](README.md) | 中文

## 概述

此私有库包含账户隔离的服务器记录、代际引用、上传 SSH 配置解析、严格 OpenSSH 参数，以及上游探测脚本与风险规则。它没有 Loader 入口、HTTP 路由、界面注册或自动启用行为。[上游记录](UPSTREAM.json) 锁定原始源码与 MIT 许可证。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

[入口](src/index.ts) 提供显式准备的云端集成基础能力。`AccountRemoteServers` 需要运行时实际安装的原始绑定，以及原始业务、存储和凭据删除回调。服务器表单不接受账户选择、宿主文件路径、私钥或密码。集合内修改按序执行；原始存储所有者必须保留实际写入、容量和失败结果的责任。

不透明引用属于一个有效代际及其目标配置。修改或删除服务器会撤销引用。执行会在审批后重验目标，并将当前检查传给原始执行器，用于其等待后的准备及实际提交。账户生命周期与原生执行工作的责任仍由原所有者承担。

<a id="understand-the-implementation"></a>
## 理解实现

上传配置通过只读内存文本解析。身份文件路径被丢弃，每个候选项均需要另行授权的账户密钥。Include、Match、代理、转发及不支持的指令均拒绝，不会读取应用宿主。OpenSSH 忽略环境中的配置和代理，仅允许公钥认证，并要求显式的已知主机记录。16 个参数符合原始受管通道的参数个数限制。

审批门保留确定性高风险规则及部署、服务器的强制审批。完整访问不提供绕过。云端 API 的[原生适配器](../../cloud/pe-cloud-api/src/remote-server-approval.ts) 使用原始 Agent、Session、调用标识、信号及原生审批请求，并保留其持久审计事件对。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 此库不是已启用的云端功能。账户私有持久化与凭据租约、原始受管执行消费者、审计过的 RPC 暴露、管理界面、聊天引用注册及真实账户、模型、浏览器的完整验收尚未实现。SSH 测试通过原生本地子进程提供者验证传输，不构成云端执行组合、资源限额或已认证多用户入口的验收。

- 原生审批策略 `never` 会在分发给应答者之前直接拒绝。因此强制远程审批在该策略下关闭执行；此 API 无法在保持原 Session 策略时显示单次强制审批。[复现](../../cloud/pe-cloud-api/tests/remote-server-native-approval.spec.ts) 使用产品 Agent、Session 与审批服务。单次原生强制审批需要上游扩展；这里没有修改原生代码。

- 取消会等待本地 SSH 受管范围退出，但不能据此确认任意远程进程已停止。不得将该观察结果当作远端清理证据，也不得在所属执行能力完成验收之前将本库启用为执行功能。

<a id="dev-note"></a>
## 开发备注

上游包声明支持 Harness `0.2.0-rc.2` 或 `0.2.1-alpha.1`；当前源码基线为 `0.2.1-rc.2`。基础能力的源码检查及原生审批测试不代表未修改上游插件或其浏览器产物已兼容。云端组合不得接入上游的原始 Host 路由、全局存储或本机凭据发现。
