# 员工1 M4 交接

## 正式 CI 入口与 test-only 补测交接（当前切片）

2026-10-09。Office 三份 production MJS（含assembler）、Dockerfile、最终镜像与先前真实九例 evidence 保持冻结。 本轮只新增 root 明确授权的 `.github/power-evolve-office/` 三个文件、自己的五份 Office Node tests、本文及员工1证据。 未操作 Git 暂存／提交、应用共享生产、Kube、PG、DSH Profile、旧容器或其他工作者的文件。

正式可进入干净 checkout 的入口为 `.github/power-evolve-office/reproduce-office-closure.mjs`，当前冻结 SHA256 `61a0d89ec0c2587201f774e5051de57cfd238439330a01f2d0b334b37cc5a049`。 同目录 `office-sdk-0.1.1-input/package.json` 和 `package-lock.json` 保持原实际 Linux 输入 bytes，SHA256 分别为 `245d64428e6c5a4d1866b69b888a4b19711135f2143740117f7b81eb08795cda`、 `9d5b0a4270b10871536c5048f51c750e402e7ea551a692e920b137c01cbf3d2b`。 固定 Kit/WASM 均为 exact 0.1.1；未把 node_modules、私有cache、closure、registry secret 或私有路径写入正式输入。

```sh
node .github/power-evolve-office/reproduce-office-closure.mjs --out /absolute/fresh-owned-root --mode online --arch x64 --validator /absolute/current-built-office-preview.js
```

必须在 checkout cwd 执行。OUT 的父目录须已存在且为 canonical physical path；OUT 必须全新。 `--arch` 只接受 arm64/x64，`--mode` 必须 online/offline；offline 必须明确 `--cache`，online 不接受该选项。 可选 `--docker-context`；CI 默认使用已有 Docker context。未知／重复／缺失参数、路径注入、物理别名、symlink、 非普通资源、多链接及输入／输出／cache 重叠均拒绝。复制后的固定 package/lock 再次核验 SHA256。 输出仍为 OUT/context/runtime 和 OUT/context/Dockerfile；`prepareOfficeCi` 的返回值为实际阶段／清单，CLI 接口未扩展。 部署闭包定义仍由冻结 `sandbox/scripts/assemble-office-preview.mjs` 拥有。

Node parent index 仍固定 `d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`； 保留的真实公开 index 去掉终端换行后 SHA256 已复核为该值。 CI installer 按 index 中的真实 platform child pin pull/inspect/create：ARM64=`253da19867dd03e2f817f433d7782adefd2a2bac8729fcd4ebc6770665167a24`， AMD64=`a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066`， 实际 installer 内再检查 Linux／arch／Node v22.23.2，避免 OrbStack 同 index 双架构 cache overwrite。 report.base 记录 parent、report.installerBase 记录实际 child；生产 Dockerfile 的原 index pin 未改变。 员工3的旧版 x64 probe 与员工1一次 ARM64 cold probe 均曾在 base-image 阶段失败，日志保留，没有忽略退出或删除共享 cache。 新版 x64 online 由员工3独立探针验证，员工1未执行或宣布 x64 安装／构建／运行通过。

正式新版实际 ARM64 offline/network=none 重放退出0；18 packages、848 files、162,622,469 bytes， 完整 assembled manifest 与冻结 `office-closure-final.json` 逐项完全相等。 新目录 `formal-ci-repro-24d18ee7` 位于原私有 staging；path 文件为 `office-formal-ci-repro-final-path`， 实际 commands／container ID／run ID／Stopped PID0／删除／source hashes 见 `office-formal-ci-final-proof.json` 和该目录 reproduction.json。 所有日志和失败阶段保留。Docker create 回复不确定时，只按本次 UUID name 查回，核验 owner/run 后才清理精确 ID； 真实 Docker “未创建”和“实际201创建后丢回复”两个 transport 故障边界均通过。没有按 label 批量删除或替换其他容器。

完整原生补测当前为154/154，0 failed／skipped；五份测试全部 observed，四份实际 authored runtime 全部经官方转换器生成 coverage。 采用官方 frozen input／collector／V8／转换器，MJS 由 Node 原生执行；没有把部署副本或历史运行的 URL 静默归属为原始源码。 当前只表示员工1这一范围，不能当作完整 cloud source 或共享 tsx lane 已通过。

| 当前源码 | Lines | Statements | Functions | Branches |
| --- | ---: | ---: | ---: | ---: |
| CI reproducer | 98.83% | 96.33% | 95.23% | 92.53% |
| DOCX render-copy | 98.75% | 97.43% | 100% | 96.53% |
| Office parser | 93.10% | 89.23% | 90.90% | 84.96% |
| Closure assembler | 100% | 99.03% | 100% | 98.61% |

每文件四项100%门禁仍失败13条；阈值／分母未改，无 ignore/exclude/skip。 新增边界含实际FIFO、独立线程观察输出创建后的validator变更与复制回滚、marker竞争、真实Node spawn错误／SIGKILL join、 XML编码／ZIP头／实际DEFLATE错误／legacy名称重编码溢出、实际冷Linux npm安装、断网cache重放、CLI成功及安装中SIGTERM。 单元 fixture 的 SDK/PDF 替身仍明确标注；新增 cold/replay 用例使用真实0.1.1依赖和正式 validator，根间接Kit0.1.5的独立性由实际版本断言验证。 七个具名真实 installer／probe 的精确ID在本次TAP中记录，并再次逐ID查验不存在；不触碰员工3独立probe的容器。

当前证据均在 `.artifacts/employee1/`：`office-native-direct8/`、`office-native-direct8.log`、 `office-test-only-final8.json`、`office-final9-static-proof8.json`、`office-formal-ci-final-proof.json`。 九份实际 MJS 的 Node syntax／官方 mapped lint／官方 JSDoc 均0；当前 hashes与原生 frozen inputs相同。 少数有局部不变式证据的冗余判断及其他仍可达缺口，交给 `office-coverage-readonly-review.md` 审查；生产未据此改动。 员工3已接通新CI入口的完整 runtime/source/lint 分母及两份JSON的native/config哈希，workflow由其拥有。 按员工3正式 `nativeDockerCoverageArguments(parent,{executionRoot:'/pe-office-probe'})` API， 最新用例已把实际 assembled runtime readonly mount 到 `/pe-office-probe/products/power-evolve/sandbox`， network-none Linux Node 实际加载真实SDK0.1.1、正式 validator 与 copied parser。 真实 V8 URL 为 `file:///pe-office-probe/products/power-evolve/sandbox/office-preview.mjs`， 执行／文件SHA均为冻结 wrapper 的 `7816c1d65b9be704147187942f3edbc1bb555767635f96e20b7cfe970706ae9a`； 转换事实保留该实际URL和独立PID namespace，并严格绑定父冻结input。没有伪造flat `/opt` alias或source map。 这只属于assembled源码／SDK单元探针，不代表正式冻结镜像或业务转换验收；原真实九例不代替当前采集。

2026-10-09 更正：此前员工1把两个不同throw混淆，误报原生与转换结果差异。 员工3锁定官方converter只读重转、员工1再次独立核对同一冻结源码／AST位置／原始V8／merged输出后确认： line40 statement23 是 `Office WASM manifest is incompatible`，raw=0／converted=0； line44 statement27 是 `Office WASM asset is undeclared`，raw=3／converted=3，转换正确。 旧 `office-assembly-raw-conversion-discrepancy*.json` 保留历史，不能再作为当前差异结论。 `office-assembly-mapping-correction.json` 明确更正并supersedes旧诊断； `employee3-office-ast-review-direct7.json` 保留逐项真实代码／区间／AST／单进程及merged对照。 未改共享helpers、计数、阈值或生产源码；已仅在own assembly test补真正不兼容manifest负例，单独40/40通过。 新增负例覆盖错误schema／engine version／platform／未完成build／native engine／program directory及无效file table， 均以真实物理manifest数据触发明确 `Office WASM manifest is incompatible`，且没有分配输出目录。 因该新增测试只再执行一次适用static/native；direct8完整154/154，line40真实原始V8与官方converted均有正计数， 逐项对照见 `office-assembly-incompatible-coverage8.json`。 收到root v4 copy窗口要求后暂停仓库写入，并直接向员工4交接assembly test SHA `5d8d6426586e4c5e950668782ba933f5672f42d98852ca888a188a8f10c4ed8c`。 root确认v4 copy已结束、5667项稳定且test不在已审阅image closure后，才继续本次必要核验；未要求重复重建生产镜像。 当前冻结hash清单为 `office-scope-final8-freeze.json`，后续新补测先在独占外部副本完成再申请集成窗口。

本机私有 registry 仍按此前授权保持运行；其 manifest pin、volume、secret及最终 image 没有变更。 下方均为先前切片，保留失败和历史过程；旧 `.artifacts` entry 不再是干净CI使用的正式入口。

## Kit 0.1.1 干净 CI 物理闭包复现交接（最新切片）

2026-10-09。只新增员工1准备输入／脚本／证据，Office 三份 production MJS、Dockerfile 和最终 image 均保持冻结； 原真实九例 evidence 未编辑。后续开始 test-only 覆盖补充，四项逐文件 100% 要求保留。

独立入口：`.artifacts/employee1/reproduce-office-closure.mjs`。 固定输入：`.artifacts/employee1/office-sdk-0.1.1-input/package.json`（161 bytes，SHA256 `245d64428e6c5a4d1866b69b888a4b19711135f2143740117f7b81eb08795cda`）及同目录 `package-lock.json` （9481 bytes，SHA256 `9d5b0a4270b10871536c5048f51c750e402e7ea551a692e920b137c01cbf3d2b`）。 两个 dependency 均 exact 0.1.1。Lock 是实际 Linux npm 安装产生的 lockfileVersion=3，包含所有依赖的 resolved URL／SRI； Kit integrity 为 `sha512-vML+3Nh/159k/TWuxLfZU1O39BA0m+/jybfySu9dJaTHR2oAi+hHWud6iRhBaCie5N6ADfo4DNHajBk52pmRog==`， WASM integrity 为 `sha512-YuKZJdDhR/0GeTZUHJsJvachJR8ZiS4lcrL+lxUF2GLRwXcMikN0zAQOA+6kD/nRI+vlHsCkX0KvHaKvfae79Q==`。

在目标 checkout cwd 执行（OUT 必须为新的、绝对物理路径，父目录已存在；VALIDATOR 为正式构建的物理 shared validator）：

```sh
node .artifacts/employee1/reproduce-office-closure.mjs   --out /absolute/new-owned-office-root --mode online --arch x64   --validator /absolute/current-shared-office-preview.js
```

干净 Linux/amd64 Docker runner 使用默认 context；脚本的平台参数是 x64，真实 Docker platform 为 linux/amd64。 宿主 Mac/OrbStack 复现实测改为 `--arch arm64 --docker-context orbstack`。 脚本运行固定 Node 22.23.2 的 pinned Linux image，检查实际 platform／arch／Node，然后执行 `npm ci --ignore-scripts --bin-links=false --omit=dev --no-audit --no-fund`。 它读取这份 lock 自己解析版本，Root pnpm 的间接 Kit 0.1.5 不参与 closure；没有根 node_modules／锁文件修改或安装脚本执行。 完整物理检查拒绝 symlink／非普通文件／多链接；资源随后只读，再调用现有 `sandbox/scripts/assemble-office-preview.mjs`，实际输出 CONTEXT/runtime 和 Dockerfile。 该 assembler 还检查 Kit/WASM 0.1.1、Linux WASM 选择、prebuilds manifest 和 engine assets SHA256、依赖闭包、validator 物理文件。

固定 Node base index：`node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`。 真实公开 index 声明的 linux/amd64 platform manifest 为 `sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066`， linux/arm64 为 `sha256:253da19867dd03e2f817f433d7782adefd2a2bac8729fcd4ebc6770665167a24`；原始 index 保存在 `office-ci-node-base-index.json`。 只有本机 ARM64 的 offline 复现已实际执行，未宣称 AMD64 CI 安装、构建或运行已通过。

已实际复现的 offline 入口（原 cache 只读复制到全新 OUT，不会修改原 closure/context/cache）：

```sh
node .artifacts/employee1/reproduce-office-closure.mjs   --out /absolute/new-owned-office-root --mode offline --arch arm64   --docker-context orbstack   --cache /Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/employee1-office-o8ujzty8/npm-cache   --validator /Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/employee1-office-o8ujzty8/context-final/runtime/office-preview-contract.mjs
```

新成功目录：`/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/employee1-office-o8ujzty8/ci-repro-d0643b63`。 原物理 closure：同 staging 下 `closure-physical`；原 package/lock 在该目录，npm cache 为 staging 下 `npm-cache`； 最终原构建 context 为 staging 下 `context-final`，其 `runtime/office-preview-contract.mjs` 是 image 内 exact validator bytes。 本次实际安装退出 0、18 packages、848 inventory files／162,622,469 bytes；完整 assembled manifest 与冻结最终 manifest 逐项完全相等。 安装命令、实际 container name、platform、status、全部 source hashes 见 `office-ci-reproduction-proof.json`、`office-ci-reproduction.log` 和成功目录的 install.json／assembled.json。 初次缓存复制因目标目录已预建而 EEXIST，未启动安装容器；失败目录及 `office-ci-reproduction-first-failure.log` 保留。 修正为复制前不建 offline cache 目录后，在全新目录实际通过。

本地私有 registry 中仅有 linux/arm64 Office manifest pin `localhost:19884/power-evolve-office-preview@sha256:e6e5397289124d2d8e6ad4213b13ddc7e45a24b5fe335bf7b192b992e2c2fc27`。 没有已发布、GitHub 可达的 linux/amd64 Office manifest pin；不能将其 config ID、ARM64 pin 或 localhost 当作该输入。 干净 CI 必须在 Linux/amd64 自己从上述固定 lock 组装并构建，或由获授权发布者提供 CI 可达的实际 AMD64 manifest pin， 并按同一 inventory／source／validator bytes 和实际 config ID 验证。这里没有公共 registry 发布授权，也未构建／发布第二架构镜像。

上述 `.artifacts` 文件是本地证据，不会自动存在于干净 checkout。 员工3须在自己获授权的 CI resource 范围纳入审阅后的两份固定输入与脚本，或明确提供等价的受验输入运输； 当前目标平台正式 validator 尚须 CI 正式构建产出，不能回退到根 Kit 0.1.5、历史 lib 或私有路径。


## Office 镜像私有 registry manifest pin（最新切片）

2026-10-09。按主集成者追加授权，新建指定 registry，仅 Host `127.0.0.1:19884`， 加入既有 owned network `pe-dsh-migration-network-20261009-v1`；未操作 k3d 节点／集群、Kube、Profile、PG 或其他功能开关。 启动前实际核对 exact 容器名称不存在、TCP bind 成功、唯一 volume 不存在、network 的 owned label／exact ID。 只发布到本机私有 registry，未向公共 registry 发布。

| 交接项 | 实际值 |
| --- | --- |
| Registry DNS | `pe-dsh-migration-registry-20261009-v1:5000`（项目网络内 HTTP） |
| Host bind | `127.0.0.1:19884`，仅此 IPv4 loopback 映射 |
| Registry exact container ID | `1751bd168012d690edfdc8fe8ea8f2136838b3ce5c785adc85e1f4c224f843a4` |
| Registry labels | `codex.owner=power-evolve-dsh-migration`、`powerevolve.dev/owner=employee1`、`powerevolve.dev/purpose=office-private-registry` |
| Registry image pin | `registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8` |
| Persistent owned volume | `pe-dsh-migration-registry-data-20261009-v1`，labels 与 registry 相同 |
| 稳定最终 tag | `localhost:19884/power-evolve-office-preview:employee1-20261009-final-b76a7e20` |
| 实际 registry manifest digest | `sha256:e6e5397289124d2d8e6ad4213b13ddc7e45a24b5fe335bf7b192b992e2c2fc27` |
| Host digest reference | `localhost:19884/power-evolve-office-preview@sha256:e6e5397289124d2d8e6ad4213b13ddc7e45a24b5fe335bf7b192b992e2c2fc27` |
| 项目网络 digest reference | `pe-dsh-migration-registry-20261009-v1:5000/power-evolve-office-preview@sha256:e6e5397289124d2d8e6ad4213b13ddc7e45a24b5fe335bf7b192b992e2c2fc27` |
| 实际拉回 config ID | `sha256:e1057bf54bafe3762295a6417c8a57c5e9aad9dff6f595fd03c0a2958eaf8f52` |
| Font inventory policy digest | `701978199fa16f0611ea0a8fbce36a1f15e627e63fac2c567d10dd868bab3c6e` |

manifest digest 从 Registry API 返回的原始 2205 bytes 计算 SHA256，同时核对 Docker-Content-Digest、push 输出和按 digest 再 GET 的完全相同字节，严格区分 image config ID。 实际 manifest media type 为 `application/vnd.docker.distribution.manifest.v2+json`；config 指向原最终镜像的 exact ID。 按 [Registry V2 API](https://distribution.github.io/distribution/spec/api/) 的内容摘要协议核验原始响应。 逐个读取并核对 config＋九个 layer 的全部 registry bytes（共 238,050,148 bytes）， 不是仅解析 tag 或使用 image ID 冒充 manifest。 执行真实 `docker pull --platform linux/arm64` digest reference，返回 config ID 与原镜像一致； Docker 使用已有本地 layer cache，因此不宣称重新下载全部 layer，前述独立 API 读取已验证 registry 的全部存储字节。 临时 UID 1000 Node probe 从指定 project network 的 registry DNS 成功 GET 同一 manifest、核对相同 SHA256； 独立记录 probe exit=0／Running=false／Pid=0 后删除。最终仅指定 registry 故意保持 Running，供主线程继续集成。

字体 digest 的精确方法：SHA256(UTF-8 `JSON.stringify(fontInventory.fontPolicy)`)，不含结尾换行。 `fontPolicy` 为有序字段 `{version:1,files:[{path,bytes,sha256},…]}`，目录递归 `readdir().sort()`， 清单包含镜像内全部 21 份 `/usr/share/fonts` 物理文件，每项 sha256 为原始字体 bytes 的 SHA256。 可直接对 `office-font-policy.canonical.json` 执行 sha256sum 复核（3484 bytes）。 这是本文定义的 inventory policy identity，未冒充 Platform converter generation；主线程须按自身 policy 定义接入。

证据目录 `.artifacts/employee1/`：`office-registry-publish.json`、`office-registry-preflight.json`、 `office-registry-manifest.raw.json`、`office-registry-office-push.log`、`office-registry-office-pull.log`、 `office-registry-dns-probe-final.log`、`office-font-inventory.json`、`office-font-policy.canonical.json`。 其中 publish JSON 包含全部 exact IDs、labels、端口、volume、字节验证、最终 DNS probe 及 font 计算定义。 首次 DNS probe 使用 ESM 中的 require 而失败，失败快照／日志分别保存在 `office-registry-publish-first-failure.json`、`office-registry-dns-probe-first-failure.log`，失败 probe 已清理； 修正为 ESM import 后用全新 probe 实际通过，未删除失败或重复发布镜像。 服务私有 HTTP secret 保存在原 employee1 private staging 的 0600 env 文件；未写入报告或打印其内容。 主线程负责节点 mirror、Office/PVC 与后续 registry 生命周期；本切片只交接实际本机发布结果。


## Office 预览独立迁移与真实 Linux 验证（最新切片）

2026-10-09。本轮迁入原先缺失的 `sandbox/office-preview.mjs`、`office-preview-docx.mjs`、 `Dockerfile.office-preview`、`sandbox/scripts/assemble-office-preview.mjs`，以及四份独立命名的 `tests/employee1-office-*.test.mjs`。保留原始 assembler 的相对位置，读取现有 `scripts/libreoffice-packages.mjs`。 修改仅限这八个新文件、员工1证据和本文；未操作 Git 暂存／提交、旧容器、当前集群、Profile 或共享门禁。 来源仓八份文件的 SHA256 全部未变；旧 `runner.mjs`、`command-children.mjs`、原 Dockerfile 未变。 并发期间冻结清单中的根锁文件和两份 Platform Office 文件由其他工作发生变化，最终比较已单独记录，未回退这些变化。

已完成固定 0.1.1 的真实 Linux ARM64 WASM 物理闭包、独立镜像构建及九个真实运行用例。 这里只验证独立 parser；Platform enabled、PVC、namespace、应用授权／取消／缓存及真实 Pod 停止的最终集成由主集成者负责。 根仓库安装的 kit 0.1.5 不等于本镜像中的 kit／WASM 0.1.1，未混用、未改版本门禁。

最终唯一镜像：`power-evolve-office-preview:employee1-20261009-final-b76a7e20`。 本地 image ID：`sha256:e1057bf54bafe3762295a6417c8a57c5e9aad9dff6f595fd03c0a2958eaf8f52`。 该 ID 是本地镜像配置身份，不能作为 registry manifest digest 填入部署配置；发布／导入和部署 digest 由主集成者处理。 实际镜像为 linux/arm64、Node 22.23.2、USER 1000:1000，固定入口 `node /opt/power-evolve/office-preview.mjs`。 闭包包含 18 个包、848 个清单文件、162,622,469 bytes，实际 SDK discoverRuntime 返回 0.1.1／wasm； 完整包、WASM manifest、worker／资源字节、SHA256、模式和无符号链接均验证。 构建输入 SHA256 与最终源码／现有 validator 均一致；镜像内 21 份物理字体共 112,025,039 bytes。 `office-font-inventory.json` 提供全部字体哈希和自定义 inventory digest 的明确定义，主集成者须核对自身 generation／font policy 定义后使用。

| 真实文件 | PDF 页数 | PDF bytes | missingFonts | 结果 |
| --- | --- | --- | --- | --- |
| LibreOffice 官方 `fdo59530.doc` | 1 | 12,329 | 空 | 退出 0 |
| 自制中文／表格／分页 DOCX | 2 | 41,729 | 空 | 退出 0 |
| LibreOffice 官方 `FillPatterns.ppt` | 1 | 27,854 | 空 | 退出 0 |
| 自制中文／文字两页 PPTX | 2 | 42,038 | Arial | 退出 0，保留真实缺字体记录 |

两个旧格式文件均为真实 OLE 文档，来自 LibreOffice/core 固定 commit `29baf2f2a596670cd30238ec1041dcc53d28b56f`，同时核对 Git blob、原始 SHA256 和签名；未用改后缀文件代替。 DOCX／PPTX 由本机 bundled Python libraries 生成，只作私有输入 fixture。 每次实际 parser 使用独立 input/output、input 只读、rootfs 只读、network none、cap-drop ALL、no-new-privileges、 2 CPUs／2 GiB memory／128 PIDs／768 MiB tmpfs；生产入口与 UID 未被覆盖。 预算明确传入当前协议允许的值：pages=20、imageResolution=300、180 秒 deadline（timeout 负例为 1000ms）；没有不受限解析或在线载荷下载。 测试 generation 为本地 image ID 文本的 SHA256，仅验证身份绑定，不代表部署 converter generation。 逐例核对原始输入哈希不变、job／nonce／generation／source 绑定、PDF 完整字节及 SHA256、私有 0600 单链接文件、 官方共享 schema、独立 Poppler 页数／文字和六张 PNG；六页均已人工视觉检查，中文、表格、分页、PPT 填充图案可见。 这是可读性及结构检查，未与桌面 Office 做像素一致性比较。

真实负例五例全部退出 1：摘要不符、带真实 OLE 头的截断 DOC、1024-byte 输出上限、1000ms timeout、SIGTERM 取消。 前四例只在清理后保留绑定身份的 `failure.json`，无 PDF／成功标记／scratch。 取消在观察到实际 SDK 打开输出 PDF、创建 `libreoffice-kit-*` scratch 且主进程有 12 个 task threads 后发 TERM； 不是固定延时猜测启动。随后 output 为空，stderr 分类 cancelled，无成功或失败 marker。 九例均独立记录 live PID 和 Docker 状态：最终 Running=false／Pid=0／OOMKilled=false；确认停止后才读取证据并删除自有容器。 最终员工1标签容器数量为零。marker 本身未被当作停止证明。

| 检查 | 实际结果 | 证据（均在 `.artifacts/employee1/`） |
| --- | --- | --- |
| 最终普通 Node/tsx 源码用例 | 107 pass，0 fail／cancelled／skip／todo | `office-source-final.log` |
| 官方 lint、Node syntax、官方 JSDoc | 七份 MJS 全部退出 0／无诊断 | `office-final-checks.json`、`office-lint-final.log` |
| 当前自动 discovery | 四测试全部为 nodeTests，三个 runtime（含 nested assembler）全部发现，vitestTests 为空 | `office-native-direct2/discovery.json` |
| 原生 Node 直接执行／官方 V8 转换 | 107/107；observedTests=4；三个实际原始 MJS 均经官方转换器生成 coverage | `office-native-direct2/{inputs,runner,process,conversion,native-istanbul,coverage-summary}.json` |
| 每文件四项 100% 门禁 | 仍失败，10 条未达标；阈值未降低 | `office-native-direct2/coverage-gate.json` |
| 镜像闭包／真实运行／停止／渲染 | 构建 0，四成功＋五负例全部验证，九 job／四 result／四 failure 经当前共享 schema 通过 | `office-evidence-final.json`、`office-real-results.json`、`office-real-negative-results.json`、`office-real-schema-final.log` |

原生直接执行使用 Node 22 内建 TS stripping 读取测试所引用的 schema，三个被测 runtime 保持原始 MJS； 保留员工3的 prepareNativeCoverage、collector、V8 输出和 convertNativeCoverage，不采用猜测代码或补造 source map。 CLI 拒绝参数用例只向其自有 child 传递当前 native observer 的三个变量，使该 child 的实际源码也有捕获证据； 普通模式仍用原 scrubbed environment。官方 100% gate 按以下实测数值正常拒绝：

| 源码 | lines | statements | functions | branches |
| --- | --- | --- | --- | --- |
| office-preview.mjs | 85.71% | 80% | 77.27% | 72.18% |
| office-preview-docx.mjs | 95.03% | 89.74% | 100% | 85.14% |
| scripts/assemble-office-preview.mjs | 97.64% | 93.26% | 100% | 90.27% |
| 三模块实测总计 | 91.31% | 86.12% | 90.38% | 81.81% |

107 例由真实 ZIP/XML codecs、物理文件／Node child 和注入转换器／合成 PDF／小型 SDK fixtures 构成， 它们不等于上述九个真实镜像运行，更不能认定产品 enabled 验收。 共享 nativeCoverageEnvironment 的 tsx 路径另有实际阻断：107 例通过，但 wrapper 的真实 inline source map 含 sources／mappings 而无 sourcesContent，官方转换器拒绝 `Native coverage: invalid source map`； 禁用 tsx cache 后仍复现。`office-native-current2.log`／`current3.log` 及各自 raw/code/inputs 保留该证据。 原生直接执行的 coverage 成功不能冒充这一共享 tsx lane 已通过，主集成者与员工3仍须处理完整 source lane 和 100% 缺口。

准备过程失败亦保留：Darwin npm 对 Linux-only WASM 报 EBADPLATFORM；实际 Linux 安装成功后默认 `.bin` shim 被物理闭包检查拒绝。最终使用独立 Linux `npm ci --offline --ignore-scripts --bin-links=false` 获得完整无链接闭包， 没有删除 symlink 后放宽检测或替换真实 SDK。 首轮旧 2 MiB 测试边界不符合当前 32 MiB 协议，现以导出的 `OFFICE_PREVIEW_MAX_INPUT_BYTES + 1` 测试拒绝； 官方 JSDoc collector 不识别来源的带类型 @param，九项注释改为其实际可识别格式，无共享规则修改。 首次真实 DOC 转换已成功，但检查器以 UID 0 观察 OrbStack bind 的 UID 映射而失败；修正为与 producer 同 UID 1000 的 observer， 再用全新目录／容器执行并保存完整九例证据。中间失败目录和日志仍保留。

私有准备目录路径保存在 `office-staging-path`；不要从旧第一次镜像或中间失败运行取最终部署证据。 最终输入、闭包、Docker 构建日志、版本／字体 inventory、所有输出 PDF 和 PNG 的路径均可从 `office-evidence-final.json` 追溯。


## Connector Runner 原生测试迁移（最新切片）

2026-10-09。本轮只写 `connector-runner/tests/`、员工1证据与本文；未改生产源码、共享脚本、`lib`、Profile、锁文件或只读来源仓。 已迁入来源仓的全部 10 份原生 Node 测试与两份 peer fixture，另补严格类型声明和 JSONL trace helper，共 14 文件。 当前员工3 `inventory()` 将全部 10 份测试分类为 `nodeTests`，runner 的 `vitestTests` 为空；没有通过 Vitest 忽略 Node 用例或缩小发现范围。

实际完整执行为 79 例通过，0 failed／cancelled／skipped／todo。39 例使用真实 SDK 2.0.0 client 与自有 Node peer： provider 34 例、dispatch 的实际 discovery／call／catalog-change 3 例、旧版 STDIO provider 2 例。 另 4 例使用真实 ssh2 加密连接、自有 loopback SSH server 与文件 marker；exec 是 fixture 接收的 SSH 请求，不能外推为真实远端 shell 执行。 其余 36 例是 parser、digest、注入 probe／transport 的 HTTP 边界和 19 例 runtime 注入驱动生命周期测试。 最新全域 test-host 在 `application/tests/employee7-skill-files.spec.ts` 与 `employee7-skill-pg.spec.ts` 报 15 项类型错误； 本切片严格 runner source 检查退出 0，未越界修改员工7文件。完整云类型门禁当前因此未通过。 这些用例不能认定 Platform enabled、真实 UID 1000 writer quiet、物理挂载、Pod 或应用完整用户路径已验收。

适配只涉及测试：移除 Device packet 分支；使用当前 Cloud 协议与真实 domain catalog digest；修正可选参数及联合类型、 Headers 构造、Node 测试注册 promise 和官方 lint 格式；用严格 schema 读取 fixture JSON，未增加 `any`、`as unknown` 或规则豁免。 JS peer 的声明文件使官方 noEmit test-host 直接校验导入，无需开启 allowJs 或重建声明。 Unix 身份用例正常执行，未使用 Windows skip；移除在同进程中用强制断言制造“缺静态必填字段”的旧负例，保留真实预算与身份边界测试。

SDK 用例核对 literal argv、原始 metadata／NUL／扩展、完整分页、冻结 selection、最多一次 tools/call、lost reply 不重放、 协议／UTF-8／预算拒绝、abort／timeout、TERM→KILL、exit 与 close 区别。所有已启动的 STDIO v2 direct child 都由独立 PID 查询确认退出； 持 pipe 的自有 descendant 在清理钩子中终止并确认消失；父 peer 在 spawn 后立即记录其 PID，避免 child 启动延迟使清理漏掉它。旧版 STDIO 两例新增 bootstrap PID 记录及 `ESRCH` 核对， SSH fixture 等待所有自有连接 close 和监听器停止。测试清理只操作各例自己的目录、PID、loopback server 与连接。

| 最新检查 | 命令／实际范围 | 结果 | 员工1证据 |
| --- | --- | --- | --- |
| 员工3原生 source 路径 | `node .artifacts/employee1/run-runner-sdk.mjs runner-sdk-native-current3`；当前 inventory 的全部 10 文件，默认 Node 并发及 collector／tsx | 退出 0；79/79；observedTests=10；实际 V8 转换 9 份源码 | `runner-sdk-native-current3.log`、`runner-sdk-native-current3/inputs.json`、`conversion.json` |
| 普通开发 Node 路径 | `pnpm exec tsx --test --test-reporter=tap products/power-evolve/connector-runner/tests/*.test.ts`；完整 10 文件，无 collector | 退出 0；79/79，0 skipped；验证未设置 coverage 环境变量时同一环境及 PID 断言成立 | `runner-sdk-plain-current3.log` |
| 当前源码严格类型 | `pnpm exec tsc -p .artifacts/employee1/runner-sdk-source-typecheck.json --pretty false` | 退出 0；noEmit，实际 runner source＋tests；保留 contracts／brand references | `runner-sdk-typecheck-current3.log` |
| 官方 test-host 类型 | `pnpm exec tsc -p tsconfig.power-evolve.test-host.json --pretty false` | 最新退出 2；员工7两份测试共 15 项类型错误，Runner 0 项；早先完整检查退出 0，最新结果优先 | `runner-sdk-official-test-host-current3.log`、`runner-sdk-official-test-host-current3.json` |
| 官方 lint | 官方 `run-oxlint.ts`，员工3 cloudLintConfig，当前严格测试 tsconfig；11 TS＋2 MJS | 退出 0，无诊断 | `runner-sdk-lint-current3.log`、`runner-sdk-lint-scope-current3.json` |
| 官方 JSDoc 规则 | 当前 `jsdocCollector`，全部 13 份可执行测试／fixture／helper | 退出 0，errors=[] | `runner-sdk-jsdoc-current3.json` |
| 逐文件四项 100% | 当前 `coverageErrors`，完整 11 份 runner runtime 清单 | 失败；33 条缺文件／不足 100% 诊断，阈值未修改 | `runner-sdk-native-current3/coverage-gate.json` |

下面仅为九个实际被测量模块的覆盖率，未执行的 `main.ts` 与 `stdio-identity-server.ts` 缺少 source 覆盖数据。

| 被测量文件 | lines | statements | functions | branches |
| --- | --- | --- | --- | --- |
| `protocol.ts` | 93.33% | 87.5% | 100% | 89.76% |
| `egress.ts` | 62.79% | 58.92% | 53.33% | 63.63% |
| `server.ts` | 92.55% | 92.17% | 100% | 87.38% |
| `stdio.ts` | 83.33% | 75% | 87.5% | 47.36% |
| `transport.ts` | 93.1% | 89.51% | 92% | 80.51% |
| `stdio-v2-digest.ts` | 92.3% | 86.66% | 100% | 83.33% |
| `stdio-v2-dispatch.ts` | 96.96% | 95.12% | 100% | 93.33% |
| `stdio-v2.ts` | 92% | 84.91% | 91.66% | 83.02% |
| `stdio-v2-runtime.ts` | 96.66% | 97.39% | 100% | 87.67% |

九模块实测汇总 lines 91.08%、statements 86.86%、functions 91.3%、branches 83.71%；不能当作十一模块或产品总覆盖率。 本轮完成迁移、发现、实际 Node 执行和当前源码验证；完整 source lane 仍需员工3与主集成者合并 Vitest 证据并处理逐文件缺口。

保留的负例与适配记录：首轮 75/79，Node 自动传给 child 的 `NODE_V8_COVERAGE` 与 fixture 原环境断言不符， 另三例的 150ms 预算在覆盖率采集下先于初始化耗尽。现在只允许观测值与父进程精确相同的 coverage 变量，仍拒绝其他环境扩展； lost reply 预算改为 request=1000／runtime=5000ms，runtime 超时用例为 runtime=1500／request=2000ms，仍断言到达实际协议阶段及不重试。 第一次类型检查和 lint 失败已保留；lint 自动处理后的数组索引检查由显式 `assert.ok` 修正，最终严格检查通过。

同一份最终源码有一次 79/79 通过但覆盖率转换退出 1（`runner-sdk-native-current.log`）： `coverage-31624-1791508802075-0.json` 为持久 0 字节；PID 已退出、无相应 source capture，退出后再次转换仍失败。 这是独立的 native 采集负例，不能算用例失败或删文件后冒充通过；原目录与 `conversion-negative.json` 原样保留。 同一固定输入随后完整复跑成功（current2），补强 descendant PID 所有权记录后最新 current3 再完成完整 79 例及转换。建议员工3核对自动继承覆盖变量的 Node 子进程被终止时的证据写入， 并验证 raw 输入完整性；现有转换器对截断 JSON 拒绝是正确的，本轮未修改共享采集器、合并器或阈值。 不能严格把该空文件归属到具体 peer mode，避免从 PID 和时间推断出未经记录的事实。

`runner-sdk-input-before.json` 保存 12 份来源文件及 11 份生产源码、56 份 lib 文件的初始 SHA-256； `runner-sdk-source-protection.json` 核对来源、生产与 lib 均无变化，并列出当前 14 份测试／helper 的 hash。 `runner-sdk-native-current3/inputs.json` 冻结全部 11 份 runtime、10 份测试与 4 份 helper，转换前核对相同原始 source hash。 `runner-sdk-tests-adaptation.patch` 是与只读来源测试的完整差异；`runner-sdk-installed-versions.json` 核对实际 SDK client／server 2.0.0、ssh2 1.17.0。所有证据位于 `.artifacts/employee1/`，不包含私有密钥或真实凭据。

## STDIO 工作流与员工3入口交接

本次只新增员工1的 `application/tests/employee1-stdio-workflow-fixture.ts` 与 `employee1-stdio-workflow.spec.ts`，未改生产模块、共享接线、`lib`、Profile、私有部署或试用实例。最终真实 PG 的 27 个工作流用例及先前 4 个管理用例全部通过，0 failed／skipped；十二个具名 PG 模块的逐文件覆盖率门禁仍失败，四项 100% 阈值保持。fixture 使用真实 Identity、PG services、HMAC／domain digest 与 FileService binding，private capture、Runner outcome、UID quiet facts 明确是合成输入；不代表 enabled Pod、原生 SDK 或系统执行通过。

覆盖行为包括完整 create／update／delete／toggle／receipt 与游标分页、容量及 owner 拒绝；独立 approval audience、immutable 第一 epoch、审批过期与拒绝；并发 authorization 只有一次 true，重查原 permit 永远 false；running 与缺 UID quiet proof 的 terminal observation 保留原写者占用；精确 quiet proof 才提交 result／catalog，重试保留同一 catalog，raw JSON 改变拒绝；原 task、instance、digest、Pod UID、mount generation 与 full scope digest 围栏；禁用账号、删除连接或更新配置之后可以记录原结果但不发布新 catalog 权限；cancel 后无替代启动，原 ready writer 不因 no-start 或 child-close 被释放；正常接管与旧 epoch 拒绝、两种 lease 服务的 mirror／renew／terminal 拒绝，以及真实账号锁等待期间 revoke 或租约过期；原 native call key 幂等、完整 raw outcome、isError 分支、一次续接、原 selection 和 root budget，root cancel 抑制自动续接但保留原结果。所有数据库、临时存储均由 `cloud-fixture.ts` 逐例创建并清理自有资源，没有启动 worker、Kubernetes、Docker 或 STDIO 子进程。

| 本次 STDIO 检查 | 命令／范围 | 退出码与实际结果 | 独立日志 |
| --- | --- | --- | --- |
| 首轮有效回归 | cloud-only Vitest，工作流文件 | 0；6 例通过，0 skipped | `stdio-workflow-regressions.log` |
| 扩充行为回归 | cloud-only Vitest，工作流＋既有管理文件 | 0；2 文件、27 例通过，0 skipped | `stdio-workflow-expanded.log` |
| 最终回归及覆盖率 | 下方完整命令 | 1；2 文件、31 例全部通过，0 failed／skipped；11 模块未达到逐文件 100% | `stdio-coverage-final.log`、`stdio-coverage-final/coverage-summary.json` |
| 严格源码类型 | `pnpm exec tsc -p .artifacts/employee1/stdio-source-typecheck.json --pretty false` | 0；当前测试及其应用 source，外部项目保留原 references；noEmit | `stdio-source-typecheck-final.log` |
| 官方 lint | `pnpm exec tsx scripts/run-oxlint.ts`，两份新增测试文件 | 0；另用 `pnpm exec oxlint --format=json` 核对 2 文件、90 规则、0 diagnostics | `stdio-lint-final.log`、`stdio-lint-scope.json` |
| 官方 JSDoc 规则 | `node --import tsx` 调用当前 `cloud-static.mjs` 的 `jsdocCollector`，两份新增文件 | 0；errors=[] | `stdio-jsdoc-final.log` |
| 空白与证据 | 两份新增文件的空白、三份测试和十二份测量源码的 SHA-256 | 空白通过；证据与未达标计数已保存 | `stdio-whitespace.json`、`stdio-evidence.json` |

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee1-stdio-workflow.spec.ts products/power-evolve/application/tests/employee1-stdio-management.spec.ts --coverage --coverage.include=products/power-evolve/application/src/platform/stdio-v2-connections.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-admission.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-actions.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-authorization.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-worker-store.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-results.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-call-admission.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-operation-admission.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-continuations.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-call-authority.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-leases.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-no-start.ts --coverage.reportsDirectory=.artifacts/employee1/stdio-coverage-final
```

| PG 模块 | lines | statements | functions | branches |
| --- | --- | --- | --- | --- |
| `stdio-v2-actions.ts` | 94.11% | 94% | 100% | 88.88% |
| `stdio-v2-admission.ts` | 96.49% | 89.04% | 100% | 75.75% |
| `stdio-v2-authorization.ts` | 93.52% | 85.22% | 93.33% | 84.84% |
| `stdio-v2-call-admission.ts` | 95.89% | 80.85% | 93.75% | 79.06% |
| `stdio-v2-call-authority.ts` | 88.88% | 81.81% | 100% | 90% |
| `stdio-v2-connections.ts` | 95.19% | 91.86% | 100% | 85.52% |
| `stdio-v2-continuations.ts` | 79.69% | 74.68% | 88.88% | 62.45% |
| `stdio-v2-leases.ts` | 95.23% | 92% | 100% | 82.6% |
| `stdio-v2-no-start.ts` | 100% | 100% | 100% | 100% |
| `stdio-v2-operation-admission.ts` | 83.72% | 73.58% | 87.5% | 78% |
| `stdio-v2-results.ts` | 90.19% | 86.6% | 100% | 89.77% |
| `stdio-v2-worker-store.ts` | 76.13% | 70.68% | 92.5% | 74.88% |

十二文件汇总 lines 87.72%（936/1067）、statements 81.8%（1043/1275）、functions 95.5%（191/200）、branches 78.54%（1190/1515）。只 `stdio-v2-no-start.ts` 四项达到 100%，不能外推到 product 或完整 STDIO 验收。剩余包括异常 durable-record 检查、预算／冲突／capture 失败分支、部分 continuation 与 creation_stopped 资源路径；physical Cloud runtime／worker／capture／SDK 不在本次 PG 测量范围，仍需真实 enabled 系统验收。本次源码未发现需要修复的生产失败，没有为提高数字改协议、断言、阈值、exclude 或跳过用例。

保留的失败记录：`stdio-workflow-first.log` 的 continuation source／state 预期错误与未及时接住 stale-lease Promise；已按当前 `stdio_v2_result`／queued 协议和立即处理所有并发拒绝修正测试。`stdio-source-typecheck-first.log` 的两个跨命名空间 branded ID 使用错误，改用所属协议解析器后通过。`stdio-jsdoc.log` 的 plain Node strip-only 无法加载官方检查器的 TypeScript parameter property，改用原本入口使用的 tsx loader 后通过。`stdio-coverage-first.log` 的 27 例通过但覆盖率门禁失败，最终 31 例的独立目录没有覆盖旧失败证据。这些都是检查／测试适配问题，不是生产模块修复或当前整体通过。

上一轮 PG 切片记录的缺口（已由上方原生迁移关闭，以下保留历史测量）：当时目标工作树的 `connector-runner` 有 11 份 runtime 源文件，但没有 `tests/` 源行为测试，`inventory()` 的 runnerSourceTests／runnerNodeTests 都是空数组，实测保存在 `.artifacts/employee1/stdio-sdk-discovery.json`。同一个当前 inventory 对只读来源仓能发现 10 份 runner 源测试并全部分类为 Node（`stdio-sdk-inventory-comparison.json`），所以这是未迁入文件的缺口，不能只调整 glob 来关闭。来源仓的 `connector-runner/tests/` 含 `stdio-v2.test.ts`、`stdio-v2-dispatch.test.ts`、`stdio-v2-runtime.test.ts`、`stdio-v2-digest.test.ts` 及 `stdio-v2-fixture.mjs`，另有 stdio、server、SSH、protocol 测试；其中四份 STDIO v2 文件共 44 条静态 test 声明，不是当前执行通过数。`stdio-v2.test.ts` 使用 `node:test`、真实 runStdioV2 SDK 与自有 synthetic Node peer。当前共享入口已按 `node:test` 分类，Vitest 排除 nativeNode 文件，由 `cloud-check.mjs` source lane 的原生 Node runner 加载 `cloud-coverage.mjs` 的 collector／tsx，并统一转换 TS source maps；不能继续把旧“转换尚未接入”记录当成现状。需要迁入并适配当前 cloud-only 协议后，核对 sourceTests／nodeTests、实际 TAP、原生 fixture 发现、V8 转换和四项逐文件 100% 合并结果。员工1没有修改员工3文件或把来源仓历史测试当作当前通过证据。

## SSH 后续切片结果

`SshExecuteService.cancel` 已在源码改为 `cancel(user: Identity, actionId: string, credential: { token: string; audience: 'agent' | 'approval' })`，账号更新锁内复核当前浏览器凭据，终态重试同样复核。主集成者已经同步共享 `application/src/platform/index.ts` 两处调用，员工1核读源码：独立 `/approvals/ssh-execute/cancel` 传 `{ token, audience: 'approval' }`；Agent `/ssh/execute/cancel` 传 `{ token, audience: 'agent' }`。Agent 路由的实际拼写是 `/ssh/execute/cancel`。`token` 必须是该请求的原始 browser bearer，audience 由可信路由固定。员工1没有修改共享接线，也没有修改或重建正在运行的 `lib`。

2026-10-09 主集成者反馈：正式构建前后 208 份生产文件哈希一致，应用 tsdown 输出完成，新具名 Profile 已 ready，四个实际 TypeScript 程序及 CSP／Scheduler built 检查通过；当前 SSH 源码和两处取消入口已集成。以上为主集成者的验证结果，员工1没有独立复跑或操作试用实例。生产冻结已解除，本轮未新增生产变更；后续生产修复需单独通知主集成者。真实 SSH 仍 disabled，待 enabled 链路验收，不能用构建或 Profile ready 代替实际执行证据。下方 19 例中间回归、22 个最终 SSH 用例及合并 32 例的记录均已完成；逐文件 100% 覆盖率门禁仍失败。

SSH 修复前真实 PG 负控制已记录 `ssh-negative-control-valid-barrier.log`：10 例，6 通过、4 失败，包括 pending／approved 两种账号锁等待撤权、错误 audience 及租约锁等待过期。续期只改 `clock_timestamp()` 的首轮回归仍失败，记录在 `ssh-regressions.log`：UPDATE 条件可能在等行锁前求值，不能据此证明取得锁后的租约仍有效。随后 `ssh-store-negative-control.log` 用真实未改写行的持锁验证 preparation、Runner observation、defer-running、未派发 settlement 四种提交均错误接受过期租约；该定向负控制的 `-t` 过滤使其余 10 例未运行，日志的 5 通过、4 失败、10 skipped 不计为验收。原 `ssh-negative-control.log` 漏算间接锁等待的失败保留但不作为产品缺陷证据；修正后的并发观察遍历实际 PG blocker 图。

员工1修改 `application/src/platform/ssh-execute.ts`、`application/src/platform/ssh-calls.ts`，新增 `application/tests/employee1-ssh-cancel.spec.ts`。取消在同一事务内先查当前 browser bearer，再按账号→call→action 顺序执行原状态处理。`SshCallStore` 的 renew、通用状态转换、recordStatus、deferRunning、settleWithoutDispatch 先取得调用行锁，再用新语句中的 PG `clock_timestamp()` 检查租约与 owner／epoch；旧租约不得因为等锁而续命或提交状态。原 committed dispatch digest、dispatch owner／epoch、Pod UID、Runner instance 和恢复观察语义保持。pending／accepted 取消仍只产生一次续接；已提交派发的取消保留 uncertain，不凭取消回执伪造续接。

22 个 SSH 用例涵盖：两种状态持账号锁撤权；Agent／approval 分离、错误 audience、伪造 owner、跨用户和 logout 终态重试；pending 并发幂等与一次续接；accepted 取消与 call 身份保持；取消和审批并发；committed dispatch 的 uncertain；call／Runner／digest 匹配；五种行锁等待到期；真实管理服务禁用、删除、配置修订、凭据替换后的首次派发拒绝；并发 claim／first permit、旧 epoch 拒绝和新 epoch 只观察；有效租约续期、延后领取、精确 Pod cleanup；未派发正常 settlement；连接锁等待期间过期后的派发拒绝。每例独立临时 PG 库，使用真实 IdentityService、TaskStore、SSH connection/action/call services 和加密代码。Runner observations、Pod UID 和 instance ID 是明确的合成测试输入；真实 SshRunnerOrchestrator 的 Kubernetes adapter 一旦被调用便抛错，结束断言 networkRequests=0，worker 未启动。因此这些用例不证明 SSH 网络执行、Pod 生命周期或最终 Host 续接。

| SSH 检查 | 命令／范围 | 退出码与实际结果 | 独立日志 |
| --- | --- | --- | --- |
| 修复前负控制 | cloud-only Vitest，SSH 文件未过滤 | 1；10 例，6 通过、4 失败、0 skipped | `ssh-negative-control-valid-barrier.log` |
| 行锁后复核回归 | cloud-only Vitest，SSH 文件未过滤 | 0；19 例全部通过，0 skipped | `ssh-regressions-lock-checked.log` |
| 最终合并回归和覆盖率 | 下方完整命令 | 1；3 文件、32 例全部通过（SSH 22＋MCP 6＋STDIO 4），0 failed／skipped；逐文件 100% 门禁失败 | `ssh-coverage-final.log`、`ssh-coverage/coverage-summary.json` |
| 当前源码测试类型 | `pnpm exec tsc -p .artifacts/employee1/ssh-source-typecheck-with-references.json --pretty false` | 0；严格选项保留，SSH 测试及其应用源码使用当前 source；外部项目沿用应用原 references；noEmit | `ssh-source-typecheck-final.log` |
| 集成后应用类型 | `pnpm exec tsc -p products/power-evolve/application/tsconfig.json --noEmit --composite false --incremental false --pretty false` | 0；包含主集成者两处接线；noEmit | `ssh-application-typecheck.log` |
| 官方 lint 入口 | `pnpm exec tsx scripts/run-oxlint.ts`，上述三份代码／测试 | 0；另用 `pnpm exec oxlint --format=json` 核对 3 文件、90 规则、0 diagnostics | `ssh-lint-final.log`、`ssh-lint-scope.json` |
| 产物保护和空白 | 三份源码／测试与四份既有 SSH JS／声明文件 | 空白检查通过；四份生成文件前后 SHA-256 一致 | `ssh-whitespace.json`、`ssh-lib-before.json`、`ssh-lib-preservation.json` |

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee1-ssh-cancel.spec.ts products/power-evolve/application/tests/employee1-mcp-approval.spec.ts products/power-evolve/application/tests/employee1-stdio-management.spec.ts --coverage --coverage.include=products/power-evolve/application/src/platform/ssh-execute.ts --coverage.include=products/power-evolve/application/src/platform/ssh-calls.ts --coverage.reportsDirectory=.artifacts/employee1/ssh-coverage
```

| SSH 源码 | lines | statements | functions | branches |
| --- | --- | --- | --- | --- |
| `ssh-calls.ts` | 63.44% | 61.53% | 75.86% | 58.09% |
| `ssh-execute.ts` | 38.31% | 34.38% | 42.1% | 23.4% |

两文件汇总 lines 44.91%（159/354）、statements 41.7%（181/434）、functions 56.71%（38/67）、branches 32.81%（127/387）。未测部分包括完整 SSH admission 分支、执行 worker／Runner／物理 cleanup、结果加密与最终 Session 续接。四项逐文件 100% 阈值和配置保持原样，当前门禁失败，不能认定 F15 或 M4 通过。`ssh-evidence.json` 保存基线、三份代码／测试 SHA-256、质量门禁计数与产物保护结果。

初始扁平源码 tsc 没有外部项目 references，错误地把 vendor 各自的源码放入应用严格选项下，退出 2（`ssh-source-typecheck.log`）；修正验证配置为应用原 references 后通过，没有关闭严格选项或重建声明。旧 `lib` 保持运行版本，因此没有用会读取旧应用声明的 `tsconfig.power-evolve.test-host.json` 冒充本次新签名验证。此次没有执行正式产物或实际 HTTP／Host 用户路径测试。`SshCheckService.cancel`／`SshCallStore.cancel` 的现有 Identity-only 入口尚未在本次切片复现或修复，不能将 SSH execute 的修复外推到 authentication-check 取消。

## 先前 MCP／STDIO 切片

2026-10-09；目标分支 `power-evolve/migrate-dsh-0.2.1-alpha.1`，官方基线 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。本切片修改仅限 MCP 服务、路由及员工1测试；没有修改共享装配、DDL、锁文件、Profile、来源工作树或私有部署配置。尚未完成 F14—F17 整体验收。

## 必需的共享接线

`McpActionStore.cancel` 现在要求第三参数 `{ token: string; audience: 'agent' | 'approval' }`。审批路由已在 `application/src/platform/mcp-routes.ts` 传入审批凭据；Agent 取消是原有允许能力，必须保留。

主集成者已将 `application/src/platform/index.ts` 的 `/mcp/actions/cancel` 分支改为 `remoteMcpActions.cancel(user, value.actionId, { token, audience: 'agent' })`，员工1已核读该调用并通过集成后的应用类型检查。此处 `token` 是该请求的原始浏览器 bearer，不能换成 worker 或 operation grant，audience 由可信路由固定，不能由请求 JSON 决定。员工1没有修改该共享文件。

STDIO 的 `/stdio-v2/config` 在本轮开始时已经存在，不能继续列为旧版缺失路由。它校验 Agent 浏览器凭据和严格空请求，只有服务、配置和 worker 就绪时返回公开 limits、management、maxReplyBytes；其他状态返回 `{ formatVersion: 2, available: false }`。本轮没有以替身或当前 disabled 状态认定真实 enabled 完整链路通过。

STDIO 实际 enabled 装配需要 `stdioV2ConfigFile` 指向 `stdio-v2-platform-config.ts` 的严格配置：approvalKeyFile、limits、management、admission、cloudDeployment、maxReplyBytes、maxPendingPerUser、maxCallsPerChain、chainLifetimeMs、approvalLifetimeMs、worker 和 transport。Sandbox 同时需要有效 kubeconfig、PVC、与 cloudDeployment.imageReference 完全一致的 sandboxImage，不能使用 sandboxNodeRoot；maxRequestBytes 至少覆盖 limits.maxInputBytes。worker.renewMs 必须小于 worker.leaseMs。密钥、部署 pin、路径和预算保持 Platform 私有，公开 metadata 不含 approvalKey、部署身份或捕获路径。主集成者负责实际配置与 Host／Platform 装配，本轮未写私有配置、未启动 Kubernetes 或 Docker 实例。

## 已复现与修复

MCP 取消与撤销权限原先只使用入口取得的 Identity，未在变更事务内复核浏览器凭据。真实 PG 持锁负例证明凭据版本变化后取消仍提交；入口校验不能覆盖锁等待。修复在账号锁下重查相应浏览器 audience、有效凭据与 owner，再访问 action／chain／permission；decide 共用同一检查。取消仍允许合法 Agent 或独立审批入口，Agent 不能因此取得审批或撤销权限。原取消／uncertain／一次续接语义保持。

## 实际检查

独立证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-cloud-migration/.artifacts/employee1/`。`evidence.json` 保存四个修改的代码／测试文件的 SHA-256、基线及最终测试／覆盖率计数。真实 PostgreSQL 使用已有开发服务；每例由 `tests/cloud-fixture.ts` 创建独立 `pe_cloud_case_<UUID>` 数据库和临时存储，结束后释放连接并删除其自有资源。没有操作旧试用库、其他应用或 Kubernetes／Docker 实例。

| 检查 | 命令／范围 | 退出码与实际结果 | 日志 |
| --- | --- | --- | --- |
| 修复前负控制 | `PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee1-mcp-approval.spec.ts` | 1；1 文件，4 例，1 通过、3 失败、0 skipped；包括真正持锁撤权失败 | `mcp-negative-control.log` |
| 首轮修复回归 | 同上，增加 `products/power-evolve/application/tests/employee1-stdio-management.spec.ts` | 0；2 文件，8 例全部通过，0 skipped | `connector-regressions.log` |
| 最终回归与覆盖率 | 下方完整命令 | 1；2 文件，10 例全部通过，0 failed／skipped；6 个源码文件逐文件 100% 检查失败 | `coverage-final.log`、`coverage-final/coverage-summary.json` |
| 集成后测试类型 | `pnpm exec tsc -p tsconfig.power-evolve.test-host.json --pretty false` | 0；不生成产物 | `test-host-typecheck-integrated.log` |
| 集成后应用类型 | `pnpm exec tsc -p products/power-evolve/application/tsconfig.json --noEmit --composite false --incremental false --pretty false` | 0；不生成产物 | `application-typecheck-integrated.log` |
| 官方 lint 入口 | `pnpm exec tsx scripts/run-oxlint.ts products/power-evolve/application/src/platform/mcp-actions.ts products/power-evolve/application/src/platform/mcp-routes.ts products/power-evolve/application/tests/employee1-mcp-approval.spec.ts products/power-evolve/application/tests/employee1-stdio-management.spec.ts` | 0；另用 `pnpm exec oxlint --format=json` 对同四文件核对，发现 4 文件、90 规则、0 diagnostics | `lint-final.log`、`lint-scope.json` |

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url pnpm exec vitest run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/employee1-mcp-approval.spec.ts products/power-evolve/application/tests/employee1-stdio-management.spec.ts --coverage --coverage.include=products/power-evolve/application/src/platform/mcp-actions.ts --coverage.include=products/power-evolve/application/src/platform/mcp-routes.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-connections.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-admission.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-actions.ts --coverage.include=products/power-evolve/application/src/platform/stdio-v2-worker-store.ts --coverage.reportsDirectory=.artifacts/employee1/coverage-final
```

| 当前测量文件 | lines | statements | functions | branches |
| --- | --- | --- | --- | --- |
| `mcp-actions.ts` | 80.25% | 69.15% | 85.29% | 55.61% |
| `mcp-routes.ts` | 21.42% | 19.35% | 50% | 14.81% |
| `stdio-v2-connections.ts` | 87.5% | 84.55% | 96.55% | 75% |
| `stdio-v2-admission.ts` | 96.49% | 89.04% | 100% | 75.75% |
| `stdio-v2-actions.ts` | 72.94% | 73% | 71.42% | 62.39% |
| `stdio-v2-worker-store.ts` | 46.91% | 43.44% | 50% | 29.1% |

六文件汇总 lines 67.35%（454/674）、statements 62.71%（513/818）、functions 76.42%（107/140）、branches 44.57%（382/857）。测量只涵盖上述具名模块，不能外推为产品覆盖率。未覆盖包括远程管理路由、完整发现／派发／结果失败分支、STDIO catalog 启用和原写者／真实资源路径；没有修改配置、阈值、skip 或关闭规则。

十例对应：MCP 未派发幂等取消与一次续接；审批 audience／owner／logout 拒绝；权限撤销与幂等；已提交 dispatch 后 uncertain、拒绝重新领取及迟到结果；Agent 有限取消但无审批权；真实账号锁等待期间撤权；STDIO literal argv／历史修订／回执／跨用户拒绝；发现原请求原 execution 与 no-start 闭合；外来 Session／执行占用／未配置部署拒绝；账号锁等待期间撤权拒绝新连接。PG rows 是独立核对依据，未以模型完成文字作为成功判断。

保留的失败记录：初始 MCP fixture 没有把循环外键插入放进同一事务，4 例均因 `pe_mcp_remote_configuration` 失败（`mcp-before.log`）；修正 fixture 事务后才取得有效负控制。初始测试类型检查发现不同命名空间的 branded IDs 混用，已改用所属协议解析器；新增 Agent 取消类型检查又遇到未刷新声明文件，主集成者完成共享接线并刷新声明后通过。初始应用类型检查在未接线的 Agent cancel 报 TS2554，集成后通过。失败日志未删除，不能计为通过。

## 剩余范围

先前 PG 测试中的 MCP catalog 是确定性测试输入，不能证明远端发现、SDK 调用或 enabled 服务配置；STDIO 仅验证管理、发现受理与 unallocated no-start，不证明 Pod／Runner、物理双用户挂载、审批后实际程序运行或 call 结果续接。SSH 的新增 PG 用例和局限见本文开头。实际 Host＋Platform＋PG enabled、三种连接器真实执行与取消、凭据分支、SDK／生产闭包、双用户隔离、重启与用户路径快照均待同版本集成验收。

先前切片静态发现的 `SshExecuteService.cancel` 缺少事务内浏览器凭据复核，已经在后续 SSH 切片用真实 PG 持锁复现并修复，两处共享调用也已由主集成者同步；详细接口、证据和未覆盖范围见本文开头。

逐文件 100% 的四项覆盖率阈值保持原样；当前覆盖率检查失败，切片测试通过不代表完整文件覆盖率或 M4 通过。拥有者 README、中英配对、实际用户路径快照与正式产物检查由主集成者结合接线更新；员工1没有越界修改这些文件。现有 `verify-export-jsdoc` 与 `verify-md-wrap` 的默认枚举范围不含这些产品文件，因此本轮没有拿根检查的通过替代产品专项检查。
