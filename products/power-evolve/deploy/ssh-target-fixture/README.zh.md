---
description: "配置一次性 OpenSSH 目标，用于受控的双用户认证、命令和远端目录验收。"
---

# 隔离 QA 的 OpenSSH 目标

[English](README.md) | 中文

## 概述

此目录提供用于受控 SSH 验收的真正 OpenSSH 目标。配置接受密码或公钥认证，并将普通命令交给各账号的 `/bin/sh`。它独立于 Connector Runner 和产品授权。运行行为、镜像构建及实际接线尚未验证；根集成任务负责串行验证和清理。

## 目录

- [账号与运行文件](#accounts-and-runtime-files)
- [接线参考](#integration-reference)
- [验收覆盖](#acceptance-coverage)
- [已知限制](#known-limitations)
- [开发说明](#dev-note)

<a id="accounts-and-runtime-files"></a>

## 账号与运行文件

镜像定义 `qa-alice`（UID/GID 11001）和 `qa-bob`（UID/GID 11002），不提供 sudo 或 root 登录。启动时为各账号创建权限为 `0700` 的 Home，包含 `work space` 和 `quote's space` 目录。守护进程以 root 启动，负责初始化密码和切换会话身份；认证后的命令以所选账号执行。此 fixture 明确允许任意受控测试命令。

[configure.mjs](configure.mjs) 从 `/run/ssh-target-input` 的只读挂载读取以下 root 所有、仅属主可访问的文件。密码文件须为无换行和控制字符的非空 UTF-8 原文；公钥文件须为不含选项的 Ed25519、RSA 或 NIST ECDSA OpenSSH 公钥行。输入缺失、超长、格式错误或权限过宽时，启动失败并仅给出固定诊断。

| 输入文件名 | 内容 |
| --- | --- |
| `ssh_host_ed25519_key` | 未加密的 OpenSSH Ed25519 主机私钥 |
| `qa-alice.password`、`qa-bob.password` | 各账号独立密码 |
| `qa-alice.authorized_keys`、`qa-bob.authorized_keys` | 各账号接受的公钥 |

主机密钥由操作人员提供，启动时不会重新生成。保留其私有源文件或 Kubernetes Secret，以保持固定指纹。客户端私钥及其口令留在目标之外；加密客户端私钥与普通私钥使用同样的公钥认证。启动时只将公钥复制到 root 控制的可读文件，并更新一次性容器的密码哈希。

[sshd_config](sshd_config) 选择端口 2222，关闭 root 登录、转发、PTY、用户 RC 文件和用户环境注入，守护进程日志级别为 ERROR。[entrypoint.sh](entrypoint.sh) 在配置完成后替换自身为 `sshd`，并清空继承的环境。此目标不需要仓库凭据、供应商秘密或宿主 Workspace。

<a id="integration-reference"></a>

## 接线参考

以下命令仅供准备参考，不是已记录的实际验收证据。依赖 Node 22、OpenSSH `ssh-keygen`、Docker、k3d、kubectl，以及明确选定、启用 gVisor 且执行 NetworkPolicy 的现有集群。按 [Connector 访问准备流程](../../connector-runner/deploy/README.zh.md) 选择一个新的、归属明确的 `pe-connector-*` 命名空间，与可写 Sandbox 命名空间分开。只有根集成任务启动基础设施。

选择仓库外、父目录已存在的新绝对路径 `PE_SSH_FIXTURE_PRIVATE_DIR`。[prepare-private.mjs](prepare-private.mjs) 拒绝已有目录，创建 `0700` 目录和 `0600` 文件，为两个账号分别生成独立密码、普通 Ed25519 私钥、加密 Ed25519 私钥和口令文件，并生成一份主机密钥。askpass 辅助脚本从私有文件提供口令，不将其放入命令参数或明文环境变量。准备过程不打印凭据。失败时保留部分私有材料供操作人员检查和删除；重试须使用新目录。

```sh
node products/power-evolve/deploy/ssh-target-fixture/prepare-private.mjs "$PE_SSH_FIXTURE_PRIVATE_DIR"
docker build -t "$PE_SSH_FIXTURE_IMAGE" products/power-evolve/deploy/ssh-target-fixture
k3d image import "$PE_SSH_FIXTURE_IMAGE" -c "$PE_K3D_CLUSTER"
kubectl --context "$PE_KUBE_CONTEXT" -n "$PE_CONNECTOR_NAMESPACE" create secret generic power-evolve-ssh-target-input --from-file="$PE_SSH_FIXTURE_PRIVATE_DIR/server"
```

只有 `server/` 文件进入目标 Secret。`client/` 和 `materials.json` 须保持私有；后者记录文件引用及公开主机指纹。Docker 构建上下文仅为此源码目录，[.dockerignore](.dockerignore) 只允许 Dockerfile 和三个运行源码或配置文件。Debian 安装产生的主机密钥在同一镜像层内删除；运行凭据不会进入镜像。基础镜像与已缓存的 Connector Runner Node 基础镜像一致，但根任务构建时仍须访问 Debian 软件包。

[kubernetes.example.yaml](kubernetes.example.yaml) 包含 Deployment、ClusterIP Service 和 NetworkPolicy，示例命名空间为 `pe-connector-real-ssh-qa`，镜像为 `pe-ssh-target-fixture:qa`。应用前须在私有副本中替换两者；示例不创建命名空间或 Secret。目标只挂载五个输入文件，不暴露宿主端口，只接受同命名空间 Connector Runner Pod 的入站连接，并禁止目标出站。`imagePullPolicy: Never` 要求事先导入镜像。root 守护进程需要列出的 capabilities，以及可写的一次性根文件系统以更新 `/etc/shadow`；这是目标配置，不是 Runner 配置。

按现有 Connector 部署流程，在同一命名空间部署可独立确认健康的禁止访问监听器。配置按当前源码重建的 Runner 镜像、受限 Platform kubeconfig，以及目标实际 Pod IP 和端口 2222 的目的地白名单。使用 `materials.json` 中的固定指纹。目标 Pod 替换会改变 IP，须明确更新白名单和连接；Service 可用于控制侧检查，不能假设其满足 Runner IP 策略验证。一个独立 PG 数据库及一对 Host/Platform 即可承载两个产品用户。

<a id="acceptance-coverage"></a>

## 验收覆盖

每个产品用户应拥有连接到对应 Unix 账号的连接。串行验证须覆盖三种凭据、错误密码或私钥或口令、主机指纹不匹配、可信页面上的精确审批、拒绝后未执行命令、跨用户拒绝，以及在原 Session 中继续。执行效果不确定性和重复调用验证须使用当前 Runner 镜像。

| 情况 | 远端观察 |
| --- | --- |
| 普通命令 | `id -un`、`pwd` 和 `printf` 返回实际账号、目录和字节 |
| 密码、普通私钥、加密私钥 | 两个账号分别通过各认证方式 |
| 工作目录 | 绝对路径、`~`、`~/work space` 和 `~/quote's space` 对应所选目录 |
| 目录不存在 | 非零退出；命令标记文件不存在 |
| 账号分离 | 各账号写入自己的 Home；另一账号不能读取该 Home |
| 持续身份与清理 | 目标替换后主机指纹保持；临时 Runner 资源被移除 |

使用 Platform 的工作目录字段验证其命令渲染，不要将所有目录切换嵌入提议命令。公钥认证不会将客户端口令发送给 OpenSSH。配置语义见 [Debian OpenSSH 手册](https://manpages.debian.org/bookworm/openssh-server/sshd_config.5.en.html)。

<a id="known-limitations"></a>

## 已知限制

这是一次性 QA 目标，不是生产 SSH 服务、受限命令代理或产品所有权及审批实现。账号共享目标操作系统和 `/tmp`；Home 权限不提供独立内核或 chroot。没有强制命令或 `qa:ping` 替身。任意测试命令可读取账号有权访问的系统文件，并修改该账号的一次性状态。不要挂载产品存储、客户端私钥或生产秘密。

示例 Home 使用 `emptyDir`，随 Pod 消失。验证身份连续性时只保留操作人员持有的主机密钥。密码变更需要重启容器；公钥在启动时复制。NetworkPolicy 执行、gVisor capabilities、软件包可用性、操作系统上的 askpass、守护进程配置、认证、目录、命令结果及产品恢复行为，均须由根任务实际验证。源码静态检查不证明这些运行结果。

<a id="dev-note"></a>

## 开发说明

无。
