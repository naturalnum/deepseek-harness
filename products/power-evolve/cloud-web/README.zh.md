---
description: "为 Host 的精确许可清单交付准备原生 PowerEvolve Web 外壳与带版本摘要的客户端资源。"
kind: package-library
---
# PowerEvolve Cloud Web

[English](README.md) | 中文

## 摘要

操作员可通过统一浏览器入口提供带有 PowerEvolve 账号操作、技能与插件配置的原生 DSH Web 外壳。本包组合已构建的页面和客户端资源，由 Host 在 `/native/` 提供。客户端资源缺失时，组装失败。认证和用户数据由 Platform 拥有；准备静态文件不授予运行权限。

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

[Host bundle](../host/README.zh.md)把本包作为准备好的静态资源使用。本包不是 Profile 层或 Cordis 挂载。操作员先准备上游页面与客户端构建，再由[组装脚本](scripts/build.mjs)写入本包 `dist`；[部署拥有者](../deploy/README.zh.md)控制具名 Profile 启动。

浏览器入口为 `/native/`。`asset-list.json` 是 Host 的精确公开文件许可清单。客户端入口缺失、依赖无法解析或字面量同目录分块缺失时，组装失败；构建器不会静默重建它们。

浏览选择器列出 Platform 拥有的云端目录名称。选择名称不会授予 Host 文件系统权限。工作区采用一个目录，并保留不可变的会话归属；Platform 根据账号和工作区身份解析物理字节存储。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>准备好的原生模块图与静态交付</summary>

组装脚本复制准备好的原生外壳、解析原生 Web 客户端清单并包含两个产品客户端。它输出带版本摘要的入口与同目录分块、排序后的模块图、应用批次及外部启动脚本。目录选择使用官方页内浏览选择器。

每个包的版本摘要覆盖全部复制的客户端脚本。模块图入口使用相对于文档的单资源 combo URL（`./plugins/??<owner>/client.js&rev=<ownerRev>`），同目录分块使用 `./plugins/<owner>/client.<name>.js?rev=<ownerRev>`；Host 通过 HTTP 返回它们的精确字节。组装过程将完整的内部 `client-resource-map.json` 与静态资源一同打包，但 Host 不提供该表。客户端请求必须同时命中精确映射 URL 与物理许可清单；未知资源以及缺失或错误的版本摘要均返回 404。启动应用批次只包含入口脚本。客户端源码映射与 Node 运行时入口不进入许可清单；上游页面自己的浏览器源码映射保留在其准备好的资源中。

Host 拥有静态服务和 CSP。原生策略允许同源脚本及 `unsafe-eval`，并为原生预览允许同源和 blob worker。[正式资源检查](tests/native-assets.built.spec.ts)读取真实许可清单、调用已构建的 Host 静态处理器并执行准备好的原生加载器，不创建替代部署资产。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Host bundle](../host/README.zh.md) — 原生浏览器服务与 Agent 组合。
- [账号客户端](../client-account/README.zh.md) — 账号入口与可信改密页。
- [扩展中心](../client-extension-center/README.zh.md) — 现有技能页与 bundle 配置。
- [云端迁移范围](../CLOUD-MIGRATION-PLAN.md) — 已确认的产品能力。

-----

<a id="model-experience"></a>
## 模型体验

### Web 资源

#### 模型可见内容

`/native/` 外壳、`asset-list.json` 与客户端模块图只提供浏览器代码。本包不增加提示词、模型工具或会话消息；原生客户端和 Host 拥有用户提交及模型可见行为。

#### Token 影响

准备或提供静态资源不增加模型请求 token，也不发起模型调用。客户端消费者拥有消息、提示词与工具结果。

#### KV Cache 影响

资源版本变化会更新浏览器资源，不改写持久化的会话消息。本包不定义模型缓存键或提供商策略；原生请求格式与提供商决定缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

准备好的资源只建立以下浏览器交付范围：

- 本包要求当前准备好的页面与客户端产物，不会启用缺失的运行服务。
- 静态资源或 factory 检查不能代表真实 Platform、SDK、双用户或完整功能验收。
- 原生侧栏 Browser factory 需要上游载体，缺少载体时保持不激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

将准备好的字节、CSP 与浏览器执行证据保留在对应迁移记录中。组装保留上游浏览器行为；运行权限由 Host 与 Platform 拥有。

</details>
