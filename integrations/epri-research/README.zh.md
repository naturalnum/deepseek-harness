# DeepSeek Harness 的 DeepScientist 与 Airalogy 科研插件

[English](README.md) | 中文

本插件为 Harness 网页配置添加科研预设、工具、skill（技能）和工作台，适配官方 `@deepseek-ai/dsh@0.2.1-rc.2` 运行时。上游仓库和确切版本见 [source-lock.json](source-records/source-lock.json)。

- **DeepScientist** 提供**科学研究 · DeepScientist** 预设。可以在当前对话中检索文献、管理科研任务、查看成果并生成报告。在线检索和模型调用需要相应服务。
- **Airalogy** 提供 AIMD 协议、实验记录和工作流执行器。工作台支持读入 CSV 数据、计算结果、生成图表，以及导入和导出 `.aira` 归档。上传、审批和变更都以当前科研对话为界。

## 使用 Cloud 账号集成

独立 Cloud 适配和部署要求见 [Cloud 集成](CLOUD.zh.md)。Cloud 模式保留本包及其科研、Airalogy、工作台三个内部插件，复用既有账号登录、原生 Session、侧栏、文件和受管执行，不启动本地科研 HTTP 服务，也不接受其全局令牌。

## 本地试用

安装 Node.js 24.14 或更高版本，并将 npm 和 pnpm 加入 PATH。若使用专用 Harness 主目录和科研数据目录，请在安装前设置 `DS_SUITE_HOME` 与 `DS_RESEARCH_DATA_DIR`，启动时使用相同设置。从仓库根目录运行以下命令。

```sh
cd integrations/epri-research
npm run install:suite
npm run start:all
```

安装程序从 npm 获取锁定的依赖，构建并测试插件，再将其注册到独立的 `research-suite` 配置。打开启动程序显示的 Harness 地址，使用自己的 Harness 账号登录，选择**科学研究 · DeepScientist**，再从当前对话的右侧栏打开科研工作台。Harness 默认使用 43128 端口，科研服务使用 43127 端口。请妥善保管生成的访问地址和本机数据。

## 配置 Airalogy 执行环境

前端使用 `@airalogy/aimd-core@2.15.0`。随包提供的协议和工作流执行器取自采用 Apache-2.0 许可的 Airalogy 引擎 0.0.9 源码。本地服务将审批通过的源码包传给执行器，完成协议解析、变量赋值与校验及工作流执行。科研记录采用 Airalogy Record v1 格式。

选用 Docker 执行时，拉取固定摘要的引擎镜像。若还需在 Docker 中处理文档和进行 OCR，另行构建文档镜像。以下两条命令均在插件目录下运行。

```sh
docker pull ghcr.io/airalogy/airalogy-engine@sha256:5d26af0a28fc42f042cf079ac6e00b1a4435ff2d1fd02631c5d356bfdd0e08b7
docker build -f Dockerfile.documents -t epri-document-tools:20261026 .
```

在 Windows 上使用本机计算时，将 `DS_NATIVE_PYTHON` 设为已安装 `airalogy==0.16.0` 的 Python 3.13 解释器的绝对路径。本机 OCR 还需要 PyMuPDF 1.26.7、RapidOCR 3.10.0、ONNX Runtime 1.31.1 及配置好的中英文模型。本机计算方法以当前用户的权限执行，应选择已审阅的方法，或使用 Docker 隔离文件系统和网络。

## 验证工作台

服务启动后，运行 `npm run doctor` 检查组件可用性。运行 `npm test` 检查服务、持久化和授权，再运行 `npm run test:profile`，使用锁定版本的官方 CLI（命令行界面）在独立主目录中检查安装、预设组合和卸载。执行环境就绪后，运行 `npm run test:engine` 检查协议与工作流执行、变量赋值、CSV 计算和证据记录。

人工验收时，选择线性标定方法，输入标准值 `0, 1, 2` 和测量值 `1, 3, 5`，核对斜率为 `2`、截距为 `1`。将研究任务导出为 `.aira` 归档，导入新对话，核对任务和计算值。

## 注册到现有宿主配置

将本目录复制到目标宿主分支。在插件目录下依次运行 `npm ci`、`npm ci --prefix harness-runtime`、`npm run build` 和 `npm test`。从目标 Harness 主目录运行 `dsh plugin --profile YOUR_PROFILE add /absolute/path/to/integrations/epri-research`。在插件目录运行 `npm start` 启动科研后端，再用相同的 `DS_RESEARCH_DATA_DIR` 启动所选配置。卸载插件时运行 `dsh plugin --profile YOUR_PROFILE remove deepscientist-harness-suite`。

更新宿主时，请核对 `package.json` 中的 `engines.dsh`，再复测配置、工作台和 Airalogy 执行。分发源码时请保留 [LICENSE](LICENSE)、[NOTICE](NOTICE) 及 `licenses/` 下的第三方许可。
