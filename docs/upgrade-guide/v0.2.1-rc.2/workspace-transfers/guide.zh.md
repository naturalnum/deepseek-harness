---
kind: upgrade-guide
description: "云端工作区下载动作需要流式 HTTP 路由和新版存储组件。"
---
# 云端工作区传输

[English](guide.md) | 中文

## 变更

云端下载改为浏览器原生附件，不再将 RPC 分段读取累计成 Blob。新对话上传同时在工作区根目录发布经过验证的副本，私有原生附件及历史记录保留；文件树上传可不保留对话回执。

## 迁移

1. 从 `packages/cloud/pe-cloud-files/native/staging.c` 重编译 staging 组件并更新固定摘要，确认声明 `workspaceTransfersVersion: 1`。
2. 为 `native.workspaceTransfers` 显式设置正安全整数 `maxFileBytes`、`maxFiles`、`maxTotalBytes`、`chunkBytes`、`maxPathBytes` 和 `timeoutMs`。`chunkBytes` 必须匹配现有 worker 读取及答复容量，原生附件与 staging 限制分别约束上传；不改变实际预置磁盘配额。
3. 加入 GET/HEAD `/api/workspace-files/download` 与 POST `/api/workspace-files/directory` 的确切 account-session Fetch 声明，handler 为 `native:workspaceFiles`。
4. 保留客户端显式 `maxDownloadBytes`，按所需文件大小配置；此参数不再代表浏览器内存分配预算。确认反向代理允许长传输，并以流式方式转发请求及响应。
5. 验证新上传立即出现在 Session 工作区根目录，Agent 通过执行环境路径读取相同内容，单文件及 ZIP 浏览器下载字节一致。上传取消或新建目录结果未知时，先刷新检查，再重试，因为文件可能已发布。不迁移或删除历史附件。
