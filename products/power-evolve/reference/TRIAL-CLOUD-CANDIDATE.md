# 云端候选版：独立恢复与固定试用

固定提交 `72c7a3a22e50e611510bf3a063673f9ff39598d5`，Schema 27。此版承接[云端组合验收](TRIAL-CLOUD-COMBINED-QA.md)，使用独立 checkout、PG 库、文件根和执行 namespace；原开发验收栈已停止。它是本机固定试用，不代表 S7 生产部署验收通过。

## 冻结与恢复证据

源环境停写后生成 `~/.config/power-evolve/backups/cloud-combined-v27-20261001-a`。目标启动前，61 张 PG 表的全部行摘要、732 个数据文件共 8,633,490 字节、4 个 Git 目录及 9 个私有配置文件与备份一致。凭据只进入目标私有目录，没有写入文档或浏览器证据。

固定副本包含 84,356 个运行与依赖文件、8,793 个内部链接；805 个启动脚本完成重定位。离线清单、7 个 Application 导入和 7 个原生客户端 bundle 字节核验通过。启动控制器核验固定提交、依赖及 Web 文件、两种 Runner 镜像 ID、独立文件根、PG 和受限 kubeconfig；后续开发无需保持在同一提交。

备份首次执行暴露旧 `k8s/platform-rbac.yaml` 缺少列举 Sandbox 的权限，导致停止写者检查被拒绝。`72c7a3a22e` 只补上当前 namespace 的 `sandboxes/list`，与已有正式部署模板一致；备份相关 5 项 Node 检查通过。源、目标作用域实测均允许本 namespace 列举，跨 namespace 仍拒绝。修复后重新完成备份；未绕过检查。

## 恢复后实际验收

| 场景 | 结果 |
| --- | --- |
| 历史及文件 | 两账号全新浏览器登录；真实 Host RPC 对照 PG 历史事件，下载各自 README，读取全部 6 个不可变产物，字节摘要一致。Bob 访问 Alice 文件、产物返回 404。 |
| 新对话 | Alice、Bob 分别发送 hi，经真实 DeepSeek 返回；执行记录保持 19 条、沙盒历史保持 8 条，目标 namespace 无 Pod。 |
| 新云任务 | 两用户各启动一个新 gVisor Sandbox，挂载候选版 POSIX 根；当前绑定分别为 Alice 第 4 代、Bob 第 1 代。Git HEAD、各自同名标记正确，合计 4 个 Python 测试通过。 |
| 恢复的 SSH 连接 | 复用已恢复的连接与加密凭据，经独立可信页面批准具体命令。新 Connector Pod 仅挂载令牌及临时目录；远端返回 `qa-alice`、`/home/qa-alice` 和 `CLOUD_CANDIDATE_SSH_OK`，exitCode 0。 |
| SSH 对账 | PG 记录原 Session 仅续接一次、调用成功且临时资源清理完成；工作区执行记录不增加。真实状态接口读取完整 stdout；Bob 查询该动作返回 404。 |
| 固定版重启 | 正常重启双 Host、双 Platform 后，9 张关键业务表摘要一致，681 条事件、21 次云执行和 6 个产物未重复。两个浏览器重新读回会话，HTTP 文件、产物及 SSH 结果再读通过。 |

SSH 续接的模型总结出现一次未写完的短文。只读诊断确认：46 个 text delta 与 PG 最终内容、浏览器逐字一致；输出仅 46 token，预算 2048；收到正常 `stop`，69 个事件连续完整。原始执行 stdout 完整，本次没有持久化或前端丢尾证据。适配器未保留供应商原始 stop_reason，不能进一步断定其内部原因。协议完成不保证自然语言总结完整，业务成功按可信结果核对。文件扫描对排除路径明确返回 `partial`，不以模型总结中的“未修改文件”或 Git 哈希代替实际结果核对。

随后从原页面显式追问已有结果，模型完整写出 exitCode 0、三行 stdout 和成功结论。该 Session 仍只有一个 SSH 动作，没有重新审批或执行；原来的短回复保留作为生成质量限制记录。

本次聚焦独立恢复后的可用性，账号停用、绑定恢复中断、技能版本挂载、重复请求等受影响路径的失败与恢复证据见组合验收；未重复运行全量矩阵。

## 试用入口与操作

| 项目 | 配置 |
| --- | --- |
| 登录／原生客户端 | `http://127.0.0.1:19756/login`／`http://127.0.0.1:19754/native/` |
| 独立可信审批 | `http://127.0.0.1:19756/approval` |
| 服务 | Host `19750/19753`、Platform `19751/19755`；负载均衡 `19754/19756`，测试 API `19752` |
| 固定 checkout | `/Users/jingchao/agent_work/main_agent/power-evolve-cloud-candidate`，detached HEAD |
| PG | 现有端口 `32971`，独立库 `pe_cloud_candidate_20261001` |
| 私有配置 | `~/.config/power-evolve/shared-host-cloud-candidate`；`alice`、`bob` 密码仅保存在其中的 `users.json` |
| 文件根 | `~/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-cloud-candidate` |
| 执行 namespace | `pe-cloud-candidate`、`pe-connector-cloud-candidate` |
| 固定镜像 | `pe-s2-runner:fixed-1b6e593c44`、`pe-connector-runner:ssh-p24-qa`；确切 image ID 在固定控制器与清单中核验 |

1. 用两个独立浏览器会话登录 Alice、Bob，展开各自的 Existing Git 工作区，查看历史。
2. 新建会话发送 hi，然后要求运行 `git rev-parse HEAD` 或小型 Python 测试；只有实际命令需要执行环境。
3. 在右侧工作区文件中查看 README，下载已有文件；Alice 的旧会话保留 Word 文件及不可变产物。
4. Alice 可要求已有 `combo-alice-readonly` 连接执行 `id -un`；在独立审批页核对目标与具体命令后批准，再返回原会话查看结果。
5. 刷新页面或正常重启后，历史、文件和已完成结果应保留；新命令按需重建已回收的执行环境。

以下每次执行一个动作；同一控制器也支持 `restart` 和离线 `verify`：

```sh
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-cloud-candidate/.artifacts/power-evolve/cloud-candidate/snapshot-tools/fixed-trial.mjs start
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-cloud-candidate/.artifacts/power-evolve/cloud-candidate/snapshot-tools/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-cloud-candidate/.artifacts/power-evolve/cloud-candidate/snapshot-tools/fixed-trial.mjs stop
```

服务日志位于固定 checkout 的 `.artifacts/power-evolve/cloud-candidate/`；离线清单、控制器日志位于其中的 `snapshot-tools/`。恢复与试用证据在开发 checkout 的 `.artifacts/power-evolve/cloud-candidate-freeze/`：`fixed-data-before-start.json`、`execution-proof.json`、`ssh-{pending,observed,final}.json`、`combined-http-readback.json`、`fixed-restart-{before,after}.json` 及浏览器记录。控制器拒绝启动时先核对固定文件及目标配置；需要数据恢复时使用保留备份和新的空目标，不在现有试用库降级 Schema。

## 剩余发布关口

继续使用原生 DSH 与现有 13 个插件入口、6 个可信模块，不新增页面或连接器种类。先完成可重复构建的发布产物，再进行目标基础设施验收；云端稳定后继续桌面。

当前 Runner 是已核验的 QA 覆盖镜像，尚不是完整 Dockerfile 可重复发布证据。k3s、PG 与 POSIX 仍在同一笔记本；独立物理节点、真实跨机共享卷、外部 PG、生产入口、目标容量及组织身份源保持 S7 未完成项。当前网络策略不开放通用外连，不能把本地 Git／测试计为远端 Git 克隆或在线安装依赖验收。SSH 测试目标复用已有 fixture，其 Pod 地址变化后须重新核对目标及主机指纹。

原开发验收栈保持停止，既有固定试用的数据与版本保留。本轮没有新增常驻 Docker 容器，仍复用 3 个基础设施容器。
