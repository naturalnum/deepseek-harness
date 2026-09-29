# S7 集成验证与发布边界

基线为官方 DSH `dsh-v0.1.7-rc.2`，产品分支 `power-evolve/native-cloud-client`。本轮将双副本故障演练、本机双 k3d 节点、登录准入容量、停写备份恢复、Platform PG 断连恢复和部署候选合入同一分支。Host 与 Platform 仍是两个独立进程；Host 不持有 PG、共享卷或 Kubernetes 权限。部署候选使用独立的 Host／Platform Deployment，执行沙盒仍按需启动。

## 已运行的集成检查

2026-09-30 在合并全部 S7d 产品代码后，仓库根目录 `pnpm run build` 通过；串行运行 `node --test --test-concurrency=1 products/power-evolve/application/tests/*.test.mjs` 为 **79/79 通过**。部署模板、Kubernetes ServiceAccount token 轮换和 Sandbox 挂载回归的组合运行 **11/11 通过**。真实 PostgreSQL 中断恢复与跨 Platform 准入组合运行 **3/3 通过**：PG 不可用时 Platform 进程存活、健康接口返回 503，恢复后返回 200；失败登录没有自动重放。

在该集成分支上重新运行 `qa-s7a-platform-failover.mjs`：两台 Host 与两台 Platform 分别经本机负载均衡服务原生 Web；已持久接收的输入在 Platform A 中断后只出现一次，Platform B 在同一 Session 继续；受控写入在首次响应丢失后由 Platform B 对账，远端只写一次；Host B 接管历史，文件仍可读。本次通过的脱敏证据在 `.artifacts/power-evolve/s7a-28675498/s7a-evidence.json`。首次尝试在原生输入框可见性等待处超时，未到故障注入步骤；第二次通过。脚本现会在同类失败时保存页面截图和正文摘要以便定位，不能把首次失败算作通过。

其他纵切面证据分别见 [S7a](TRIAL-S7A-LOCAL.md)、[S7b](TRIAL-S7B-LOCAL.md)、[S7c](TRIAL-S7C-BACKUP.md)、[简单对话容量](TRIAL-S7-CAPACITY.md)和[登录容量](TRIAL-S7-LOGIN-CAPACITY.md)。部署候选从干净提交的 Git archive 成功构建应用与 Runner 镜像，模板及 23 个资源通过本地解析和 `kubectl --dry-run=client`；这不是运行中生产集群的证据。

## 尚未达到的发布门槛

本机 S7b 的两个 k3d Node 仍共处一台物理机器。需要在至少两台独立机器、真实 `ReadWriteMany` POSIX 卷、外部 PostgreSQL、实际 CNI 与 HTTPS Ingress 中，按 [部署验收步骤](deploy/README.md)重复双用户编程、Pod 跨节点接管、停止证明、权限拒绝、网络出口、流式请求、备份恢复与故障回滚。部署候选的 PVC `subPath` 和 in-cluster 权限已做静态及局部测试，尚无上述实机结果。目标硬件的持续混合负载、容量上限和生产 RPO/RTO 也未测定。因此 S7 和云端发布仍为**未完成**。

当前 Platform 从私有 `users.json` 播种账号，配置校验上限为 100 个用户；每个副本启动时还会为种子密码计算哈希。它只覆盖阶段试用账号，万人组织的账号开通、撤销与身份源同步需要独立纵切面和端到端验收，不能用本轮 128 账号容量探针替代。

可继续试用的 S6 固定 V18 版本位于 <http://127.0.0.1:19371/login>，使用既有私有双用户账号配置；2026-09-30 用其原 V18 二进制安全重启 Platform 后，Alice/Bob 的原生登录、历史 Session、STDIO 返回及 Files 视图已复查。该试用未升级至本集成提交；不要用当前 V19 程序直接启动它。S7c 的独立 V19 恢复试用位于 <http://127.0.0.1:19401/login>，其代码同样早于本次 PG 断连修复。账号口令只存于相应的私有配置，不写入文档。
