# Office 解析器运行时

[English](README.md) | 中文

## 摘要

Office 解析器使用专用 runsc handler，在进程启动前禁用网络。Platform 持有私有解析器配置和 Kubernetes 凭据。解析器仅挂载固定输入、输出子目录，使用 UID/GID 1000，且不接收 service-account token。

## 目录

- [节点 handler](#node-handler)
- [集群依赖](#cluster-dependencies)
- [私有配置](#private-configuration)
- [验证](#verification)

<a id="node-handler"></a>
## 节点 handler

在每个允许调度解析器的节点安装兼容的 runsc 和 `containerd-shim-runsc-v1`。将 [offline-handler-extra.toml](offline-handler-extra.toml) 合并到节点持久 containerd 模板，并将 [pe-office-offline.toml](pe-office-offline.toml) 安装到 `/etc/containerd/pe-office-offline.toml`。所有节点的 handler 名、ConfigPath 和 runsc 参数必须一致。审阅节点其他工作负载后，通过集群节点管理流程重载 containerd，并保留已有 handler。

示例 handler 使用 `systrap`、`network = "none"`、禁用 raw networking 并启用 gVisor marker 文件。替换或升级节点须保留相同模板和 runsc 配置。单独创建 RuntimeClass 不会配置节点 shim 或禁用网络。

<a id="cluster-dependencies"></a>
## 集群依赖

所有允许调度的节点配置匹配 handler 后，才在自有集群创建 [RuntimeClass](runtimeclass.yaml)。审阅 [networkpolicy.yaml](networkpolicy.yaml) 的 namespace 占位符，再将其应用到使用有效 CNI 策略执行器的独立解析器 namespace。该策略选择 `power-evolve-office-preview` Pod 并拒绝 ingress、egress；运行时在策略控制器观测新 Pod 之前就禁用网络。

创建运维人员拥有的 PVC，仅向所有解析器节点及 Platform 暴露解析器 cache 树。本地镜像目录与 `volumeSubPath` 必须指向相同字节。存储须支持所需多节点访问；示例不创建 hostPath PV。cache 不得与 workspace、附件、Home 或 Skill 根重叠。解析器输入只读，使用 UID/GID 1000、mode 0400；独立输出目录须允许 UID/GID 1000 写入。

<a id="private-configuration"></a>
## 私有配置

将 [office-preview.example.json](office-preview.example.json) 复制到 Git 外，替换两个 digest 占位符、自有 namespace、claim、cache 路径和部署预算，再限制为仅 Platform 所有者可读。`runtimeClassName` 必须指向已验证的 `pe-office-offline` handler。镜像 digest 和字体策略 digest 必须与审阅后的解析器镜像及字体清单一致；示例占位符不是可执行配置。

Platform row 的 `officePreviewConfigFile` 指向该私有 JSON，`officePreviewKubeconfigFile` 指向独立私有 kubeconfig，或使用 `in-cluster` 选择已有集群内 provider。两个引用须同时配置。私有 deployment JSON 可在 `rows.platform["power-evolve-platform"]` 下覆盖这些字段；Host 不接收任何一个文件。新转换 intent 保留 `runtimeClassName` 和 `safetyVersion: 2`；保留的旧 intent 不得通过未验证运行时启动解析器。

<a id="verification"></a>
## 验证

在每个允许调度的节点，对相同受控 HTTP endpoint 运行自有 control probe 及使用本 RuntimeClass 的 probe。control 的首次请求须成功，受限 probe 的首次请求须以 `ENETUNREACH` 失败，且仅能看到回环网络。在同一受限进程中验证 UID/GID 1000、输入写入返回 `EROFS` 和输出写入成功。记录实际节点、Pod UID、运行时身份和字节，再仅清理这些精确自有 probe。

策略存在、稍后请求被阻止或 Pod 已完成，都不能作为启动网络隔离证据。[镜像证据](../QA-IMAGE-EVIDENCE.md) 区分已记录的两节点 handler probe 与尚待执行的镜像、实际 Office 转换和完整部署验收。
