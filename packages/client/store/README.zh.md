---
description: "具有显式快照、订阅与生命周期所有权的浏览器可观察状态存储。"
kind: "package-library"
---
# @deepseek-ai/dsh-client-store

[English](README.md) | 中文

## 概述

供 Client 控制器与 renderer 适配器共用的不依赖 React 的 observable 和快照存储基础原语。本包负责同步与 animation-frame 发布、基于 Immer 的更新、浅比较和可选的浏览器持久化；React 钩子的构造仍属于 `@deepseek-ai/dsh-client-ui-renderer`。当 Client 状态必须在不依赖 React 的情况下发布稳定快照时，请使用它。

## 目录

- [页面持久化](#page-persistence)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="page-persistence"></a>
## 页面持久化

`ClientPersistence` 负责逻辑键的 `getItem`、`setItem`、`removeItem` 和 `keys` 操作。通过 `createSnapshotStore(init, { persist: { name, storage: port } })` 或 `handle.create(scopeKey, port)` 传入捕获的页面端口。自定义 handle 包装器须转发第二个参数。renderer 在创建 store 前捕获 `ctx.get('clientPersistence')`；直接读取与库存发现使用同一依赖。端口不改写逻辑键或 Session 身份。

省略依赖时保留普通浏览器本地存储行为；存储缺失视为空，普通 I/O 失败只记录日志、不使 store 失败。显式端口的失败向上传播，但 observer 分发器会包含并记录订阅回调的异常。持久化写入失败时内存快照可能已更新；显式端口拥有者必须封闭端口并停止依赖它的 UI。清除一个值不会取消 store 订阅，也不会撤销其再次写入的权限。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包提供浏览器侧状态基础原语，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些存储既不组装也不发送模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **持久化仅限浏览器本地**——持久化 store 通过捕获的端口读写 JSON；普通调用者使用 `localStorage`，非浏览器调用者没有默认持久化。本包不提供跨设备同步。
- **Web 壳构建输入**——静态 ESM 为 Vite 保留第三方导入；独立消费方自行提供开发依赖（[依赖规则](../AGENTS.md#dependency-declaration)）。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
