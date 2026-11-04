# Office 镜像交接

[English](README.md) | 中文

此离线准备工具核验保留的 v5 Office 镜像上下文全部 251 个文件，保全原始技能资源，并输出确定性的上下文归档和明确的容量判断。它不调用 Docker，不改变账户、镜像、配额、源资源或正在运行的服务。已有暂存环境 CLI 结果仍只是历史证据；准备出的归档不是已经执行的 Office 环境。

运行 `python3 prepare_context.py --context <v5-directory> --manifest <v5-manifest.json> --output <new-owned-directory> --builder-free-bytes <actual-bytes> --production-free-bytes <actual-bytes> --required-builder-free-bytes <reviewed-bytes>`。输入必须是实际选定构建器和生产镜像存储的新测量值。构建器允许量必须显式来自已审阅的镜像层、工作副本、缓存及提交峰值方案，不隐含要求 4 GiB 空闲。容量不足时，工具写出交接记录并以状态码 2 退出。准备成功返回状态码 0，但不会放行生产导入：新增独有层的字节数及导入峰值只有构建后才能确定。

工具显式选择已经审阅的 SSH 依赖镜像作为基础，在增加 Office 时保留 Remote 能力。运行负责人必须确认基础镜像仍存在，并测量最终镜像。v5 apt 配方尚未固定包版本，Python 也只固定了顶层依赖；冻结上下文或核对其哈希均不能证明依赖锁定可重现。构建器必须将实际完整系统包和 Python 包清单与最终镜像摘要一并保全。

上下文包含前一轮集成的只读原生技能资源。此工具不修改任何原生文件，也不证明与未修改的上游原生基线兼容。严格集成审查者必须另行确认该基线、资源放置位置及既有公开 provider 接口，之后才能选择最终镜像。

只有唯一运行负责人可以构建、导入或切换生产选择。资格验证必须保留原 Guest 安全字段、全部租户限额及当前与回滚数据，不挂载 Host 依赖，并在原生 `--clearenv` 的情况下核验实际签发的账户环境。现有独立 CLI 探针不证明原 SDK、账户及审批生命周期。13 项技能的模型任务、完整包哈希、取消和文档视觉检查必须通过，之后才可开放调用。

在本目录通过 `python3 -m unittest discover -s . -p 'test_*.py'` 运行针对性控制检查。完整产品验收仍由原部署及账户负责人负责。
