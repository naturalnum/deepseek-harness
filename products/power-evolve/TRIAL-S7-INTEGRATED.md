# S7 集成验证与发布边界

基线为官方 DSH `dsh-v0.1.7-rc.2`，产品分支 `power-evolve/native-cloud-client`。本轮将双副本故障演练、本机双 k3d 节点、登录准入容量、停写备份恢复、Platform PG 断连恢复和部署候选合入同一分支。Host 与 Platform 仍是两个独立进程；Host 不持有 PG、共享卷或 Kubernetes 权限。部署候选使用独立的 Host／Platform Deployment，执行沙盒仍按需启动。

## 已运行的集成检查

2026-09-30 在合并全部 S7d 产品代码后，仓库根目录 `pnpm run build` 通过；串行运行 `node --test --test-concurrency=1 products/power-evolve/application/tests/*.test.mjs` 为 **79/79 通过**。部署模板、Kubernetes ServiceAccount token 轮换和 Sandbox 挂载回归的组合运行 **11/11 通过**。真实 PostgreSQL 中断恢复与跨 Platform 准入组合运行 **3/3 通过**：PG 不可用时 Platform 进程存活、健康接口返回 503，恢复后返回 200；失败登录没有自动重放。

独立复核还发现部署模板把上述 `/health` 当作存活探针，会在持续 PG 故障时反复重启 Platform。现已将 Platform 的 `/live` 用作存活探针，`/health` 保留给启动和就绪探针；真实 PG 断连测试确认失联时 `/live` 仍为 200、`/health` 为 503，恢复后重新就绪。修复后的针对性产品构建与部署／断连测试为 **3/3 通过**。[当前正式镜像的真实 Kubernetes 长时连接拒绝演练](deploy/QA-RELEASE-COMPOSITION.md#sustained-postgresql-connection-refusal)已补齐原 Pod 无重启、恢复就绪和记录保留证据；其范围是本机静止状态的 Platform，不替代外部数据库或运行中用户任务的故障验收。

在该集成分支上重新运行 `qa-s7a-platform-failover.mjs`：两台 Host 与两台 Platform 分别经本机负载均衡服务原生 Web；已持久接收的输入在 Platform A 中断后只出现一次，Platform B 在同一 Session 继续；受控写入在首次响应丢失后由 Platform B 对账，远端只写一次；Host B 接管历史，文件仍可读。本次通过的脱敏证据在 `.artifacts/power-evolve/s7a-28675498/s7a-evidence.json`。首次尝试在原生输入框可见性等待处超时，未到故障注入步骤；第二次通过。脚本现会在同类失败时保存页面截图和正文摘要以便定位，不能把首次失败算作通过。

其他纵切面证据分别见 [S7a](TRIAL-S7A-LOCAL.md)、[S7b](TRIAL-S7B-LOCAL.md)、[S7c](TRIAL-S7C-BACKUP.md)、[简单对话容量](TRIAL-S7-CAPACITY.md)和[登录容量](TRIAL-S7-LOGIN-CAPACITY.md)。部署候选从干净提交的 Git archive 成功构建应用与 Runner 镜像，模板及 23 个资源通过本地解析和 `kubectl --dry-run=client`；这不是运行中生产集群的证据。

后续[镜像启动演练](deploy/QA-S7D-IMAGE-STARTUP.md)发现运行层缺 Python，修复后在真实 PG、只读容器根、Host UID 10001 下通过 7 项启动／文件／内网 RPC 检查；[网络策略演练](TRIAL-S7D-POLICY.md)验证了本机两个 k3d 节点的允许与拒绝路径。两个演练分别验证相应组件，不代表整套生产部署通过。

[当前恢复预览](TRIAL-S7-CURRENT-PREVIEW.md)又发现旧种子技能目录权限、恢复后 Git 所有者以及本地检查失败遗留沙盒槽位的问题。主线已补启动前 POSIX 所有权准备、符号链接目标保留和提交槽位前的本地检查；修复后的产品构建及挂载／POSIX 回归 **13/13 通过**，其中挂载测试使用真实 PG 和 Kubernetes 替身。独立 Linux 容器中 UID 1000 在恢复后的 Git 树提交成功，外链目标及技能包不变。全新 c3 已从原备份自动恢复，并通过双用户真实模型 `hi`／追问无沙盒、文件／产物隔离、真实云 Git 提交及重启读回；没有手动改权限或 PG。该预览未启用新的 SSH／STDIO 调用，完整功能及生产部署仍有下述限制。

## 尚未达到的发布门槛

本机 S7b 的两个 k3d Node 仍共处一台物理机器。需要在至少两台独立机器、真实 `ReadWriteMany` POSIX 卷、外部 PostgreSQL、实际 CNI 与 HTTPS Ingress 中，按 [部署验收步骤](deploy/README.md)重复双用户编程、Pod 跨节点接管、停止证明、权限拒绝、网络出口、流式请求、备份恢复与故障回滚。部署候选的 PVC `subPath` 和 in-cluster 权限已做静态及局部测试，尚无上述实机结果。目标硬件的持续混合负载、容量上限和生产 RPO/RTO 也未测定。因此 S7 和云端发布仍为**未完成**。

当前 Platform 从私有 `users.json` 播种账号，配置校验上限为 100 个用户；每个副本启动时还会为种子密码计算哈希。它只覆盖阶段试用账号，万人组织的账号开通、撤销与身份源同步需要独立纵切面和端到端验收，不能用本轮 128 账号容量探针替代。

可继续试用的 S6 固定 V18 版本位于 <http://127.0.0.1:19371/login>，使用既有私有双用户账号配置；2026-09-30 用其原 V18 二进制安全重启 Platform 后，Alice/Bob 的原生登录、历史 Session、STDIO 返回及 Files 视图已复查。该试用未升级至本集成提交；不要用当前 V19 程序直接启动它。S7c 的独立 V19 恢复试用位于 <http://127.0.0.1:19401/login>，其代码同样早于本次 PG 断连修复。账号口令只存于相应的私有配置，不写入文档。
