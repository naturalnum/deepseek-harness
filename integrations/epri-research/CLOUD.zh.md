# 账号原生 Cloud 集成

[English](CLOUD.md) | 中文

本特性保留独立的 `deepscientist-harness-suite` 包及科研、Airalogy、工作台三个内部插件。Cloud 适配复用现有平台；原有本地配置和 HTTP 服务仍可独立使用。Cloud 模式不启动本地科研 HTTP 服务，不使用全局科研令牌，也不创建新的登录、Session、Agent 或执行控制器。

## 职责分工

| 既有 Cloud 能力 | 科研包 |
| --- | --- |
| 真实认证 Peer/AccountUse、原生 Session、已批准 Workspace/Preset | 科研协议、记录、任务、证据、路线、报告及不可变执行包指纹 |
| 原生 userQuestions 和精确版本人工回答 | 原有科研算法、审批详情和回答后的版本/指纹复查 |
| 已验证预分配账号存储、原生 FS、项目挂载及配额 | files 签发的固定 `private/research-suite` 目录中的独立 SQLite Store，以原生 Session ID 关联 |
| 原有受管执行、进程约束、命令预算和实际排空 | 可注入的引擎/工作流、OCR、Git 传输，既有工作台与账号内动态 lab skills |
| 既有侧栏 slot 和账号绑定 Connection RPC | 只读 `/research/` 资源和限定 iframe 桥接，不增加第二条数据 HTTP 通道 |

Host 必须具备仓库 Cloud 原生补丁中记录的能力库存、Session/项目、原始 Peer 和输出释放接口。可选 Host peer 依赖须解析到当前 Host 的同一组包实例；另装一套 Harness 不能满足此要求。

## 配置组合

在共享 Web root 安装 `deepscientist-harness-suite/cloud-assets`，显式配置 `requestTimeoutMs: 180000`。它使用所属 Loader 配置树的安装基址，经原有 `clientModules` 注册本包的浏览器客户端，并提供不可变资源及公开地址；此模式没有 `/research/api` 或 `/research/auth`。账号数据始终经带有真实 Session resource 的原生 `cloudResearch/action` Remote 访问。共享 Root 需要原有 `clientModules` 提供方；资源入口导出的依赖会请求该服务，无需新增设置。卸载该入口会撤回浏览器声明、公开配置及资源路由。原有注册表会拒绝重复的浏览器声明，因此不要另行声明同一 Root 浏览器包。该入口不激活科研 Host 服务。

账号图使用 [cordis.cloud.patch.yml](cordis.cloud.patch.yml)。将完整 `research-suite` 声明加入 Root 批准的 Preset 清单并设为可选，保留 Standard 原声明。账号组合继续安装原工作台及科研/Airalogy 插件。本功能不依赖另行实现的 MCP 管理特性。

Cloud 示例选择原有私有 `cordis:pe-account-instructions-session` 入口和显式有限的来源/快照预算。Root 必须保留原本已准备的账号/项目指令所有者，并在批准科研声明前，将通用工具选项与已批准的受管配置对齐。

自定义技能沿用同一个原生技能注册表中的账号受管提供方。Cloud 科研预设不另装默认文件系统提供方，因为其独立模式默认会发现 Host 用户目录；独立科研内置与账号内发布提供方仍注册在原生技能服务中。

示例显式配置 256 MiB SQLite 页容量、8 MiB 请求/回复/输入结果容量、两个待执行工作台请求、180 秒观察/工具预算、4 KiB 命令输出及 Python/Git 路径。原生 FS 操作只须容纳选定的 64 KiB 窗口及原有 range 回复开销。原有 HTTP unary 载体须另容纳选定 8 MiB 逻辑 RPC 限额与请求/回复包装；这是一次有界 HTTP 调用，并非分块 RPC。WebSocket 入站帧限制与之独立。结果文件经过完整性核验，stdout 仅传递有界回执。配置本身不能证明计算或 OCR 已就绪。

`maxOutputBytes` 对 stdout、stderr 的选择都不得超过原 Root 的 `commands.commandLimits.maxTailBytes`。示例为每流 4096 字节。Python 通过 stdout 返回很小的字节数／哈希回执，完整科研 JSON 则保存在有界 FS 结果文件中。Git 参数及完整 stdout/stderr 通过同样有界的输入/结果文件传输，不占用原生命令参数或尾部容量。配置固定的 Git 可执行文件在受管 Python 下运行，继承其进程组及资源限额，并发读取双管道且受 `maxPayloadBytes` 约束；完整 JSON 超限会显式失败。原受管所有者确认包括 hooks/helpers 在内的整个范围结束后，才报告成功。

文件传输显式选择 `fileChunkBytes: 65536` 和 `maxConcurrentFileTransfers: 2`。输入先编码为 UTF-8，再通过原生 FS 写入 base64 分片；同一受管 Python bootstrap 在原脚本读取 JSON 前核对完整字节数与 SHA-256。结果、Git 及已交付文件通过原生 `readByteRange` 读取，校验精确长度、前后原生版本及结果回执指纹。完整快照受科研包自己的容量限制；短读、版本变化、取消或指纹不符均明确失败，不报告成功。传输槽位保留到实际暂存、命令观察与结果收集返回；无需修改 Cloud FS 全局限制或复制引擎。

Cloud 工具与工作台回复沿用本包 HTTP JSON 表示，省略普通对象中值为 undefined 的可选字段。非有限数值、负零、函数、不支持的对象类型、访问器、循环引用及不完整数组均明确拒绝，不静默转换。`maxReplyBytes` 在发布成功结果前限制完整 UTF-8 JSON 字节数，包括工作台工具的外层包装。Store 写入后的结果失败不会撤销该写入；再次修改前须先读取当前状态。

示例中的 8 MiB 输入至多需要 171 个暂存分片；base64 暂存、两个有界脚本及一个 8 MiB 结果合计至多占用每次传输 19,704,492 字节项目空间。收集器保留一个结果缓冲区及一个 64 KiB 窗口，不再拼接出第二份完整缓冲区。两个槽位合计至多保留 16 MiB 结果字节缓冲及 128 KiB 窗口；UTF-8/JSON 转换还可能在这两个槽位内保留至多 32 MiB 解码后的 UTF-16 文本。这些是字节/字符串容量，不是整个进程的 heap 上限：原领域值、解析对象、源技能资源及原生 FS 预留仍由各自限制和所有者负责。

启动加载器以 UUID 命名，通过原有有界 FS 提供方写入文件。Python 参数使用生成的相对文件名，避免内联加载器源码和重复的绝对项目路径，为原有完整 4 KiB guardian 配置、文件策略及技能副本清单保留空间。加载器恢复脚本、输入、工作目录、结果和 `EPRI_EXECUTION_ROOT` 的绝对路径，校验后立即移除本次精确输入分片，并在 `finally` 中删除加载器、脚本及工作目录。Git 在调用前移除已编译的本次脚本及其配对加载器，不创建工作目录，退出后才生成结果。每个账号同时只准入一次 Git 传输，重叠调用在暂存前拒绝；同名前缀的用户文件仍对 Git 可见。受管 worktree 使用 Git 返回的共享元数据目录，且必须仍在同一授权项目内；外置元数据被拒绝。Git 自身忽略此元数据，不改用户忽略规则。结果沿用原哈希/分段校验和受管删除。取消、准入拒绝或进程被终止不能保证 Python 清理：暂存文件仍受原项目配额约束，未决执行仍由原受管范围负责；Host 不绕过原生 FS 权限删除这些文件。

资源准备另有有限并发、提供方数量、文件数、总字节、单文件及相对路径限制；示例为一次并发、64 个提供方、1024 文件、总量 32 MiB、单文件 4 MiB、相对路径 256 字节。只读预览不创建执行。实际复制须处于真实原生 `skill` 调用中，复查原 Agent/Workspace，并使用既有受管子进程。资源地址必须是当前项目执行世界地址；拒绝符号链接和逃逸，保留用户修改，全部分批复制成功后才返回完整源码/工作副本清单。二进制资源保留原字节。动态 lab skills 继续以内嵌复核证据的 opaque 形式提供，在发布、编辑或撤回后立即使本账号原生技能缓存失效。

Root 必须通过 `commands.additionalTools` 精确批准以下工具，并按相同顺序追加到原有内置 `allowedTools` 之后。这不能授予原生工具分派之外的执行权限。

```json
["skill", "research_workbench_execute", "research_engine_status", "research_engine_run", "research_document_status", "research_document_extract", "research_record_update", "research_record_bind_engine", "research_record_submit", "research_task_open", "research_task_import_csv", "research_roadmap_put", "research_project_git_bind", "research_project_git_state", "research_project_git_commit", "research_project_git_working", "research_project_git_checkpoint", "research_project_git_branch", "research_project_git_merge", "research_project_git_revert", "research_project_git_policy"]
```

## 工作台执行行为

只读元数据使用既有原生 Remote。工作台写入、计算、CSV 导入、记录自动重算、OCR 或 Git 操作，会提交绑定真实 Peer、账号代次和 Session 的有界一次性请求。原生聊天记录操作、请求 ID 和参数指纹；Agent 用此 ID 调用 `research_workbench_execute`，工具读取已保存的精确参数，再经原生执行所有者运行。界面等待真实领域结果，既有执行历史显示进度。因此按钮操作会在聊天中新增执行意图，绝非只填写草稿。协议版本缺失及版本冲突经原生 Remote 错误与既有 iframe 通道保留原 `NOT_FOUND` / `CONFLICT` 恢复判断，因此首次交互示例可以创建其不可变协议；账号拒绝与其他原生失败保持原错误码。

请求在过期、退出登录、作用域销毁或撤回后不能继续执行。模型未调用、取消、超时或重启会报告执行未确认；重启后不会自动重放待执行 ID。重试前应刷新原记录或执行历史，并保留原领域幂等键。实际进程清理和输出容量仍待执行范围与 I/O 真正结算后释放。引擎可在已拥有的取消清理期间记录实际终态；已撤销请求不能在稍后提交人工记录修改。

模型提出的审批继续使用原有 `userQuestions` 和回答前后的精确版本校验。审批详情仅在被审操作具有修订号或版本时显示通用版本行；准备任务时显示准确的方法版本和源码指纹。模型不能提交人工令牌，也不能批准另一个版本。已发布 lab skills 仅在本账号不同对话间共享。Git 关联限于真实 Session 原项目；研究分支工作区位于该项目内，不接受 Host 任意路径。

文档检索结果的长来源引用在窄科研侧栏内换行展示，完整保留附件引用。

冷态科研对话在操作前后复用原生历史 opening snapshot 的成员、header 和 Preset 准入，并在该 snapshot 处关闭迭代器，不触发原生 promotion。重启后仅打开工作台不会创建或恢复 Agent；执行仍由原生 prompt 恢复。

## 科研镜像

[Dockerfile.cloud](Dockerfile.cloud) 从精确固定的 Office workload 镜像派生。原 Office 解释器仍为 `/opt/dsh/runtime/dependencies/python/bin/python3` 下的 Python 3.12.13；科研执行另用 `/opt/dsh/research/python/bin/python3`，默认 Office/Session PATH 及其包保持不变。新增构建输入、安装文件及最终 `research.json` 均位于 `/opt/dsh/research` 下，结束时仅将该目录设为只读。Root 的 workload 与 SDK-server 镜像白名单仍由各自流程负责。

Git 单独提供于 `/opt/dsh/research/git/bin/git`。[cloud-git.json](source-records/cloud-git.json) 固定官方 Debian 13 arm64 包、完整成员清单和核心 ELF；[cloud-git-verifier.json](source-records/cloud-git-verifier.json) 固定五个临时验签工具包。将三个来源输入和五个验签归档按记录文件名放入 `runtime-input/git/`。独立 Docker 构建阶段验证原不可变 Debian keyring、两个受审 Trixie 签名，以及签名 Release → 包索引 → 包字节、成员路径/链接和精确 ARM64 核心；仅解包到独立目录，不安装系统包、不运行包脚本、不改 Office 库。固定启动入口仅选择该目录内的 Git helpers 和模板。最终镜像仅复制 Git 目录和验证记录，临时验签程序与库均被删除。

运行时 Git 核心采用 Git 官方 `CSPRNG_METHOD=getrandom` 编译选项。[cloud-git-build.json](source-records/cloud-git-build.json) 固定原不可变 Debian keyring，以及签名 Release → Sources 索引 → 精确 Git 2.47.3 源码归档链。将这五个输入放在 `runtime-input/git-source/`，并通过 `GIT_BUILDER_IMAGE` 提供受审且摘要不可变的 Office 派生编译镜像；该镜像须提供 GCC、Make、binutils、zlib/PCRE2/curl 开发头、GPGV 和原 Office Python。构建器验证源码签名及有界归档成员，仅编译 `git`，并检查真实 ARM64 ELF 的 `getrandom` 导入且没有 `/dev/urandom` 回退。运行镜像仅替换原核心的两个副本并新增构建回执；所有原 helpers、模板、Office 和科研 Python 文件保持不变。编译工具及开发库只保留在独立构建阶段。原执行守卫、设备权限和资源限制保持不变；[getrandom 镜像记录](source-records/cloud-git-getrandom-image.json) 区分真实镜像资格与受管 Git 验收。

[原二进制供给镜像资格记录](source-records/cloud-git-image.json) 保留真实离线构建及精确 workload/server 摘要。Office、科研 Python 树和运行配置均保持相同。科学 Python 子进程以 UID/GID 2000、空附加组和全部六项原限制运行，其中 NOFILE 为 32；真实执行 init/status/add、长消息提交、历史/补丁/ref 读取、worktree/merge/revert 与清理，长历史和补丁均超过 4096 字节。这属于镜像供给资格，不代表受管 Session 或已登录 Web Git 验收。Root 必须选择新资格确认的精确镜像组合；仅更改 `gitPath` 不会提供可执行文件。此前的[科研镜像记录](source-records/cloud-images.json) 保留其独立不可变构建历史。

[cloud-python.json](source-records/cloud-python.json) 固定官方 Astral CPython 3.13.18 Linux arm64 GNU install-only stripped 归档，发行版为 20261026：大小 29,492,455 字节，SHA-256 为 `578d9da1983463ffb0c8c98ab0da2f18177f44069328eb0af847860c1eb05c3e`。冻结构建上下文前，将校验后的归档放在 `runtime-input/cpython-3.13.18-aarch64.tar.gz`；该本地输入不纳入 Git。归档的 Python 许可保留在其标准库目录内。ELF 解释器使用 `$ORIGIN/../lib` 及兼容 GLIBC 2.17 的符号；科学包原生 wheel 可能要求更高版本 glibc 和 `libstdc++`。原生扩展仅安装二进制 wheel，避免依赖构建期编译器/sysconfig 的重定位假设。唯一源码例外是固定 SHA 的纯 Python `antlr4-python3-runtime==4.9.3` 归档（117,034 字节），由 RapidOCR 经固定 OmegaConf 2.3.0 引入；已检查其 setup 未声明原生扩展，精确 URL 与 SHA 见 `cloud-requirements.txt`。仍须通过真实 Linux imports 和 `ldd` 检查。[官方发行版](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)、[运行要求](https://github.com/astral-sh/python-build-standalone/blob/main/docs/running.rst)、[构建期路径限制](https://github.com/astral-sh/python-build-standalone/blob/main/docs/quirks.rst)。

独立解释器安装 `airalogy==0.16.0`、PyMuPDF 1.26.7、RapidOCR 3.10.0、ONNX Runtime 1.31.1、NumPy 2.3.4、Pillow 12.0.0 和 pandas 2.3.3，不继承 Office 包。固定 RapidOCR wheel 包含三个离线 ONNX 模型，资格检查核对实际模型文件和指纹并构造引擎。RapidOCR 3.10 在推理时延迟实例化模型，构造成功不证明 OCR 已完成。探测先记录原 Office 解释器、完整包表、运行时清单及受保护的 runtime/skills/fonts/stdlib/LibreOffice 文件树，在安装后与科研 imports 后分别比较。独立调用的科学探测要求精确解释器/来源记录及包版本，拒绝其他解释器导入路径，导入保留执行器 API、构造 OCR 引擎并记录模型文件指纹；其清单仅证明这些构建检查。[Airalogy 发行页](https://pypi.org/project/airalogy/0.16.0/)、[RapidOCR 发行页](https://pypi.org/project/rapidocr/3.10.0/)、[ONNX Runtime 发行页](https://pypi.org/project/onnxruntime/1.31.1/)、[PyMuPDF 发行页](https://pypi.org/project/pymupdf/1.26.7/)。

Root 在独立 Linux 后端以本包和固定归档为 Docker context 构建。当前 classic builder 接受本地 `sha256:` 基础镜像选择；准备源码不会调用 Docker。Linux 按大小写敏感规则展开；在大小写不敏感的 macOS 文件系统中，内置 terminfo 名称可能冲突，因此该 Host 上的归档、指纹与 ELF 检查不能替代 Linux 执行验收。新不可变摘要仍须经过原 RootDeployment 及精确 SDK-server/image-policy 资格验证。须在原进程限制内检查实际受管 Python 版本/import、协议解析、变量赋值/验证、工作流转换、CSV 自动重算、生成文件及中英文扫描文档 OCR。缺少依赖时，相应状态保持不可用，实际操作明确失败；提供技能目录不代表其全部第三方服务、可执行程序和凭据已安装。

[实际镜像构建记录](source-records/cloud-images.json) 固定已成功构建的 Linux arm64 工作负载及其精确的仅 COPY 服务端，登记为其原有封闭 v2 供应商配对。构建保留原 Office 十五层及受保护文件树、完整包表和运行时清单，并实际核对独立科研包 API、OCR 模型文件与引擎构造。这些观察不证明受管 Session 执行、Airalogy 解析/赋值/验证、工作流转换、CSV 重算、受管扫描文档 OCR 或认证 Web 验收；这些检查仍待完成。

OCR 在自身进程内固定一个 OpenCV 工作线程，并保留原 ONNX 线程限额；官方检测器采用 `limit_type=max`、`limit_side_len=1024`，独立于输入页数上限约束检测放大，三个模型文件与归一化保持不变。[资源回归记录](source-records/cloud-ocr-resource.json) 保留原分配失败，以及同一中英文图片在 AS 512 MiB、CPU 75 秒内的成功结果。该诊断在标准库启动后、科研 imports 前设置 AS，原 Native guardian 则在 exec 前设置；它不是受管 Session/Web 验收，也不保证所有小字、旋转和长宽比样本均通过。PDF 与质量矩阵须另验。原生 runner 将当前 Host 文档源码传给原受管解释器，因此此有界源码变更无需重建依赖镜像。

PDF 渲染与 OCR 共用原受管任务，但分离各自重库：PDF 父进程仅导入 PyMuPDF，每个扫描页依次调用一个同脚本图片子入口，复用原图片提取器且不加载 PyMuPDF。子进程继承原文件、网络、进程组及六项资源限额；输入和 stdout 各限 8 MiB，stderr 限 32 KiB，单页墙钟限 60 秒。每页清理先杀停仍存活的子进程，等待退出并 join 三个管道工作线程，再处理下一页；不新增脱离的 Session、Cloud 执行器或重放所有者。CPU 75 秒按进程计，整体墙钟、取消和物理结算仍归原 Native range。[资源记录](source-records/cloud-ocr-resource.json) 区分此前七过一失败矩阵、失败的同进程生存期调整，以及精确当前源码在继承限额下成功处理两页 PDF 的证据；八份未改变的资源/质量输入现已全部通过，包括中英文小字、两页扫描 PDF、旋转、极端长宽比及 PDF 原文提取；真实 Native Session/Web 组合仍须另行验收。

自动计算实验表为未保存的步骤/检查项编辑提供**保存草稿**入口。修改未保存或正在保存时，会立即阻止对话人审请求，包括 React 尚未更新按钮前的第二次点击。保存失败会保留本地勾选和已有计算结果，显示错误并继续阻止人审；显式保存成功后才允许基于最新已保存修订发起人审，不会自动提交或批准。输入自动重算保持原触发范围和防抖。原生确认选项仍精确匹配当前选项文字，不再重复添加确认前缀。

## 开发与持续升级

先在本包自己的真实 `node_modules` 中完成依赖安装。当前单仓库中先运行 `npm ci --omit=peer`，再运行 `node scripts/link-cloud-peers.mjs`；这些链接存在期间禁止运行安装命令。构建 Host artifacts，用 `node scripts/build.mjs` 构建本包，检查 `tsconfig.cloud.json`；从仓库根目录运行 `node node_modules/vitest/vitest.mjs run --config integrations/epri-research/vitest.cloud.config.ts`。原有包测试继续验证本地模式兼容。

[cloud-integration.json](source-records/cloud-integration.json) 记录导入分支/基线及精确科研文件。对应补丁记录复用源码中的 executor/fetch 传输选择、可选模型缺失诊断，Store 的服务注入、JSON 结果与完整图表分页，按绑定仓库重建的 Git 操作状态，以及保留代码块和表格滚动的 Markdown 正文换行，保留原 upstream 树及许可。可选协议 `model.py` 不存在时不记录警告；实际模型内部的依赖/导入错误及父模块解析失败仍然可见。必需模块缺失和已有 namespace 没有 loader 的情况保留原诊断。升级时获取来源新分支，在独立 feature 分支审阅并仅应用 `git diff --binary OLD NEW -- integrations/epri-research`，协调这些适配、更新来源记录，再运行独立包及 Cloud 组合测试。Python 依赖变化时重新验证新不可变镜像；不要覆盖 Cloud 的根目录检查脚本，也不要以删除 Cloud 准入解决冲突。

[500 行 CSV](tests/fixtures/power-quality-500.csv) 与[精确重算请求](tests/fixtures/power-quality-500-recalculate.json)覆盖原内置质量方法：应有合计 50,000、有效合计 45,000、缺失率 10%，计算错误和待计算字段均应为空。生成的柱状图按原始顺序保留全部有效计算点，沿用原图表协议，每页最多 200 点。标题说明页码与总数；500 点分别呈现为 200/200/100。首页标识保持稳定，重算仅删除该记录/图表不再需要的生成页，保留用户图表。[两行 CSV](tests/fixtures/power-quality-2.csv)用于恢复 300/270/10% 示例与单幅生成图。实际原生/Web 资格必须在原 stderr 预算内运行这些输入；使用脚本化科研结果的组件测试及 stdlib 导入器回归不能证明 Airalogy 计算通过。

组件测试覆盖真实 Loader/Gateway/原生 Session、一次性工作台请求及记录的 keyless 聊天/工具轨迹、脚本化计算通道所有权、账号隔离的实际资源复制与用户修改保留、动态技能隔离及失效。它们不代表真实 Linux 后端验收。最终仍须在已登录浏览器验证按钮 → 原生聊天意图 → 受管 Airalogy 计算 → 原界面结果，并验证精确人工审批、A/B 账号、重启/停用/排空和上述完整工作流/OCR。
