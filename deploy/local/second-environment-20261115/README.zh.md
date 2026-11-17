# 第二环境部署输入

[English](README.md) | 中文

这些由 Root 持有的生成器保留原 scientific workload、execd、server 摘要及实测账号物理域。

## SDK 组装

`assemble-native-sdk.mjs` 接受原 `--input`、`--sha256` 和新的 `--output-dir` 参数。它生成新的 SDK 私有输入与密钥。既有部署保留原密钥，经正常排空生命周期选择版本化配置。Execd 使用 Root 命令配置执行固定摘要的受信 Root prep 和 loader；普通命令继续由 AgentData 的 UID 映射、零 capabilities、seccomp 和 bwrap 隔离。

输出包含已安装的精确 Linux x64 ripgrep 文件、只读 workload 挂载和 `BACKEND-MOUNTS.private.json` 内的公开程序元数据。Root 在启动该 server 前，将这些生成文件复制到原 SDK 工作域并核对摘要。

## 检索输入

`node prepare-native-search-inputs.mjs --input /absolute/original-parameters.json --sha256 ORIGINAL_SHA256 --output-dir /absolute/new-directory` 生成新的账号 skeleton 和 Root 参数文件。它保留既有消费者，追加 glob/grep，把原生检索 stdout 和 stderr 各限为 4096 字节，并选择已有 single-instance 模式。激活前，原生成器校验所有账号组合及 Loader schema。

## 激活候选

`generate-feature-root-profile-v3.mjs` 消费原固定摘要的 Root 参数及公开来源，校验匹配已安装产物的 Loader schema 和账号组合，仅在 Linux Root 下写入全新输出目录。可选 `servicePreview` 选择 `inert-text-v1` 或 `service-application-v1`。两者均要求显式 Cookie domain、惰性 origin、完整惰性限额及精确 API 批准。完整模式还要求全部应用/客户端/监听器限额及准确启动批准，并启用原生右侧 Browser，以及隔离 Cordis 分组内的独立原生 WebServer。管理和内容传输均具备显式有限限额。生成的 profile、package 依赖和 `GENERATION.json` 覆盖完整分组；原启动器及最终 profile SHA/FD4 封存仍为准。该生成器不修改运行中的 profile、不启动应用。

将 `DSH_DEPLOY_TEST_INSTALL_ANCHOR` 指向本匹配已构建工作树的 `packages/cloud/pe-cloud-client/package.json`，从其依赖作用域解析真实配置模块，运行 `node --test deploy/local/second-environment-20261115/service-preview-profile.test.mjs`。有限用例覆盖组合、缺省/惰性模式、精确批准、分组发现，以及真实 Root/客户端/监听器配置解析器，不创建监听器、SDK、数据库登录或部署 profile。实际候选仍须经过原生成器 `--check-only true`、正常受保护生成/封存及 Browser/服务验收。

两个生成器均接受 `--check-only true`，校验输入而不创建输出目录。SDK 校验使用精确 Linux x64 检索字节及真实 Root 部署解析器；临时新凭据值仅保留在内存。检索校验使用真实账号组合器并报告计划输出的摘要。实际输出写入仍要求 Linux Root。这些检查不验证运行中的 SDK、物理挂载或服务启动。

生成器产物测试要求匹配的已构建工作树和调用者自有的公开夹具。将 `DSH_DEPLOY_TEST_INSTALL_ANCHOR` 设为该工作树的 `package.json`，将 `DSH_DEPLOY_TEST_PUBLIC_INPUTS` 设为明确的公开输入目录，再运行 `node --test deploy/local/second-environment-20261115/producer-inputs.test.mjs`。夹具读取器仅接受具名公开 SDK 源、参数模板和固定 Linux 检索二进制，不读取既有部署或用户凭据；缺少夹具时测试失败。平台检索路径解析在夹具内隔离，以便在 macOS 校验字节，不执行 Linux 程序。

Root 确认原应用实际退出、原分配实际终态释放，保留可变账号文件和凭据，只在原摘要仍匹配时安装精确托管静态 patch。SDK 生成器仅用于新部署；配置更新保留原 API key、token、控制器记录、backend generation 和镜像。激活后通过真实 UI 工作流验证命令、原生检索、文件传输、重登、Python 执行及账号隔离。

所有 Root 生成在写入前都校验原生管理监听器配置和完整认证策略，包括未启用服务预览的情况。

## Office 依赖清单

组合包含绑定执行镜像的 `load_workspace_dependencies` 工具时，Root 输入必须提供 `officeRuntime: { path, sha256, workloadImageDigest }`。从精确选定的不可变工作负载镜像提取 `runtime.json`。生成器通过匹配的已发布原生解析器检查清单、所选镜像和平台，将原字节暂存至 `office-runtime/`，并在 `OFFICE-INSTALLATION.json` 中列出所有配置的 Host 目标。启动候选前，以生成的完整 `feature-assets/` 目录作为只读功能资产挂载源；其中包含账户基础配置、模块链接、清单和镜像回执；工具有配置但缺少清单时，生成过程拒绝继续。应用 Host 不安装解释器载荷。完成匹配的产物构建后运行 `node --test deploy/local/office-runtime.test.mjs`。
