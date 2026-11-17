---
kind: upgrade-guide
description: "Cloud Office 配置生成需要绑定镜像的 Host 运行时清单，有界命令载荷也使用新的源码 pins。"
---

# 发布 Cloud Office 运行时清单

[English](guide.md) | 中文

## 变更

Root 配置生成器拒绝启用绑定执行镜像的 `load_workspace_dependencies` 工具却未提供所选镜像清单的组合。生成器暂存清单原字节，并列出明确安装目标。原生清单读取器将旧 OCI 架构名 `amd64` 规范化为 `x64`，不改写镜像文件。

有界命令启动器现在将 `MALLOC_ARENA_MAX=1` 传入已清空的环境。Python 源码及 bootstrap pins 随之变化；512 MiB 地址空间上限、32 个文件上限、隔离及 wire 协议均不变。仍固定旧载荷的部署需使用匹配的新受保护配置。关闭图像的部署不再提供 `read_image`；这不会启用 Cloud 图像入口。

## 迁移

1. 从 Root 精确选定的不可变工作负载镜像提取 `/opt/dsh/runtime/runtime.json`，记录其 SHA-256 与镜像摘要。解释器载荷保留在镜像内。
2. 向 [Root 生成器](../../../../deploy/local/second-environment-20261115/generate-feature-root-profile-v3.mjs)提供 `officeRuntime: { path, sha256, workloadImageDigest }`。通过正常的版本化资产安装流程，以完整的 `feature-assets/` 目录作为应用只读功能资产挂载源；`OFFICE-INSTALLATION.json` 记录挂载目标和每个清单位置。
3. 构建匹配的产物，在后继受保护部署中使用当前 [agent 源码 pin](../../../../packages/cloud/pe-opensandbox/src/agent-data/constants.ts)。保留账户数据，正常等待旧执行拥有者结清，使用原启动及回退流程。不得改写运行中实例的 pins，也不能把旧分配视为新载荷。
4. 在新测试会话中调用真实依赖工具两次，执行其返回的 Python，修改输入后重算工作簿，核对缓存结果和中文 PDF 文本，并下载实际保存文件。保留既有进程限制。图像入口关闭时，确认 `read_image` 不可见，且视觉检查明确报告不可用。
