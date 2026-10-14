# Employee1 Host test typed lint handoff

历史私有归档引用：以下 `.artifacts/employee1` 路径和原记录名称保留为文本；当前 checkout 不提供这些收据，本轮当前验收未使用它们。原历史结果、失败与验证限度继续保留。

2026-10-09：按主线程授权，只修复五份旧 Host 测试/辅助文件的类型声明和排版。最终官方 cloud 映射 typed lint **exit 0**，实际完整 TestHost source program 的 tsc **exit 0**；未重跑原行为用例，也未新增案例或运行时行为。

员工3原报告含 239 条历史诊断：以下五文件占 209 条；另外 30 条属于上一轮 Contracts Office Platform 测试修复前的快照，已在 132 项协议消费者交接中关闭，本轮保持冻结。原诊断、原文件文本和 SHA 均保存，未改规则、覆盖阈值或 shared config。

| 授权文件 | 历史诊断 | 本轮修改 |
| --- | --- | --- |
| [MCP approval](application/tests/employee1-mcp-approval.spec.ts) | 41 | PG readonly 返回投影、原查询首行的类型非空声明、unknown 拒绝回调、排版。 |
| [SSH cancel](application/tests/employee1-ssh-cancel.spec.ts) | 78 | 相同类型面修复，保留全部锁等待、取消、dispatch 和 lease 断言。 |
| [STDIO management](application/tests/employee1-stdio-management.spec.ts) | 16 | 查询返回类型、拒绝回调和排版。 |
| [STDIO workflow fixture](application/tests/employee1-stdio-workflow-fixture.ts) | 7 | 排版，去除已由原条件收窄的冗余非空类型断言。 |
| [STDIO workflow](application/tests/employee1-stdio-workflow.spec.ts) | 67 | readonly 查询返回类型、原首行类型声明、unknown 拒绝回调、排版。 |

查询 SQL、绑定参数、返回值、预期值和控制逻辑全部保留；没有加入 as unknown、额外数据解析或新 fixture 方法。类型非空声明擦除后的 JavaScript 与原版相同，不会把缺失行变成成功结果。

审计对原文备份与最终源码分别进行 TypeScript ESNext JS 转换，去除类型和注释，保留 literal/operator/identifier AST，并归一化多余括号与源码位置。五文件的全部运行时 AST 一致，**40 处测试注册与 248 个 expect 调用**的 AST、顺序及参数一致；这里的 40 是注册位置数，参数化表及整个测试回调也在相同 AST 内，不是新执行用例数。

首版全文件 hash 错把 SourceFile.text 源字符串纳入语义树，因此排版产生假差异；首版结果留存。修正后的 v2 从原备份重新计算，确认原文件 SHA 未漂移，并明确替代首版；测试注册与 expect 审计两版都一致。

实际程序为 application/tests/tsconfig.json，继承共享 tsconfig.power-evolve.test-host.json；五文件均为真实程序根，完整 Application/Contracts/Connector source 与依赖引用继续按员工3配置读取，没有用产品 lib/types 代替 source。两个实际完整源类型检查均 exit 0，最终五文件 typed lint exit 0，正式映射配置未变化。原 Contracts 四测试与旧 Office 九份冻结文件 SHA 均未漂移，生产、Manifest、锁文件、容器与 v5 context 均未修改。

证据：原诊断与原输入登记（`../../.artifacts/employee1/host-typed-lint/baseline.json`）、运行时与断言一致性 v2（`../../.artifacts/employee1/host-typed-lint/runtime-assertion-audit-v2.json`）、正式 typed lint（`../../.artifacts/employee1/host-typed-lint/final-lint.log`）、完整源类型检查（`../../.artifacts/employee1/host-typed-lint/types-final.log`）、真实程序与冻结检查（`../../.artifacts/employee1/host-typed-lint/source-program-and-freeze.json`）。本批事实只证明这些类型/排版修复；原运行时、真实 PG 与物理执行验收仍采用原独立证据，不增加通过计数。
