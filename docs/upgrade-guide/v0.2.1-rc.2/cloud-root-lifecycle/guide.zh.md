---
kind: upgrade-guide
description: "Cloud Root 配置错误会阻止应用启动，不可恢复的单实例排他失败会以状态码 1 退出。"
---

# 配置 Cloud Root 故障处理

[English](guide.md) | 中文

## 变更

Runtime 和认证 Root 配置拒绝嵌套未知字段，不再保留拼错或废弃的键。类型、范围及预算矛盾会以字段路径报错，不回显输入值。两个 Root 插件声明原生 `startupRequired`，配置或激活失败都会阻止应用成功启动，不依赖部署入口 ID。

维护恢复以外启用 `singleInstance: true` 时，确认锁竞争或五次连接恢复耗尽会启动原 Root 收尾，并请求原生启动器以状态码 1 退出。临时重连保留 Context 和 owner epoch。账号或沙箱关闭未知时保留资源责任及隔离状态；数据库锁丢失本身不会终止沙箱。

## 迁移

1. 对照当前 schema 检查部署 profile 的 `cordis.patch.yml` 及 overlay 中的 Runtime/Auth Root 配置。删除未知键，修正报告的类型、范围和预算矛盾。秘密值仍由正式凭据提供者保管。
2. 通过原生 `dsh --profile <name>` 启动器运行。确认错误配置以非零状态退出且不报告就绪，合法部署通过原有就绪检查。
3. 让既有进程监督器观察失败退出状态。单实例不可恢复失败后，在重启前检查保留的 owner、隔离及清理证据，不得清空记录来通过启动。此模式限定每个元数据数据库只有一个应用 Root。
