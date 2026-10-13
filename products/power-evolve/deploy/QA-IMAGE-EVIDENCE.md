# Linux 镜像构建证据

本记录保留 2026-10-09 各固定版本的镜像与备份结果；下文“当前”“最新”均以对应记录时点为准。现行候选资格及 M5 状态见[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)。

2026-10-09；本切片独占 Dockerfile、三个 cloud-image MJS、image 测试、baseline.json 及 deploy 文档。最新 V5 已从固定 `dsh-v0.2.1-alpha.1` 基线和冻结文件清单完成实际冷构建，三个镜像用例全部通过、0 skip；逐文件四项 100% 覆盖门和完整业务恢复验收仍未通过。以下保留各轮的原始结果，旧的 32 个运行工具测试不计入 V5 镜像覆盖。

证据位于仓库外 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee4-cloud-image/`。每轮 `owned-build-vN.json`／`owned-build.json` 绑定唯一 image、context 和源 SHA 清单；`cold-build-vN.log` 与结果 JSON 保留实际失败。原 context 不因共享源更新而改写。

1. v1 frozen install 缺失已声明 patch 文件，失败后显式补入 patches context 路径。原日志和 context 保留。
2. v2 locked cold 安装因 registry 连接中断失败，未进入应用编译；该失败不能标记为业务测试失败。原日志和 context 保留。
3. v3 locked cold 安装实际从零下载全部 1,338 个依赖，编译阶段因 owned builder 把 README sidecar 当成目录触发 ENOTDIR。builder／packer 现使用普通目录筛选；原日志和 context 保留。v3 尚未生成运行镜像。

基线 guard 从 tag 等于 HEAD 修正为固定 tag SHA 加 HEAD 包含该基线，并分别记录 baseline、currentCommit 和工作树文件 SHA。实际独立 Git clone 创建后代提交，确认旧 guard 拒绝、新 guard 接受；新 guard 拒绝缺失 tag 和无关历史。fixture 中 orphan index 清理的初版失败也保留，修正独占 fixture 后完成全部检查。证据为 `baseline-guard-results.json` 与 `baseline-guard-initial-fixture-failure.json`；临时 clone 和其输出 context 已清理，未修改原 checkout 的 Git 状态。

`deps-diagnostic-v3-*` 和 `builder-diagnostic-v3-*` 仅用于重用 v3 已完成的依赖 stage 诊断构建管线，不属于 cold image、运行验收或运行覆盖证据。正式 image 使用新源清单和 `--no-cache`。Application 导出通过真实 pnpm pack，强制检查 Schema v2 SQL／manifest 和 safe-posix.py，并记录 manifest／archive SHA；不以整目录复制掩盖 package 文件清单遗漏。

`builder-diagnostic-v3.log` 保留过早编译 Client 导致缺失 Host 生成的 remote 类型，以及 v3 旧 legacy 源的两个 unused import 诊断。新 owned builder 依官方 face 程序拆分顺序，从官方 Web patch 启用行与 inject 闭包选择 Client，先编译 Host、生成 Typert，再编译及打包 Client；不关闭诊断或改共享配置。`pipeline-diagnostic.*` 绑定单独新快照，Host／Client 编译、Typert、真实 Linux native addon、CLI 及五个产品 bundle 完成，最终在 Vite preview entry 的 experimental worker 缺失处退出 1，失败日志完整保留。

cloud-image.vite.config.ts 复用官方 Vite 配置及隔离检查，entry 只选择实际 served index.html，去掉其专属 preview-page emitter；不修改上游文件或把缺失模块 externalize。cloud-web assembler 的正式输出本来排除 preview。该配置通过一次独立 Mac Vite 编译，输出到唯一仓库外目录，读取既有 lib、没有执行 pnpm install 或写共享 dist，见 `vite-shell-diagnostic-result.json`；正式新镜像还须完成 Linux 编译和实际运行。

第二个 `pipeline-pack-diagnostic.*` 从第一个旧快照复制到新独占 context，仅更新本目录 builder、packer、context 与 Vite 配置，重算全部输入 SHA，明确为旧 production snapshot 的诊断；没有改原 context。Linux served Web 编译、assembler 和实际 Application pnpm pack 已完成，未冒认为包含 root 后续 NUL／Office 新源码的正式 v4。

root 的五个 NUL／Office production 和 pnpm lock 已逐文件核对完整 SHA，保存 `root-production-freeze-verified.json`；四份员工6 manifest 与其 PEER handoff 全 SHA 一致，保存 `package-lock-freeze-readonly.json`。Office 的节点 handler、runsc 配置、RuntimeClass／NetworkPolicy 模板和私有 JSON 占位示例已写入 [office-runtime](office-runtime/README.zh.md)，没有试用 namespace／UID 或凭据。root 另行实证两节点 control 首请求 HTTP 200、受限首请求 ENETUNREACH、仅 lo、UID1000、输入 EROFS 和输出写入成功；具名原始配置／资源证据位于仓库外 `private/office-enabled-v1/`。这些探针事实不等于实际 Office 文档转换或完整镜像业务验收。

context 冻结后再次核对来源目录 inventory 和 Git 版本。独立真实 fixture 在 vendor 已复制后新增一个普通源文件，最终发现 `5647 → 5648` 条目并拒绝发布 manifest，见 `inventory-drift.log`／`inventory-drift-result.json`。失败 context 私有保留，源 fixture 已删除；没有把新增源文件悄悄纳入旧版本 context。

新 image 测试缺少真实镜像输入时的负例退出 1：context 检查通过，两个运行用例明确失败，skip 0，见 `missing-image.log`。新三个运行 MJS 尚未通过逐文件 100% 覆盖阈值。deploy README 双语 sidecar、四个新增 MJS 语法和补充 oxlint 检查通过；完整镜像验收完成后需按最终源 hash 重新核对。

成功的旧 production snapshot 诊断镜像进一步通过无网络、默认 UID1000 的实际 native flock 竞争／关闭释放，以及 psql、pg_dump、pg_restore 启动检查；容器已按独占身份删除，见 `warm-native-tools-probe-result.json`。该结果不是正式 v4 冷构建、Profile 或恢复验收。新测试允许由 source case 自身执行 `coldBuild: true`，父输入冻结后创建两个独立 build／pack capture，以及 anchor／Host／Platform 的真实 Linux UID capture 卷；原 bytes 运回原 UUID 目录后才交覆盖转换器，运行容器不挂载 Mac 源仓。

正式 v4 已由 `employee4-image.test.mjs` 的 source case 创建 5,667 项冻结 context，绑定唯一 owned image／父 native 输入；`v4-copy-complete.json`记录全 SHA／inventory 核验。Root 五个 NUL／Office 源码、修正版两个 search 源码、员工5 v2 五模块及四份 package manifest／lock 均与复制字节一致。测试资源按镜像方案排除，员工4 source-test 本身另由父 native manifest 冻结；其他员工新增审查测试不属于该镜像文件集合。当前正执行真正 `--no-cache` 构建，尚无正式镜像、Profile 或恢复通过结论。

正式 v4 的 source case 已通过真正 no-cache 冷构建和 build／pack 原 bytes 导出。首轮全三个用例为 1 通过／2 失败／0 skip：flock 探针误从未声明依赖的仓库根导入，默认 Docker 地址池已耗尽。后续真实运行分别保留未开启 seed stdin、短／长容器 ID 重复清理、Docker 错误提示大小写、PG 初始化临时 Unix socket 以及 64 字符 Platform DNS 名称的失败；只修自有夹具，未改镜像、业务源码或 HTTP 200 断言。恢复清理只触及已核对精确 owner label 的资源；原日志和空 backup 故障卷保留。最终 TCP 就绪检查和缩短 DNS 名称后，同一 v4 image 的完整三个用例通过、0 skip，见 `runtime-v4-9c9c0c17-578b-45f3-9a15-ce5e981d2bab/`。

该运行实际验证 Linux native flock、两个正式 CLI/Profile 的同 PID namespace SIGTERM／退出身份消失、UID1000 Platform 与 UID1001 Host 的直接及 `/proc/root` 凭据隔离、native Web 200，以及两个 NOSUPERUSER／NOCREATEDB／NOCREATEROLE PG 角色下的 71 表全量快照／独立恢复。根目录原文件 UID0、租户 UID1000／mode640 和 hardlink inode／bytes 均保留。`linux-image-acceptance.json`仍明确 `businessReadinessChecked: false`，成功用例自有容器／network／volume均已清理；没有完成完整业务重绑定或同版本 2 Host＋2 Platform。

修改夹具前，v4 cold 原生证据已转换三 MJS／三个上下文；最终 v4 runtime 原生证据在下一源码修订前转换六 MJS／四上下文。上下文都使用真实 `/build` 或 `/opt/power-evolve` 路径，父输入和运回的 input／raw／code 原字节绑定成功。cold 三 MJS 的覆盖为 context 85.50／84.37／100／76.11，build 100／96.87／100／87.17，pack 100／86.66／100／74.07（line／statement／function／branch）；逐文件四项 100% 未通过。这些是 v4 冻结版本事实，不能在当前 builder／packer／测试 hash 已改变后重新转换旧父输入或冒认为新版本 coverage。

v4 实際 Profile 日志还暴露 logger-console 入口缺失；只读诊断同时确认当时 Platform ready 和 PG Schema 2 已成功，健康失败的直接原因是 Docker DNS 名称过长，而非 logger 警告。Root 已批准新候选：builder 从正式 Host／Platform bundle 行补入动态模块类型／构建根，packer 从实际导出消费者导入所有 Profile 行和三个 query 包及 `/message-projections` 入口。最终运行测试在镜像内重做这些公开导入，并拒绝 Profile 激活失败提示。`candidate-v5-freeze.json`记录候选源码 SHA，语法／lint 已通过；当前等待其他拥有者下一一致输入冻结，v5 冷构建与运行尚未执行，v4 不构成当前完整交付。

Root 统一确认后，v5 已由 source case 开始真正 no-cache 冷构建。最终核读 root 新 11 项、员工2集成 64 项及原 48 测试、员工5窄 v3 的 8 生产／3 测试、员工6当前搜索、既有 NUL／Office 五源码、自有七候选和两 collector，共 147 个唯一冻结输入，差异 0。93 项实际 context 文件逐 SHA 对齐，54 项测试／测试配置按已审阅方案排除且另存冻结；整个 context 为 5,682 项，SHA／inventory guard 完成。新版 lock 完整 SHA 为 `e3b6ea1d696fbb636092d889d33587d91a7596f9f376ad091a9301d5c468e682`，见仓外 `v5-698f473e-0106-4292-9719-815662fde414/copy-complete.json`。该 v5 目录独立于全部 v4 原证据，当前尚无冷构建或运行通过结论；Root 下一批解冻后修改不进入本快照。

V5 全轮现已完成：source case 自行执行 `docker build --no-cache`，真实冷安装下载全部 1,338 个依赖、0 reused，完成 Linux 类型检查、native addon、Host／Client／产品 bundle、Web 资产和 Application 实际 pnpm pack。实际镜像为 `pe-employee4-cloud:698f473e-0106-4292-9719-815662fde414`，image ID 为 `sha256:5df2bc267e25bb59e1709fdc1f024ff8d7a3c14c332c68678c342ba4eab0a742`，source manifest SHA 为 `97392345ab36612ff5d6b14f914610d7e25684991240dfaec4841f8e91a97abe`。三个用例通过、失败 0、skip 0，全轮 1,060.5 秒；原始 `cold-build.log` 和 `image-test.log` 位于同一 V5 独占目录。

packer 从实际导出消费者导入 Host 的 20 行、Platform 的 3 行及四个 query 公开入口；最终镜像用例再次实际导入这些入口，两个正式 CLI/Profile 的健康响应为 200，私有日志没有模块导入或激活失败提示。实际验证还包含 native flock 的跨进程竞争／精确 FD 关闭释放、同 PID namespace 精确停止、不同 UID 的直接及 `/proc/root` 凭据隔离、普通 PG 角色、71 表全部行／定义／sequence 恢复、原 UID0／租户 UID1000／mode640 和 hardlink inode／bytes 保留。`image-verification.json` 绑定实际 image ID、pack 元数据与 acceptance；`image-cleanup.json` 记录自有容器 0、成功卷全部删除、network 已删除。

在任何自有运行源码、测试或 collector 修改前，V5 父输入已成功转换原始 V8／执行代码证据：八个 MJS、六个上下文（root、build、pack、anchor、Host、Platform）和一个实际执行的测试文件。`native/conversion.json`、`native/native-istanbul.json` 与 `native-coverage-summary.json` 保留父输入、原字节、源 hash 和实际执行 URL 绑定。总 line／statement／function／branch 为 `90.00／82.15／93.65／68.54%`，逐文件四项 100% 未通过，没有合并旧用例覆盖、添加 ignore 或降低门槛。

V5 固定为 Schema 2／71 表，`businessReadinessChecked: false`。完整同版本 2 Host＋2 Platform、恢复后私有配置重绑定与新业务任务、Office 实际转换及整体质量门仍待验收。Root 在复制完成后开始的 Schema 3 等下一候选修改不进入 V5 镜像或覆盖结果；V5 context、镜像和原始证据保持完整。

## Schema 3 备份候选

Root 分派的下一独立批次只把两个备份模块接入 Schema 3／73 表，保留全部表 DDL、行、canonical events 和 sequence。`requireQuiescentDatabase` 明确拒绝非空 `pe_native_presentations` 或 `pe_native_presentation_entries`，不执行删除。恢复从真实 dump 得到并验证当前 census，在同一只读事务内检查临时表和停写状态，随后才复制文件根；旧 Schema 2 备份不升级、不重标。

最终拥有者证据位于仓外 `employee4-schema3-candidate-cc14f996-c9f4-46bc-88f1-376bef86650a/`。一个新增实际数据消费者用例通过、0 skip：新独占 PG 16 容器、普通来源及目标角色、完整 Schema 3 与真实 71 表 Schema 2 拒绝、两张临时表非空分别拒绝且行不变、完整 73 表快照／custom dump／公开 `restoreBackup`、全部行／定义／sequence 与文件字节一致、非空目标拒绝。实际含临时行的 dump 在恢复任何文件根前被拒绝。Profile 目录仅为明确归档夹具，`formalProfilesChecked` 与 `businessReadinessChecked` 均为 false；本轮不构成 V6 正式 Profile 或恢复后模型任务验收。

首次 native 运行使用既有 tsx preload，真实生成的 MJS source map 缺少 `sourcesContent`，转换器拒绝；该原始失败、input、raw 和 code 保留，没有修补 map 或放宽转换器。最终纯 MJS 测试只加载实际 collector，当前四 MJS 与一个实际测试的原始执行字节／源 SHA／实际 URL 转换成功。逐文件 line／statement／function／branch 四项 100% 检查退出 1，共 15 个文件指标不足；本轮总值为 `57.42／52.25／63.33／49.02%`，不合并旧覆盖或冒认为全部部署运行代码的完整检查。

当前四个 owned MJS 经官方映射 lint 通过，保留了此前 17 条格式诊断、补正后的中间诊断和依赖串行窗口内 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 阻断。Root 完成锁文件 `c15629b43ab7d7355947d6de2a613b3d8c162be61feeb9722e7a9434fb7591c1` 后，正式包管理器入口在 `pnpm_config_verify_deps_before_run=error` 下返回 0；没有 install 或修改共享依赖。源码、测试与 README 双语及 sidecar 属于下一候选，V5 build helper、context、镜像和原始转换证据均未改动。

## Schema 4 备份与静态镜像候选（2026-10-09 历史记录）

Root 在 2026-10-09 18:18:39（上海时间）确认 v4 资产落盘后授权本批适配，证据独立位于仓外 `employee4-schema4-1f94edb1-5ed1-4199-b6cc-12a63be58ccb/`。备份当前版本为 4，读取 v4 manifest 并完整核对 74 表。新增 `pe_native_writers` 的 live 条件为 `expires_at > clock_timestamp()`，released NULL 与 expired 行完整保存身份、token digest、epoch 和到期时间，不删除 tombstone、不重置 epoch。原 Schema 1–3 六资产 SHA 保持一致。packer 要求实际 package 中版本 1–4 八项 SQL／manifest；image guard 当前为 4／74，保留临时表空检查，新增 live writer 排除及版本 2、3 回滚负例。

本批实际普通角色 PG 16 专项为 1 通过／0 失败／0 skip，耗时 14.116 秒，源码及资产输入 0 漂移。真实 Schema 2／71、Schema 3／73 拒绝且版本行未改；两张非空临时表及 live writer 拒绝且原行未改。含临时行及 live writer 的真实 dump 经公开恢复入口，在任何六 root／两个归档目录复制前被拒绝。夹具以 expires_at=NULL 模拟自身 release 后，三条 released／expired writer tombstone、最大安全 epoch 和微秒到期时间完整恢复。74 表所有行／定义／sequence、canonical event 和文件均一致，queued operation、unknown mount、其他连接、非空目标的拒绝仍成立。自有容器剩余 0，成功夹具已清理。

纯 MJS collector 的父输入绑定当前四个 MJS 与一个实际测试，原 V8 raw、执行代码和当前源 SHA 在后续修改前成功转换；line／statement／function／branch 为 `57.42／52.83／63.33／49.67%`。逐文件四项 100% 门实际退出 1，15 项指标不足，没有合并旧轮覆盖或降低阈值。六个 owned MJS 官方映射 lint／语法、两个嵌入 image 程序纯语法检查及文档专项独立记录。

本批没有新冷构建、image context 或 image 用例；归档 Profile 仅为数据夹具，正式 Profile 与业务 readiness 均未验证。当前 Schema 4 不是已通过的 V5 镜像内容。V5 Schema 2／71 表原镜像、Schema 3 原候选及其转换证据保持原 bytes，不以新 manifest 重标、重转或覆盖历史结果。
