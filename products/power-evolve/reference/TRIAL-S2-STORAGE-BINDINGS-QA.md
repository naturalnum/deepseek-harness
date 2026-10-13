# S2 C 存储选择与绑定恢复验收

本组使用原生 DSH 工作区弹窗、真实 DeepSeek、PG、POSIX 和本机 k3s。功能验收提交 `b25c683f1e`，数据库 V27。它补齐 [S2 的 C 组](S2-COMPLETION.md)；整组 A–C 随后完成独立备份恢复，并固定为 `1b6e593c44fc7c1623de08285eac7615c0cceec2`。本机结果不代表 S7 目标基础设施通过。

## 真实流程

| 场景 | 实际结果 |
| --- | --- |
| V26 升级 | 从 B 的完整停写备份恢复到独立 C 数据库及文件根，正常启动迁移到 V27。迁移前 488 个文件、5,818,750 字节及两个 Git HEAD 与备份一致；旧会话和产物保留。 |
| 选择已有仓库 | Alice 在应用内浏览器、Bob 在独立 Chrome 登录，通过原生弹窗创建私有目录、选择已有 Git 仓库并新建会话。仓库由验收程序预置，再由页面选择；没有以数据库注入替代选择流程。 |
| 对话与编程 | Alice 的 `hi` 没有创建 Pod。两用户分别要求真实模型编写加法／乘法模块及测试；各自三个云命令成功，两个 unittest 通过，仓库和文件归属分离。 |
| 首次缺失与中断 | 所有命令结束后，验收程序重命名 Alice 的真实目录，未修改 PG 绑定。页面显示缺失，受控文件读取返回 503。选择新目录后，在 PG 已受理时终止该套 QA 的 Platform，再重启。首次暴露空闲回收竞态；修复后以同一请求 ID 重试两次，得到同一回执，绑定由第 1 代恢复到第 2 代。 |
| 连续恢复 | 再次重命名目录，发现完成的恢复请求仍阻挡新请求；修复后，原生页面可再次选择目录。第二次在受理后终止 Platform，重启自动完成，无需人工重试，绑定由第 2 代变为第 3 代。 |
| 写者停止与读回 | 两次恢复都保存了与原 Pod UID、挂载代次匹配的 kubelet 停止证明，旧 Pod 已不存在。原 Session、Workspace ID 保持不变。第 2、3 代均在原会话创建新沙盒，读到原 Git 提交 `ea56dd8`，两个测试再次通过；Bob 仍为第 1 代，提交 `e0a3065` 未变。 |
| 跨用户及路径拒绝 | 真实产品 HTTP 核验 8 项：Bob 不能列举 Alice 存储、查询／发起其恢复或读取其会话文件；本人 README 字节正确；额外伪造身份、路径穿越被拒绝。此项为协议核验，不计作浏览器点击。 |

目录故障由验收程序在命令结束后注入；恢复选择、状态查询和继续编程来自真实客户端。PG 结果与磁盘、Pod 身份另行核对，不以模型的完成文字判断成功。

## 实测驱动的修复与检查

- 空闲回收在每个清理阶段核验当前所有权，恢复请求保留其捕获的写者身份；已被恢复流程占用的工作区不参与空闲候选选择，避免阻挡其他用户回收。
- 恢复完成原子清空当前请求引用，保留历史回执；缺失查询也兼容早期残留的完成引用。真实 PG／POSIX 回归覆盖连续两次恢复。
- 原生工作区列表跟随只读取元数据；实际文件访问和恢复检查才探测目录，避免每秒对所有工作区启动文件系统探测。
- 文件下载绑定准备时的工作区代次；即使换绑后的字节相同，也不能沿旧下载引用跨代读取。

定向自动检查已通过：存储 PG／POSIX 13 项；原生弹窗 Loader 15 项及 Node 7 项；Sandbox 挂载及停止相关 26 项；恢复与实际停止服务组合 1 项；空闲回收竞态及跨用户候选专项；根集成的下载／文件事实／迁移 24 项。并发回归先在旧实现得到预期失败，再验证修复。涉及 FakeKube、确定性时钟或事件 fixture 的自动检查不能代替上表真实流程。相关类型检查、客户端打包、原生云 Web 构建和文档配对检查通过。

## 独立备份恢复

源服务停止且执行、恢复请求全部终态、namespace 无 Sandbox／Pod 后，生成 `~/.config/power-evolve/backups/s2-storage-bindings-v27-20261001-a`。备份包含 558 个条目，停止写入至捕获完成为 1772 ms；这是捕获时间，不是整体服务恢复时间。源保持停止，恢复到新的 PG 库、私有配置和 POSIX 子树。

启动前核对 61 张 PG 表的全部行摘要一致；550 个数据文件、5,876,385 字节及 4 个 Git HEAD 与备份一致。恢复后的原生双用户登录、历史及 Bob 的 README 预览通过；真实 Host RPC 下载两用户 README、可信平台读取原有 5 个不可变产物，字节均与 PG 摘要相同，跨用户文件及产物访问仍返回 404。

Alice 在原会话执行一次真实云命令：原 Git HEAD 未变、两个测试通过，新增 `fixed-restore-check.txt`。实际新 Pod 使用固定 Runner 镜像，并挂载恢复后的第 3 代绑定；文件只存在于恢复根，源目录未被写入。原生内联发布生成第 6 个产物。固定版正常停止并重启后，7 张会话／事件／执行／产物／绑定业务表摘要完全一致，292 个事件、12 个执行和 6 个产物未重复；两用户浏览器及 HTTP 再次读回通过。

## 固定试用

本地标签 `power-evolve-native-s2-v27-trial`，独立 checkout 为 `/Users/jingchao/agent_work/main_agent/power-evolve-s2-v27-fixed`。84,356 个运行／依赖文件和 8,793 个链接通过清单验证；依赖、workspace 链接和启动脚本均指向固定副本。控制器不要求开发分支继续停在相同提交，后续开发可独立推进。

| 项目 | 配置 |
| --- | --- |
| 原生产品／可信登录 | `http://127.0.0.1:19730/native/`／`http://127.0.0.1:19731/login` |
| 服务 | 单 Host、单 Platform；测试 API `19732`，桌面及 MCP／SSH fixture 关闭 |
| PG | 现有端口 `32971`，独立库 `pe_s2_v27_fixed_20261001`，schema 27 |
| 私有配置 | `~/.config/power-evolve/shared-host-s2-v27-fixed`；测试账号 `alice`、`bob`，密码仅在 `users.json` |
| POSIX | `~/OrbStack/docker/volumes/pe-e32-session-shared-posix/pe-s2-v27-fixed` |
| Runner | `pe-s2-runner:fixed-1b6e593c44`，实测 image ID 为 `sha256:98a8e764ab16adcc9d90ca59da69f566225f9b1eee37da3a94bd4a5a55dcfb5a`；启动时核对 |

固定控制器命令如下；每次选择一个动作，`restart` 和离线 `verify` 同样受支持：

```sh
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s2-v27-fixed/.artifacts/power-evolve/s2-v27-fixed/snapshot-tools/fixed-trial.mjs start
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s2-v27-fixed/.artifacts/power-evolve/s2-v27-fixed/snapshot-tools/fixed-trial.mjs status
/Users/jingchao/.nvm/versions/node/v22.22.1/bin/node /Users/jingchao/agent_work/main_agent/power-evolve-s2-v27-fixed/.artifacts/power-evolve/s2-v27-fixed/snapshot-tools/fixed-trial.mjs stop
```

1. 打开可信登录入口，用两个独立浏览器会话分别登录 Alice、Bob。
2. 展开 `Alice Existing Git` 或 `Bob Existing Git`，打开其中已有会话，核对各自编程历史和文件产出。
3. 打开右侧“工作区文件”，预览 README；勾选文件后下载。Alice 可点击最后一轮的 `fixed-restore-check.txt` 内联按钮发布下载。
4. 新建会话发送 `hi`，或在已有会话提出小型编程任务；只有实际命令执行才需要沙盒。刷新后历史与工作区应保留。
5. 从“添加工作区”选择已有私有目录或创建新目录。仅在真实绑定丢失时使用恢复入口；恢复保持原 Session／Workspace ID，不恢复旧进程内存。

固定版服务日志位于其 `.artifacts/power-evolve/s2-v27-fixed/`，控制器日志及清单在其中的 `snapshot-tools/`。验收证据保存在开发 checkout 的 `.artifacts/power-evolve/s2-storage-bindings-qa/`，包括 `final-proof.json`、两次 `accepted-crash`、`fixed-data-before-start.json`、`fixed-execution-proof.json`、`fixed-http-readback.json`、`fixed-restart-before/after.json` 和浏览器快照。固定控制器校验失败时应先核对该副本及私有配置；不要在原库降级 schema，恢复使用保留的备份和独立空目标。

A、B、C 开发组合均已停止；既有 V25／S8 固定试用未改动，Docker 仍为三个既有容器。Runner 的固定标签保留了已验收字节，仍属于 QA 覆盖镜像，不作为完整 Dockerfile 可重复发布的证据。接下来完成受影响路径的云端组合验收；独立物理节点、生产 RWX、外部 PG、生产入口、目标容量及组织身份源继续列为 S7 未完成项。
