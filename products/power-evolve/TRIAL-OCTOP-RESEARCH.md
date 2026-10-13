# Octop 与当前 DSH 迁移的适配调研

2026-10-09，Asia/Shanghai。核查 [TencentCloud/Octop](https://github.com/TencentCloud/Octop) 的固定提交 `0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda`。主线程阅读官方文档，员工1独立浅克隆并核对源码、调用路径和测试定义。此批为静态调研，未安装、运行或测试 Octop，未验证外部 Harness 内部实现。

## 决策

维持 [已确认 DSH 迁移方案](CLOUD-MIGRATION-PLAN.md)及18项能力范围。Octop 可参考其派工规则、任务归属和 ACP 接入边界；当前不加入候选镜像、依赖或产品界面。其 Python／LangGraph 运行契约与本次 DSH 事件、授权和多副本协议不同，直接整合会增加运行时及数据适配工作。这个工期判断是基于下列差异的推断，没有性能或节省工时实测。

## 已核实的能力与边界

| 方面 | 官方实现或说明 | 对本次迁移的意义 |
|---|---|---|
| 产品与技术栈 | Python 3.12、FastAPI 和 React；提供多用户、专家、团队、IM、连接器和 ACP。[项目说明](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/README.md) | 自托管助手的完整产品，可作交互参考；无法直接替换 DSH 模块 |
| 调度与恢复 | 架构决策采用单进程、进程内协调；团队在途记账也是进程内，文档明确排除 inbox 的进程外持久化，重启丢失在途任务。[架构决策](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/docs/adr/001-single-process-model.md)、[团队契约](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/docs/expert-teams.md) | 不能作为当前跨进程 claim、租约 fencing 或2＋2恢复已完成的证据 |
| 历史与 PostgreSQL | checkpoint 有 PG 适配；启用或保留 `history_v2` 归档时，当前启动代码拒绝 PG 控制面。[启动代码](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/src/octop/infra/server.py#L430)、[checkpoint 测试](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/tests/integration/test_postgresql_checkpoint_history.py) | 必须区分可读 checkpoint、完整历史归档和在途任务恢复；PG 选项不自动提供三者 |
| 专家协作 | 主持人限制工具权限，成员保留独立会话和工作区，派工使用稳定 job_id 记账。[团队源码](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/src/octop/infra/agents/teams/service.py)、[任务跟踪](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/src/octop/infra/agents/teams/jobs.py) | 适合参考员工分工与成果归属；Git 修改所有权、集成与检查仍由本任务负责 |
| ACP | 支持 IDE 驱动 Octop，以及委派外部编码 CLI；当前使用 stdio JSON-RPC，依赖外部 CLI 配置与认证。[ACP 文档](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/docs/acp.md) | 可供将来的独立接入评估；本轮未获得免适配的 DSH 接口或多副本协调实现 |
| 工程质量 | PR CI 在 Linux／Windows 执行 Python lint、类型和测试；live 缺凭据会跳过，PG 测试缺专用配置会跳过，mypy 亦有例外。[CI](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/.github/workflows/ci.yml)、[PG 条件](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/tests/support/postgresql.py)、[类型配置](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/pyproject.toml) | 有质量检查流程；不能据此认证此提交测试通过、前端完整检查或真实 HA |
| 许可 | MIT，复制或使用实质代码需保留版权和许可声明。[LICENSE](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/LICENSE) | 可评估具体代码复用；外部依赖需分别核对许可 |

## 源码核查的限制

当前可见 stream／resume 路径按 `(agent_id, thread_id)` 使用进程内锁。异步团队派工进入外部 Harness 的 `submit_peer`；Octop 对派工及回复合成私有方法有运行时改写。[Agent manager](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/src/octop/infra/agents/manager.py)、[team manager](https://github.com/TencentCloud/Octop/blob/0c5a46ab5f82e5ad9d1a56fa09b00e542f042fda/src/octop/infra/agents/teams/team_manager.py)。旧 mailbox 文档的全局串行描述与新团队文档的按成员并行描述存在差异；外部 worker 实现未在本批核查，故不推断实际完整并行范围或故障恢复。

当前借鉴限于开发组织：主持人承担调度和验收、员工保持清晰文件所有权、稳定任务身份用于避免重复记账。产品界面继续使用原生 DSH 及方案限定的扩展位置；Octop 独有功能不因本次调研扩大迁移范围。原生队列、完整旧数据转换和同版本多副本验收仍按 [集成进度](TRIAL-CLOUD-MIGRATION-STATUS.md) 推进。

原始源码摘要、逐项路径与核查限制保存在私有 `employee1-octop-fZM3nE/review-v2.json` 和 `closeout.json`；这里只记录公开来源与适配决策，不含凭据或生产数据。
