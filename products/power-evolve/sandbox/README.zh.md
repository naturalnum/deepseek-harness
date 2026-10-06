# 沙盒文档工具链

[English](README.md) | 中文

沙盒镜像保留现有 HTTP runner。可信进程以 root 启动，使 `runner.mjs` 能以 UID/GID 1000 运行用户命令。部署时 `/workspace`、`/home/agent`、`/tmp` 是可写挂载，镜像根文件系统只读。工具链和 OfficeCLI 位于镜像内；Platform 另行挂载用户的包技能。

## 固定输入

- Node 22.23.2 Bookworm slim 基础镜像：`sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`。
- Debian Bookworm 及安全更新的 apt 仓库：`20260901T000000Z` 的签名快照。精简基础镜像尚无 CA 证书，所以首次 apt 更新使用 HTTP；apt 仍用基础镜像中的 Debian 归档密钥校验 Release 签名与软件包哈希。
- 私有 venv 中的 Python 3.11：`requirements-skills.lock` 固定全部直接和间接依赖的版本及发行文件 SHA256，由 `requirements-skills.in` 生成。runner 限制命令 `PATH`，`/usr/local/bin/python3` 包装脚本仍会调用该 venv。
- OfficeCLI 1.0.151：amd64 二进制的 SHA256 必须是 `8e2512234ae1111e51ad3a9fadbdeca266adfa7f683773469aa45b83fe06dc7f`；arm64 必须是 `fccb7d7841c9ec93593a62181544c893ee184455421cf15bd76110bf0ad29c41`。

镜像包含 LibreOffice Writer、Calc、Impress、Math、Python UNO、Pandoc、Poppler、XeLaTeX/CTeX、Noto CJK 及 Debian 的文泉驿和 TeX 字体。Writer 导出可编辑 OMML 公式需要 Math；缺少它时，PDF 导出可能返回成功却遗漏公式。报告目录更新器通过 `/usr/bin/python3` 使用 UNO；文档编辑使用私有 venv。不安装 JDK、Maven、Chromium 或 Windows 字体。Debian 指定日期快照固定 apt 软件包集合，基础镜像摘要固定初始系统状态。本地 QA 标签可以改变；用 `docker image inspect pe-s8-skills-runner:qa --format '{{.Id}}'` 记录准确的本地镜像 ID。推送后才能获得部署用的不可变 registry digest。

runner 为子进程提供固定环境，不转发镜像的 `ENV` 值。需要 `OFFICECLI_SKIP_UPDATE=1` 的文档命令必须在该命令内显式设置。

## 隔离 Office 预览

`office-preview.mjs` 通过共享 Office 预览验证器处理一个解析任务。进程入口不接受参数：`/input/job.json` 只能选择固定的 `source.doc`、`source.docx`、`source.ppt` 或 `source.pptx`；`/output` 必须是空的私有物理目录。包装器核对源文件实际大小和 SHA256，创建私有快照，并要求已安装的 0.1.1 WASM SDK，只使用 `/usr/share/fonts` 且禁用字体元数据缓存。全部转换预算来自 job。部署必须不挂载工作区/Home 且不提供凭据；job 不能选择命令、路径或镜像。

对 DOCX，私有渲染副本将已有 OMML 界符字符属性按 `begChr`、`sepChr`、`endChr` 排列，供 LibreOffice 导入。原始源字节和任务源摘要保持不变；属性值、空右界符及其它包部件内容均保留。UTF-8 和 UTF-16 编码保持不变；无 BOM 的 UTF-16 XML 声明通过字节序前缀识别。ZIP/XML 库从 kit 的物理依赖解析。元数据和实际解压均受 job 的成员数量和解压字节上限约束；加密、ZIP64、重复／越界成员及含 DTD 的 Word XML 部件被拒绝。重打包遵守 `inputBytes`、取消和原有期限；副本超限在创建转换器前以 `input-too-large` 失败。此兼容步骤不核验任意公式语义或视觉版式。

转换和 SDK dispose 成功后，固定的 `/usr/bin/pdfinfo` 在解析器隔离环境中有界输出；取消会终止其所属进程组并等待关闭。PDF 大小、文件头、页数和共享结果验证全部完成后，才独占发布 `result.pdf` 和最后的 `result.json` 标志。失败不会发布成功标志。已验证任务仅在 dispose 和 scratch 清理成功后，才可独占发布 `failure.json`；其中只含协议版本、job、nonce、generation、源摘要和一个共享错误码。无效任务、预加载失败、调用者取消或清理失败均不发布失败标志。同步提交前取消会阻止发布；已经提交成功的结果仍为成功。成功标志绑定 job、nonce、generation、源摘要、PDF 摘要与字节数、页数及缺失字体。消费者还须独立确认解析进程已停止且退出码为零，再核验 PDF 字节；两种标志均不能证明进程停止。

离线 `scripts/assemble-office-preview.mjs` helper 把已准备的物理 Linux 包闭包和已构建的共享验证模块拷贝到新目标。它复用仓库的 Office 包选择机制，要求 0.1.1 WASM，核对引擎文件声明的摘要，拒绝链接与非普通资源，并记录拷贝后的包身份与哈希。它保留拷贝文件权限，并显式把生成文件设为 0644、资源目录设为 0755。它不安装、下载、转换或构建镜像。现有 HTTP Runner 仍独立运行。`tests/` 中的所属测试使用真实临时文件和子进程关闭事件，SDK/Poppler 或微型包资源由替身提供；这些测试不证明生产隔离或原生浏览器验收。

`Dockerfile.office-preview` 使用上述固定 Node 基础镜像和签名 Debian snapshot，定义独立解析器镜像，只安装 Poppler、fontconfig 及指定的 Liberation/Noto CJK/文泉驿/TeX Gyre 字体。构建上下文只含 `runtime/`，即完整离线装配结果：包装器、共享验证器、物理 SDK/WASM 依赖和 `office-preview-closure.json`；不含凭据或用户数据。拷贝文件必须可由 UID/GID 1000 读取。配方以该用户核验 Node 版本、全部清单字节和权限、物理资源及 SDK 预加载，然后使用固定单任务入口。它将 `HOME` 和 `TMPDIR` 设为 `/tmp`，不提供服务，也不下载 npm 资源。部署提供只读输入及根文件系统、空私有输出和有界 `/tmp`。静态及输入测试使用微型 SDK 替身执行验真；实际镜像构建、字体清单和 generation 绑定须另作构建验收。

## 执行文件候选

执行终态响应可包含 `fileChanges`，其中有 `status`、`files` 和 `reasons`。每个文件包含相对 `/workspace` 的规范路径、零到 2 MiB 的 `sizeBytes`，以及扫描字节的小写 SHA256。候选来自命令执行前后有界扫描所证明的新增或内容改变的普通文件；打印路径、未改变文件、仅时间戳更新和删除不会产生候选。前扫描不完整时，只有枚举完成的目录之下才可证明文件新增；先前已观察到的大小改变或已知摘要改变仍可证明文件改变。Platform 另行授权和校验下载。

扫描范围是文件下载契约接受的规范路径：最多 16 段、路径最多 512 个 UTF-16 码元、每段最多 100 个码元。扫描拒绝链接、多重硬链接文件和特殊文件；在任意深度跳过 `.git`、`node_modules`、`.venv`、`__pycache__`、`.cache`；排除超过 2 MiB 的文件。实际遇到排除项会返回 `partial` 和 `excluded_paths`。预算耗尽、路径不可读、读取期间检测到改变，分别产生 `budget_exceeded`、`read_failed`、`changed_during_scan`。只有两次扫描均在该范围内完成且没有排除或错误时，才返回无原因的 `complete`。缺失扫描返回 `unavailable`、空文件列表和 `scan_unavailable`。快照描述观察到的字节，不提供原子视图，也不能识别命令可能创建的所有产物。

root Runner 读取挂载的 Runner token；cwd 校验、命令启动和扫描仅在不含凭据的 UID/GID 1000 子进程中访问用户路径。Python helper 使用目录描述符，扫描不穿越符号链接。命令保留原有 cwd 行为：接受指向工作区内目录的符号链接，外部目标返回 HTTP 403。前扫描、命令执行、写入者清理和后扫描共用一个准入锁；完成前，其他执行 ID 返回 HTTP 409。重复已接受的 ID 只返回已存储状态，不会重新执行。主进程退出后先清理，再等待继承的输出管道关闭或扫描；无法确认写入者已退出时继续关闭准入。取消 helper 时发送 TERM，300 ms 后升级为 KILL，并等待进程关闭。后扫描期间取消保留已经确定的命令结果。扫描失败不改变退出码、超时或取消结果。

沙盒要求隔离的容器 PID 命名空间，root Node Runner 为 PID1。Linux 清理先校验 UID/GID 1000、父 PID1，以及 PID1 的 root 身份和精确 Runner 命令行；不满足则拒绝按 UID 清理。清理终止其他 UID 1000 进程，包括调用 `setsid` 的后代，排除自身和僵尸进程，再验证两轮无活跃进程。后台任务不受支持。清理内部期限为 2.5 秒，每轮最多 4096 个进程条目、总共最多 65536 个条目，地址空间限制 128 MiB、描述符 64 个、CPU 时间三秒；父进程期限为三秒。Runner 对清理另设四秒期限，管道关闭最多等待 500 ms。验证失败时，在尝试清理后关闭剩余输出传输，返回 `unavailable`，并保留准入锁直到 Pod 被替换。关闭输出管道不能作为写入者已停止的证明。

下列整数环境字段分别限制每次扫描。无效值会阻止 Runner 启动；最终列表始终不超过 100 个文件。

| 环境字段 | 默认值 | 有效范围 |
| --- | ---: | ---: |
| `PE_RUNNER_SCAN_MAX_ENTRIES` | 4096 | 1–65536 |
| `PE_RUNNER_SCAN_MAX_HASH_BYTES` | 33554432 | 1–209715200 |
| `PE_RUNNER_SCAN_TIMEOUT_MS` | 5000 | 1–30000 |
| `PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES` | 1048576 | 1024–4194304 |
| `PE_RUNNER_SCAN_MAX_FILES` | 100 | 1–100 |

父进程限制 helper 输出，扫描期限后再给予 500 ms 才终止进程。Linux 扫描子进程限制地址空间为 128 MiB、描述符为 64 个、CPU 时间为 `ceil(timeoutMs / 1000) + 1` 秒；命令子进程不继承扫描资源限制。专项测试位于 `application/tests/s2-sandbox-file-scan.test.mjs` 和 `application/tests/s2-sandbox-runner.test.mjs`。macOS 测试使用真实 POSIX 文件、Bash、HTTP 和子进程关闭事件，以本地 UID 替代生产 UID/GID 1000；Linux 权限隔离、`/proc` 命名空间清理和 Kubernetes 部署须另行集成验收。

## 构建与烟测

```sh
docker build --pull=false --progress=plain -t pe-s8-skills-runner:qa \
  -f products/power-evolve/sandbox/Dockerfile products/power-evolve/sandbox
docker run --rm --user 1000:1000 --read-only \
  --tmpfs /workspace:rw,uid=1000,gid=1000,mode=755 \
  --tmpfs /home/agent:rw,uid=1000,gid=1000,mode=750 \
  --tmpfs /tmp:rw,mode=1777 \
  -v "$PWD/products/power-evolve/sandbox/qa-skills-toolchain.sh:/qa-skills-toolchain.sh:ro" \
  --entrypoint /bin/bash pe-s8-skills-runner:qa /qa-skills-toolchain.sh
```

脚本实际创建和校验 OfficeCLI 文件、导入锁定的 Python 包、生成和提取中文 PDF 并渲染页面、编译中文 CTeX 文档，还会创建并读取 DOCX、PPTX、XLSX 文件。每种 Office 格式均在独立目录导出 PDF，检查非空字节和预期文本，再用 Poppler 渲染 PNG。DOCX 导出还必须保留原生 OMML 公式中的文本。LibreOffice 可能未生成文件却返回零，因此仅凭退出码不能确认渲染成功。脚本另检查 Pandoc、可写挂载和排除的软件。此烟测覆盖工具链；内置技能完整工作流及 Platform 文档命令桥须另行验收。
