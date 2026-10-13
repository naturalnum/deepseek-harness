# M3 云端执行与正式组合验证

2026-10-09，目标基线为 `dsh-v0.2.1-alpha.1`，HEAD 为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，迁移分支为 `power-evolve/migrate-dsh-0.2.1-alpha.1`。本记录对应当前未提交迁入代码、正式产物及独立测试资源；不是完整 M3—M5 交付。

## 已验证的范围

通过正式具名 DSH Host、Platform、独立空 PG 数据库和新 Kubernetes 集群，两个真实 DeepSeek 模型任务各调用一次 `cloud_exec`，写入各自 Workspace 的中文文件。实际回执退出码为 0，UID/GID 为 1000，命令不能读取 Runner 控制凭据。两次执行各产生一个 `sandbox_result` 续接，原任务及续接都已完成；独立读取物理文件、正式 FileService 和 HTTP 文件接口得到相同字节，跨账号读取返回 404。

运行中的 TERM-resistant Python 命令经正式 `/executions/cancel` 取消。PG 先观测到 `running`，命令实际输出 `CANCEL_V3_UID=1000`，最后为 `cancelled`、`exitCode: null`、`timedOut: false`。取消后的可信续接完成，不能将其描述为正常退出或超时。节点同时观测到实际 `runsc` 进程；Sandbox 使用 `gvisor` RuntimeClass。空闲回收后 namespace 无 Pod，两位用户的 mount slot 均为 `free`，原 Pod UID 和停止证据仍持久保存。

## 版本与资源

| 项目 | 本轮固定事实 |
| --- | --- |
| 正式构建 | 实际 Host、Client、TestHost、TestClient 四个程序通过；application 为 132 个 JS 输出；Web 为 68 个 client module、267 个静态文件 |
| 构建输入 | 修复后监测的 238 项产品源码／构建／配置输入前后摘要一致；该库存不是完整上游依赖闭包，不据此声称全仓固定 |
| Runner v3 | 本机标签 `pe-dsh-migration-runner:20261009-v3`，image ID `sha256:282f4f19a0b32de4a3237753cc828b4552ff2e9e4b1cedc46901df2a8561fbc5`；已导入两个节点，尚未发布固定 registry digest |
| Kubernetes | 独立集群 `pe-dsh-migration-20261009-v1`，一个 server、一个 agent；固定 Sandbox controller 与 gVisor；原默认 kubeconfig 摘要未变 |
| 数据库 | 新库 `pe_migration_enabled_v1`，`cloud-native` Schema 2；没有把旧 Schema 37 数据直接写入 |
| 正式服务 | 本轮 Host `http://127.0.0.1:19980`，Platform `http://127.0.0.1:19981`；所测 instance 分别为 `c2e38a45-3a84-4f60-adb2-9de643ff1e7f`、`59155be7-accb-4ec3-b0c3-27d46238d304` |
| 可用性 | `executionEnabled: true`；MCP、SSH、STDIO 与 Office preview 在此部署仍未启用，不能按本轮结果追认为通过 |

当前数据位于独立 Linux Docker volume，对 Workspace、Home、Skill packages 提供可映射的节点存储；私有配置、附件和 Office cache 分别位于其他独立根。Profile 由 [部署工具](deploy/README.md)渲染和监督，没有另建公共业务 launcher。

## 本轮修复及检查

| 发现 | 实际修复与结果 |
| --- | --- |
| 命令退出时末尾 UTF-8 字节丢失 | child close 后刷新两个 StringDecoder，按完整码点维持每路 64 KiB 上限；员工4独立复核共 23 例通过、0 skip，保留修复前失败 |
| Native Session 历史中间缺行、JSON seq 错配被接受 | 在持有 Session SHARE 锁及 watermark 时读取精确有界 `seq,event` 区间，核对行数、主键连续性、原生事件格式和 JSON seq；原 15 个真实 PG 用例通过，员工5继续扩大边界复核 |
| 持久化解析错误被归为请求 400 | 只围住持久化解析，将其返回为 `500/native_history_invalid`；序列缺口仍为 `500/native_history_gap`，外部请求解析保持原入口行为 |
| 空库登录返回 503 | LoginAdmission 启动时为无账号窗口的数据库原子初始化 singleton；已有计数不重置，缺失 counter 且保留账号窗口则拒绝启动；8 个真实 PG 用例通过，实际 Alice/Bob 登录均为 200 |
| macOS bind 控制文件权限不可靠 | 初次 Linux fixture 确认 UID1000 可读 macOS bind 文件，未追认为隔离通过；改用原生 Linux volume 后再验证。实际 Kubernetes Secret mount 中的控制 token 不可读 |
| 启停事实 | 早一轮 root 使用 SIGINT，实际退出 130，保留该失败；本轮停止 Host/Platform 使用精确出生身份和 SIGTERM，两者实际退出 0 后才重建 |

正式产物专项中，当前 native Scheduler 的两个用例和两个 client factory 用例通过。Scheduler 的 Platform／模型适配器是内存夹具；它们不替代上面的真实云端任务。四个修改运行模块的官方映射 JSDoc 检查没有诊断，完整 lint／依赖／文档与覆盖率仍未通过，不据局部结果宣布工程质量通过。

镜像内真实 Runner HTTP 路径执行了工具链 QA，生成中文 PDF、CTeX PDF、Word／PPT／Excel 及其 LibreOffice PDF。独立检查文件字节并查看四张实际页面图，文字可读；Word native OMML 也有检查。该轮使用 v1 镜像及 Linux volume，只是工具链 fixture，不能代替 v3 上完整报告工作流或 Office preview 验收。

## 证据与复现

凭据、数据库 URL、原始模型事件和全部私有证据在仓库外 `power-evolve-migration-evidence/private/`，目录 0700、文件 0600。关键证据如下；这些文件含私有配置引用，不能作为公开发布材料。

| 证据 | 对应事实 |
| --- | --- |
| `enabled-bootstrap-build-input-before.json`／`after.json`、`enabled-bootstrap-application-bundle.log` | 修复后的输入监测与正式产物 |
| `native-history-integrity-repair.log`、`login-admission-bootstrap-repair.log` | 15 个历史读取、8 个登录初始化真实 PG 用例 |
| `enabled-cloud-v1/first-login-failure.json`、`login-evidence-v2.json` | 实际空库 503 及修复后 200 |
| `enabled-cloud-v1/cloud-command-world-proof.json` | 两个执行回执、dispatch 身份、正式读取、物理摘要及原生事件 |
| `enabled-cloud-v1/cloud-command-http-files-proof.json` | HTTP 正常读取及双向跨账号拒绝 |
| `enabled-cloud-v1/cancel-live-v3-proof.json` | 运行态观测、runsc、正式取消、真实终态 |
| `enabled-cloud-v1/cloud-lifecycle-after-cancel-v3.json`、`pods-after-cancel-v3.json` | 续接完成、空闲回收、精确停止证据和 mount slot 释放 |

一次早期取消探针因本节点 `k3s crictl` 不可用而未及时发出取消，命令自然成功；其后对终态请求取消只得到原成功回执，不能计为取消通过。`cancel-response-v2.json` 保留此结果，真正运行态取消依据后续独立 `cancel-live-v3-proof.json`。

构建使用 `pnpm exec tsc -b tsconfig.power-evolve.host.json tsconfig.power-evolve.client.json`、产品 application／runner／client bundle、Web build 和 Docker build。具名 Profile 通过 `node products/power-evolve/deploy/start.mjs platform|host <private-deployment.json>` 启动。运行验收读取私有文件后调用真实 API，不把 token、密码或模型 Key 放入命令参数。

## 仍需完成

完整原生浏览器流程、Office preview、报告工作流、启用的 MCP／SSH／STDIO、2 Host＋2 Platform、多副本故障与恢复、旧数据隔离导入、完整备份恢复后的业务出口、固定发布材料及逐文件四项 100% 工程检查仍需继续。本记录不合并旧试用证据，也不覆盖产品排除功能。
