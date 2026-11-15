# 第二环境部署输入

[English](README.md) | 中文

这些由 Root 持有的生成器保留原 scientific workload、execd、server 摘要及实测账号物理域。

## SDK 组装

`assemble-native-sdk.mjs` 接受原 `--input`、`--sha256` 和新的 `--output-dir` 参数。它生成新的 SDK 私有输入与密钥。既有部署保留原密钥，经正常排空生命周期选择版本化配置。Execd 使用 Root 命令配置执行固定摘要的受信 Root prep 和 loader；普通命令继续由 AgentData 的 UID 映射、零 capabilities、seccomp 和 bwrap 隔离。

输出包含已安装的精确 Linux x64 ripgrep 文件、只读 workload 挂载和 `BACKEND-MOUNTS.private.json` 内的公开程序元数据。Root 在启动该 server 前，将这些生成文件复制到原 SDK 工作域并核对摘要。

## 检索输入

`node prepare-native-search-inputs.mjs --input /absolute/original-parameters.json --sha256 ORIGINAL_SHA256 --output-dir /absolute/new-directory` 生成新的账号 skeleton 和 Root 参数文件。它保留既有消费者，追加 glob/grep，把原生检索 stdout 和 stderr 各限为 4096 字节，并选择已有 single-instance 模式。激活前，原生成器校验所有账号组合及 Loader schema。

## 激活候选

Root 确认原应用实际退出、原分配实际终态释放，保留可变账号文件和凭据，只在原摘要仍匹配时安装精确托管静态 patch。SDK 生成器仅用于新部署；配置更新保留原 API key、token、控制器记录、backend generation 和镜像。激活后通过真实 UI 工作流验证命令、原生检索、文件传输、重登、Python 执行及账号隔离。
