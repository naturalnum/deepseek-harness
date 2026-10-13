# 员工6：Office runtime 独立审查

本次在指定源码版本中未发现由 mandatory `runtimeClassName` 和 safety version 2 变更引入的确定性阻断缺陷。18项聚焦测试通过，其中14项是员工6新增的独立服务补测，4项是主线程的 runtime 测试。结论限于源码行为和下述记录，不能替代真实应用启用 Office 后的验收。

## 范围与版本

生产审查对象是 [office-preview-pod.ts](application/src/platform/office-preview-pod.ts)、[office-preview-config.ts](application/src/platform/office-preview-config.ts) 和 [office-previews.ts](application/src/platform/office-previews.ts)，并读取了主线程的 [office-runtime.spec.ts](application/tests/office-runtime.spec.ts)。启动顺序和 README 仅作只读上下文核对。员工6只新增 [独立测试](application/tests/employee6-office-review-persistence.spec.ts) 与本报告，没有修改上述生产文件、主线程测试、共享库或 DDL，没有 install、build、Git add／commit，也没有操作真实 Host、Platform、PG、集群或 Profile。

最终检查窗口为2026-10-09 12:00:44至12:01:44 +08:00，以下五份输入在该窗口内稳定。这不是整个仓库的冻结证明。

| 输入 | SHA-256 |
|---|---|
| office-preview-pod.ts | `0518e0ce18d7581014b3520402082782a2ac8bd357b834ffa39eaf3ede2bb7c2` |
| office-preview-config.ts | `aad9067dadf2b70153349b6960145d3f6e8117a5d6315a545c1480a484b30404` |
| office-previews.ts | `a463780f9c6be250afa9587787a4f965947fea0e9c27592178130c2bba415a38` |
| office-runtime.spec.ts | `1d34c9ff59cd3379960adb4ccb24102de9100692499221f2f918fc4c1f323752` |
| employee6-office-review-persistence.spec.ts | `c8f59cb8a1e0f89cb1c0c478eeeed29a8c2ecf22c82187477cf2680db145bdf3` |

审查开始后，主线程将 Pod adapter 的 Kubernetes `call` 返回类型改为 `Promise<unknown>`，并将其测试的 outputBytes 从32MiB修正为协议允许的8MiB；当前结论针对表中修正后的版本。私有 before 副本保留了这两处差异，员工6没有代改它们。

## 持久兼容、创建与恢复

| 行为 | 核对结果 |
|---|---|
| 启用配置 | runtime 字段必填且须为有效资源名；缺失、空值、非法值拒绝。两个配置引用同时为空才关闭功能。启动源码先加载这份配置，再读取数据库等凭据并构造 PG Pool。这里只核对源码顺序，未启动 native Platform。 |
| 新转换器 | safety version 2 与 runtime 选择进入 converter snapshot 和 generation 哈希。真实 `OfficePreviewService.prepare()` 在注入的持久行模型中保存该快照；后续 tick 保存提交标记，并只 POST 原 intent。 |
| 历史读取 | intent 的 runtime 可缺失，以读取旧 intent。converter 对 safety 1 无字段、safety 2 有字段作严格区分；互换组合拒绝。intent 与 converter 的 runtime 不一致也拒绝。 |
| 历史终态 | safety 1 的 succeeded／failed／cancelled 可按原 generation 查询、取消和幂等 prepare；终态字段、intent、result 和 stop proof 保留，tick 不创建 parser。无快照的提前取消占位行还有独立源码分支，本轮未增加其专门测试。 |
| 旧 queued | 旧 generation 没有 intent 时转 failed／unavailable，不生成 replacement intent，不读输入，不调用 Kubernetes。 |
| 旧 intent 尚未提交且 Pod 不存在 | 保留原 intent，写 NOT_SUBMITTED 证据并释放 slot；没有 POST。 |
| 旧 intent 已提交且 Pod 不存在 | 保持 blocked 和已占 slot，不生成虚假的停止证据，不重试 POST。 |
| 旧 runtime 已创建 Pod | 按冻结 intent 观察原 runtime，使用实际 UID 删除；取得停止证据后，以同一 UID、resourceVersion 和 finalizer 集合释放。最终 failed／unavailable，保留原 generation 和 intent digest，不重放。补测使用未调度删除分支。 |
| runtime 替换 | observe 比较实际 Pod 与原 intent，允许旧选择的精确清理；submit 比较 intent 与当前配置，拒绝旧选择。主线程测试还覆盖实际 Pod 缺字段或选择不同的拒绝。 |
| 缓存与幂等键 | runtime／safety 变化使 generation 改变。旧终态可以继续查阅，但旧 PDF content 返回409；同一 request key 保留原受理，不静默升级。要重新转换须使用当前 generation 和新 request key。 |

未发现需要修改表结构的字段：runtime 和 safety version 均进入既有 JSON snapshot。此结论不证明真实 PG 的事务、持久化或租约竞争正确。

## 执行证据

使用现有依赖直接运行，未通过包管理器安装或重写锁文件：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.power-evolve.cloud.config.ts products/power-evolve/application/tests/office-runtime.spec.ts products/power-evolve/application/tests/employee6-office-review-persistence.spec.ts --reporter=json --outputFile=/Users/jingchao/agent_work/private/employee6-office-review-20261009/test-report-final.json
```

结果18／18通过，没有 pending。测试使用真实 Service、Pod adapter、事务和账号授权函数；PG query 响应、文件服务读取和 Kubernetes API 响应由每个 fixture 的实例内适配器提供，没有打开数据库连接或 HTTP。新 prepare 的本地输入写入真实独占临时目录。实际 SQL 参数、POST template、UID 删除条件、finalizer patch 和持久行变更均由断言检查；未知 SQL 响应拒绝。

每个临时目录由 `mkdtemp` 原子分配，cleanup 从取得资源时起注册；service stop、Pool end 和目录删除分别在嵌套 finally 中完成。没有全局环境、cwd、timer 或 fetch 修改，没有固定 sleep。当前 Vitest 使用两个 fork worker；这些测试没有共享端口、服务或文件根。

新增测试的独立 noEmit TypeScript 检查为0项本文件诊断。该单文件程序的导入图另有102项诊断，未运行正式项目 typecheck，不能把这一检查描述为全生产类型检查通过。

私有证据位于 `/Users/jingchao/agent_work/private/employee6-office-review-20261009`，权限0700。`test-report-final.json`、`test-final.log`、`typecheck-final.log`、`final-input-before.json` 和 `final-validation.json` 保存最终结果与输入。首次沿用主线程旧32MiB fixture 的失败日志也保留；这是测试输入超过协议预算，不能作为生产缺陷。该次构造器提前失败遗留的10个空临时目录已按本轮唯一前缀、创建时间和所有者确认后删除，`owned-temp-cleanup.json` 记录最终剩余0；当前 fixture 的 finally 也包围初始化阶段。

## 真实隔离证据与剩余缺口

只读核对的目录是 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/office-enabled-v1`。原 NetworkPolicy 首次探针的 `pe-office-isolation-restricted-first.log` 明确记录 `Network policy allowed registry 200`。该负例支持新增启动前离线 runtime 的动机，不能作为原隔离成功证据。

`pe-office-offline.toml` 配置 `network = "none"`；RuntimeClass 的 handler 与名称均为 `pe-office-offline`。server／agent 两份 proof 记录对照 Pod 收到200，受限 Pod 的首个网络请求以 ENETUNREACH 拒绝，只有 loopback 接口，UID为1000，输入只读且输出可写。两份实际 Pod 快照的四个容器均 exit 0、restartCount 0，runtime 选择与 proof 一致，镜像 digest 相同。这是两节点 handler 探针证据，探针覆盖了容器命令，并未走应用生成的转换任务。

仍需主线程独立接受以下范围：

- 真实启用配置经 native Host／Platform 到 PG 行、Pod intent、实际 Pod runtime、转换结果、content 的完整链路，以及成功、取消、故障和恢复后的准确回收。
- 真实 PG 多副本租约、并发、提交后崩溃和重启；本轮注入的行模型无法证明数据库锁或 fsync 的效果。
- 两节点离线 handler 下实际 Office entrypoint／SDK 四格式运行，而不是替代命令的网络探针。`office-evidence-final.json` 的既有 SDK 渲染结果不构成当前应用 enabled 通过。
- 按 UID 删除请求／响应的独立落盘证据。现有 proof 保存了创建 UID；`probe-storage-cleanup.json` 记录预期输出校验，不能单独证明 UID 条件删除。本轮没有连接集群检查这一点。

2026-10-09补充只读核对：主线程新增 `probes-final-empty.json`，记录 Office namespace 的List响应为 `items=[]`，SHA-256为 `7a779468a2dde976a9b896541df1e4ef805e813093bd5edb40ef1a6eea588edf`。它补齐当前清单零剩余证据，不能反推历史删除请求使用了UID preconditions；这一历史请求／响应缺口继续保留。

Application 双语 README 已说明启动前离线 RuntimeClass、safety 1 历史读取与 safety 2 选择保留，和源码一致。运行时名称的语法与一致性检查不证明节点 handler 的实际隔离配置；该性质依赖运维验证和真实探针。
