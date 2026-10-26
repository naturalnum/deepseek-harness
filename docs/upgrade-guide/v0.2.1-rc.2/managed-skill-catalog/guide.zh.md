---
kind: upgrade-guide
description: "托管技能目录和完整树副本记录要求读取方支持 schema2。"
---
# 托管技能目录读取方须支持 schema2

[English](guide.md) | 中文

## 变更

启用 `pe-cloud-files/root.skillBundles` 后，托管安装项写入原私有 `skills/current.json` 的 schema2 目录。schema1 不迁移，仅映射为旧 `sample` 安装项；首次目录提交保留该项及其不可变版本。旧 API 仍只向该槽发布两个文件。完整树的项目副本关联使用 schema2，同时支持旧 schema1 记录。旧读取方拒绝新格式，无法安全管理这些目录。

## 迁移

1. 一并升级 files helper、files 包及消费它们的原生 provider／API。在原已核验的 private/projects 硬域内显式配置全部 `skillBundles` 限额。要求三个独立的包 helper 能力；仅有 ABI8 不足以启用。
2. 将管理修改纳入同一 AccountSaves turn，并对完整目录执行 FsVersion CAS。完整树原生消费者持有原操作借用；`withBundleSource` 回调中的物化使用该回调的 `source.version` lease。
3. 确认旧 sample 内容和第二个含嵌套资源的安装项可正确列出、更新和完整下载。旧目录令牌必须冲突。卸载后新加载须失败，同时已有工作副本继续可用。
4. 首次写入 schema2 后，继续使用支持该格式的读取方。不得编辑或替换 `skills/current.json` 以降级。恢复时保留用户副本及不可变来源依赖；unknown 影响须由原 owner 解决后方可复用。
