# PowerEvolve 执行客户端

[English](README.md) | 中文

此浏览器插件在原生 DSH 输入区为每次提交提供 Cloud 或获授权 Device 选择。设备与目录元数据来自按归属限制的 Host 读取。可信平台在持久受理提示时授权所选目标；选择本身不启动执行环境。

## 执行对账

既有选择器打开当前 Session 的 Cloud 执行及结案回执只读视图。原命令按文本显示，并链接独立认证的平台审批页。Host 仅开放 list、inspect 和 status RPC；客户端不持有审批凭据，不能确认清理。

请求与响应使用[共享校验](../contracts/src/execution-resolution.ts)。关闭或切换会话会取消读取并拒绝晚到响应。已完成的 `closed_unknown` 回执表示写者已停止，但命令副作用仍不明。它不表示成功，也不授权重放命令。此 Cloud 视图不提供 Device 和 SSH 对账。

## 模型体验

目标选择为原生提示流程提供对应提交的确切提示。只读对账视图不添加模型消息。可信平台拥有持久受理、清理及原 Session 的唯一续接；见[执行结案实施计划](../EXECUTION-RESOLUTION-COMPLETION.md)。
