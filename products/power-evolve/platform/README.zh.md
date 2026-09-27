# 可信平台 Bundle

[English](README.md) | 中文

这个独立 `dsh` Bundle 将 Web 服务与 PowerEvolve [可信平台](../application/README.zh.md#trusted-platform) 组合，负责数据库连接、身份与审批检查、持久操作、带凭据的模型请求、受控连接器派发和 Agent Sandbox 管理，不运行 Agent 或用户命令。

使用[当前试用指南](../TRIAL-SLICE4.md)准备私密配置和仅限指定命名空间的 Kubernetes 权限。表结构初始化与测试账号预置完成后才发布就绪状态，重启不会覆盖已有账号和权限决定。
