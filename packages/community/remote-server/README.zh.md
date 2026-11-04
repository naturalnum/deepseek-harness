---
description: "源自 dsh-remote-server 的账户隔离基础能力，明确云端职责及原生审批行为。"
kind: "package-library"
---

# @deepseek-ai/dsh-remote-server-cloud

[English](README.md) | 中文

## 概述

此私有库包含账户隔离的服务器记录、代际引用、上传 SSH 配置解析、原生工具注册，以及上游探测脚本与风险规则。它没有 Loader 入口、HTTP 路由或自动启用行为；管理界面与生命周期组装由云插件负责。[上游记录](UPSTREAM.json) 锁定原始源码与 MIT 许可证。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

[入口](src/index.ts) 提供显式准备的云端集成基础能力。`AccountRemoteServers` 需要运行时实际安装的原始绑定，以及原始业务、存储和凭据删除回调。服务器表单不接受账户选择、宿主文件路径、私钥或密码。集合内修改按序执行；原始存储所有者必须保留实际写入、容量和失败结果的责任。

不透明引用属于一个有效代际及其目标配置。修改或删除服务器会撤销引用。执行会在审批后重验目标，并将当前检查传给原始执行器，用于其等待后的准备及实际提交。账户生命周期与原生执行工作的责任仍由原所有者承担。

<a id="understand-the-implementation"></a>
## 理解实现

上传配置通过只读内存文本解析。身份文件路径被丢弃，每个候选项均需要另行授权的账户密钥。Include、Match、代理、转发及不支持的指令均拒绝，不会读取应用宿主。云端执行消费者忽略环境中的配置和代理，仅允许公钥认证，并要求上传已核实 known_hosts。固定 Python 辅助程序将密钥保存在原有受管范围的密封内存描述符中，沿用原有完整载体上限。

审批门保留确定性高风险规则及部署、服务器的强制审批。完整访问不提供绕过。云端 API 的[原生适配器](../../cloud/pe-cloud-api/src/remote-server-approval.ts) 使用原始 Agent、Session、调用标识、信号及原生审批请求，并保留其持久审计事件对。

<a id="model-experience"></a>
## 模型体验

### 工具定义与所选引用

#### 模型可见内容

显式安装会注册 [`remote_exec(server, command)`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-remote-server-cloud) 与 `remote_server_info(server)`。描述要求使用用户所选的当前精确引用，并说明审批与取消行为。原生引用编解码器只将所选别名及不透明引用写入用户消息，不包含私钥和 known_hosts。

#### Token 影响

安装期间产生固定工具定义开销；每个所选引用增加少量用户消息内容。注册与管理不会发起模型请求。

#### KV Cache 影响

安装及可见性不变时工具定义保持稳定。所选引用改变用户消息内容及从该消息开始的前缀。

### 工具结果

#### 模型可见内容

结果含 `detail` 与 `ran`：拒绝原因或有界的实际 SSH 结果、输出及退出状态。固定探测返回机器事实。超时文本明确说明远端后代进程可能仍在运行。

#### Token 影响

输出开销取决于实际有界结果。探测输出与命令沿用原执行及输出限额。

#### KV Cache 影响

结果追加到 Session 对话。新输出改变从该结果开始的前缀；集成不重写既往消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 通过云目录、账户配方与原有受管执行提供者显式启用。源码验收覆盖原生私有存储、实际 Loader 编解码器、两个 PostgreSQL 认证账户、原有受管提供者上的真实 SSH，以及原生模型与工具回合。生产 Root SDK、存储导出和已部署 Web 的验收仍由部署负责。

- 原生审批策略 `never` 会在分发给应答者之前直接拒绝。因此强制远程审批在该策略下关闭执行；此 API 无法在保持原 Session 策略时显示单次强制审批。[复现](../../cloud/pe-cloud-api/tests/remote-server-native-approval.spec.ts) 使用产品 Agent、Session 与审批服务。单次原生强制审批需要上游扩展；这里没有修改原生代码。

- 取消会等待本地 SSH 受管范围退出，但不能据此确认任意远程进程已停止。不得将本地清理事实当作远端进程终止的证据。

<a id="dev-note"></a>
### 开发备注

上游包声明支持 Harness `0.2.0-rc.2` 或 `0.2.1-alpha.1`；当前源码基线为 `0.2.1-rc.2`。基础能力的源码检查及原生审批测试不代表未修改上游插件或其浏览器产物已兼容。云端组合不得接入上游的原始 Host 路由、全局存储或本机凭据发现。
