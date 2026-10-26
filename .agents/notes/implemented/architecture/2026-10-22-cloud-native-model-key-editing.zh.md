# Agent Note: 云端模型密钥沿用原生保存与页面所有权

Status: implemented

[English](2026-10-22-cloud-native-model-key-editing.md) | 中文

## Problem

共享 Node 进程服务多个云端账户。原生 Models 页面依赖凭据和 Settings 操作；云端必须把每次写入绑定到原始登录账户，并拒绝其他保存发生前已打开的旧草稿。撤销浏览器页面不能证明已发出的凭据保存是否完成。

## Decision

[云端 API](../../../../packages/cloud/pe-cloud-api/README.zh.md) 通过原生生成的 Remote 描述符开放单一批准模型密钥操作族。原登录 Peer 保留既有 AccountUse。版本比较在原账户保存轮次内进行，原生凭据 provider 持有文档及原子写入权。确认完成后推进不透明编辑版本；完成情况未知时关闭准入，保留原图、失败和容量，直到实际结算。

[云端页面](../../../../packages/cloud/pe-cloud-client/README.zh.md) 在 UI 激活前准备原 [Models 集成](../../../../packages/client/ui-settings-models/README.zh.md)。稳定编辑源初始为 null，并同步撤销。每个显式编辑意图捕获一次版本及回调，后台元数据读取丢弃版本。既有 renderer 经框架 hook 绑定该源；页面或依赖替换时卸载对应草稿。晚到响应不能向替代页面报告成功。

Settings 元数据保持只读。云端不注册自动 Welcome 和凭据 onboarding，避免不可用的确认设置挡住手动 Models。未提供可选集成的应用保留原生行为。必需原生 UI 模块各有唯一供应方及实际发布的浏览器产物。

账户环境在启动前屏蔽环境各层中的批准模型密钥引用，因此移除账户已保存密钥不会选中共享进程的密钥。原生[凭据优先级](2026-10-09-stored-credential-precedence.zh.md)、[凭据边界](2026-07-30-credential-boundaries-and-atomic-registration.zh.md) 和[授权记录](2026-08-13-credential-records-and-authorization-flows.zh.md) 继续作为通用契约；此账户集成不增加凭据存储或文档格式。

## Alternatives considered

**开放未受限原生写入口。** 页面可以立即操作，但通用 Settings 和凭据操作会超出批准的账户字段及引用策略。

**新增云端凭据存储和保存队列。** 第二套持久化及排序权会与实际模型请求使用的 provider 分离，并使排空责任复杂化。

**每次元数据读取后更新已打开编辑的 token。** 这会悄悄把旧草稿变成当前写入，失去预期的冲突检查。

## Consequences

用户通过手动 Models 编辑或移除批准密钥。提供商选择、其他 Settings 写入及自动 onboarding 属于独立能力。确认的本地保存证明持久化，随后真实原生模型请求证明可用性。组件测试和生成契约不能证明已安装浏览器模块激活或部署验收。
