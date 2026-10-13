# 员工4部署与恢复切片交接

本记录保留 2026-10-09 各固定版本的部署与恢复切片结果；下文“当前”“最新”均以对应记录时点为准。现行候选资格及 M5 状态见[集成进度](../TRIAL-CLOUD-MIGRATION-STATUS.md)。

2026-10-09；F20／M5 可审查切片。备份工具、镜像 packer 及测试 guard 已按 root 分派进入 Schema 4 新 cut；启动、生命周期、文件树和其余镜像 helper 保持原冻结。原 Schema 2 运行工具的 32 个用例全部通过，建议 patch 仅供审阅未应用。V5 已完成真正 Linux 冷构建与三个实际镜像用例，0 skip；100% 严格覆盖门和完整业务恢复验收仍未通过，最新候选结果见文末。目标分支为 `power-evolve/migrate-dsh-0.2.1-alpha.1`，固定官方标签 `dsh-v0.2.1-alpha.1`。本切片只修改 deploy 工具、员工4测试和本目录文档；未修改 `tsdown.attachment.config.ts`、Profile 源文件、应用代码、根配置、锁文件或其他员工文件，未执行 git add／commit。

## 已交付行为

`start.mjs` 使用不可变部署摘要和私有所有者标记；渲染与启动共享跨进程排他预留。活跃或不确定生命周期、旧 ready 文件、不同部署、非本部署 Profile 和复用 PID 均拒绝。精确 child 的出生身份、请求信号、退出码／signal 和已观测停止事实持久化；SIGTERM／SIGINT 等待真实 child 退出，非零退出及意外 signal 保持失败。预留不自动回收，不按端口或裸 PID 杀进程。

`backup.mjs` 只接受 cloud-native Schema 4，按当前列清单核对 74 表。live native writer（`expires_at > clock_timestamp()`）阻止备份；released／expired writer tombstone 的全部字段及 epoch 纳入完整快照，不删行、不重置 epoch。dump 和每行摘要使用同一个导出快照；恢复后比对全部表行、JSON、微秒时间、schema 定义和 sequence。两张临时 presentation 表必须为空，非空时拒绝且不删除；恢复在复制文件根前检查实际 Schema 4 和停写状态，不重放 presentation。普通角色预检包含非表对象和本库设置，非空目标在写入前拒绝。Node 与 libpq 的服务代次／数据库／角色一致，工具主版本须匹配服务。Schema 37 不转换、不重写，已有 bundle 不覆盖。

六个显式物理根和两个 Profile 快照全部纳入。附件树保留原始字节、硬链接别名、孤儿文件、未发布对象和 crash staging；保存硬链接关系以维持 inode 去重容量事实。技能目录不按当前 catalog 筛选，保留历史版本及全部实际持久内容；不修改 generated 或 generated-cloud-v2 资产。文件权限、UID/GID、空目录及符号链接文本均参与核对；符号链接不被跟随。

恢复不启动业务应用。源 Profile 所有者、原路径和数据库 URL 作为归档保留，必须用审阅后的目标配置另行渲染新具名 Profile。结果明确标记 `readinessChecked: false`，不把数据恢复比对当作恢复后业务任务验收。

## 实际检查与证据

下列命令在目标当前工作树运行，详细结果见仓库外 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee4-coverage.log`。真实 PG 为已授权独立测试服务；每轮新建随机命名普通 LOGIN 角色及四个独立数据库，角色无 superuser／createdb／createrole。工具容器由本测试创建，使用匹配的 PG 16 libpq；没有 exec／修改原有 PG 容器，也没有写试用库或旧库。

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url node --experimental-strip-types --experimental-test-coverage '--test-coverage-include=**/products/power-evolve/deploy/*.mjs' '--test-coverage-exclude=**/*.test.mjs' --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 --test products/power-evolve/deploy/employee4-start.test.mjs products/power-evolve/deploy/employee4-backup.test.mjs
```

当前发现 2 个测试文件、16 个测试，行为用例通过 16、失败 0、skip 0。真实 built Host／Platform 分别通过具名 dsh Profile 启动，独立 `/health` 为 200，正常停止后核对 child PID 和持久停止事实。普通角色通过真实 CLI 创建备份并恢复至独立空库；71 表全量行摘要、定义／sequence、两个用户、凭据微秒时间和所有选定文件均核对。附件别名恢复后确为相同 inode，原始文件和 orphan staging 字节一致。已有 bundle、非空库、仅含函数的占用库、Schema 37、活跃连接、损坏文件和路径别名均有拒绝断言。

覆盖命令退出 1：逐文件 100% 门未通过，阈值未降低。当前总计 lines 98.26%、branches 76.45%、functions 93.83%；backup-postgres 为 100/66.67/100，backup-tree 为 99.24/81.69/100，backup 为 96.69/75.68/100，lifecycle 为 95.97/62.22/72.22，start 为 99.33/87.50/100。未覆盖项包括 Linux 进程出生读取及部分拒绝、失败清理与 CLI 错误路径。当前记录没有用 mock、skip 或历史证据代替真实当前验收。

根 oxlint 配置明确排除 `**/*.mjs`，直接运行发现 0 文件，不能计为产品 lint 通过。补充 oxlint 配置位于仓库外 `employee4-oxlint.json`，启用 correctness／suspicious 及 unicorn、import、promise、node、jsdoc；debug discovery 确认检查本次 7 个 MJS 文件，补充检查退出 0、诊断 0。该检查不代替员工3负责的正式云端静态／CI 入口。

此前失败保留：测试凭据 audience 曾与当前 Schema 不符，修正测试数据后通过；macOS `/var` 祖先别名曾被目标父目录检查误拒绝，改为实际父目录权限与物理重叠检查后通过；PG 17 pg_restore 对 PG 16 的 `transaction_timeout` 指令失败，现于写入前拒绝主版本失配，改用 PG 16 工具后完整恢复通过。全部资源由测试创建并等待退出、关连接、删独立库／角色及释放自建容器；最后查询本测试容器前缀为 0。

语法检查发现本次 7 个 MJS，全部通过；独立扫描本次 11 个文件的结尾换行／空白、3 个 Markdown 的链接／段落，结果为 0 破链、0 硬换行。`pnpm exec tsx scripts/verify-translation-pairing.ts products/power-evolve/deploy/README.md` 检查 1 对文档并通过。补充 lint 命令为 `pnpm exec oxlint --no-ignore --config /Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee4-oxlint.json`，后接本次 7 个 MJS 精确路径；仓库外 `employee4-frozen-sha256.json` 保存冻结文件摘要供集成者核读。

## 具体使用限制

启动器支持 macOS／Linux，使用固定角色名；2＋2 副本须各有独立 dshHome。任何部署文档变化均须新 dshHome，旧 owner 标记不会自动升级；历史活跃或身份不确定 Profile 必须由集成者先核读及对账，不能删除锁或旧 ready 文件强行重用。持久停止证据写入失败时先等待自己创建的精确 child 退出，仍保留不确定预留。

备份要求两份由该启动器产生的停止证据、完整六根选择及没有其他数据库连接；仅支持无 URL query 参数的 PG 连接。恢复要求不同数据库名，即使服务重启改变了代次也不允许回写同名来源库。保留 UID/GID 需要实际 OS 权限，权限不足会留下停服的部分目标。私有配置和附件禁止符号链接，可写数据保存符号链接文本；跨不同选择根的硬链接关系不作为本切片的全局映射处理。归档配置仍含原数据库 URL，不得直接启动；需独立重绑定和业务验收。

## 必须继续的 M5 项目

1. 员工3／集成者将全部员工4部署测试与运行 MJS 明确纳入云端 discovery、lint 和逐文件覆盖门，补齐未覆盖拒绝路径及真实 Linux 生命周期证据，保持 100% 阈值；当前切片不得标为最终工程验收通过。
2. 本切片要求六根物理独立。现有部署若把存储子树放在 privateDir 内，须补充按实际布局去重的根选择与恢复路径映射，不能为了运行工具移动现有试用数据。本轮真实测试使用独立的六根和私有配置，没有修改既有 deployment。
3. 多副本及 Kubernetes／Runner 的物理停写、精确停止对账由同版本组合验收继续验证；本工具预留的是两个本机 Profile，并拒绝数据库中的活跃／不确定执行及额外连接，不能声称已经停止未知外部 Pod。
4. 用正式镜像和 2＋2 组合完成当前实际业务数据备份，恢复到新目标后重新绑定私有配置／Profile，并让两个用户完成新对话、执行和连接器任务及重启。该完整恢复后业务出口本轮未运行，明确待验收。

## 第二轮质量补测

2026-10-09；本轮按 root 分派仅修改两个员工4测试和本交接，五个运行 MJS 保持第一轮冻结摘要，未新增部署功能或改动现有业务数据。只读附件审查已单独交接，未发现该审查范围内可确认的可达缺陷。

真实 Linux 身份用例创建独立、无网络的 Node 22.23.2 容器，只读挂载冻结的 `lifecycle.mjs`，直接比对 `/proc/<pid>/stat` 的出生 tick 与当前 boot ID；子进程名称包含右括号，验证解析不误截断。用例等待自己的 child 真实关闭，验证其 `/proc` 身份消失，观测容器停止及退出 0 后删除精确容器 ID。Node 的独立覆盖目录作为唯一可写挂载，Linux 结果与本轮 host 覆盖合并。

两种真实停止写入失败分别在运行态建立后把自己的 lifecycle 或 reservation 文件替换为目录；child 正常退出后父监督进程失败，旧运行证据及不确定预留仍存在，后续 render 拒绝。其余生命周期补测包含 SIGINT 匹配退出、spawn 失败、所有者替换、旧 ready 清理和 private metadata 拒绝。

普通角色仍使用每轮随机四库，未扩大数据库数量。补测覆盖数据库／角色和 libpq 目标失配、真实 PG 17 工具对 PG 16 的主版本拒绝、普通角色的额外 schema／本库设置／函数占用、额外列清单、未知 mount、源库重用、坏 manifest／root inventory 和恢复后 census 不一致。增加真实 sequence 恢复比对、硬链接 UID／GID／mode 比对、符号链接文本复制、FIFO 和非法持久 inventory 拒绝。失败恢复不创建文件目标，目标数据库仍由 fixture 精确清理。

当前两个测试文件共 28 个测试，通过 28、失败 0、skip 0。最终覆盖命令退出 1，100% 阈值未改，未添加 coverage ignore。五个运行模块的行覆盖均为 100%；总分支为 94.87%，函数为 96.30%。逐文件 line／branch／function 为 backup-postgres `100/96.97/100`、backup-tree `100/96.63/100`、backup `100/96.88/100`、lifecycle `100/82.09/83.33`、start `100/98.90/100`。本轮不标记最终质量验收通过。

最终命令与第一轮相同，增加 spec／lcov reporter 输出；仓库外 `employee4-quality-stage2/final.log` 和 `final.lcov` 保存当前结果，`remaining-coverage.json` 保存按当前源码行归类的剩余缺口。未覆盖项中的正常 POSIX 根不存在、`URL.port` 的 nullish 分支和固定 bundle 缺少 `insert` 分支在当前配置不可达；其余为 OS 查询失败、子进程身份／信号竞态、读文件期间源改写，以及备份／恢复校验期间额外改写或查询失败，需要独立可控的真实故障环境，不能把现有成功路径或不稳定竞态当作这些分支的验收。本轮未发现需要改动冻结生产代码的缺陷。

补充 oxlint 通过，debug discovery 精确列出两个本轮测试文件；两个 MJS 语法检查和三个修改文件的空白／结尾换行检查通过。最终只读清理查询为员工4前缀数据库 0、角色 0、容器 0；未操作现存容器或移动试用数据。`employee4-quality-stage2/source-sha256.json` 保存当前测试／交接摘要以及五个运行 MJS 与第一轮冻结摘要的一致性。

## 第三轮质量收尾

2026-10-09；仅补两个员工4测试、更新本交接，并写独占 `employee4-quality-proposals.patch`。五个运行模块保持原 SHA，不应用建议，不触碰正式 Profile、现有服务、镜像、lib、私有部署、来源数据库或业务 namespace。

新增四个独立用例：原生进程 FD 耗尽导致实际出生查询／信号转发失败；初始化期间真实 SIGTERM 排队及其后重复 SIGINT；发布运行 metadata 期间真实 EMFILE 导致清理转发失败、等待精确 child 关闭并保留不确定预留；观测目标已有非零复制字节后真实追加源文件，拒绝读取期间改写。两个 FD 用例仅给各自新建的 Node 进程设置 `RLIMIT_NOFILE=64`，没有改变主机限制或替换 OS API。初始化 barrier 装饰的是本测试自己的 lock.save，先调用真实 save，再等待真实 OS 信号；没有修改生产监督器。

原 Linux 用例增加独立容器 `nofile=64` 的真实 `/proc` EMFILE 拒绝；所有 FD 均关闭，自己的 child／容器实际退出后删除精确容器 ID。原普通角色长用例增加实际 PATH libpq transport、捕获 inventory 后的额外源文件、恢复复制期间的额外目标文件、真实 census 查询取消与 rollback。查询取消先观测自己随机库中普通角色的唯一 `DECLARE backup_rows ... "pe_users"` 被自建 blocker PID 阻塞，再仅取消该 backend，断言 PostgreSQL `57014`；所有文件目标仍不存在。仍使用每轮自己的四个随机数据库，失败恢复只重置其中明确拥有的随机目标库。

当前两个测试文件共 32 个测试，通过 32、失败 0、skip 0。严格命令退出 1，阈值仍为 line／branch／function 各 100，无 ignore／skip。五模块行覆盖均为 100，总分支 `97.18%`、函数 `98.77%`；逐文件为 backup-postgres `100/98.53/100`、backup-tree `100/97.87/100`、backup `100/100/100`、lifecycle `100/88.41/94.44`、start `100/98.90/100`。当前不标记最终工程质量或正式数据备份验收通过。

严格 LCOV 剩余 12 个分支及 1 个函数。`lifecycle.mjs:39` 的 V8 offset `2127..2130` 仅为换行与两个空格，`:144` 的 `7076..7077` 仅为空格；更正第二轮分类，它们是 catch/finally 控制流范围，不能当作未触发的真实 metadata／信号故障。`URL.port` 的 nullish fallback 属内部冗余；固定 bundle 缺少 insert、正常 POSIX 根不存在及第三种 OS 拒绝属于当前配置／环境不可达。其余保留的缺口为真实文件身份替换、初始 child 身份建立和 forward 的退出／身份／kill 竞态；不通过篡改 process.platform、ChildProcess、文件 API 或覆盖 ignore 触发。

独占 patch 只建议两处最小调整：让三处完全相同的 forward 失败赋值共享一个 `recordSignalFailure` 回调，保留三个 Promise.catch 的调用／微任务时序及全部身份、信号、等待、持久停止、预留释放检查；去掉 `parsed.port ?? '5432'` 中不可达的 fallback，保留空字符串交给 libpq 默认端口的现有行为。patch 头部列出五模块当前 SHA；`git apply --check` 通过，未应用。隔离目录只替换 lifecycle 候选，26 个真实生命周期测试通过，候选 line／function 为 100、branch 为 `86.36%`，严格门仍失败；render／launch CLI 使用原冻结 start，不能据此宣称完整候选产品通过。原生 Node 验证 36 种 URL／端口配置的表达式等价。最终候选结果见 `proposal-current-start.log`；先前把 catch 集中到 forward 内的候选与日志保留为历史证据，最终建议选择共享回调以保持原 Promise.catch 时序。隔离候选已保存证据后移除自己的临时目录。

证据目录为仓库外 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee4-quality-stage3/`：`handoff.log`／`handoff.lcov` 为覆盖接线后最终当前结果，`raw-handoff/` 保留所有当前原始进程 V8 JSON，`merged-handoff-v8.json`／`zero-ranges-handoff.json` 保留独立 merge 的精确范围，`remaining-coverage.json` 对第二轮 21 分支／3 函数逐项重分类并列出当前严格门缺口。独立 merge 另有四个零 block 不对应 Node 严格报告零分支，已单独注明，不能改写严格门或冒认新的未覆盖业务路径。此前 `current.*`／`raw-current/` 结果保留，不能按 LCOV 字节或生成 block ID 完全相同来合并；已核对剩余源行、函数及严格统计一致。

负例证据保留：`new-start.log` 记录初版 FD／排队信号 barrier 不足的两个失败，修正测试时序后通过；`new-backup.log` 记录事务内 pg_stat_activity 快照未刷新导致阻塞观测失败，明确刷新 snapshot 后观测实际阻塞并通过；`proposal-start.log` 保留 Mac 临时 `/var` URL 与 canonical `/private/var` URL 导致隔离覆盖分裂的结果，只更正隔离路径后得到 `proposal-canonical-start.log`。`oxlint.log` 保留测试变量重名诊断，修正后 `oxlint-final.log` 通过；两个测试的语法检查通过。当前只读清理查询确认员工4前缀数据库、角色、容器均为 0。

已按员工3接口在独占 Linux fixture 接入 `nativeDockerCoverageArguments`：有 `PE_CLOUD_COVERAGE_INPUT` 时用每容器独立 UUID capture context；仅有 `NODE_V8_COVERAGE` 时保留原独立 raw 挂载。真实 Linux 出生／消失及 EMFILE 断言不变，独立 helper 模式用例通过 1，经真实 collector 与 `convertNativeCoverage` 确证一份容器 context、当前 Linux 源码和 frozen parent hash 绑定／转换；证据位于 `helper-native/`。接线后完整 32 例再次通过，严格门仍失败，补充 lint 及语法检查通过。PG16 工具与 PG17 mismatch 容器仅在原生 Linux backend 时加 `--add-host=host.docker.internal:host-gateway`；当前完整 PG 运行在 Mac backend，不能宣称原生 Linux PG 部署已验收。未修改员工3脚本。

已向员工3同步两个测试文件的 discovery／coverage 入口、32 个通过用例、当前严格门缺口及原始 V8 证据，维持 100% 门。对正式 Mac 备份的真实 fchown EPERM，仅只读提出 Linux 原生根、实际 chown 权限、真实同 PID namespace Profile 启停的路径建议，保存在同目录 `linux-deployment-path.md`。Mac 停止 JSON 不能直接移入 Linux 作停止证明，partial／dump 不能手工升级成功；未改变存储所有权或降低校验。

## Linux 部署镜像切片

2026-10-09；root 已审阅 [镜像方案](QA-IMAGE-PLAN.md)，授权本目录 owned cold build、CLI/Profile Linux 启停和普通 PG 角色恢复。默认正式 UID/GID 1000，独立同 PID namespace fixture 使用 Platform 1000、Host 1001，备份 anchor 仅以 root 保留实际所有权。原五个运行 MJS 仍冻结。Dockerfile、cloud-image-context／build／pack、baseline.json、新 image 测试及 README 双语／sidecar 已写入；[镜像证据](QA-IMAGE-EVIDENCE.md) 记录当前构建失败、基线 ancestry 检查和待完成验收。三个新增运行 MJS 的逐文件 100% 覆盖尚未通过，当前不能宣称正式 Linux 镜像或恢复验收完成。

正式 v4 true cold source case 和同镜像后续完整三用例均通过；首次取得真实 Linux、普通 PG 角色、同 PID namespace 的两个正式 Profile 停止证明及 71 表／六 root 独立恢复，实际 UID0／UID1000、mode640 和硬链接字节保留。完整业务重绑定仍未检查。原 cold／夹具失败、修正与精确资源清理均见 [镜像证据](QA-IMAGE-EVIDENCE.md)，没有改写旧失败。

v4 原 bytes 已在源码修改前分别转换 cold 三 MJS／三个上下文、runtime 六 MJS／四上下文，四项 100% 覆盖仍未通过。v4 logger-console 的动态编译入口遗漏及后续新 query manifest 不属于已通过的旧快照；当前候选补正式 Profile roster 构建根，并在 pack／最终镜像中实际导入每个 Profile entry、三个 query 包和 `/message-projections`。候选源码已冻结并通过语法／lint，尚待下一统一 cut 的冷构建／运行验证。旧五运行 MJS 仍未修改。

## V5 实际结果

统一 cut 的 V5 已完成，三个实际镜像用例全部通过、0 skip，全轮 1,060.5 秒。source case 自行执行真正 `--no-cache`，context 的 5,682 文件和 147 项拥有者冻结核验保持绑定；固定 image 为 `pe-employee4-cloud:698f473e-0106-4292-9719-815662fde414`，实际 image ID 为 `sha256:5df2bc267e25bb59e1709fdc1f024ff8d7a3c14c332c68678c342ba4eab0a742`，source manifest SHA 为 `97392345ab36612ff5d6b14f914610d7e25684991240dfaec4841f8e91a97abe`。证据位于仓外 `employee4-cloud-image/v5-698f473e-0106-4292-9719-815662fde414/`，完整事实及历史失败见 [镜像证据](QA-IMAGE-EVIDENCE.md)。

实际导出消费者和最终运行镜像都成功导入全部 Host 20／Platform 3 个 Profile 行与四个 query 公开入口；两个正式 Profile 健康响应 200，私有日志未见导入或激活失败。native flock、同 PID namespace 精确停止、UID1000／1001 的凭据隔离、普通 PG 角色、71 表全量恢复、原 UID0／租户 UID1000／mode640 和 hardlink inode／bytes 均通过。`image-cleanup.json` 记录自有容器 0、成功卷已全部删除、network 已删除。

原始覆盖在任何自有运行源码、测试或 collector 更新前已完成转换：八个 MJS、六个上下文和一个实际测试，父输入／执行字节／原源 hash／实际 URL 绑定成功。总 line／statement／function／branch 为 `90.00／82.15／93.65／68.54%`，逐文件四项 100% 仍未通过；没有将旧 32 用例的覆盖混入这一父输入。V5 固定为 Schema 2／71 表，业务 readiness 仍为 false；完整 2＋2、恢复后重绑定与新业务任务、Office 实际转换和整体质量门尚待验收。

Root 在复制完成后开始的 Schema 3 等修改属于下一候选。V5 镜像、context 和原始证据完整保留，不用新工作树的 manifest／源码重标旧镜像结果；下一批备份接口改动须按协调者明确的 Schema 3 契约单独验证。

## Schema 3 下一候选

两个备份模块现在共享当前版本常量 3，并读取 v3 列清单。创建仍完整 dump／核对全部 73 表、canonical events、定义和 sequence；两张临时 presentation 表非空时明确拒绝，不删除来源行。恢复拒绝旧版本清单，实际还原当前 dump 后在 census 的只读事务内检查临时表及停写状态，任何文件根复制前即拒绝残留 presentation，不重放临时内容。

新增 `employee4-schema3-backup.test.mjs` 最终实际通过 1、失败 0、skip 0。它用自有 PG 16 容器和普通来源／目标角色验证真实 Schema 2 拒绝、两张临时表各自非空拒绝及原行保留、73 表全部行／定义／sequence 与公开数据恢复、含临时行 dump 的文件恢复前拒绝及非空目标拒绝。Profile 目录明确为归档夹具，正式 Schema 3 Profile 启动、恢复后模型／连接器新任务和完整同版本系统未运行。旧长用例只同步 3／73 断言与必要格式，未把其原 Schema 2 的 32 用例重新计入当前结果。

仓外 `employee4-schema3-candidate-cc14f996-c9f4-46bc-88f1-376bef86650a/` 保留当前 source freeze、实际 PG census／清理、正式 lint 和原始 native 转换。当前四 MJS 覆盖的 line／statement／function／branch 为 `57.42／52.25／63.33／49.02%`，逐文件四项 100% 检查退出 1，15 项指标不足；不降低阈值、不合并旧父输入。首次 tsx source-map 转换拒绝和依赖串行期间的正式 lint 阻断均私有保留，最终纯 MJS 原字节转换与更新后的正式 lint 已完成。

V5 helper、镜像、context 和旧证据保持冻结。下一候选源码、测试和文档由独立冻结清单交协调者；V6 镜像及完整恢复后业务任务继续由集成验收处理。

## Schema 4 候选（2026-10-09 历史记录）

Root 于 2026-10-09 18:18:39（上海时间）通知 v4 资产及应用集成完成后，本批将当前备份版本与列清单接入 Schema 4／74 表，只新增 `pe_native_writers` 表的 census 内容。原 Schema 1–3 六项 SQL／manifest 摘要保持一致，备份不转换旧版本。镜像 packer 要求实际 package 同时导出 1–4 全部八项资产；image 测试 guard 接入 4／74，并在事务回滚内分别检查版本 2、3 拒绝。这里只完成静态检查，没有创建新 image context 或执行冷构建、镜像用例。

现有 discovery 文件 `employee4-schema3-backup.test.mjs` 保留文件名，当前内容实际验证 Schema 4。一个纯 MJS 实际用例通过、失败 0、skip 0，耗时 14.116 秒；自建 PG 16 容器提供六个自有数据库及无 superuser／createdb／createrole 的来源、目标角色。真实 Schema 2／71 表和 Schema 3／73 表被拒绝，原版本行不变；非空 temporary presentations／entries 分别拒绝且原行不变。live writer 用服务端 `clock_timestamp()` 判断并拒绝，不改 writer 行；实际含 live writer 或临时行的 dump 经公开 `restoreBackup` 在恢复任何文件根前拒绝。

夹具仅模拟 release 将自己 live 行的 `expires_at` 改为 NULL。三条 released／expired writer 行的 session／worker 身份、token digest、epoch 和到期时间完整纳入 dump，MAX_SAFE_INTEGER epoch `9007199254740991` 与微秒 expired 时间无损恢复；生产备份未删除行或重置 epoch。74 表全部行／定义／sequence、canonical event、六 root 与两个归档目录的文件核对一致，queued operation、unknown mount、其他连接和非空目标仍被拒绝。自有 PG 容器剩余 0，成功夹具目录已删除。归档 Profile 目录只含夹具字节，`formalProfilesChecked` 和 `businessReadinessChecked` 均为 false。

证据位于仓外 `employee4-schema4-1f94edb1-5ed1-4199-b6cc-12a63be58ccb/`，包含八项 Schema 资产及测试输入原字节、TAP、74 表来源／恢复 census、资源清理、源 SHA 和实际 V8 raw／执行代码。四个 MJS 和一个实际测试在后续源码修改前完成独立转换；line／statement／function／branch 为 `57.42／52.83／63.33／49.67%`，逐文件四项 100% 检查实际退出 1，15 项指标不足。未合并 Schema 3、V5 或旧 32 用例覆盖，未修改 collector 或阈值。六个本批 MJS 官方映射 lint／语法和两个嵌入镜像程序的纯语法检查通过；README 双语 sidecar 及四文档链接／段落／结尾换行另行核对。

Schema 3 原冻结与转换、V5 原 context／镜像／转换仍完整保留，不按当前 Schema 4 工作树重转旧父输入。当前独立 freeze／diff 交 root 集成；新同版本冷镜像、正式 Profile 和恢复后业务任务继续待集成验收。
