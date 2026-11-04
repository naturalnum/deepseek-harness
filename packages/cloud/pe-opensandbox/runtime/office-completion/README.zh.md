# Office 镜像交接

[English](README.md) | 中文

这些离线工具核验保留的 v5 Office 上下文全部 251 个文件，保全每个原始资源字节。它们不调用 Docker，不改变资源，也不执行 Office 镜像。历史暂存环境 CLI 检查与实际签发账户的验收分开记录。当前集成策略允许经审查的必要小补丁；此前严格上游迁移和隐含要求 4 GiB 空闲的方案均已被替代。

`prepare_context.py` 保留原始 v5 配方，供历史对照。其 `--required-builder-free-bytes` 输入必须来自明确审阅的峰值模型，不隐含要求 4 GiB 空闲。成功准备上下文不会放行生产导入。只有唯一运行负责人可以构建、导入、调整已批准的本任务基础设施额度或切换生产选择。

`materialize_v6.py --context <v5-directory> --manifest <v5-manifest.json> --wheelhouse <retained-wheel-directory> --wheel-manifest <measured-wheel-manifest.json> --output <new-owned-directory>` 输出确定性的 `context-v6.tar` 和 `manifest-v6.json`。要生成具备构建输入的上下文，必须同时提供 `--owner-inputs <original-directory>` 和 `--stage1-inputs <actual-stage1-directory>`；仅提供一个会被拒绝。两者均不提供时，只生成不能构建的模板。负责人输入目录必须包含 `base-dpkg.raw`、`base-dpkg.json`、`apt-plan.raw` 和 `apt-plan.json`。两份 JSON 都要求 `baseImage` 等于已审阅的精确 c756 镜像、`architecture: arm64`、`observationKind: actual-readonly-owner-observation`，以及原始文件的 `rawEvidenceSha256`。基础 `packages` 和方案 `newOrChangedPackages` 包含完整的 `{name, version}` 记录；`requestedPackages` 必须保留全部原始直接 apt 依赖。基础原始行使用 `dpkg-query -W -f '${db:Status-Status}\t${Package}\t${Version}\n'`；方案原始文本是对完整请求列表执行 `LC_ALL=C apt-get -s --no-install-recommends install` 的原输出。两者必须在同一受控观察中从 c756 取得。第一阶段目录包含已经审查的精确 `ACTUAL-STAGE1-PLAN.json`、`APT-STAGE1-SIMULATION.raw` 和 `APT-STAGE1-SELECTED-METADATA.raw`。固定方案指纹为 `e5a58884652af1dc840d0f37fedabd8da09edb85901ff4e3001052eb75e7d816`。它选择 192 项变更，得到 287 包的中间包表；剩余 59 项变更必须复现原始完整 345 包版本表。此前静态 193/58 估算已被替代。每阶段核验完整起始包表，对刷新后的索引重新模拟，拒绝降级或未计划变更，安装精确版本后核验完整结果包表。清单记录各阶段预期包表指纹。

默认归档包含原始完整的 28 个固定哈希 ARM64 wheel。即使清理后，压缩 wheel 的 COPY 层仍保留在最终 legacy 镜像中，必须计入。可选 `--url-report <pip-dry-run-report.json>` 则要求完全相同的 28 个 wheel 文件名与哈希，并使用官方 `https://files.pythonhosted.org/` 归档 URL。它生成较小上下文，以 `--no-index --require-hashes --no-cache-dir --no-compile` 安装这些直接 URL；不另行解算依赖，不引入 BuildKit 或第二个 daemon。保留的离线 wheel 仍是审计证据。不提供 URL 报告时，为满足 USTAR，多个平台标签的 wheel 文件名缩短为其中已有的一个 ARM64 兼容标签；归档内容和哈希不变。

`Dockerfile.v6` 保留 c756，使用原 legacy 构建器支持的三个阶段。`office-system` 通过 `apt-office` 安装真实 192 项 Office、图形与字体变更集；`office-apt` 通过 `apt-tex` 增加精确剩余 59 项变更；`office-complete` 在随后同一个 RUN 中增加 Python、字体、运行清单和最终权限，不对 apt 目录树执行 chmod。这使各部分工作层与提交层重叠分别发生，最终 345 包版本完全不变。资源仅复制一次，子项权限提前冻结。legacy COPY 以 0755 创建新的目标根目录；payload RUN 仅将 `/opt/dsh/skills/office` 设为 0555，再由未修改的安装器验证完整目录树。不递归 chmod 已复制子项或继承层。资源验证时不再 chmod，通过镜像内符号链接同时保留 `/opt/dsh/skills/office` 和 `/opt/dsh/skills/reports`。已经只读的文件不会再次 chmod。不删除任何包、模板、许可、字体家族、Python 依赖或原生资源字节。两个 apt 阶段都清除自定义 `FONTCONFIG_FILE`，只有字体配置存在后才设置它；apt 触发器使用系统配置。

负责人必须分别审阅每个目标。首先使用 `docker build --target office-system --build-arg BASE_IMAGE=sha256:<exact-reviewed-c756-digest> -f packages/cloud/pe-opensandbox/runtime/office-completion/Dockerfile.v6 -t <owned-system-tag> - < context-v6.tar`。只有实际镜像层、包表、生成文件、内存、inode、提交及清理回执均通过审阅后，才可用完全相同的冻结上下文、`--target office-apt` 和本任务 apt 标签构建，复用原 legacy 缓存。缓存未命中导致早先阶段重新执行时，必须重新取得该阶段当前放行，不能自动批准。`office-complete` 目标还需要单独审阅。不得为用户账户选择中间镜像。准备源文件及此前单 APT 阶段的准入均不授权任何新目标的物理构建。

每个 apt RUN 在包校验和缓存清理后，进入各自有限 900 秒的提交检查点。第一阶段使用 `/opt/office-build/apt-office-commit-request.json` 和 `apt-office-commit-approval.json`，第二阶段使用 `apt-tex-commit-request.json` 和 `apt-tex-commit-approval.json`。请求包含固定阶段、新请求标识、安装器指纹、实际与预期包表指纹及预期包数。批准内容必须恰好为 `{"requestId":"<live-id>","phase":"<matching-phase>","expectedPackageMapSha256":"<reviewed-map-hash>","decision":"approve"}`。第一层的批准不能放行第二阶段。唯一运行负责人必须识别确切本任务构建容器，并对照冻结清单核验请求、实际上层分配、上下文与临时分配，以及剩余提交允许量和 256 MiB 存储、512 MiB 内存保留量。工具无法观察 Host 上层目录，也不认证这些物理测量。旧批准、阶段或包表不符、拒绝和超时均会在成功提交前令 RUN 失败；失败不证明资源已释放，负责人仍必须做物理审计。

用户仅批准本任务后端镜像存储上限 4 GiB 和其父级内存上限 8 GiB。这不证明构建一定容纳，租户配额保持不变。模型必须计入现有层、apt 归档及生成文件、Python 和 venv 文件、适用时压缩 wheel 的保留层、上下文解压、工作层与已提交层的重叠、元数据及至少已审阅的保留空间。缺失的 driver、临时路径、apt 安装后测量不能算作可用容量。外部构建成功不证明原存储导入容量充足。不启动已知容量不足的构建，不清理无关资源，不超出已批准额度扩容，不挂载 Host 依赖，不在运行 Guest 中安装依赖。

通过 `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_*.py'` 运行离线控制检查。实际资格验证必须保留原 Guest 安全字段、租户限额及当前与回滚数据，在原生 `--clearenv` 下验证原 SDK 和账户环境，并在开放调用前完成 13 项技能的模型任务、完整资源哈希、取消和文档视觉检查。冻结归档和离线检查不证明 Office 执行已经完成。
