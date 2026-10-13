---
kind: upgrade-guide
description: "PowerEvolve 云端 Profile 要求私有未决请求密钥，并将产品数据库推进至 schema 6。"
---
# PowerEvolve 未决请求配置

[English](guide.md) | 中文

## 变更

PowerEvolve Platform Profile 现在要求 `nativeIntentKeyFile`。cloud-native 数据库通过相邻迁移从 schema 5 推进至 schema 6，保留既有数据。密钥保护共享 Platform journal 中的原始变更请求，其中包括 operation 与 Writer 凭据。Host 无需此密钥副本。当前产品默认仅预装 `builtin.pdf`；其他既有 Skill 资产和历史保留。

本变更影响私有 PowerEvolve 产品 Profile，不影响普通上游 DSH Profile。旧产品二进制不接受 schema 6。

原生 publication、input 与 turn 变更现在先调用 `/runtime/native-intents/prepare`，再调用 `/runtime/native-intents/execute`。原八个直接变更路由返回 HTTP 410 和 `native_retained_protocol_required`；Host 与 Platform 必须同步升级。经 worker 凭据认证的对账扫描覆盖其他 Host 身份的原请求，只返回无令牌结果，不签发旧操作权限。冷恢复 worker 仅在原操作不可恢复且 Session 没有活动 Writer 时清除已提交请求。Host 的 `nativeIntentReconcileLimit` 限制每次维护扫描，`nativeIntentMaxLocalReceipts` 限制待确认的本地回执记录数。

## 迁移

1. 使用与旧版本匹配的备份工具，备份已停止的部署，保留 PostgreSQL 及全部配置的私有存储根。启动新版前停止旧 Host 与 Platform Profile。
2. 创建 Platform 私有文件，内容为随机生成的32字节密钥的规范、无填充 base64url 编码，仅允许 Platform 账户读取。将 `power-evolve-platform` 行的 `nativeIntentKeyFile` 设为其绝对路径。随附补丁使用 `PE_NATIVE_INTENT_KEY_FILE`，或 `PE_PRIVATE_DIR/native-intent-key`。私有配置备份和恢复必须保留其准确字节。
3. 渲染新版[具名 Profile](../../../../products/power-evolve/deploy/README.zh.md#profile-lifecycle)。按当前迁移范围将 `enabledBuiltinSkills` 与 `preinstalledSkills` 配置为 `['builtin.pdf']`。`nativeIntentMaxRequestBytes`、`nativeIntentMaxPendingPerSession`、`nativeIntentMaxRecordsPerSession` 和 `nativeIntentMaxRetainedBytesPerSession` 定义部署限额；达到限额时拒绝新增保留请求。
4. 使用普通部署角色先启动 Platform，再启动 Host。新业务前核对实际 schema 版本、就绪状态和原数据。使用同一应用产物验证未决请求恢复；就绪状态本身不证明恢复或业务验收通过。
5. 此后使用匹配 schema 6 的备份工具。其必填 `nativeIntentKeyFile` 必须指向选定 `privateConfig` 根内的实际密钥，恢复校验原相对路径与准确字节。回退时将已停止的旧备份恢复到独立目标，再启动匹配的旧版本；不要让旧二进制连接已升级数据库。
