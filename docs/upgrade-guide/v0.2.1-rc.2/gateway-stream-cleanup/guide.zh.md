---
kind: upgrade-guide
description: "Gateway Node 流 transport 关闭在等待所有流及 Peer 清理后，会拒绝真实清理失败。"
---
# 处理 Gateway 流清理失败

[English](guide.md) | 中文

## 变更

`TypertGatewayService.createNodeStreamTransport()` 仍返回幂等的 `close()`，但现在会等待所有在途 opener、迭代器读取及 return、Peer effect 清理结算后，拒绝首个真实清理失败。此前连接和 Peer 清理失败可能只记日志，随后仍报告关闭成功。普通逻辑流业务错误保留原生错误帧。

可选第三参数为 `NodeStreamTransportOptions`：`maxFrameBytes` 通过 ws 限制完整 WebSocket 消息字节；同步 `acquireStream(endpoint)` 在逻辑流或 inbox 分配前预留资源，并返回同步、恰好一次的结算回调。资源拒绝关闭物理 carrier。`beforeOpen` 继续只拒绝逻辑业务流。省略 options 时保留既有输入限制和业务协议。

## 迁移

1. 在每个 Node transport 拥有者中等待并处理 `transport.close()`。拒绝时保留未解决的资源责任并报告关闭失败；socket 已关闭不能证明真实清理完成。
2. 使用资源选项时，提供正安全整数 `maxFrameBytes`，在 `acquireStream` 中从真实流拥有者预留。仅在 `confirmed` 时释放，`unknown` 时保留容量。通知失败也会使 close 失败。回调必须同步，不能等待包含自身的 transport 或 Peer 关闭。
3. 验证延迟 opener/read/return 清理会持续占用容量，清理失败会在其他清理完成后使 close 拒绝。公开 [Gateway 文档](../../../../packages/api/gateway/README.zh.md) 说明 carrier 语义；无需迁移 wire DTO 或 Session 数据。
