# 员工3：云端检查入口与 CI 交接

工作树为 `/Users/jingchao/agent_work/main_agent/power-evolve-cloud-migration`，分支为 `power-evolve/migrate-dsh-0.2.1-alpha.1`，HEAD / 官方基线为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。本记录依据 2026-10-09 的实际证据；员工3入口与 CI 接线已完成自身检查，完整源码逐文件四项 100%、当前四类型引用图、实际 GitHub Actions / Windows 尚未通过验收。主集成者仍在修改产品源码，员工4已报告旧 v4 snapshot 的完整三例通过，正在准备包含新 query / logger roster 的 v5 一致版本；尚无全源冻结窗口。

员工3拥有 8 份检查脚本、corpus、Vitest 配置、workflow 和本交接；按明确分派修改共享 TestClient 发现 / 引用、共享 TestHost 源码程序与三个默认 Host tests/tsconfig.json，以及已授权的 `.github/AGENTS.md` 单一产品 POSIX 例外。第 9 份 `cloud-peer-policy.mjs` 为员工6所有，三份 `.github/power-evolve-office/` 固定 SDK 资源为员工1所有，部署 Dockerfile、三份镜像脚本及测试为员工4所有。没有修改这些独占文件、业务源码、manifest / lock、官方 SAFE / PEER / duplicateSafe 表或运行 lib，没有 add / commit、根安装、重建或停止既有 Profile / 试用服务；源仓只读。当前 18 份员工3写入文件的 SHA-256、只读协作输入与证据索引见 `/tmp/employee3-handoff-proof-current.json`，该清单只证明这些文件的交付版本。

## 完整入口与发现

本地共享树使用 `node --import tsx/esm products/power-evolve/scripts/cloud-check.mjs` 直接调用已锁定工具，默认串行执行 discovery、selftest、types、lint、jsdoc、dependencies、docs、duplication、source、built。`--only=` 选择具名阶段；source 完整发现全部源码测试，不接受单文件过滤；built 只读准备工件，为两个 factory 测试传入实际 `lib/client.js` 路径，不隐式构建。所有内部 pnpm 调用设置 `pnpm_config_verify_deps_before_run=error`，依赖陈旧即失败，避免 pnpm 11 在检查前隐式安装。主集成者已独立完成 manifest 串行审查与 frozen 安装，员工3没有把旧 lib 当作最新准备工件。

[cloud-policy.mjs](scripts/cloud-policy.mjs) 于 2026-10-09T05:02:44.082Z 发现 runtime 228、sourceTests 103（原生 Node 23、Vitest 80）、built 文件 4、native assets 10、翻译 sidecar 11、工具 9、lint 文件 356、文档 127、manifest 8。corpus 按旧集合与新集合并集更新，不删除旧条目；新增 legacy-import owner / adapters、native-search current / cancel / wire 和四份 Contracts consumer 测试已纳入。当前 corpus admission errors=[]，Contracts 缺所属测试的发现拒绝已消失；发现完整不能代替真实消费者行为、类型、lint 或四项覆盖通过，这些发现数不是全源冻结声明。

运行覆盖包含产品 src、deploy 非测试脚本、cloud-web/scripts、application/web、sandbox 根脚本及 sandbox/scripts，以及 `.github/power-evolve-office/**/*.mjs`。CI SDK reproducer 是实际运行源码，必须执行并满足四项覆盖，不能仅按输入资产登记。测试保留执行、lint 和失败计数；Python / Shell、全部产品 Dockerfile、requirements 与固定 SDK JSON 纳入输入哈希，不据此声称其语言行 / 分支覆盖。Vitest `coverage.include` 直接复用 runtimePatterns，源码测试 include 同步包含 GitHub Office 范围。

入口拒绝基线消失、空集合、缺必需模块测试、skip / todo / only 及别名，拒绝实际覆盖忽略注释。Vitest JSON 必须含全部预期文件且全部用例通过；原生 TAP 与 [cloud-reporter.mjs](scripts/cloud-reporter.mjs) 每文件 summary 同时核对真实退出、失败、取消、跳过、todo 和空文件，拒绝 Node 空文件包装 PASS。可选 client 阶段完整运行两个客户端拥有者，双方必须非空且 JSON 完整；该 Windows Client 信号不宣称覆盖，覆盖由全源 source 判断。

每轮创建新的私有 `pe-cloud-check-*` 目录，保留命令、退出、日志、JSON、原始 V8、实际代码和转换明细；开始 / 结束比较源码、测试、工具、配置、工件、native assets、文档 / sidecar、manifest / lock 及官方规则的文件成员和 SHA-256。配置发现也覆盖 workflow、固定 Office MJS / JSON 和部署 baseline；新增配置或任一输入变化均追加 input-stability 失败，不拼接不同版本的结果。

## 原生覆盖与实际执行根

[cloud-capture.mjs](scripts/cloud-capture.mjs) 在被测 Node 内通过 inspector 收集实际代码、script ID、真实 URL 和 inline map，不开放网络调试端口；每进程记录其输入 JSON 精确文本哈希。[cloud-coverage.mjs](scripts/cloud-coverage.mjs) 验证冻结源码 / 测试、真实代码哈希、代码范围、map 指令、sourcesContent、预期测试及父子输入绑定，以锁定官方 Vitest V8 / Istanbul 依赖转换。缺代码 / map、过期输入、越界范围、漏测试或被改上下文均失败。

[cloud-provider.mjs](scripts/cloud-provider.mjs) 在官方 V8 `generateCoverage` 返回前合并 Node 与 Vitest Istanbul map，保留官方 report 和逐文件 lines / statements / functions / branches 四项 100%。真实 runner 自测证明互补分支 100% exit 0，同分支不足 100% exit 1，断言失败即使覆盖 100% 仍 exit 1。database.ts map 探针采用明确 Pool / client 替身，只验证转换，不能代替 PostgreSQL 行为。

`prepareNativeCoverageContext(inputPath, {executionRoot, executionDirectory, collector})` 为每个真实执行 / PID 命名空间创建独立 UUID 子目录及输入。调用者把输入原字节复制到实际执行目录，准备私有 raw / code，退出后把原 inputs / raw / code 运回本地；不得重序列化 JSON。转换事实保留实际 URL / executionRoot。异根只允许相同仓内相对路径的字节一致、未转换 JS / MJS；带 map 的异根 TS / 编译 JS 拒绝，不猜 flat-image 文件名别名。Docker 每个 RUN 的 PID 1 必须用不同上下文。

`nativeDockerCoverageArguments` 仍是只读挂载工具仓与冻结源根的便利 API，仅用于可信纯 fixture；整仓挂载不能证明 Host / Platform 凭据隔离。员工4真实隔离测试使用最小两份 collector 源码、cold-image 依赖元数据、Linux owned volume 和精确 UID / 私有目录，通过原字节运输证据，不挂 Mac 源仓、`.git` 或 `.env`。两份已交接 helper 冻结 SHA 为 capture `482538de336953d5325fb9ae0c0dae26b543a8402d5f715f8930f0c24d14c9d2`，coverage `a15e9b6c818ea1c14a01ba4f6b0bc47afb41a35327ddcfdb1b92bb421eca067b`。

员工1实际 SDK probe 按 `/pe-office-probe/products/power-evolve/sandbox/office-preview.mjs` 仓内相对结构执行，真实 URL / wrapper 哈希被采集；其作用域是 SDK 与 assembled source probe，不是冻结 flat 生产镜像的文件别名或 Officeenabled 验收。direct7 疑似 converter 差异经逐段原始 range、实际 AST 行列与 unchanged official converter 核对，实为错配两个 throw：line44 column74 asset undeclared 对应 statement27 raw / single / merged count3；line40 column4 manifest incompatible 对应 statement23 raw / converted0。员工1已独立确认并保留旧诊断、更正结论；证据 `/tmp/employee3-office-ast-mapping-review-direct7.json`，没有修改 helper 或计数。

## 自身与真实前置证据

| 检查 | 结果与明确作用域 |
|---|---|
| 当前检查器自测 | 29 / 29 PASS、0 fail / skip / todo / cancel、exit 0；`/tmp/employee3-unified-29-selftests-mapped-context-final.log` |
| 当前 8 脚本官方 lint / JSDoc | lint 0、signal=null、JSDoc errors=[]、工具输入稳定；`/tmp/employee3-own-mapped-peer-ci-static-final.log` |
| 实际异根 Docker 原生证据 | 本机 Node 与 Linux Docker 互补分支合并四项 100%，真实 `/opt/power-evolve/runtime.mjs` URL 保留，篡改绑定拒绝；`/tmp/employee3-docker-mapped-coverage-probe.log` |
| 固定 SDK x64 online CLI | Kit / WASM0.1.1、实际 Linux/x64/Node22.23.2、18 packages / 848 physical files / 162622469 bytes、8 个输入哈希稳定、exit 0；`/tmp/employee3-office-x64-online-final-probe.log` |
| 当前 CI 文件静态验证 | YAML / 三 job / coldBuild 合同 / 完整 source / inline Node syntax 均通过；`/tmp/employee3-ci-delivery-current-validation.log`；实际 PowerShell7.6.6 parser检查16脚本无错误，真实最终guard16组合均正确；没有Actions或Windows执行 |
| 前一依赖完整发现轮 | exit 1，79 条 export 分类拒绝，其余 import / section / singleton / integrity 0，未追加输入变化失败；`pe-cloud-check-iUlsWh/report.json` |

29 项自测包含真实 runner 的空文件、失败 / skip / todo，完整 corpus / JSON / 每指标 99.99% 拒绝，真实官方 lint / JSDoc / Markdown / YAML / 依赖 collector、native TS stale map / code / range 拒绝、跨 runner 合并、异根原字节运输、capture inputHash 篡改，以及精准 PEER 分类与直接依赖 / unused / namespace / SAFE 变异拒绝。最新 lint 私有配置为 `pe-employee3-mapped-peer-ci-static-YfRUMZ/oxlint.json`，是 root 可复用的真实官方映射配置。

x64 复现输入为员工1正式三资源（entry SHA `61a0d89ec0c2587201f774e5051de57cfd238439330a01f2d0b334b37cc5a049`），证据目录 `pe-employee3-office-x64-final-5uVgr4`。用的是当时已有 contracts validator 字节；不能当作当前重新构建产品、Officeenabled、镜像发布或 GitHub runner 验收。旧 entry `2c6c…` 的 index pull 因本地 ARM64 缓存与 x64 index 冲突失败，证据保留；新 entry 按同一父索引精确 child digest 选择成功，没有删除缓存或忽略失败。

上述 `pe-*` 私有目录位于 `/var/folders/rw/j_ygzn_x7qx_c3mqrwq1rcwr0000gn/T/` 或其 `/private` 等价路径。实际异根 Docker 目录为 `pe-employee3-docker-mapped-coverage-sA86il`；owned 容器 `2821a6b739cba5cb1da675e3cfdc1537e852cb0955de9ec47ebae1d2f8dc4e1a` 核对 UUID label 后精确移除。SDK installer `d24975520c854bc62d6b7a01abf6b0b76ed539496ef5c89671e3fc804b57fd7e` 退出0 / Running=false / PID0 / containerRemoved=true，随后独立 inspect 证明精确 ID 不存在。没有清理其他人的资源。

## 依赖、类型与未完成验收

[cloud-static.mjs](scripts/cloud-static.mjs) 使用官方 lint、JSDoc、Markdown / Summary / pairing、dependency 与 Host export policy。普通 contracts / connector SDK 不自动按 Cordis 插件分类，客户端按 client-host、application 按 configured-host；JS / MJS 映射含 GitHub reproducer，不套仅 TS 规则，实际 lint 负例验证临时配置生效。

员工6拥有的 [cloud-peer-policy.mjs](scripts/cloud-peer-policy.mjs) 提供 103 个实际使用的精确 Contracts PEER exports、官方字段 / unused / namespace / SAFE 重叠完整性检查及协议 manifest 守卫。员工3已接入可选 `dependencyReport(..., policy)`：同一精准 cloud policy 同时生成 peerRequiredHostDependencies facts 和 combined 官方 collector，原 `readPackageDependencyState` 使用原 policy；新增违反项保存在 structured section / integrity 和 failures 中。消费者 peer+dev、Host / Platform 显式 provider 与 pinned zod 由 manifest 检查强制，未知 export 仍拒绝。官方 SAFE / duplicateSafe / PEER 表均未改；Root 审查不冒充人工 SAFE 批准。

前一完整发现依赖证据 `pe-cloud-check-iUlsWh/dependencies.json` 为 Connector 24、官方 55，共79条未分类；Contracts 未分类0，import / section / singleton / policyIntegrity0。与更早读数78不同，是该轮真实发现结果，尚未复跑随后新增的 query / legacy 源码；该轮没有 input-stability 附加失败，不能据此宣布整个共享树冻结。旧 318 条（私有266 / 官方52）与更早报告保留为历史。

TestClient 已添加 cloud-web/tests 的 TS / TSX 与 modules / loader 引用，原 strict / noUncheckedIndexedAccess / exactOptionalPropertyTypes / noImplicitOverride 保留。types admission 覆盖 source / built 测试，新测试不属于任何程序即失败。旧稳定 types 轮 `pe-cloud-check-n6Fq7M` TestClient34 / TestHost35 和全部叶 noEmit0 仅对应当时输入。私有四引用图 `pe-employee3-four-types-kG3Lie` 156 nodes / 1579 hashes，Host / Client / TestHost0，但无 TestClient终态与整轮稳定报告；独立补跑 `pe-employee3-test-client-resume-QwOrHb` 141 nodes / 34 roots、exit0、inputChanges=[]。不同窗口不能拼为四程序单轮 PASS；当前四程序等待 root 统一构建与冻结。

旧本机完整 Client facet 为31文件 / 466 PASS且该轮稳定，证据 `pe-cloud-check-74C42V`，不是 Windows 实跑。旧 prepared built14 / 14 PASS，证据 `pe-cloud-check-LbUouL`，同轮 discovery 与输入稳定失败，整轮未过。当前全产品 lint / JSDoc / docs / duplication / dependencies、完整源码行为及逐文件四项100%尚未稳定验收；员工1 / 4 / 7 局部通过或覆盖缺口保留原报告。root 的 Officeenabled 网络负例尚未成立，不能声称 Officeenabled 验收或 Kube 首请求网络隔离通过。

两个客户端默认名 `tests/tsconfig.json` 已由员工2落地并获 root 授权保留，员工3只读验证、不拥有两文件。均继承完整共享 TestClient 范围，显式重复两 Client / modules / loader 四 references，保留 Client JSX / DOM、Node 测试 types 与原 strict / noEmit；根 solution 没有形成混合 Host / Client 程序。此前39文件稳定轮 exit0 后，新增 catalog-actions / transport-failures；一次扩大轮因 Application manifest / lock 不一致被正式 pnpm guard 拒绝，未自动安装。Root 串行完成锁与 frozen 安装后，最新实际 repo 41 文件 typed lint 稳定轮 exit0 / signal=null / diagnostics0；Go 后端41个文件全部匹配真实 leaf，Unmatched0且无 `<none>`。775项测试 / Client源码 / configs / manifests / TS程序源与声明 SHA 前后无变化，文件成员无变化，证据 `pe-employee3-client-typed-stable-0tG7I0/report.json` 和 `/tmp/employee3-client-typed-stable-after-lock.log`；只证明41文件 typed lint，不能代替完整四程序 typecheck。39文件、首次29诊断及并行修复后的 debug 历史证据保留。

Host 发现修复已获 root 明确批准并写入：共享 TestHost 保留原 Node types、四项严格选项 / noEmit 和全部原测试范围，追加三个产品 src；移除三个产品自身 project references，把原依赖合并为36 references，保留实际 session-query / session-query-sqlite / session-format-catalog 三新增引用。三个默认 Host test leaf 继承完整范围并显式重复36 refs。四个实际 TS 程序读到157产品 src / 0产品 lib/types，cancelActive 定位到实际 tasks.ts:239，证据 `/tmp/employee3-host-source-plane-applied.json`、`/tmp/employee3-host-actual-program-verify.json`；这不是 tsc 通过声明。此前46文件 programs0 / Unmatched46 / 351诊断稳定失败保留。修复后55个 Host 测试及辅助文件在实际 repo 的官方 mapped typed lint 全部匹配，Unmatched0 / 无 `<none>`，1018哈希与成员稳定，但 exit1、365真实诊断仍 FAIL；分组为员工1 239、员工6 42、其它84，原始 `/tmp/employee3-host-typed-stable-current.log` 和三份 owner diagnostics JSON保留，没有修改他人测试或降低规则。

完整正式 types 阶段上一轮 `pe-cloud-check-cpa28m` 中 Application / Contracts / Connector / Account / Extension / TestClient 六个 noEmit 均0，TestHost六处 fixture错误 exit2。Root 与对应 owner 修复 required limits、pg import 和品牌类型后，按 root 指示只复跑失败 TestHost；当前218 roots / 775 TS源 / 160产品 src / 0产品 lib/types，807输入哈希及根成员稳定，上一轮六处错误已消失，但新增 legacy-import 暴露12条真实 TS诊断（readonly数组 / 对象联合缩窄与一个未用 import），exit2。日志 `/tmp/employee3-test-host-noemit-recheck-current.log`、目录 `pe-employee3-test-host-noemit-recheck-Ab5CNG`，已交员工5与 root；未重复其余六项、没有宣称完整类型通过。

Contracts9模块 / 43组独立 wire validator 与实际 consumer 必要 case 建议 `/tmp/employee3-contracts-consumer-case-proposal.json` 已由 root 分派员工1。四份真实 Application Host / Platform Office 与 download 消费者测试已被发现；员工1最终冻结四文件132 / 132 PASS / 0 skip、官方 mapped typed lint 四文件0；已只读核对其 final-proof 与测试日志，office-preview.ts / file-download.ts 两份真实源码逐文件四项100，仅覆盖2 / 9协议模块。其真实 source-plane noEmit整体exit2有27条其它src / tests诊断，本组四文件0；14输入漂移=[]，原 Office 冻结范围漂移=[]。证据 `.artifacts/employee1/contracts-consumer-final-proof.json` 与 `contracts-consumer-final4.log`；此scope不代替当前统一 TestHost / Host lint验收。PG构造器 / Kube query观测替身与临时真实文件 / loopback HTTP作用域明确，不能当作真实 PG / Kube 或完整 Contracts / 源码覆盖验收。schema self-test、peer16和 import smoke 不替代消费者行为。

## 已落地 CI 与待实跑边界

[power-evolve-cloud.yml](../../.github/workflows/power-evolve-cloud.yml) 已落地三 job；`.github/AGENTS.md` 已按 root 明确授权加入最小 named product POSIX 例外，其他 workflow 和原 Windows 默认不变。Windows2025 原生 pwsh 执行当前 checkout 构建后的 discovery / types / lint / JSDoc / dependencies / docs / duplication / 完整 Client / prepared built；Ubuntu24.04 原生 pwsh 执行全量 Node+Vitest source 与统一逐文件四项100%，90分钟上限。最终 `cloud` check 必须两 job success，失败 / skip / cancel均拒绝。Office资源路径变化触发同一 PR门禁，两个 job 禁止 pnpm运行前隐式安装。

POSIX job检查真实非root Linux Node、Linux Docker backend、容器Linux Node及实际 bridge / host.docker.internal DNS；创建 UUID owned PG16、随机 gateway映射端口、掩码password env与0600 URL文件，仅按精确ID / owner label清理。构建相同 checkout的Host / nativeWeb / 产品，明确运行 build:native-system，再实际调用 Node-API tryLockExclusive。固定 Office0.1.1 JSON lock经正式 CLI online / x64复现、owned no-cache镜像构建、实际 network-none Kit/WASM版本探针、闭包每文件SHA / 当前wrapper / DOCX / freshly-built validator校验，源码锚点必须解析到该闭包。无需外部 registry变量或已有本地ARM64 tag。

部署 source测试前只创建owned父目录 / owner.json和已存在私有evidence，写 `PE_IMAGE_BUILD_MANIFEST={id:UUID,context:仓库外尚不存在的绝对目录,coldBuild:true}`，tag为同UUID的 `pe-employee4-cloud:UUID`。不提前建context / cold-build-v4.log或预构建部署镜像；员工4既有完整源码测试首例在父native清单冻结后真正 --no-cache coldbuild，build / pack两UUID实际 `/build` 捕获和runtime三角色实际 `/opt/power-evolve` 捕获原字节运回。真实Linux构建预计额外10–15分钟；新增三脚本覆盖仍由真实报告判断，接线不等于当前100%。员工4报告旧 v4 snapshot 最后三例全 PASS / 0 skip，原 raw transport 与6 MJS / 4 contexts 转换成功；旧版仍有 logger 动态模块遗漏警告且没有新 query 包。新 v5 roster、实际全部 entry import 与 HTTP200 后 activation failure 拒绝已由员工4准备，待 root 全 owner 一致 freeze 冷构建。最新 test / source SHA 不得重转旧 parent，历史覆盖不是当前100%证据。失败证据上传，owned资源仅按精确ID / label / 父目录owner清理。

最新 CI YAML与inlineNode语法、coldBuild fixture合同及最终拒绝条件静态检查0，交付副本 `/tmp/employee3-power-evolve-cloud-ci-delivery.yml`。本机没有全局pwsh；先尝试官方 .NETSDK9镜像两次因MCR v2 EOF失败，旧日志保留。随后按[微软官方二进制归档说明](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-macos?view=powershell-7.6)在UUID私有目录解包GitHub正式PowerShell7.6.6 ARM64归档，实际70604356字节与官方API SHA `6df833d094ebac1c1a74340d7b3437f4aaf5e03ce640484a1c4359f3ce8b3db1` 一致；禁用profile/telemetry，配置缓存仅私有目录，无全局安装。实际Parser检查当前16个run脚本 errors0，执行实际最终guard的16状态组合，仅双success放行；原始 `/tmp/employee3-powershell-real-parser-output.json` 与 validation日志保留，解析输入与当前workflow逐段相同。这是macOS语法/guard验证，没有实际Actions/Windows/Linux job证明。完整运行仍须在root最终冻结的源码 / 测试 / 当前准备工件上进行，并保留所有真实失败。

## 历史保留与资源边界

旧 `pe-cloud-check-mE0P0e` 459用例 / 455通过、built4 / 4、4输入变化及未合并旧覆盖；旧静态 `pe-cloud-check-mEFuRX` 370依赖 / 167文档 / 31duplication / 350变化；旧 `pe-cloud-check-B3pzom` 354依赖 / 7变化均是历史。旧交接 `/tmp/employee3-handoff-previous.md` 与原始故障证据保留。旧ownedPG `895fe645ed2cebcbae7f8a89714826b3feb7258bc565214c1e16fd4762cbfd4e` 和旧Docker覆盖probe `b33bbef004172af97c02bf3038cb930b7dfc9ef7ced00ba76edd877e73f994a6` 已核对owner后移除。员工3没有新增或停止既有Profile、试用服务，也没有发布镜像、修改他人证据或把局部结果写成整体验收。
