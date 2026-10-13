# Office 节点隔离与原生日志文本回归

2026-10-09，Asia/Shanghai。本记录对应官方 `dsh-v0.2.1-alpha.1`／`5badb15009ae1756c3afe0ae0cef1faafc290ccc` 上的当前迁移源码和本轮隔离探针，不能代替 [M5 完成标准](CLOUD-MIGRATION-PLAN.md#测试与完成标准)或已停止的旧 Profile 验收。

## 实际镜像与节点

Office 镜像来自本次拥有的私有 registry。根代理独立读取原始 manifest 并验证摘要与 image config；两个 k3d 节点各自通过 `imagePullPolicy: Always` 拉取固定 manifest。镜像引用为 `localhost:19884/power-evolve-office-preview@sha256:e6e5397289124d2d8e6ad4213b13ddc7e45a24b5fe335bf7b192b992e2c2fc27`，image config 为 `sha256:e1057bf54bafe3762295a6417c8a57c5e9aad9dff6f595fd03c0a2958eaf8f52`。这些是本机 ARM64 证据，不能认证 AMD64 镜像。

两个节点的实际容器均报告 Node 22.23.2、SDK 0.1.1、UID/GID 1000。21 个物理字体文件共 112,025,039 字节，逐文件摘要及固定顺序的字体策略摘要均一致；策略摘要为 `701978199fa16f0611ea0a8fbce36a1f15e627e63fac2c567d10dd868bab3c6e`。此探针只验证拉取、运行时和字体，没有调用应用转换入口。

缓存使用独立 owned 子树、PV 和 PVC；Pod 仅挂载本次任务的 input/output 子目录。原 Workspace、Home、Skills 和附件根未挂入解析器。Mac 进程新建的 mode 0400 文件在 Linux 卷中为 UID 0，UID 1000 无权读取；保留该负例，未通过公开权限绕过它。应用启用路径转入实际 Linux Platform，由匹配 UID 创建私有输入。

## 保留的失败与隔离修复

第一轮实际 Kubernetes 探针中，对照 Pod 成功访问测试 registry；受 `office-deny-all` 选择的短命 Pod 也在首次请求中取得 HTTP 200，隔离测试退出 1。输入可读、只读挂载写入返回 EROFS、输出可写已经通过，但 NetworkPolicy 对象存在不能证明启动时网络已经受限。原 Pod JSON、退出事实和错误日志均保留。

两个 owned 节点增加独立 `pe-office-offline` containerd handler，使用已安装的 runsc release-20260831.0、systrap 和 `network=none`。原 Cloud Runner 的 runsc 配置保持原值。每个节点分别执行新的首包探针：同节点对照 Pod 访问 registry 得到 HTTP 200；离线 Pod 只看到回环接口，首次访问同一地址立即返回 ENETUNREACH。两组对照与受限 Pod 均实际退出 0，受限 Pod 的 UID 1000、只读输入和可写输出同时通过。Pod 按已核实的终态与精确 UID 删除；两棵探针目录按字节和 UID 核对后清理。

[应用配置](application/src/platform/office-preview-config.ts)要求明确的 `runtimeClassName`。[Pod 意图](application/src/platform/office-preview-pod.ts)和转换器安全版本 2 固定该值，提交拒绝缺失或不同的运行时，观察拒绝实际 Pod 运行时不一致。旧安全版本 1 和缺少该字段的意图可用于读取保留事实；该兼容不授权重新启动旧解析器。NetworkPolicy 仍作为附加隔离，不能替代部署对离线 handler 的实际验证。

## PostgreSQL 文本与检查点

新增 [原生 JSON 文本测试](application/tests/native-json-text.spec.ts)在独立 PostgreSQL 数据库中复现两处缺陷：合法事件 JSON 含转义 NUL 时，列表 SQL 的 JSON 提取失败；标题或 inbox 含 NUL 时，直接写入 jsonb 检查点失败。最初一轮另有序列化顺序的测试断言失配，修正为 EventStore 的实际解析序列化后再取得两个真实数据库失败；各轮结果分别保存。

[原生读取](application/src/platform/native-session-read.ts)按至多 256 条已验证事件读取转次状态。[投影拥有者](application/src/platform/native-projections.ts)以私有检查点编码 2 将严格验证的原状态 JSON 文本存入 jsonb，保留 NUL、字面反斜杠转义和未配对代理项。旧编码 1 仍可读并在追加时升级；未来编码、坏 JSON 文本及内外水位不一致拒绝读写，事件历史保持原值。此编码版本与产品 PG Schema、DSH Session 格式是三个不同版本，业务 DDL 与 Session V4 未改变。

最终选中六个源码测试文件，共 44 例，44 通过、0 失败、0 跳过。其静态导入解析得到 534 个受监控仓库输入、0 缺失，运行前后摘要一致；24 个外部模块文件不在仓库输入摘要内。专项类型检查直接包含五个生产根和两个新增测试根，移除 Application 自引用并保留其上游／Contracts／Connector 引用，退出 0；同七个文件的完整官方映射 lint 退出 0。此结果没有测量本轮完整产品覆盖率，也没有构建或启动新 Profile。

[Office adapter 测试](application/tests/office-runtime.spec.ts)的四例使用明确的 Kubernetes API 测试响应，覆盖配置、提交与运行时失配拒绝；它们与上述实际节点探针分别记录。错误的测试 outputBytes 首次超过固定 8 MiB 上限，四例因此失败；修改测试输入后通过，生产上限没有放宽。

## 固定输入与证据

| 当前生产输入 | SHA-256 |
| --- | --- |
| `native-session-read.ts` | `96710e0db5515acce8a6e543e4019f21892b157296f259301e527fdeba5f135f` |
| `native-projections.ts` | `0000ad0c8473935efb233906714f39a6c8da050985ae67543376a7ba0705672a` |
| `office-preview-config.ts` | `aad9067dadf2b70153349b6960145d3f6e8117a5d6315a545c1480a484b30404` |
| `office-preview-pod.ts` | `0518e0ce18d7581014b3520402082782a2ac8bd357b834ffa39eaf3ede2bb7c2` |
| `office-previews.ts` | `a463780f9c6be250afa9587787a4f965947fea0e9c27592178130c2bba415a38` |
| `pnpm-lock.yaml` | `24d22b5bc00c16cb79ef5e60d8dc9aea10b995c4d5e826d455a2b1c07db2b269` |

私有证据根为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private`。`office-enabled-v1`保存 manifest、两节点拉取结果、首轮失败、离线 handler 配置、第二轮实际 Pod／日志和清理记录；`root-native-json-v1`保存原生产文件、各轮失败／通过、专项类型／lint、完整选定输入摘要与冻结清单。`root-peer-lock-v1`保存显式 lockfile-only 和 frozen install 的真实日志，二者退出 0，完整解析锁前后没有变化；没有把此前锁写入归于本轮命令。私有配置和凭据不进入本记录或 Git。

## 未完成验收

Office 应用 enabled 路径的四格式转换、缓存、取消、恢复和原生预览尚未用这批正式产物完成；Linux 冷镜像、当前完整恢复及独立审查仍在推进。原生搜索仍使用 PostgreSQL JSON 提取，含 NUL 的历史搜索兼容待修，不能据上述读取／投影回归解除全部导入限制。完整产品 lint、依赖未知分类、逐文件四项 100% 覆盖率及同版本用户流程尚未通过。上述缺口继续按原迁移目标处理。
