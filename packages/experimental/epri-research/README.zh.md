---
description: "在既有云端账号中运行电科院科研工作台。"
kind: "package-reference"
---
# @deepseek-ai/dsh-experimental-epri-research

[English](README.md) | 中文

## 概述

将科研工作台接入云端平台原有账号、Session 和执行服务。科研数据归属于原账号，人工决定保留原生认证与审阅流程。此接入是可选功能，不改变默认 Web 组合。

## 目录

- [使用本包](#use-this-package)
- [账号归属](#account-ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

本可选插件将独立构建的[科研套件](../../../integrations/epri-research/cloud/README.zh.md)接入云端平台。在账号 Loader 中安装主入口与 `/workbench`，在原有已批准 Preset 中安装 `/tools`、`/skills`，仅在共享 Web 根实例中安装 `/web`。`/client` 挂载生成的 Remote 描述。应用仍通过平台原有 `dsh` 配置启动。

主入口依赖 `peCloudApi` 和原生 Session Controller。显式配置指定后端 `file:` URL、沙箱 Python 绝对路径、JSON/输出字节上限及子进程清理等待毫秒数。`/web` 需要构建后 `dist/ui` 的绝对路径、浏览器请求超时及并发请求上限。各贡献入口使用空配置。

使用[配置整理脚本](scripts/prepare.ts)处理已解析的部署 JSON，生成供检查的 Root/account 配置副本。脚本保留原有 Preset 标识，通过平台摘要函数固定新配置，仅增加带 `account-session` 守卫的 `epriResearch/execute`。原有容量保持不变；容量不足或托管技能提供器关闭时明确拒绝整理。脚本不启动、封存或发布部署。

<a id="account-ownership"></a>
## 账号归属

每个账号在原有 profile home 的 `storage/epri-research` 下拥有独立 SQLite 存储。每次操作都通过原有 Controller 和项目守卫解析 Session。模型调用保留原生 Agent 和 agent 角色；浏览器调用要求原生已登录 owner Peer。模型工具中的人工审阅还要求原生提问流程及未变更的被审阅版本。JSON 参数和 iframe 均不能指定角色或账号。

计算、Git 和文档提取通过当前 Session 的既有子进程及文件系统提供器执行；缺少提供器时拒绝执行。随包技能资源经云端文件服务的托管技能投影复制，目录元数据不包含 Host 资源路径。账号失效会阻止等待中的结果写回；卸载会取消并等待在途操作完成，然后关闭数据库。

共享 Web 入口仅提供固定公开资源。iframe 只与已挂载的同源父窗口及当前 Session 通信，业务数据通过账号 Remote 传输；`/research/api` 不是数据接口。窗口卸载会取消其待处理请求。

<a id="model-experience"></a>
## 模型体验

### 已批准科研 Preset

#### 模型所见

已批准 Preset 增加科研套件原有的 `research_*` 工具与工程技能目录。[后端贡献](../../../integrations/epri-research/plugins/airalogy/index.mjs)负责其描述和结果。工具结果继续记录为原生 Session 事件。技能按需加载，不会自动追加科研指令正文。

#### Token 影响

工具 schema、工具结果与选中的技能产生相应提示词 token。本包不会额外发起模型调用，也不另建对话日志。

#### KV Cache 影响

工具和技能选择会改变对应缓存前缀。结果事件追加到原生 Session；账号认证本身不增加模型 token。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 接入依赖部署环境实际提供的云端认证、托管技能资源服务、具有物理容量上限的私有存储及已批准 OpenSandbox 镜像。本地 Loader 或 Docker 测试不能证明这些生产设施可用。镜像需要 Airalogy、Python、Git、Poppler 和 Tesseract；[镜像扩展](../../../integrations/epri-research/cloud/Dockerfile)保留原始入口，构建时应选择原基础镜像的运行用户。

- 科研后端保留自己的许可证和依赖锁文件，与本 workspace 插件分别构建。现有单机科研数据不会自动迁入云端账号。

<a id="dev-note"></a>
### 开发备注

运行本包组合测试前先构建科研后端；Web 浏览器包供应测试还需要最新平台构建产物。
