---
description: "通过原生页面管理个人技能、Remote MCP 与 Cloud STDIO，并支持凭据直传及原请求恢复。"
kind: package-reference
---
# PowerEvolve 扩展中心

[English](README.md) | 中文

## 摘要

用户可在原生技能页浏览、安装和试用个人或内置技能，也可在官方插件 bundle 配置中管理个人 Remote MCP 与 Cloud STDIO。凭据与技能包字节直传可信 Platform 地址。外部检查与操作保留请求身份和审批要求；浏览器配置本身不授予执行权限。

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

现有原生技能页提供“我的技能”“全部技能”和分类搜索。当前云端 profile 开放内置 PDF；保留的发行目录包含九项固定技能包。页面支持列出、读取、安装、启停及撤销个人文本技能和 ZIP 技能包。上传票据让技能包字节直传 Platform，Host 不接收 ZIP 正文。“试用技能”在新的原生会话中填写可编辑的调用草稿。个人 Remote MCP 和通用 Cloud STDIO 控件位于官方插件页 `@power-evolve/host` bundle 的配置区域，使用 `plugins.bundle.config` 插槽；共享插件清单、导航和部署权限保持原生行为。

[云端 Web 外壳](../cloud-web/README.zh.md)通过原生客户端元数据包含此浏览器插件。本包没有独立 Profile 层或用户填写的挂载字段；已配置的 [Host bundle](../host/README.zh.md)拥有服务端组合。

<a id="skills-and-package-import"></a>
### 技能与技能包导入

卸载安装或导入弹窗，或替换其账号客户端后，迟到回复不能更新视图。取消导入时保留原请求编号，并将结果标为不确定以供显式恢复；迟到回复不代表确认成功。

内置目录条目指定固定版本和摘要。个人已安装版本保留独立记录；展示当前目录不会替换较旧的安装。

<a id="personal-ssh"></a>
### 个人 SSH

SSH 浏览器管理延期。当前原生入口不构造其 HTTP 客户端，不加载其列表，也不显示其区域。保留的[延期配置组件](src/client/DeferredConnectorConfiguration.tsx)和 SSH 叶组件为历史测试保留下述行为。

个人 SSH 页保留原版密码/私钥表单、可选口令、远端工作目录、搜索、启停、编辑与确认删除。工作目录支持绝对路径或相对远端主目录的路径，例如 `~/project`；留空表示不覆盖工作目录。编辑时密码和私钥字段为空；未填写替换值时保留已保存的秘密。请求也明确指定是否保留口令；清除口令需要勾选清除选项。切换认证方式需要新凭据。公开记录只含认证方式和配置状态标记，不含秘密值。

创建连接及任何替换秘密的更新先通过 `sshConnectionsTicket` 申请等待状态的票据，再把 UTF-8 JSON `{formatVersion:2,password?,privateKey?,passphrase?}` 直传可信平台的固定 `/ssh/upload` 路径。上传只包含需要替换的字段。密码、私钥和口令的字节上限分别为 4096、7168 和 1024，整个封装上限为 65536 字节。Host 只收到元数据、替换指令和字节数。纯元数据更新和显式清除口令直接使用 `sshConnectionsUpdate`，不上传秘密值。列表、启停和删除使用固定管理 RPC；删除返回墓碑，页面保留最近检查记录。

上传响应丢失后查询原请求的 `sshConnectionsReceipt`；空回执仍表示结果不确定。显式重试保留请求编号、已保存的基础版本和不可变输入；即使请求已经完成，票据重试仍会再次上传字节。

SSH 检查只使用已保存连接的版本，仅验证登录，不执行远程命令。最近检查列表可在刷新后恢复当前账号的调用状态，并用一次有界列表 RPC 轮询未结束的调用。

Agent 可以针对已固定的 SSH 连接提议一条确切命令；可信平台在独立审批页展示命令和目标，供用户确认。只有获批准的命令才会经专用 Runner 执行，有界结果将续接到原会话；拒绝不会创建 Runner 调用，执行请求也可以取消。

<a id="personal-remote-mcp"></a>
### 个人 Remote MCP

Remote MCP 配置区域提供原版多连接表单，提供搜索、详情、创建/编辑弹窗、启停、删除、只写 Bearer 和自定义请求头字段，以及已保存配置/草稿检查、取消与持久状态展示。浏览器适配器通过同源 MCP 管理 RPC 发送元数据，并凭短时票据把替换凭据直传可信平台的固定上传地址。Host 只收到名称、操作和字节数，不接收凭据值。普通 HTTP 页面缺少 `crypto.randomUUID` 时仍可生成请求编号和新增请求头行。上传响应丢失后，客户端查询原请求回执。显式重试沿用同一请求编号与不可变输入。

检查使用已有原生会话，默认选择主视图保留的会话。检查未结束时，所选会话保持固定；删除该会话会使草稿检查失效，迟到响应不能覆盖已修改草稿或已取消检查。连接身份、配置和凭据版本用于识别过期的正式检查结果。旧结果作为历史保留，当前配置明确显示尚未检查。草稿检查使用独立版本，不代表保存后的配置已通过检查。启停会增加连接修订，不改变配置版本。页面持续展示到期和取消结果。只有等待或运行中的检查已请求取消时，才显示取消中的提示；即使保留了取消请求标记，终态检查也会隐藏该提示。管理服务不可用时禁止写入，但允许刷新。

<a id="cloud-stdio"></a>
### Cloud STDIO

通用 Cloud STDIO 配置区域管理字面程序、JSON 参数数组和相对工作目录。用户先选择已有会话，再保存配置或请求发现。保存不授予启动权限，发现需要独立审批。区域展示持久任务详情、取消请求，并通过原请求核对丢失的回复。同一已登录页面实例中关闭该区域后，仍保留未确认请求。组合不可用时禁用通用写入并展示元数据错误，不改用固定连接或返回成功的空目录。

STDIO 会话选择器调用原生 `Session.list` 方法时保留原接收对象。在普通 HTTP 页面，即使 `crypto.randomUUID` 不可用，也可生成管理请求编号。取消读取后，不会发起后续 action 查询，也不会报告已退出一代的可用状态。Platform 返回管理不可用时，历史连接仍作为只读记录展示，显示本地化状态并撤下管理控件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>原生组件与有界浏览器传输</summary>

[原生入口](src/client/index.ts)绑定现有 Skills 面板与官方 bundle 配置。浏览器 HTTP 适配器校验公开记录、保留请求编号和版本，并把替换凭据限制在直传 Platform 的上传路径。STDIO 校验器与打包的 Zod 禁用动态代码生成。

客户端源码测试不导入 Host 实现模块。明确的网络和 Port 替身检查传输、脱敏、界面状态及迟到回复；Host schema 接纳与真实 Platform/Runner 行为由集成检查负责。准备好的 factory 检查要求 `POWER_EVOLVE_FACTORY_FILE` 指向当前 `client.js` 的绝对路径。

客户端目录夹具读取当前 cloud-only 版本和摘要，不修改部署资产。[cloud-only 检查入口](../scripts/cloud-check.mjs)拥有源码与准备好的产物校验。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Host bundle](../host/README.zh.md) — 原生 Agent 与浏览器组合。
- [Application](../application/README.zh.md) — 授权与受控执行。
- [连接工作进程](../connector-runner/README.zh.md) — 远端检查与获批操作。
- [云端迁移范围](../CLOUD-MIGRATION-PLAN.md) — 已确认的产品能力。

-----

<a id="model-experience"></a>
## 模型体验

### 技能试用草稿

#### 模型可见内容

试用技能准备一个可编辑草稿，以 `/{alias}` 和换行开头。英文模板随后使用 `Use the “{name}” skill to help with my current task.`；中文模板使用 `请使用“{name}”技能协助我处理当前任务。`。客户端不提交草稿；原生会话提交拥有后续用户消息。

#### Token 影响

打开草稿不增加模型请求 token。用户提交后，生成的消息包含编辑后的文本。安装或启用技能会更新服务端能力；原生 Skill 和 Host 消费者拥有载入的指令与请求格式。

#### KV Cache 影响

草稿开启新的会话，不改写已有会话前缀。编辑草稿会改变后续提交的消息。此浏览器客户端不设置提供商缓存策略；原生技能选择后的缓存复用由请求消费者和提供商负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

用户与维护者必须保留以下操作限制：

- 不确定结果需要核对原请求，或以保留的输入显式重试；新的请求编号代表新操作。
- 连接配置或技能安装不授予通用程序启动权限；审批与当前部署能力仍是授权依据。
- 浏览器替身和准备好的 factory 不能代表真实 Platform、Runner、SDK 或双用户隔离验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文</summary>

将当前运行证据保留在对应迁移记录中。更新适配器时保留原生插槽、只写凭据字段、已固定的身份与原请求编号。

</details>
