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

在共享 Web root 安装 `deepscientist-harness-suite/cloud-assets`，显式配置 `requestTimeoutMs: 180000`。它仅提供不可变资源并注入公开地址；此模式没有 `/research/api` 或 `/research/auth`。账号数据始终经带有真实 Session resource 的原生 `cloudResearch/action` Remote 访问。

账号图使用 [cordis.cloud.patch.yml](cordis.cloud.patch.yml)。将完整 `research-suite` 声明加入 Root 批准的 Preset 清单并设为可选，保留 Standard 原声明。账号组合继续安装原工作台及科研/Airalogy 插件。本功能不依赖另行实现的 MCP 管理特性。

Cloud 示例选择原有私有 `cordis:pe-account-instructions-session` 入口和显式有限的来源/快照预算。Root 必须保留原本已准备的账号/项目指令所有者，并在批准科研声明前，将通用工具选项与已批准的受管配置对齐。

自定义技能沿用同一个原生技能注册表中的账号受管提供方。Cloud 科研预设不另装默认文件系统提供方，因为其独立模式默认会发现 Host 用户目录；独立科研内置与账号内发布提供方仍注册在原生技能服务中。

示例显式配置 256 MiB SQLite 页容量、8 MiB 请求/回复/输入结果容量、两个待执行工作台请求、180 秒观察/工具预算、32 KiB 命令输出及 Python/Git 路径。原生 FS 操作只须容纳选定的 64 KiB 窗口及原有 range 回复开销。原有 HTTP unary 载体须另容纳选定 8 MiB 逻辑 RPC 限额与请求/回复包装；这是一次有界 HTTP 调用，并非分块 RPC。WebSocket 入站帧限制与之独立。结果文件经过完整性核验，stdout 仅传递有界回执。配置本身不能证明计算或 OCR 已就绪。

文件传输显式选择 `fileChunkBytes: 65536` 和 `maxConcurrentFileTransfers: 2`。输入先编码为 UTF-8，再通过原生 FS 写入 base64 分片；同一受管 Python bootstrap 在原脚本读取 JSON 前核对完整字节数与 SHA-256。结果、Git 及已交付文件通过原生 `readByteRange` 读取，校验精确长度、前后原生版本及结果回执指纹。完整快照受科研包自己的容量限制；短读、版本变化、取消或指纹不符均明确失败，不报告成功。传输槽位保留到实际暂存、命令观察与结果收集返回；无需修改 Cloud FS 全局限制或复制引擎。

示例中的 8 MiB 输入至多需要 171 个暂存分片；base64 暂存、一个脚本及一个 8 MiB 结果合计至多占用每次传输 19,638,956 字节项目空间。收集器保留一个结果缓冲区及一个 64 KiB 窗口，不再拼接出第二份完整缓冲区。两个槽位合计至多保留 16 MiB 结果字节缓冲及 128 KiB 窗口；UTF-8/JSON 转换还可能在这两个槽位内保留至多 32 MiB 解码后的 UTF-16 文本。这些是字节/字符串容量，不是整个进程的 heap 上限：原领域值、解析对象、源技能资源及原生 FS 预留仍由各自限制和所有者负责。

资源准备另有有限并发、提供方数量、文件数、总字节、单文件及相对路径限制；示例为一次并发、64 个提供方、1024 文件、总量 32 MiB、单文件 4 MiB、相对路径 256 字节。只读预览不创建执行。实际复制须处于真实原生 `skill` 调用中，复查原 Agent/Workspace，并使用既有受管子进程。资源地址必须是当前项目执行世界地址；拒绝符号链接和逃逸，保留用户修改，全部分批复制成功后才返回完整源码/工作副本清单。二进制资源保留原字节。动态 lab skills 继续以内嵌复核证据的 opaque 形式提供，在发布、编辑或撤回后立即使本账号原生技能缓存失效。

Root 必须通过 `commands.additionalTools` 精确批准以下工具，并按相同顺序追加到原有内置 `allowedTools` 之后。这不能授予原生工具分派之外的执行权限。

```json
["skill", "research_workbench_execute", "research_engine_status", "research_engine_run", "research_document_status", "research_document_extract", "research_record_update", "research_record_bind_engine", "research_record_submit", "research_task_open", "research_task_import_csv", "research_roadmap_put", "research_project_git_bind", "research_project_git_state", "research_project_git_commit", "research_project_git_working", "research_project_git_checkpoint", "research_project_git_branch", "research_project_git_merge", "research_project_git_revert", "research_project_git_policy"]
```

## 工作台执行行为

只读元数据使用既有原生 Remote。工作台写入、计算、CSV 导入、记录自动重算、OCR 或 Git 操作，会提交绑定真实 Peer、账号代次和 Session 的有界一次性请求。原生聊天记录操作、请求 ID 和参数指纹；Agent 用此 ID 调用 `research_workbench_execute`，工具读取已保存的精确参数，再经原生执行所有者运行。界面等待真实领域结果，既有执行历史显示进度。因此按钮操作会在聊天中新增执行意图，绝非只填写草稿。

请求在过期、退出登录、作用域销毁或撤回后不能继续执行。模型未调用、取消、超时或重启会报告执行未确认；重启后不会自动重放待执行 ID。重试前应刷新原记录或执行历史，并保留原领域幂等键。实际进程清理和输出容量仍待执行范围与 I/O 真正结算后释放。引擎可在已拥有的取消清理期间记录实际终态；已撤销请求不能在稍后提交人工记录修改。

模型提出的审批继续使用原有 `userQuestions` 和回答前后的精确版本校验。模型不能提交人工令牌，也不能批准另一个版本。已发布 lab skills 仅在本账号不同对话间共享。Git 关联限于真实 Session 原项目；研究分支工作区位于该项目内，不接受 Host 任意路径。

冷态科研对话在操作前后复用原生历史 opening snapshot 的成员、header 和 Preset 准入，并在该 snapshot 处关闭迭代器，不触发原生 promotion。重启后仅打开工作台不会创建或恢复 Agent；执行仍由原生 prompt 恢复。

## 科研镜像

[Dockerfile.cloud](Dockerfile.cloud) 从精确固定的 Office workload 镜像派生。原 Office 解释器仍为 `/opt/dsh/runtime/dependencies/python/bin/python3` 下的 Python 3.12.13；科研执行另用 `/opt/dsh/research/python/bin/python3`，默认 Office/Session PATH 及其包保持不变。新增构建输入、安装文件及最终 `research.json` 均位于 `/opt/dsh/research` 下，结束时仅将该目录设为只读。Root 的 workload 与 SDK-server 镜像白名单仍由各自流程负责。

[cloud-python.json](source-records/cloud-python.json) 固定官方 Astral CPython 3.13.18 Linux arm64 GNU install-only stripped 归档，发行版为 20261026：大小 29,492,455 字节，SHA-256 为 `578d9da1983463ffb0c8c98ab0da2f18177f44069328eb0af847860c1eb05c3e`。冻结构建上下文前，将校验后的归档放在 `runtime-input/cpython-3.13.18-aarch64.tar.gz`；该本地输入不纳入 Git。归档的 Python 许可保留在其标准库目录内。ELF 解释器使用 `$ORIGIN/../lib` 及兼容 GLIBC 2.17 的符号；科学包原生 wheel 可能要求更高版本 glibc 和 `libstdc++`。仅安装二进制 wheel，避免依赖构建期编译器/sysconfig 的重定位假设。仍须通过真实 Linux imports 和 `ldd` 检查。[官方发行版](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)、[运行要求](https://github.com/astral-sh/python-build-standalone/blob/main/docs/running.rst)、[构建期路径限制](https://github.com/astral-sh/python-build-standalone/blob/main/docs/quirks.rst)。

独立解释器安装 `airalogy==0.16.0`、PyMuPDF 1.26.7、RapidOCR 3.10.0、ONNX Runtime 1.31.1、NumPy 2.3.4、Pillow 12.0.0 和 pandas 2.3.3，不继承 Office 包。固定 RapidOCR wheel 包含三个离线 ONNX 模型，资格检查加载其实际字节。探测先记录原 Office 解释器、完整包表、运行时清单及受保护的 runtime/skills/fonts/stdlib/LibreOffice 文件树，在安装后与科研 imports 后分别比较。独立调用的科学探测要求精确解释器/来源记录及包版本，拒绝其他解释器导入路径，加载保留执行器 API 和模型，并记录实际指纹；其清单仅证明这些构建检查。[Airalogy 发行页](https://pypi.org/project/airalogy/0.16.0/)、[RapidOCR 发行页](https://pypi.org/project/rapidocr/3.10.0/)、[ONNX Runtime 发行页](https://pypi.org/project/onnxruntime/1.31.1/)、[PyMuPDF 发行页](https://pypi.org/project/pymupdf/1.26.7/)。

Root 在独立 Linux 后端以本包和固定归档为 Docker context 构建。当前 classic builder 接受本地 `sha256:` 基础镜像选择；准备源码不会调用 Docker。Linux 按大小写敏感规则展开；在大小写不敏感的 macOS 文件系统中，内置 terminfo 名称可能冲突，因此该 Host 上的归档、指纹与 ELF 检查不能替代 Linux 执行验收。新不可变摘要仍须经过原 RootDeployment 及精确 SDK-server/image-policy 资格验证。须在原进程限制内检查实际受管 Python 版本/import、协议解析、变量赋值/验证、工作流转换、CSV 自动重算、生成文件及中英文扫描文档 OCR。缺少依赖时，相应状态保持不可用，实际操作明确失败；提供技能目录不代表其全部第三方服务、可执行程序和凭据已安装。

## 开发与持续升级

先在本包自己的真实 `node_modules` 中完成依赖安装。当前单仓库中先运行 `npm ci --omit=peer`，再运行 `node scripts/link-cloud-peers.mjs`；这些链接存在期间禁止运行安装命令。构建 Host artifacts，用 `node scripts/build.mjs` 构建本包，检查 `tsconfig.cloud.json`；从仓库根目录运行 `node node_modules/vitest/vitest.mjs run --config integrations/epri-research/vitest.cloud.config.ts`。原有包测试继续验证本地模式兼容。

[cloud-integration.json](source-records/cloud-integration.json) 记录导入分支/基线及保留的科研文件。对应补丁仅在复用源码中注入 executor/fetch 传输选择，保留原 upstream 树及许可。升级时获取来源新分支，在独立 feature 分支审阅并仅应用 `git diff --binary OLD NEW -- integrations/epri-research`，适配已记录的注入点、更新来源记录，再运行独立包及 Cloud 组合测试。Python 依赖变化时重新验证新不可变镜像；不要覆盖 Cloud 的根目录检查脚本，也不要以删除 Cloud 准入解决冲突。

组件测试覆盖真实 Loader/Gateway/原生 Session、一次性工作台请求及记录的 keyless 聊天/工具轨迹、脚本化计算通道所有权、账号隔离的实际资源复制与用户修改保留、动态技能隔离及失效。它们不代表真实 Linux 后端验收。最终仍须在已登录浏览器验证按钮 → 原生聊天意图 → 受管 Airalogy 计算 → 原界面结果，并验证精确人工审批、A/B 账号、重启/停用/排空和上述完整工作流/OCR。
