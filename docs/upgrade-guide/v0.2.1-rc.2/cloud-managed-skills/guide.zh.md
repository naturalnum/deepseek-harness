---
kind: upgrade-guide
description: "Cloud 技能装配必须显式提供管理能力及八方法 Remote 清单。"
---

# Cloud 托管技能装配

[English](guide.md) | 中文

## 变更

装配 `CloudSkillService` 的 Cloud 部署必须提供必需的 `managed` 能力。服务将旧 sample 两方法和六个管理方法注册为一个原生能力；缺少管理配置时在注册前拒绝。现有 `current`/`publish` 请求字段和 schema1 sample 数据继续支持；普通原生技能组合不变。单一目录仅在实际修改后转为 schema2；不支持 schema2 的旧 reader 必须拒绝，不能覆盖它。

## 迁移

1. 将 `approvedConfiguration.skills.mode` 设为 `managed`，保留有限的旧 `limits`，并显式提供 `ManagedSkillApiLimits` 的四个有限 `management` 字段。
2. 添加 `CloudSkillService` 声明的八个 `cloudSkills` 端点，均使用 `handlerId: native:cloudSkills` 和 `guard: authenticated-account`，不添加 stream。
3. 显式配置 `files/root.skillBundles` 的每个字段及原技能源与投影限额。Runtime 经 `LinuxFilesPool.requireSkillBundleLimits()` 读取这些实际限额，并提供原 `assertWorkspace` 与完整资源 materializer。仅传递活动源回调内的 `snapshot.version`；源、父目录、materialize 和核验操作结果会同时占用 resident 容量。配置受保护执行策略的 `skillCopies.maxCopiesPerOperation`，每条命令都经 `borrowAllBundleWorkingCopies` 借用包括 legacy 在内的完整副本。保留原 files/account binding、保存 owner 和 Agent/项目守卫。
4. 重新生成 Host/Remote 产物，编译 owning Client 和独立发布声明 consumer；开放业务准入前核验实际八方法原生清单和 restore。
5. 编辑前重读安装状态。冲突要求重读；持久化未知或应用失败必须先对账，不能自动重放。回退到不兼容二进制时保留 schema2 数据及不可变源。
