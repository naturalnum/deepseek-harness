# 共享宿主 Bundle

[English](README.md) | 中文

这个独立 `dsh` Bundle 将原生文本 Agent 服务与 PowerEvolve [宿主插件](../application/README.zh.md#host) 组合，不继承原生本机执行 Profile。部署默认值在 `cordis.patch.yml` 中声明；Profile 补丁会替换条目的完整配置。

使用[当前云端试用指南](../TRIAL-S4-NATIVE.md)准备私有 Profile 并启动。平台必须可用，才能完成准入、任务领取、历史访问、模型调用、连接器工具授权、个人技能和云端执行受理。

Bundle 装配原生 `dsh-skill`、`dsh-tool-skill` 及作用于单个 Agent 的平台提供器，不启用文件系统技能扫描器，不在宿主装载用户包代码。
