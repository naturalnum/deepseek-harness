# Device 冷领取封存验收

2026-10-04，集成代码固定为 `42dc491f28da59fea7c1d5c23c1f3c2c98c81cc3`，完成 [Device Bundle](../device/README.md) 严格冷 `claiming` 的永久封存。此次使用已运行的 PG 和 Docker，未启动 Electron、真实模型或共享 Host，未部署或迁移 Cloud 固定试用。结果属于 Device 协议验收，桌面装配继续按[官方桌面复用约定](../DESKTOP-COMPLETION.md)推进。

## 已核验的处理

Worker 持有私有 journal 与原共享写入锁，以稳定请求 ID 提交原进程、登记、目录及冻结摘要。平台在账户、Device 和 execution 行锁下核对未曾发放启动许可且没有容器／结果／停止事实，原子保存永久 fence、取消状态、唯一回执及适用的原会话续接。旧 claim/register/finish 被拒绝；停用账户可以清理原意图，但不产生新续接。Worker 先同步匹配回执，再退掉原未登记写入槽，最后删除 journal；退槽重试不重建原槽或修改另一写者。

## 实际验证

| 验证 | 结果与范围 |
| --- | --- |
| [请求与回执字段](../application/tests/device-execution-contracts.test.ts) | 4 项通过；严格 JSON 拒绝命令、路径、虚构停止及不成立的 no-start 字段 |
| [永久封存](../application/tests/device-claim-closure.test.mjs) | 14 项真实临时 PG 通过；覆盖身份、原派发与未领取、撤销／停用、稳定回执、迟到 RPC、并发领取／登记、数据损坏与事务回滚；Docker 身份为合成 DTO |
| [迁移](../application/tests/device-execution-schema.test.mjs) | 1 项真实 PG 通过；明确经过 V29、V30、V31，原执行字节及事实不变，两个结案表为空，没有补造历史 capture／stop／closure |
| [Worker 恢复](../application/tests/device-worker-recovery.test.ts)及[写入协调](../application/tests/device-writer-coordinator.test.ts) | 隔离候选首轮 45 项通过；最终新增持久回执未退槽窗口后，定向 24 项通过，未重复宣称最终全集。真实文件、Python、native flock 和 OS 子进程；Platform／Docker 为替身 |
| 既有 [Device 协议](../application/tests/device-execution-protocol.test.mjs)与[未知结案](../application/tests/device-execution-resolution.test.mjs) | 平台候选受影响 17 项真实 PG 回归通过；合成 Docker 身份，无真实容器 |
| [真实 PG／Docker](../application/tests/device-real-docker-protocol.test.mjs) | 集成 7 项通过；使用真实公开 Worker、Device／Task／File 服务、Git 和实际容器，HTTP fixture 注入回执丢失；没有完整 Platform Profile、Electron 或模型 |

新增真实场景故意丢弃原领取 ACK，停止原 Worker 后，从同一私有目录启动新 Worker；平台封存已提交后再次丢弃 ACK，再停止和替换 Worker。最终旧任务保持原进程／派发，容器、启动、停止与结果字段仍为空，只有一条封存及续接；实际 Docker CLI 没有执行旧任务的 create/start，禁止标记文件不存在。随后新 Git 任务创建并启动一次、文件只写一次、journal 清空，旧命令仍未重放。这里是同一 Node 内的 Worker 对象替换与真实 PG／Docker；真实 OS 子进程重启由上述源码恢复测试覆盖，二者不能合并声称为 Electron 重启验收。

固定使用已有 ARM64 镜像 `pe-release-cloud-runner:7e2c0067e1-arm64`，镜像 ID 为 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`。Application／contracts 类型构建通过；三组平台并发使用真实 PG 锁等待确认竞争请求已进入锁等待。平台封存输入完整保存，唯一续接的模型可见文本由真实 PG 精确断言；原始执行内容及停止事实均保留各自含义。

集成源码测试严格类型、导出 JSDoc、受影响 lint 和正常提交 hooks 通过。数据库初始化已有 JSDoc 缺少 pool 参数，补齐后定向检查通过。最终四份产品文档的实际链接、段落与末尾换行，以及 Device 双语配对和暂存记录均通过；桌面审计期间的根级 20 项 doc-quick 也通过。真实 cold 场景在补强精确迟到 claim 错误码后再次定向通过。没有新增常驻容器、集群或镜像。

## 复验入口

先构建 contracts 与 application，再使用 `node --test` 执行上述 PG `.mjs`；显式提供 `PE_PRIVATE_DIR` 中的私有 `database-url` 或 `PE_TEST_DATABASE_URL`。真实 Docker 测试另设置 `PE_DEVICE_TEST_IMAGE` 为已安装镜像；没有镜像导致的 skip 不算验收。源码恢复测试通过 `node --import tsx/esm --test` 运行；测试只清理由自身持有的随机数据库、目录、进程及容器。凭据和数据库 URL 不写入记录。

## 剩余范围

封存只适用于没有已领取派发、镜像、容器、停止及结果事实的严格 `claiming` journal。`claimed`／`created` 缺少停止证明仍保留占用并阻止替代写者，不能依靠容器缺失或进程退出结案。本记录不验收正式 Profile 的双用户原生模型组合、Device 技能／Office／连接器、Electron、安装包、Linux 真机及生产多物理节点。既有 V28 Cloud 固定试用保持原数据库、镜像和文件根；V31 只在本轮临时库中验证。
