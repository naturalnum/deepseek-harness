---
description: "通过账号隔离的身份与安全登录恢复，打开原生账号操作及可信改密或账号管理页面。"
kind: package-reference
---
# @power-evolve/client-account

[English](README.md) | 中文

## 摘要

用户可从一个账号菜单打开原生设置、在可信 Platform 修改密码并退出登录。菜单显示首字母头像、显示名称与角色。管理员在独立可信页面管理账号。个人元数据和授权模型选择保持账号隔离；提供商凭据保留在 Platform。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[原生云端 Web 外壳](../cloud-web/README.zh.md)包含此浏览器插件。[Host](../host/README.zh.md) 与 [Platform](../platform/README.zh.md)分别拥有具名 Profile、origin 和认证配置；此客户端没有用户配置字段。

账号入口显示首字母头像、显示名称和角色。三个操作分别打开原生设置、进入可信改密页和退出登录。账号管理保留在 Platform；插件不新增设置分区或登录失效遮罩。

<a id="native-sign-in-lifetime"></a>
### 原生登录生命周期

插件在启用、Connection 状态变化、浏览器获得焦点或恢复在线以及文档变为可见时检查个人 `/api/powerEvolve/me` 端点。首次成功响应将文档绑定到该用户 ID。后续成功响应若属于另一用户，则停止旧 Connection 并只重载一次当前文档，丢弃前一账号保留的视图；该操作不依赖登录地址查询。同一用户的设置或显示名称变化保留当前文档。确认 HTTP 401 后停止原生 Connection 当前代及其重试循环，随后只导航一次，将页面替换为 Host 配置的可信登录地址。该退出页面中迟于身份检查启用的 Connection 循环也会停止。账号组件发出的个人身份请求也报告同一类确认失效。网络故障、服务端错误和 HTTP 403 保留 Connection 的正常恢复行为。

登录地址来自 `/config`，必须为不含内嵌凭据的 HTTP(S) URL。查询失败后 Connection 保持停止，并记录登录地址不可用；`AccountSession.returnToLogin()` 支持明确重试。本包不增加恢复弹窗。插件销毁时取消身份、能力和退出请求。替换客户端时清除入口身份并取消待处理的退出操作；迟到响应不能导航新的客户端。插件要求浏览器 Connection 服务提供[停止方法](../../../packages/client/connection/README.zh.md#connection-generation)。

<a id="trusted-account-page"></a>
### 可信账号页面

本包拥有在 Platform `/account` origin 提供的账号管理和改密表单。密码与账号凭据只保留在该页面的内存中；原生入口只接收只读能力和导航地址。需要首次改密的账号先显示个人改密表单，完成后才能管理账号或进入产品。改密成功后清空表单并要求重新登录。

管理员可在可信页面管理账号；普通用户保留个人改密操作。Platform 会为每次管理操作重新校验当前权限。

连续退出登录操作共用一个待处理请求。客户端替换或页面销毁会取消该请求，迟到的回复不能更改新账号。明确的退出失败会保留账号，并允许用户重新发起操作。

管理界面在结果不确定时保留每个请求编号和当时的账号版本。查询收据不会再次读取临时密码；丢失临时密码的管理员需明确发起新的重置。临时密码只显示到关闭提示或销毁页面为止。变更成功后的列表刷新失败不会提供重放该变更的操作。权限失效时移除管理数据并返回账号登录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>浏览器身份与可信页面交付</summary>

原生账号入口以 priority -10 注册，销毁后恢复官方 priority 0 入口。 入口复用上游 Menu 和显式 MenuItemButton 操作，保留键盘导航、快捷键显示及禁用或危险状态。Host RPC 适配器提供已认证的个人元数据和授权模型，不传递提供商凭据。[原生入口](src/client/index.ts)拥有注册与生命周期行为。

`./trusted-assets` 导出提供构建目录 URL。打包生成 `lib/trusted/index.html`、脚本、样式和 `asset-list.json`；Platform 只提供清单中的文件，并使用账号页面的 CSP 与私有响应头。原生 Web 插件和可信页面分别打包；可信页面不依赖 Host 的模块加载器。

浏览器源码测试使用明确的 HTTP、Connection 和组件端口替身。准备好的 factory 检查通过 `POWER_EVOLVE_FACTORY_FILE` 接收当前 `client.js` 的绝对路径，并拒绝原生模块表之外的依赖。[cloud-only 检查入口](../scripts/cloud-check.mjs)分别记录源码与准备好的产物证据。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Platform](../platform/README.zh.md) — 可信账号与凭据拥有者。
- [原生 Connection](../../../packages/client/connection/README.zh.md#connection-generation) — 已停止的一代连接与恢复。
- [云端迁移范围](../CLOUD-MIGRATION-PLAN.md) — 已确认的产品能力。

-----

<a id="model-experience"></a>
## 模型体验

### 账号控件

#### 模型可见内容

`settings.launcher` 控件不贡献提示词、工具或会话消息。账号 API 读取授权模型与个人设置；原生 DSH 控件和可信 Platform 拥有模型选择与请求准入。

#### Token 影响

账号导航和元数据读取不增加模型请求 token。模型或授权变化通过原生和 Platform 消费者影响后续请求准入，不会向此客户端暴露提供商凭据。

#### KV Cache 影响

此浏览器插件既不改写较早请求的 token，也不定义提供商缓存策略。原生会话消费者拥有请求格式；提供商的缓存复用和淘汰不属于本包。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

调用者必须保留以下账号约束：

- 可信登录地址查询失败后，原生 Connection 保持停止；恢复需要显式重试。
- 密码与临时凭据只属于可信页面；查询回执不能恢复已关闭的临时密码。
- 浏览器能力只控制展示，不能替代 Platform 授权或代表部署验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

将客户端、可信页面和真实部署证据保留在对应检查中。单项源码或 factory 测试不能代表真实 Platform 或浏览器会话验收。

</details>
