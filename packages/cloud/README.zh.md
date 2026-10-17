---
description: "云端包导航：供维护者使用原生 DSH 服务装配账户隔离、入口、存储和远端执行。"
kind: "package-group"
---

# cloud/ — 云端账户集成

[English](README.md) | 中文

## 概述

云端包为显式配置的多账户部署提供组件。本页用于查找账户归属、请求绑定、端点策略、文件准入、远端执行、指令快照和浏览器绑定的负责包。原生 DSH 服务继续持有 Session、Agent 和对话状态。各包 README 说明激活前提和尚不可用的集成。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

各包参考文档持有配置和激活要求。

| 包 | 职责 |
|---|---|
| [`pe-cloud-access`](pe-cloud-access/README.zh.md) | 认证集成及账户/代际请求一致性。 |
| [`pe-cloud-runtime`](pe-cloud-runtime/README.zh.md) | 账户身份、归属、容量及生命周期协调。 |
| [`pe-cloud-api`](pe-cloud-api/README.zh.md) | 经审核的原生端点开放与账户策略。 |
| [`pe-cloud-files`](pe-cloud-files/README.zh.md) | 有界文件工作及存储激活要求。 |
| [`pe-opensandbox`](pe-opensandbox/README.zh.md) | 会话执行作用域及远端执行激活要求。 |
| [`pe-account-instructions`](pe-account-instructions/README.zh.md) | 有界指令读取及原生 pre-step 快照。 |
| [`pe-cloud-client`](pe-cloud-client/README.zh.md) | 浏览器初始化及绑定账户的原生传输生命周期。 |

<a id="related-documentation"></a>
## 相关文档

- [云端账户参考](../../docs/subsystems/cloud.zh.md) — 共享账户身份和生命周期要求。
- [原生 API 包](../api/README.zh.md) — 云端适配复用的控制器及传输。

<a id="dev-note"></a>
## 开发备注

无。
