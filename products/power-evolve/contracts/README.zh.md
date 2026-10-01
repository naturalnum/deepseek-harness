---
description: "浏览器客户端与可信平台共用的 PowerEvolve 协议记录。"
kind: "package-library"
---
# PowerEvolve 协议记录

[English](README.md) | 中文

## 摘要

此私有库提供账号与文件下载校验、响应记录、路由名和品牌化标识符。浏览器客户端与可信平台消费相同的定义。它不导入平台服务或 Node API，也不注册 DSH 插件。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [限制](#limits)
- [开发说明](#dev-note)

## 使用此包 {#use-this-package}

从 `@power-evolve/contracts/account` 导入账号记录。Zod 解析器拒绝无效协议值，其推导类型描述已校验的值。[账号源码](src/account.ts) 定义字段与路由。消费者声明对此包的工作区依赖和 TypeScript 项目引用。

从 `@power-evolve/contracts/file-download` 导入下载请求及同源 URL 构造函数。[下载源码](src/file-download.ts) 定义规范相对路径、元数据摘要和协议上限。部署限额与授权仍由平台负责，见[文件切片](../S2-COMPLETION.md)。

## 实现 {#implementation}

运行时仅依赖 Zod 和上游品牌类型工具。TypeScript 一并生成兼容浏览器的 ESM 和声明文件。应用为现有内部导入重新导出这些账号定义。此包没有进程状态、凭据存储、授权检查或独立的生命周期不变量。

## 限制 {#limits}

解析不确立身份、归属或权限。可信平台须验证凭据，并在资源事务内检查当前账号。浏览器中的角色或能力字段只控制展示。[账号切片](../S3-ACCOUNT-COMPLETION.md) 定义集成与验收要求。

## 开发说明 {#dev-note}

账号与应用消费者共用同一个 `UserId` 类型。修改协议记录时，须在同一次交付中更新可信页面与平台处理器。
