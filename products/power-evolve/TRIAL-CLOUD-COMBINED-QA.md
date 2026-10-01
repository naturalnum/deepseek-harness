# 云端组合验收：账号、存储绑定与执行

本轮核对 S2 A–C 与已交付账号、云执行功能的衔接，使用两个 Host、两个 Platform、真实 PG、DeepSeek 和本机 k3s。当前是开发验收环境，尚未冻结为发布候选；[S2 固定试用](TRIAL-S2-STORAGE-BINDINGS-QA.md)保持独立可用。桌面、外部生产基础设施和新增连接器不在本轮范围。

## 路线与发现

架构仍为共享 DSH Host＋独立可信 Platform。交付按“限定范围并行修复 → 串行集成 → 实际客户端与失败恢复验收 → 固定版本”推进。模块数量、单条成功演示及单个切片通过，均不能替代跨模块验收。此次修复集中在以下实际复现问题，没有增加产品插件或平台模块。

| 交界 | 已修复行为 |
| --- | --- |
| 账号删除与新存储布局 | 检查全部自有存储根、未完成意图及完成回执；只豁免默认绑定的空目录结构。 |
| 浏览器授权与持久受理 | 新建目录、恢复绑定在受理事务内复核 bearer；请求体等待或账号锁等待期间撤销后，拒绝新意图。已提交意图仍按既有账号状态继续。 |
| 正常停服与恢复接管 | 释放当前恢复租约，保留请求、原写者及停止证明；新的执行者继续同一请求。 |
| 账号停用与沙盒清理 | 阻塞的绑定不再永久阻止停用账号的旧写者清理；释放必须有确切停止证明，不能自动换绑。真实 Kubernetes 暴露的 finalizer 移除后短暂可见时序也已修复。 |

实现提交为 `9ded49aee4`、`e60a533957`、`5a72b3bbb9`、`990cabd9e1`、`2993d89201`；负例补充为 `c538f04357`。功能集成未改变 Schema 27。

## 已运行的验证

- 原生浏览器全新登录 Alice、Bob，经两个负载均衡入口完成真实对话。hi 前后执行记录均为 11、沙盒实例历史记录均为 6，namespace 无 Pod；这些存量来自恢复的试用库，不是 hi 创建的资源。
- 两账号在不同绑定工作区并发运行 Git 和 Python 测试，各通过 2 项测试。两个 Pod UID、工作区根及 Git HEAD 不同；同名 `combined-execution-check.txt` 分别保存各自标记。重启后浏览器历史和文件读回保持可用。
- 真实 Host RPC／Platform HTTP 核对两账号历史、README、下载及 5 个既有不可变产物；Bob 读取 Alice 文件或直接下载其产物均返回 404。
- 在实际 k3s 上注入一次 DELETE 前 503，使恢复阻塞，再停用专用测试账号。旧 Pod 最终按 kubelet 证明移除、挂载槽释放；绑定仍阻塞、代次不变，没有创建替代 Pod。首轮发现的 finalizer 等待误判实例也依据已存证明完成清理。
- 原生页面受理 Alice 的目录恢复后，以测试 finalizer 暂缓旧 Pod 消失。在 kubelet 停止证明已持久化时正常关闭开发环境，确认请求仍为 `stopping`、租约释放、绑定代次仍为 3。撤去测试阻塞并重启后，原请求完成，租约代次 1→2、绑定代次 3→4，原页面显示恢复成功。测试 finalizer 已撤去；同一 Session 随后在代次 4 的新 Pod 中读回原标记与 Git HEAD，再次通过 2 项测试。
- 两用户分别通过原生 `skill` 读取 PDF、Word 说明；Alice 在恢复后的原 Session 额外用 `skill_resource` 读取 `SKILL.md`。PG 记录实际工具调用及返回摘要，云执行记录保持 14 条、沙盒实例历史保持 8 条。读取说明没有创建执行环境。
- Alice 在同一 Session 经 `office` 创建、写入并校验 Word 文件，再经原生报告技能调用已选版本的套件脚本，初始化工作流并执行同级生成器的样例目录门禁。四次执行均成功并完成可信续接；实际 Pod 同时挂载代次 4 工作区、用户 Home 和用户独立只读技能库。沙盒内读取 Word 技能摘要与受控文件服务返回一致，`statvfs` 也确认只读挂载；既有 Git HEAD 和标记保持不变。
- 原生文件按钮发布当前 Word 版本后，Host 工作区下载、Platform 不可变产物下载与实际文件字节一致；旧布局和旧相对目录没有新增同名文件。Bob 读取 Alice 技能、准备该文件下载或直接下载其产物均返回 404。旧轮次指向的文件已被后续命令修改时，原生入口拒绝发布旧摘要；当前版本可正常发布。

以上技能联测验证版本、挂载、执行、文件归属与续接。Word 结构校验通过，但样例使用未定义的 `Heading1` 样式产生警告；报告门禁返回 0 错误、6 个样例内容警告。两者均保留在实际回执中，不作为完整文档版式或业务报告质量验收。

定向回归使用真实独立临时 PG 与 POSIX。Sandbox fixture 中的 Kubernetes 回复明确是替身，与上面的真实 k3s 演练分别记录：`s2-sandbox-bindings` 23 项、`storage-disabled-cleanup` 3 项、`storage-recovery-shutdown` 4 项、`sandbox-stop-finalizer` 6 项、`account-storage-composition` 23 项、`storage-browser-admission` 8 项通过。各缺陷先用原代码复现；新增浏览器授权测试通过真实 Platform HTTP 入口。Application 叶编译、相应提交 lint 与 whitespace 检查通过，未运行仓库全量矩阵。

本地证据位于 `.artifacts/power-evolve/cloud-combined-qa/`：`facts-before-hi.json`、`facts-after-hi.json`、`execution-proof.json`、`combined-http-readback.json`、两用户浏览器记录、`disabled-cleanup-k3s-proof.json`、`graceful-recovery-{observe,stopped,proof}.json`、`graceful-recovery-browser.txt`、`skill-description-proof.json`、`skill-execution-proof.json`、`skill-file-readback.json` 和 `skill-combined-browser.txt`。秘密配置只在用户私有目录，未写入证据正文。

## 环境与后续关口

开发验收入口为 `http://127.0.0.1:19746/login`，原生客户端为 `http://127.0.0.1:19744/native/`。数据库 `pe_cloud_combined_20261001`、文件根 `pe-cloud-combined-qa` 与同名 namespace 均独立于固定试用。复用现有 PG 容器和 k3s，不新增 Docker 基础设施；启停使用本地证据目录中的 `control.mjs up|stop|restart|status`，日志同目录，运行 Node 22。

下一步只核对尚未覆盖且确实受 S2 变更影响的连接器、技能及撤销组合路径，然后冻结候选版。正常关闭的真实演练已覆盖恢复中断，不代表所有网络故障或多物理节点场景。k3s 与 POSIX 仍在同一笔记本；目标服务器、真实跨机共享卷、外部 PG、生产入口、容量及组织身份源保持 S7 未完成项。本轮受控 namespace 禁止通用外连，因此没有把本地 Git 测试计为远端 Git 下载或依赖安装验收。
