---
kind: upgrade-guide
description: "PowerEvolve 云端 STDIO 必须配置原生物理提供方及其 SDK worker 镜像。"
---

# PowerEvolve STDIO 使用原生执行

[English](guide.md) | 中文

## 变更

云端 STDIO 不再通过账户级可写挂载槽启动。配置云执行或 STDIO 的部署必须提供 `nativeExecutionConfigFile`；缺少原生执行配置时 Platform 启动失败。每个获批动作在独立拥有的原生 Pod 中只执行一次。云数据库相邻迁移保留既有记录，并增加独立服务及准备身份。

## 迁移

1. 正常停止原 Profile，对账全部活跃或不确定的旧执行，并使用该版本的备份工具保留匹配检查点。
2. 从匹配版本构建包含 `native-stdio-worker.mjs` 的原生 payload；在原生执行及 STDIO 部署设置中固定同一镜像 registry 摘要，保留精确 runtime 镜像身份映射。
3. 提供私有 `nativeExecutionConfigFile`，保留自有存储、命名空间、资源配额和原生权限。由 Platform 执行相邻数据库迁移；不修改版本标记，也不覆盖旧 SQL 资产。
4. 启动匹配 Profile，重新显式检查并审批 STDIO。验证同账户两个 Session 使用不同 Pod，取消其中一个不改变另一个的 UID。旧审批和不确定副作用不得授权替代调用。详见[应用参考](../../../../products/power-evolve/application/README.zh.md)。
