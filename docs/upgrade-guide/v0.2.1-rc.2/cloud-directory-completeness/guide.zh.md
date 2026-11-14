---
kind: upgrade-guide
description: "Cloud 内容准备要求 helper 的真实目录完整性能力；有界列表显式报告截断。"
---

# Cloud 内容能力要求目录完整性

[English](guide.md) | 中文

## 变更

Cloud 选用的 ABI8 内容能力组现在要求 helper 和 worker 实际报告 `directoryListingVersion: 1`。缺少该能力的旧 ABI8 helper 不能再准备这组能力，即使眼下只使用 `lstat` 或字节读取。ABI8 或方法存在不代表具有新能力；未知版本使协议握手失败。

`FileSystem.listDir` 仍完整返回或失败。Cloud 的有界扫描不完整时返回 `FS_TOO_LARGE`。新增的 `listDirectory` 返回必需的 `{ entries, truncated }`；Native WorkspaceFiles 同时保留提供方截断与自身答案上限。既有 Local 和 SSH 提供方继承完整的默认实现。部分子集没有游标，不提供遗漏项的完整访问。

完整浏览可选用独立的 `directoryPagingVersion: 1` 能力和 `WorkspaceFiles.listPages` 流。未选用分页与旧 helper 保留有界列表；截断数组不会变成可接续页面。

## 迁移

1. 使用 `DSH_FD_TEXT_ABI` 和 `DSH_FD_CONTENT_ABI` 构建并固定独立命名的 ABI8 helper，与匹配的 worker/client 一起部署。保留显式内容限额和原账号排空步骤；不得给旧二进制补写能力标记或在适配器中推定能力。
2. 确认实际 helper 导出和 worker ready 消息都携带 `directoryListingVersion: 1`，再通过原 `assertContentAvailable()` 接纳依赖内容的配方。ABI6/7 资产和未选用内容能力的路径保持既有行为。
3. 需要完整结果的消费方保留 `listDir` 并处理失败；允许部分展示的消费方可使用 `listDirectory`，必须保留 `truncated`。不能将已排序子集当成全目录排序后的前若干项或分页游标。
4. 执行正常 Linux 生成、构建和所属回归，包括现有 built-worker 内容检查中的 0／63／64／65／129 项。确认旧 helper 拒绝准备，完整列表消费方绝不接受截断结果。
5. 启用分页时，显式选用正数 `directoryPaging.idleTimeoutMs`、`totalTimeoutMs` 和 `maxPages`，部署匹配的 helper／worker／client，并将 `workspaceFiles/listPages` 暴露为 account-session 流。核验 65／128／129 项浏览及末项文件动作、版本变化重开、无 credit 清理，以及预览／下载前的 Host 关闭确认。保留原 Peer／Use 检查，不把该端点加入 HTTP 文件读取准入。
