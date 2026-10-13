---
kind: upgrade-guide
description: "RemoteStreamMuxServer 现在要求显式提供下行发送期限。"
---

# Remote stream 发送必须提供期限

[English](guide.md) | 中文

## 变更

`RemoteStreamMuxServer` 现在要求第五个构造参数 `streamSendTimeoutMs`。四参数调用不再通过类型检查。Gateway 插件配置仍可兼容载入：新字段 `streamSendTimeoutMs` 默认 10000 毫秒，接受 1 到 2,147,483,647 的整数。

此前，尚未完成的 `ws.send` 回调可能在取消后仍保留逻辑流。现在每个帧都有涵盖排队时间和回调完成的期限。取消尚未开始写入的帧会撤回该帧；取消已开始的写入或其期限届满会终止共享物理载体，并取消其中全部逻辑流。server close 等待 source 迭代器清理，迟到的回调无法恢复交付。

## 迁移

1. 为每个直接的 `new RemoteStreamMuxServer(open, failure, heartbeatIntervalMs, streamInboxBytes, streamSendTimeoutMs)` 调用增加第五个参数，使用部署所选的发送期限。构造器没有隐式回退值。
2. 当 10000 毫秒的默认值不适合预期写入延迟时，在 `@deepseek-ai/dsh-api-gateway` 插件的 `cordis.yml` 配置中设置 `streamSendTimeoutMs`。拥有独立 mux 的应用必须校验并显式传入自身配置值。`streamInboxBytes` 仍为上行限制。
3. 检查所属 composition 的类型，并在发送回调尚未完成时执行取消。确认载体关闭且 source 清理完成，也确认取消排队帧后健康载体仍可使用。[载体测试](../../../../packages/api/gateway/tests/stream-server.host.spec.ts) 通过真实 WebSocket 和受控的回调扣留覆盖这些路径，并未模拟慢速网络。部署和清理义务见 [Gateway README](../../../../packages/api/gateway/README.zh.md)。
