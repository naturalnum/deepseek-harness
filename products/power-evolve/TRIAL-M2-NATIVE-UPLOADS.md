# 原生云端附件切片验收

2026-10-09，Asia/Shanghai。本记录只证明下列附件切片；M0—M5 整体尚未交付。用户已确认实施并授权常规技术决策。来源工作树保持原位，目标仍为官方 `dsh-v0.2.1-alpha.1`／`5badb15009ae1756c3afe0ae0cef1faafc290ccc` 上的未提交迁移分支。

## 实现与数据

普通文件经原生客户端的 `session/uploadFileBinary` 流式送至 Host，再由 Platform 核验用户、接收 Session、数量和字节预算。维护中的官方附件后端原样保存只读对象并核验 SHA-256。原文件位于私有附件根，不进入可写工作区、Home 或 Skill 挂载；Platform 在打开数据库前拒绝词法及实际祖先路径重叠。

受理在账号与 Session 锁内绑定按原顺序提交的回执；同一 requestId 重试核对文本、目标及有序回执。原生事件、模型可见目录和工具调用／结果均持久记录。`cloud_file_read` 在当前租约下读原始 UTF-8 行；`cloud_file_copy` 在同一授权事务中幂等创建工作区副本。分支只继承准确事件前缀中的文件引用，保存原 storage Session，不重新上传或扩大授权。

目标数据库由完整 Schema 1 相邻升级至 Schema 2：增加 `pe_native_file_receipts` 与 `pe_native_prompt_inputs`，共 71 张表。原 Schema 1 文件和 manifest 不改写。首次升级前保留了独立私有 PG checkpoint；这一 checkpoint 不能代替 M5 的文件及私有配置全量备份恢复。

## 本轮实际检查

| 检查 | 实际结果及证据文件名 |
| --- | --- |
| Host、Client 及两侧 Test 类型程序 | 附件完整实现时四个 `tsc -b` 程序通过，`native-upload-complete-typecheck.log`；随后根目录检查版本通过 `native-upload-root-typecheck.log` |
| PostgreSQL 附件／会话命令／数据库 | 3 个测试文件，19 个用例通过，`native-upload-complete-pg.log` |
| 目录重叠、摘要、复制、跨用户、前缀分支 | 1 个附件文件，7 个用例通过，`native-upload-root-pg.log` |
| 有序文本与持久 text 一致性补充 | 7 个附件用例通过，`parallel-native-input-pg.log`；包括不一致拒绝且回执保持未绑定 |
| 审查后的物理配额、数据库断连和复制租约 | 2 文件，15 例通过、0 skip，`native-upload-lifetime-pg-final.log`；真实 PG INSERT 失败仍计孤儿容量，真实 mount slot 锁等待跨租约后不创建副本，PG 后端退出时不等待下一块输入 |
| 当前云端 Skills 分发及私有安装 | 1 文件，5 例通过、0 skip，`builtin-cloud-skills-validation-fixed.log`；九个 ZIP 经原生提取和元数据验证，真实 PG 私有安装、服务重建、幂等及双用户隔离通过 |
| 正式应用构建 | tsdown 130 个输出文件，`native-upload-root-application-built.log` |
| 官方附件 helper 构建 | 明确 attachment-only 配置成功，3 个公开 helper 导入验证，`native-upload-attachment-built-explicit.log`／`native-upload-attachment-built-exports.log` |
| 正式 Scheduler／AgentLoop | 2 个 built 用例通过，无跳过，`native-upload-scheduler-built-test-fixed.log` |
| README 中英配对 | 2 对重新登记并校验通过，`native-upload-readme-pairing.log`／`native-upload-readme-check.log` |

完整私有证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence`；其中配置、PG 内容和浏览器读回不提交 Git。失败构建与失败测试日志保留，后续修复的通过记录使用新文件名，没有覆盖失败记录。

## 真实 Profile、浏览器与模型

具名 `power-evolve-cloud-host` 和 `power-evolve-cloud-platform` 经正式 DSH CLI／Loader 启动，使用本轮自建 PostgreSQL 16.14。两个隔离浏览器上下文分别登录 `migration-alice` 与 `migration-bob`，模型为真实 `deepseek-v4-flash`。文件经原生隐藏 file input 的 File／change 事件提交，真实客户端 worker、网络、Platform 和存储路径均运行；浏览器工具拒绝读取证据目录的 chooser 文件路径，因此本记录**不宣称操作系统文件选择器已验收**。

1. Alice 接收 Session `59f6cee5-13f3-40f8-bd42-01a7bc7280c0` 上传 `native-upload-sentinel.txt`，119 字节，SHA-256 `9d3c4e97033582d276f3b751393bcaa2a091f51308a6dea7c2e8c2e6dca1c3b2`。客户端上传返回成功，PG 回执随后被受理绑定。首个实际受理为附件单独输入，不把自动化中未进入模型的文本计为通过。
2. 模型实际调用 `cloud_file_read` 并返回文件中的唯一标记 `PE_UPLOAD_20261009_A39C`。随后调用 `cloud_file_copy` 创建 `附件验收/原始副本.txt`；原生 `workspaceFiles/read` 独立读回三行、119 字节及相同摘要。
3. 原生分支创建 Session `470ef401-51cf-4339-b136-ea1dae3d7c13`，回执的 storage Session 仍为父会话。模型在分支中再次实际调用 reader，读回原始第二行。
4. Bob 经独立登录与 Cookie 上下文读取 Alice 的副本、向 Alice 的 Session 上传，均得到业务 `session/not-found`，没有获得文件或回执。
5. 精确识别 owned launcher 后，向 Host／Platform launcher 转发 SIGINT，两个启动器都以 0 退出；同一构建再次启动，Schema 保持 2。Alice 的 Cookie、历史、分支回执仍可读，并且模型在重启后实际调用 reader 返回同一第二行。
6. 新 Platform 使用用户提供、仅存于私有文件的模型 Key。Alice 的上述重启后调用及 Bob 的独立文件读取均通过该配置完成。Bob 上传 `bob-upload-sentinel.txt`，60 字节，模型实际读回 `PE_BOB_UPLOAD_20261009_D82B`。不记录或复制 Key 的值。

重启后 Platform 实例为 `d4ce7829-b61a-4f36-bb0c-ee50a40def15`，Host 为 `b31cd70b-cdd9-4a5f-8fcb-2b76c0e833e1`。证据为 `native-upload-restart-pg-evidence.json`、`native-upload-alice-restart.txt`、`native-upload-bob-owned-upload.txt`、`native-upload-bob-foreign-refusal.txt` 和 ready／health 读回。应用 lib 中的 JS 文件清单及摘要另存 `native-upload-built-manifest.json`；清单包含类型程序的 JS 发射，不能把总数当作 tsdown 输出数。

## 集成边界与剩余工作

本记录上述历史运行版本包含目录隔离、上传、文件读取／复制及分支继承。随后新增的有序文本一致性、物理配额、数据库断连、复制租约、云端 Skills 后继目录、员工1的连接器凭据修复及员工2的客户端修复，已进入[并行集成版本](TRIAL-M2-PARALLEL-INTEGRATION.md)并完成新的正式构建与附件用户路径验收。此前源码检查点 `post-review-source-slice-checkpoint.json` 原样保留；新的 `post-review-source-slice-checkpoint-integrated.json` 记录当前构建证据，fullCoveragePassed 仍为 false。历史测试不能替代新版本尚缺的系统验证。

并行集成时完整类型检查曾失败：共享 MCP cancel 第三参数和新客户端测试类型未完成。当前集成版已经补齐共享调用并刷新完整引用图，Host、Client、Test Host、Test Client 四个实际程序均通过；证据和适用输入见新集成记录。原失败日志保留，不把随后并行新增的测试自动算作该固定版本通过。

图片受理、原生 steering／queue 修改、原生下载与适用预览的完整用户路径尚待完成。普通对话和读取原文件未启用执行 Sandbox；Office、MCP、SSH、STDIO 在本轮试用中仍为 disabled，不能计为 enabled 验收。完整覆盖率与新增工程门槛尚未达标；同版本 2＋2、独立全量备份恢复和正式镜像交付继续按迁移方案推进。
