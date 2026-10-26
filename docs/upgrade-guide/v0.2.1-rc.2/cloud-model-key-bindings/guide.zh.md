---
kind: upgrade-guide
description: "Cloud 模型密钥部署配置将 providerEntryId 替换为显式原生 provider/ref bindings。"
---

# 声明 Cloud 模型密钥 bindings

[English](guide.md) | 中文

## 变更

启用 `approvedConfiguration.modelKey` 的部署必须将其单一 `providerEntryId` 替换为有限非空的 `bindings` 列表。每个 binding 显式选择 `{ provider, providerEntryId, moduleName, ref }`。共享 API 不再导出 `APPROVED_MODEL_KEY`；codec 和环境 helper 必须接收选中引用。四个模型密钥 RPC 及其请求/响应结构保持不变。

支持范围为使用 `apiKeyEnv` 凭据引用与 `models` 声明的原生 Models 配置路由；未扩展 OAuth/record 凭据。Cloud 元数据继续保持设置只读。其中 `settings.writable=false` 和 `settings.hasDocument=false` 描述 Cloud 能力，保留原生 Settings `hasDocument` 语义，不表示物理设置文档不存在。

## 迁移

1. 在 Root 条目配置中，将 `approvedConfiguration.modelKey.providerEntryId` 替换为 `approvedConfiguration.modelKey.bindings`。若既有原生 DeepSeek 条目名为 `provider`，选择数据变为 `[{"provider":"deepseek-official","providerEntryId":"provider","moduleName":"@deepseek-ai/dsh-llm-deepseek-api-key","ref":"DEEPSEEK_API_KEY"}]`。这些是部署选择；请使用实际模块、条目 id、provider id 及配置中的 `apiKeyEnv` 引用。继续显式提供正数有限的 `maxKeyBytes`、`maxVersionBytes`、`maxReplyBytes` 和 `maxMetadataBytes`。
2. 核对每个选中原生条目的 Models 声明及凭据引用 schema 与其 binding 一致。provider id 必须唯一，bindings 必须符合 [API 参考](../../../../packages/cloud/pe-cloud-api/README.zh.md) 中的目录条目、字符串及完整字节上限。原生事实缺失或不匹配时启动拒绝。
3. 将消费者对 `APPROVED_MODEL_KEY` 的导入替换为同一可信 Root 选择。把其中的引用交给 `modelKeyCodecs(limits, refs)` 和 `new AccountModelKeyEnvironment(environment, refs)`。codec、原生挂载前的环境屏蔽及既有原生保存白名单必须使用同一选择。
4. 确认准备后的 `cloudModelKey/metadata` 返回全部选中路由及其原生脱敏模型/设置数据。编辑 ref 时，从 `cloudModelKey/describe` 取得当前 `{ epoch, editToken }`，并在 set/unset 成功后保留返回版本；对选中 ref 的直接、无版本原生编辑仍拒绝。edit token 仅属于当前图，不是磁盘 revision；持久化仍由原凭据文件锁及 writer 负责。冲突或结果未知后重新读取状态；禁止自动重放写入。
