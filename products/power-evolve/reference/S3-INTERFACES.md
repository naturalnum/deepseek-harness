# S3 云端账号与设置接口

本切片只增加原生 DSH Web 的本人设置。登录和退出仍使用现有可信平台身份流程；浏览器只持有 Host 范围的 HttpOnly Cookie。旧 PowerEvolve 的管理员用户 CRUD、改密页和原生 Host 全局模型／凭据设置不进入 S3。

## 客户端与 Host

新增一个 `@power-evolve/client-account` Web 包，在原生 `settings.launcher` 注册唯一账号入口，在 `settings.section` 显示本人用户名、授权模型和最大输出 token 数。使用现有 `/api/powerEvolve/me` 和 `/api/powerEvolve/logout`，并新增两个经现有 Cookie 鉴权的产品 RPC：

| RPC | 请求 | 响应 |
| --- | --- | --- |
| `modelsList` | `{}` | `{ models: [{ id, label, maxTokens }] }`，仅当前用户已授权且启用的模型 |
| `settingsUpdate` | `{ requestId: UUID, expectedRevision: 正整数, model: 字符串, maxTokens: 1–8192 }` | `{ model, maxTokens, revision }`，更新后的设置或同一请求的原结果 |

Host 只校验和转发到可信平台 `/identity/models`、`/identity/settings/update`，不读取 PG、模型密钥或全局 DSH 配置。客户端生成一次稳定 `requestId`，网络失败后重试复用；读取新的本人设置后才开始另一次修改。版本冲突显示当前值并请用户重新选择。退出调用产品 `logout`，清除浏览器 Cookie，再跳转可信登录页。

## 可信平台和 PG

V11 增加 `pe_user_models`（用户、模型 ID、显示名、最大 token、启停）与 `pe_settings_mutations`（用户、请求 ID、规范化请求摘要、原结果）两表。现有用户只回填其当前模型的授权。新用户可在私有 seed 文件中提供可选模型清单；只在该用户**首次创建**时装入 PG，日后授权以 PG 为准，平台重启不得从旧 seed 静默恢复已撤销授权。模型 ID 必须属于当前平台接入的 DeepSeek Anthropic 兼容服务；本切片不开放任意 provider URL。

`settingsUpdate` 由平台从凭据解析用户 ID，在一个事务中锁定用户行：先查询该用户的请求 ID；相同请求内容返回原结果，不同内容返回 409；新请求校验 `expectedRevision` 与已启用的模型授权及其 `maxTokens` 上限，再将用户 `settings.revision` 加 1、保存设置和幂等结果。未知或无权模型为 403，旧 revision 为 409。响应不含密钥。`modelsList` 也只按凭据所属用户查询。

新 Prompt 的操作设置快照要在同一用户行锁内从 PG 重读，不能沿用 HTTP 认证阶段读取的旧设置；同一 Prompt 请求重试继续返回旧操作。模型代理在发起一次上游调用前，以 PG 事务检查当前租约和模型授权；这个检查是调用的授权生效点，撤销提交后才开始检查的新调用必须拒绝。已经通过检查的调用可能随后建立网络连接或继续流式输出；S7 再对长期流的撤销响应做故障演练。

## S3 验收

独立 `native-s3` 环境使用两个新账号和真实 PG；两者的授权模型清单不同。两个原生浏览器会话完成登录、打开设置、选择授权模型、修改 token 上限、保存、刷新、发出真实 DeepSeek 对话与退出。检查模型操作快照与平台出站请求一致，无执行沙盒。跨用户读取／修改、伪造用户 ID、无权模型、重复请求、不同内容重用 ID、并发旧 revision 均受控拒绝；Host／平台重启后设置保持。模型密钥仅在平台私有配置，日志与界面不含密钥。

DeepSeek 当前官方 [Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api/) 文档以 `deepseek-flash` 为示例，并说明 `deepseek-v4-pro` 映射。真正授权哪些模型由平台种子或管理员配置决定，不依赖客户端硬编码列表。
