# S7b：本机双 k3d 节点共享 POSIX 故障演练

此演练使用独立的 k3d 集群（1 个 server、1 个 agent）、独立 Docker POSIX 卷、命名空间、PostgreSQL 卷和私有配置。两个 k3d 节点容器把**同一个** Docker 卷挂到相同路径；平台进程从 OrbStack 暴露的同一卷目录读写。它验证 Kubernetes 在两个节点容器间调度 Agent Sandbox 后，工作区、Home 和已发布技能包的实际字节可见、用户隔离、旧 Pod 停止证明和新 Pod 启动顺序。

## 本机准备

需要 Docker/OrbStack、k3d、kubectl、`zip`、Node 22 和构建好的产品及原生 Web。当前本机的 k3d 节点镜像 `pe-c0-worker3-k3s:v1.35.5-k3s1-gvisor-20260831` 包含 `runsc`。首次准备时，从一个**只读的**已有 Agent Sandbox 控制器集群复制 CRD 与固定镜像的控制器定义；S7b 运行时不依赖该源集群。准备脚本要求源控制器镜像为固定 digest，且只向新集群写入资源。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:power-evolve:web
PE_S7B_CONTROLLER_SOURCE_CONTEXT=k3d-pe-e32-session-probe \
PE_S7B_NETWORK=k3d-pe-e32-session-probe \
  node products/power-evolve/scripts/prepare-s7b-cluster.mjs
```

`PE_S7B_NETWORK` 只让独立集群复用本机现有 Docker 网络，以避免当前机器的地址池耗尽。准备脚本新建 `pe-s7b-multinode` 集群与 `pe-s7b-shared-posix` 卷，验证两个 Ready 节点均有 `runsc`、镜像均已导入，并以同一标记字节证明 Host 与两个节点读到同一卷。已有兼容集群可重复运行准备脚本；默认本机卷目录为 `~/OrbStack/docker/volumes/pe-s7b-shared-posix`，其他 Docker 环境须设置 `PE_S7B_LOCAL_VOLUME` 指向该卷的实际本机目录。`PE_S7B_K3S_IMAGE`、`PE_S7B_RUNNER_IMAGE`、`PE_S7B_NODE_ROOT` 可用于与现有环境对齐，准备和演练应使用相同设置。

准备脚本还检查源与目标集群的 Sandbox CRD 结构摘要及控制器镜像 digest。已用临时 `pe-s7b-install-probe` 集群验证从零创建、控制器安装、镜像导入和双节点卷探针；验证后只删除该临时集群与其独立卷。正式演练集群 `pe-s7b-multinode` 保留供复查。

## 实际演练

```sh
PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default \
  node products/power-evolve/scripts/qa-s7b-multinode.mjs
```

若 Docker 有可用地址池，可省略 `PE_COMPOSE_EXTERNAL_NETWORK`。演练随机创建 `s7b-*` 试用名与独立命名空间、PG 和私有目录；模型为本机确定性 SSE fixture，但 Agent 工具实际派发到 gVisor 下的真实 Sandbox Runner。它执行以下检查：

1. 发布 Alice 的真实 ZIP 技能包，封锁 server 调度，把 Alice 的 Sandbox 放在 agent 节点。Runner 写 Python 代码与单元测试并实际运行，通过 Git 提交，写入 Home，并执行只读挂载的技能脚本。平台文件 API 读回代码。
2. Bob 在独立 Sandbox 中执行实际命令，确认不能看到 Alice 工作区代码、Home 标记或技能包；Pod 的 hostPath 指向 Bob 自己的工作区。
3. 等待 Alice 的原 Pod 完成 kubelet 停止、`KUBELET_STOPPED` 证据进入 PG、挂载槽释放及原 Pod 删除。随后封锁 agent，把同一 Session 的新 Sandbox 放在 server 节点；它重新运行测试，读取原 Git 提交、Home 标记和技能包脚本，再提交第二次 Git 变更。平台文件 API 读回新字节；Bob 读取 Alice Session 得到 404。
4. 最后等待所有写入 Pod 的停止证明与删除完成，再停止本次试用、删除本次 PG 卷和命名空间，并移除私有配置及该试用的卷子目录。脱敏证据与进程日志保留在 `.artifacts/power-evolve/s7b-*/`。

本机实测报告为 `.artifacts/power-evolve/s7b-99859746/s7b-evidence.json`：首个 Pod UID `49627de7-6828-4dce-be50-eca212334920` 在 agent 节点执行成功并记录 `KUBELET_STOPPED`；继任 Pod UID `5e2b8685-3bda-4ef0-8b71-7674b7ccebc9` 在 server 节点执行成功。Bob 的 Pod 位于 agent 节点且工作区不同。三个执行的退出码均为 0，最终两个用户的 Pod 都有停止证明。演练脚本以退出码 0 完成，专属命名空间和 PG 已清理。

故障中若仍有带停止观察 finalizer 的写入 Pod，脚本保留本次命名空间、PG 与私有配置供对账，不会先删除共享文件。`PE_S7B_KEEP_TRIAL=1` 也可留住试用进程与数据供检查；脚本退出后模型 fixture 关闭，因此该选项不用于继续对话。

## 证据边界

本机试用的两个 Kubernetes Node 是**同一物理主机上的两个容器**，共同读取一个 Docker 卷。它证明了这两个节点容器上的调度、挂载和数据保留，**不证明**独立机器之间的 POSIX 一致性、存储故障切换、网络分区、节点失联后的人工恢复、生产镜像分发、集群安全策略或容量。生产跨物理节点验收仍须在独立主机与真正共享存储上重复相同的 Pod UID、停止证据、用户隔离及 Git/文件检查。
