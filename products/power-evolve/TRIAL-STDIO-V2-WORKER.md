# 通用 STDIO 的 Cloud worker 验证

## 范围与版本

2026-10-08，内部 Cloud worker 链固定于 `4b3e0fc4721c503a7413f39bf49d0c646b7779d3`；未签发许可时的审批恢复修复固定于 `ffa33f3646b14ccbd161e9bfc860ae97c396ca83`。两位工程师分别实现持久认领／授权和事务外传输，一位独立源审，Root 实现编排并串行集成及真实验证。Schema 仍为 35；此前原始许可和结果约束见[持久化验证](TRIAL-STDIO-V2-RESULTS.md)。本记录验证内部 worker，通用 STDIO 尚未在产品 Profile 启用。

## 通过的流程

- 按数据库时钟认领，复用用户上次认领时间轮转；Alice 的旧积压不能抢占 Bob 的首次认领。两个服务实例共享有效 Cloud worker 租约上限，动作和执行租约原子镜像，到期接管增加 epoch，旧认领者不能写入、续期、清理或捕获。`maxActive` 限制认领并发，不限制实际运行中的 Pod 或用户程序数量。
- 首次准备先落盘，再在授权事务外取得原 Session 的 ready 环境并保存准确 writer。独立审批前实际 Runner 查询为 404，启动 POST 数为零。许可提交后仅本次确认的 true 可以首次 POST；接管已提交意图不调用创建、准备或授权，只查询原 Runner。
- Runner HTTP 前，以另一个真实 PG 事务对账户、Session、连接、动作和执行记录取得 `NOWAIT` 锁，验证捕获事务已经释放。私有 Kubernetes 观察仍在有界捕获事务中进行，不能据此声称全部网络 I/O 都脱离事务。
- 两个新 PG 用户各完成一次真实 SDK discovery、完整结果入库和唯一目录。Bob 的首次 POST 已到达实际 Runner 后人为丢失回复，新 worker 只查询原记录；实际 trace 各只有一次 UID1000 启动，准备适配器调用和 Runner 启动 POST 各一次。独立 UID 清理完成后才保存终态与停止事实。
- 续租回复不明阻止后续写入；停服等待正在进行的创建、授权及 HTTP 收敛。创建末尾取消或撤权仍保留 ready 身份。没有 Prepared／许可时的临时准备失败可恢复原 reservation 或原已捕获 writer，不能替换已派发环境。
- 审批已保存但派发前捕获临时失败时，无许可的原审批保持原状态、指纹和有效期；后续成功捕获仍只发一次 true。已有许可但提交回复丢失时保持 `blocked/uncertain`，只能对账，不能使用这个恢复分支重新发许可。

## 实际检查与证据

`4b3e0fc472` 的严格 Application 构建、定向回归 121/121、真实 PG 26/26、实际 PG＋Docker 组合 2/2、导出 JSDoc、lint、双语配对和正常提交 hooks 通过。最后的未签发审批恢复修复重新通过严格构建、定向回归 122/122、受影响真实 PG 5/5 和正常 hooks；没有重复无关的 Docker 场景。独立源审核对了每个固定候选和最终源码 SHA，没有把源审算作真实执行测试。

Root 日志位于 `.artifacts/stdio-v2-worker/`：`pg-final.log` SHA 为 `9e012db6304312c05995614b364c42990ce6b38522457e25ad000a4d3e390cec`；`pg-docker-final.log` 为 `c946509a9a01dfd1b9bfbd19e565932d8ef61349a77366a2f6f5b96b01643660`；最后定向 `focused-final.log` 为 `83e79ffd9315a207969edb1c9ffc0b8ab81aab4f19646c39c60034ca8a2b51cb`；审批恢复 `pg-approval-retry-final.log` 为 `e45e96ab53818f807c026d35a2b61bb3d8fa5cc1ef765d40fbfcc42a24e0b43d`。失败日志保留，不计作通过：旧夹具只手动过期动作租约，没有同步新增的执行镜像；新夹具在审批前读取尚未创建的 trace 文件；最后故障开关曾声明于错误测试作用域。分别修正夹具后复验通过。

测试的私有容器、镜像、Linux 卷和临时 PG 数据库已清理。原 O6 R8 试用保留独立 `83e46b3`／schema 33，Host、Platform 均 ready，仅保留既有试用 Platform、PG 和本机 k3d 三个运行容器。本轮没有升级旧试用数据或创建长期测试服务。

## 尚未完成

组合夹具顺序使用同一真实 Docker Runner；环境准备、Pod／PVC、Node 和 OCI manifest 是明确替身。它不证明跨用户物理文件系统隔离、真实 k3s 调度、原生客户端或通用 call。正式 no-start 结案尚未实现，派发前取消保留 blocked 和原占用，不伪造停止事实。

同一纵切面继续补齐 no-start 结案、call 原子受理与唯一续接、Device journal、真实部署 pin／Node 权限和原生管理／审批入口。两用户从原生客户端完成 discovery／call、取消及故障恢复并固定独立试用后，才启用通用 STDIO Profile；这些内部验证不作为产品纵切面完成声明。

## 后续结案验证

2026-10-08 的 discovery 正式 no-start 结案及资源围栏另见[固定验证记录](TRIAL-STDIO-V2-NO-START.md)。本记录以上事实仍绑定原 schema 35 候选；通用 call、Device、真实部署与原生客户端验收继续未完成。
