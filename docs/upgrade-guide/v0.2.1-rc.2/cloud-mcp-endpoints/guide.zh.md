---
kind: upgrade-guide
description: "Cloud 账号的 MCP 连接须使用 Root 配置批准的确切服务地址。"
---

# 批准 Cloud HTTP MCP 服务地址

[English](guide.md) | 中文

## 变更

原先 Cloud 用户可从账号设置连接 HTTP MCP 服务。升级后，账号只能连接部署管理员批准的地址。允许列表为空或省略时，已保存的定义仍可查看、停用和移除。受限连接会显示地址策略提示，工具数为零。

## 迁移

1. 确认部署需要访问哪些 MCP 服务。在生效的 Cloud Root profile 中，将这些完整的 HTTP(S) URL 写入 `approvedConfiguration.mcp.allowedEndpoints`。协议、主机名、端口、路径和查询字符串须匹配。选择可通过公网直连且无需跳转的服务。在账号设置中填写凭据。参见 [MCP 地址策略](../../../../packages/cloud/pe-cloud-api/README.zh.md)。
2. 保留原 Root profile，通过部署的正常重启流程应用新配置。以普通账号打开**设置 → MCP 连接**，测试一个获准的旧连接，确认工具重新出现。检查其余受限连接是否显示地址策略提示。
3. 回退时先恢复原 Root profile 和配套的应用版本，再重启。旧版本按原有规则连接仍处于启用状态的定义。如需让某条连接在回退后继续保持停用，请先在设置中停用它。
