# 可信平台 Bundle

[English](README.md) | 中文

这个独立 `dsh` Bundle 将 Web 服务与 PowerEvolve [可信平台](../application/README.zh.md#trusted-platform) 组合，负责数据库连接、身份与审批检查、持久操作、带凭据的模型请求、受控连接器派发、Agent Sandbox 管理和配对设备授权，不运行 Agent 或用户命令。

使用[当前云端试用指南](../TRIAL-S4-NATIVE.md)准备私密配置和仅限指定命名空间的 Kubernetes 权限。平台需要 Python 3.9+ 以[安全访问 POSIX 工作区](../S2-SAFE-POSIX.md)。表结构初始化与测试账号预置完成后才发布就绪状态，重启不会覆盖已有账号、模型授权、个人技能、设备和权限决定。

Profile 按用户预置九个内置技能，无需启动执行环境。`skillLibraryRoot` 指向私有 POSIX 存储；启用云执行时必须与 `sandboxLocalRoot` 相同，保证已校验的包与沙盒只读挂载使用同一来源。`preinstalledSkills` 选择目录 ID，`maxSkillsPerUser` 限制个人库规模。
