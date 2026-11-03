# Cloud 内置技能

[English](cloud-builtin-skills.md) | 中文

本运维参考说明可信 Cloud 账户配方，不涉及个人技能安装。[示例覆盖配置](../../apps/cli/config/examples/cloud-builtin-skills.cordis.yml)通过原生提供方注册七项 Office 技能和六项报告技能。原生优先级允许用户安装的同名技能覆盖内置项；管理页面保留两行，并为不可修改的内置项提供详情、文件及完整技能包下载。

在租户可写存储之外准备带版本的发布目录，将 `packages/skill/skill-office/assets` 和 `packages/skill/skill-office/assets/reports` 复制到其中，保留同级目录结构及生成的技能包载荷。运行 `python3 scripts/package-builtin-skills.py --check`。保留报告资源的权限及[来源说明](../../packages/skill/skill-office/assets/reports/SOURCES.json)；内部集成不代表获得额外的再分发许可。

使用 [Office 依赖 Dockerfile](../../packages/cloud/pe-opensandbox/runtime/office/Dockerfile)构建 guest，并选择已批准的精确基础镜像。原生 LibreOffice（包括显示 Word 公式所需的 Math 组件）和 Poppler 在不改变默认执行限额的情况下提供操作能力。字体准备会提取完整简体中文字体面并验证字形和 Unicode 映射保持一致；镜像保留原始字体许可。将该镜像的 `/opt/dsh/runtime/runtime.json` 导出到受保护的 Host 载荷目录，将其摘要绑定到同一发布和镜像。在把覆盖配置应用到账户配方并执行正常封存、审计之前，将 `DSH_BUNDLED_OFFICE_SKILLS`、`DSH_BUNDLED_REPORT_SKILLS` 和 `DSH_EXECUTION_RUNTIME_MANIFEST` 设置为这些 Host 绝对目录。覆盖配置中的 guest 路径保持为 guest 路径，不能替换成 Host 解释器路径。

Linux [Word 目录操作](../../packages/cloud/pe-opensandbox/runtime/office/refresh_word.py) 支持内置报告按顺序排列的主目录、插图目录和表格目录 `TOC \f C/F/T` 字段，包括 1–3 级大纲和文字匹配的 TC 标记；其他目录结构明确拒绝。操作在一次性工作副本中使用独立原生 Writer 实例计算页码，再仅把目录缓存和链接书签写回原始 DOCX。原字段代码、目录外正文/分节及其余 ZIP 成员字节保留；输入文档宏和外部链接更新禁用。原资源（包括 Windows COM 脚本）保持原样。示例配置通过原生文件系统技能提供方和可选 `systemTools.wordRefresh` 提供运行指引，原生技能结果负责记录该指引。

在既有受管 Bash 执行中运行 `/opt/dsh/runtime/office/refresh_word.py <source.docx> <new-output-directory> --soffice /usr/bin/soffice --timeout-seconds <remaining-execution-seconds> --cancel-grace-seconds <remaining-cancellation-seconds>`，显式选择原限制以内的有限时间。已存在的输出路径会拒绝。成功后发布 `report.docx`、`report.pdf` 和 `catalogs.json`；普通失败或已确认的取消会删除自身未完成文件。无法确认子进程静止时保留私有工作文件并报错，原执行所有者继续承担责任。必须检查交付 PDF，并逐条对照目录缓存与实际打印页码；退出状态和已存字段不能单独证明排版质量。

在既有权限、审批、CPU、内存、进程、磁盘及执行预算下，验收构建后的镜像和真实账户配方。验证技能加载、DOCX/PPTX/XLSX 生成和修改、公式缓存、渲染页面、中文字体、PDF/Word 报告、预览下载及取消。[Word 公式探针](../../packages/cloud/pe-opensandbox/tests/builtin-word-math-guest-probe.py)要求公式文本实际出现在渲染 PDF 中，仅保存 XML 不能证明公式显示正常。依赖准备、返回解释器路径、单元测试和临时 CLI 探针均不代表已部署账户或真实模型验收。将失败项和输出哈希保留在发布证据中，并在原运行负责人完成正常部署和验收之前保留上一版本。
