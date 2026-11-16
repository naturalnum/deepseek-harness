# 第二环境部署输入

[English](README.md) | 中文

这些由 Root 持有的生成器保留原 scientific workload、execd、server 摘要及实测账号物理域。

## SDK 组装

`assemble-native-sdk.mjs` 接受原 `--input`、`--sha256` 和新的 `--output-dir` 参数。它生成新的 SDK 私有输入与密钥。既有部署保留原密钥，经正常排空生命周期选择版本化配置。Execd 使用 Root 命令配置执行固定摘要的受信 Root prep 和 loader；普通命令继续由 AgentData 的 UID 映射、零 capabilities、seccomp 和 bwrap 隔离。

输出包含已安装的精确 Linux x64 ripgrep 文件、只读 workload 挂载和 `BACKEND-MOUNTS.private.json` 内的公开程序元数据。Root 在启动该 server 前，将这些生成文件复制到原 SDK 工作域并核对摘要。

既有 `images.workload` 和 `images.server` 输入可显式选择原重建 pair 或[本机离线 pair](../../../packages/cloud/pe-opensandbox/runtime/server/native-amd64-rebuild-20261116-local.json)。server 必须匹配该精确 workload 及原 AMD64 execd。`supplierCompletionSource` 提供该 server 固定摘要的公开源码；相对原守卫只允许固定 workload selector 不同。原 pair 和默认夹具保持不变。镜像构建与源码检查不建立 SDK 启动、物理挂载或受管执行资格。

## 检索输入

`node prepare-native-search-inputs.mjs --input /absolute/original-parameters.json --sha256 ORIGINAL_SHA256 --output-dir /absolute/new-directory` 生成新的账号 skeleton 和 Root 参数文件。它保留既有消费者，追加 glob/grep，把原生检索 stdout 和 stderr 各限为 4096 字节，并选择已有 single-instance 模式。激活前，原生成器校验所有账号组合及 Loader schema。

## 激活候选

两个生成器均接受 `--check-only true`，校验输入而不创建输出目录。SDK 校验使用精确 Linux x64 检索字节及真实 Root 部署解析器；临时新凭据值仅保留在内存。检索校验使用真实账号组合器并报告计划输出的摘要。实际输出写入仍要求 Linux Root。这些检查不验证运行中的 SDK、物理挂载或服务启动。

生成器产物测试要求匹配的已构建工作树和调用者自有的公开夹具。将 `DSH_DEPLOY_TEST_INSTALL_ANCHOR` 设为该工作树的 `package.json`，将 `DSH_DEPLOY_TEST_PUBLIC_INPUTS` 设为明确的公开输入目录，再运行 `node --test deploy/local/second-environment-20261115/producer-inputs.test.mjs`。夹具读取器仅接受具名公开 SDK 源、参数模板和固定 Linux 检索二进制，不读取既有部署或用户凭据；缺少夹具时测试失败。平台检索路径解析在夹具内隔离，以便在 macOS 校验字节，不执行 Linux 程序。

Root 确认原应用实际退出、原分配实际终态释放，保留可变账号文件和凭据，只在原摘要仍匹配时安装精确托管静态 patch。SDK 生成器仅用于新部署；配置更新保留原 API key、token、控制器记录、backend generation 和镜像。激活后通过真实 UI 工作流验证命令、原生检索、文件传输、重登、Python 执行及账号隔离。
