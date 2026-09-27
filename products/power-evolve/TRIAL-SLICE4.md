# 切片 4 试用指南

此版本在共享宿主、可信平台、文件、技能和受控 API 上增加按需云执行。普通 `hi`、读取文件和查询技能说明不会启动沙盒。首次调用 `cloud_exec` 时，平台为根会话创建 Agent Sandbox；命令结果作为可信平台消息回到原会话。用户工作区和 Git 仓库保存在 POSIX 卷中，沙盒回收后仍可访问。

## 已验证的本机环境

需要 Node 22.19+、pnpm 11、Docker、`k3d`、`kubectl`，以及安装了 Agent Sandbox 控制器和 `gvisor` RuntimeClass 的 k3s 集群。本机试用使用 context `k3d-pe-e32-session-probe`、命名空间 `pe-shared-host-slice4`；节点将 Docker 卷 `pe-e32-session-shared-posix` 挂载在 `/var/lib/power-evolve-e31-shared`。`sandbox.json` 中的本机目录与节点目录必须指向同一共享卷。真实模型密钥从私密的 `model.env` 读取，不写入仓库或聊天。

从固定的切片 4 检出目录执行以下准备；集群及其卷须先存在，准备脚本不会创建集群：

```sh
pnpm install --frozen-lockfile
pnpm run build
docker build -t pe-shared-host-slice4-runner:s4-2ffb04551212 products/power-evolve/sandbox
k3d image import pe-shared-host-slice4-runner:s4-2ffb04551212 -c pe-e32-session-probe
kubectl --context k3d-pe-e32-session-probe get runtimeclass gvisor
kubectl --context k3d-pe-e32-session-probe get crd sandboxes.agents.x-k8s.io
```

私密目录 `~/.config/power-evolve/shared-host-slice4/` 中的 `sandbox.json` 保存挂载与集群配置。本机已验证的配置如下；权限准备脚本会将 `kubeconfigFile` 改为命名空间专用凭据文件。`idleMs` 在日常试用中设为 `300000`；验收回收路径时可短暂设为 `5000` 并重启服务。`model.env` 应含 `DEEPSEEK_API_KEY=` 配置行。私密目录权限为 `0700`，其中凭据文件为 `0600`。

```json
{
  "workspaceRoot": "/Users/jingchao/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-shared-host-slice4/workspaces",
  "kubeconfigFile": "/Users/jingchao/.kube/config",
  "namespace": "pe-shared-host-slice4",
  "image": "pe-shared-host-slice4-runner:s4-2ffb04551212",
  "localRoot": "/Users/jingchao/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-shared-host-slice4",
  "nodeRoot": "/var/lib/power-evolve-e31-shared/pe-shared-host-slice4",
  "idleMs": 300000
}
```

安装仅限该命名空间的 ServiceAccount、Role 和 RoleBinding，并将其 kubeconfig 写入私密目录：

```sh
export PE_PRIVATE_DIR="$HOME/.config/power-evolve/shared-host-slice4"
PE_SANDBOX_NAMESPACE=pe-shared-host-slice4 PE_KUBE_CONTEXT=k3d-pe-e32-session-probe \
  node products/power-evolve/scripts/prepare-sandbox-access.mjs
kubectl --kubeconfig "$PE_PRIVATE_DIR/sandbox-kubeconfig" -n pe-shared-host-slice4 auth can-i create sandboxes.agents.x-k8s.io
```

上面最后一条应输出 `yes`。同一凭据在 `default` 命名空间执行 `auth can-i list secrets` 应输出 `no`。平台读取私密 kubeconfig；共享宿主和沙盒都没有 Kubernetes 管理凭据。凭据需要撤销时，删除该命名空间的 `power-evolve-platform-access` Secret。

## 启动和试用

```sh
export PE_TRIAL_NAME=slice4 PE_DATABASE_PORT=18435 PE_HOST_PORT=18888 PE_PLATFORM_PORT=18889 PE_TARGET_PORT=18890
pnpm run power-evolve:trial up
```

对话入口为 <http://127.0.0.1:18888/>，登录入口为 <http://127.0.0.1:18889/login>，审批入口为 <http://127.0.0.1:18889/approval>。Alice、Bob 的随机密码在本机 `~/.config/power-evolve/shared-host-slice4/users.json`；请从私密文件读取，不发送到聊天。试用端口和 PG 卷均与前三个切片分开。

1. 用 Alice 登录，发送 `hi`，再查询 `kubectl --context k3d-pe-e32-session-probe -n pe-shared-host-slice4 get sandboxes,pods`；应没有执行资源。
2. 让 Alice 在云工作区创建一个含测试的 Python 项目，运行测试并提交 Git。右侧“云执行”展示每条命令的状态和输出，“文件”展示产物。已验证的示例为 `fizzbuzz.py`、9 个 `unittest` 测试和一个本地 Git 提交。
3. 在另一浏览器会话以 Bob 登录，让他创建 `hello.js`、运行 `node hello.js` 并提交 Git。Bob 的文件列表中没有 Alice 的 Python 文件；两人拥有不同的工作区 UUID 和沙盒实例。
4. 让 Bob 执行 `sleep 55 && echo SHOULD_NOT_APPEAR`，在右侧“云执行”点击“取消命令”。终态应为“已取消”，输出中没有 `SHOULD_NOT_APPEAR`。空闲回收后，PG 中应有对应 Pod UID 的 `KUBELET_STOPPED` 记录。
5. 等待空闲沙盒回收，或重启服务后，再让 Alice 实际运行 `git log -1 --oneline` 和测试；旧文件和 Git 提交应仍在，新命令进入新的沙盒实例。

查看、重启和停止：

```sh
pnpm run power-evolve:trial status
pnpm run power-evolve:trial restart
pnpm run power-evolve:trial stop
```

以上命令沿用四个端口环境变量。`stop` 只停止产品进程，不删除 PG 卷、私密文件或尚未空闲回收的沙盒；结束试用前应等待命令和回收完成。日志位于 `.artifacts/power-evolve/slice4/`；平台 `/health` 返回表结构版本 `6`。本机试用使用真实 DeepSeek、真实 PG、k3s、Agent Sandbox 和 POSIX 挂载；`pnpm run test:power-evolve` 另用确定性模型及执行器检验重复请求、双用户并发、取消、失败、重启受理和实例变化后的禁止重放。

## 数据和限制

平台启动时在一个事务中将切片 3 的表结构从 `4` 迁移到 `6`。升级已有数据前，应先确保没有运行中的命令，备份 PG 与对应的 POSIX 工作区及 Home。旧版本不能直接读取升级后的表；回退须停止进程并同时恢复旧 PG 和文件备份。此次切片 4 使用独立空库，未迁移前三个试用库。

```sh
mkdir -p .artifacts/power-evolve/slice4/backups
docker exec pe-shared-host-slice4-postgres-1 pg_dump -U powerevolve -d powerevolve -Fc \
  > .artifacts/power-evolve/slice4/backups/database.dump
tar -C /Users/jingchao/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-shared-host-slice4 \
  -czf .artifacts/power-evolve/slice4/backups/files.tar.gz workspaces homes
```

当前试用是单节点共享卷验证；多节点 POSIX 一致性、桌面执行、生产级网络出口策略和异常节点的人工恢复流程尚未验收。命令容器使用 gVisor，进程以 UID 1000 运行且没有平台模型密钥；平台与宿主在本机仍以同一个 OS 用户运行。平台文件接口尚未使用目录描述符逐层约束路径；当沙盒进程并发修改工作区中的符号链接时，仍存在路径检查与打开之间的竞态，不能作为生产级多租户文件隔离保证。若 Pod 身份变化且没有准确的停止证据，执行保持 `uncertain`，不会自动复用工作区或重放命令。命令最长运行 60 秒，标准输出和错误输出各最多保留 64 KiB；沙盒回收不保存内存、后台进程或 PTY。
