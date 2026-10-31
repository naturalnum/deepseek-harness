---
kind: upgrade-guide
description: "云端 profile 通过现有 access 插件提供公开登录页，不再使用原生 frontend-static 的 indexAuth。"
---

# 迁移云端公开首页条目

[English](guide.md) | 中文

## 变更

原生 `@deepseek-ai/dsh-host-frontend-static` 配置恢复为必须使用 Connection 鉴权，不再提供 `indexAuth`。显式声明 frontend 行并使用 `indexAuth: public` 的云端 profile 改用现有 access 包的 `/frontend` 入口。该入口复用原静态文件响应函数；认证、bootstrap、API 和 WS 的命名路由保留原检查。普通原生 profile 无需修改。仅此分支提供的 `ordinaryConfigPolicy` 与 `OrdinaryConfigPolicy` 从原生 Settings 导出中移除，由现有 Cloud API 在内部持有策略。`ConfigField.onReset` 恢复为必填；不支持 unset 的纯文本调用者保持 `choices: []` 和 `overridden: false`，并提供拒绝意外重置请求的回调。

## 迁移

1. 安装更新后的 `@deepseek-ai/dsh-pe-cloud-access` 包及其声明的原生 frontend 依赖。在云端 profile 中，仅将原 frontend 行的 `name` 改为 `@deepseek-ai/dsh-pe-cloud-access/frontend`，保留 id 和绝对路径 `config.distIndex`，删除 `config.indexAuth`。不要新增另一个 fallback 拥有者。
2. 保持认证及原 API/WS 条目不变。确认制品目录和全部首页注入仅包含公开资源；不得将 `distIndex` 指向账户数据目录。
3. 正常启动完整后继 profile。确认 `/` 和 `/index.html` 显示登录页、静态资源正常、未授权的 bootstrap/API/WS 请求仍被拒绝，并实际验证登录和退出。对外开放前确认原 Root 审计及资源上限通过。
4. 为省略了 `onReset` 的自定义 `ConfigField` 调用者补齐回调；有限选项字段仍须有实际重置操作。无需迁移用户数据或改变配额。
