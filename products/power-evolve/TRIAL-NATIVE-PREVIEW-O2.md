# 原生 Word／PowerPoint 预览固定试用

本版复用原生 DSH 文档侧栏，将工作区 Word／PowerPoint 文件交给独立可信 Platform，按需创建一次性解析 Pod，完成后在原生 PDF 组件中展示。共享 Host 不运行转换程序，普通对话不创建解析 Pod。它是独立本机 HTTP 浏览器试用，保留此前云端正式镜像、O1 及 Mac 安装应用。

## 固定版本与实际范围

源码为 `db0011e8211df99ef272aec0eac0d650be5e16c0`，数据库为 schema V32。Host 独立 runtime 在 `/Users/jingchao/.local/share/power-evolve/trials/native-office-20261005-o2-r5/`，使用固定 Node 22.22.1 和正式 DSH Profile，包含 642 个生产／peer 包及 234 项原生资源。闭包清单记录 28266 个文件、515727625 字节；`manifest.json` SHA256 为 `bd981321653f3293d739ab833958d9dc8b9e5df2da3f559032d0c3fde58d998b`。启动时核对文件、权限、别名、Profile 及 Linux Platform 的精确容器／镜像身份。

Linux Platform 使用独立本地镜像 `pe-office-app-o2:db0011e821-r5`，实际配置摘要为 `sha256:65526078e2b3af35aa6959f7bf3fbfd95d040826586a4794bcc0e6bfce33a478`。它保留已验收的 Linux 生产依赖闭包，并覆盖本提交的应用、契约、内置目录及 Profile；本记录不声称重新构建全部正式发布镜像。解析器固定为 `docker.io/library/pe-office-preview-o2@sha256:262fa83613d2585c68d1d6275647733763e5423510af77ec6da97d3fdf431828`，Linux ARM64，离线 WASM 后端。真实单节点 containerd 已预载此摘要；本机结果不代替多节点镜像拉取验收。

| 真实原生浏览器／PG／k3s 场景 | 结果 |
| --- | --- |
| 普通对话 | 初始 Alice 真实 DeepSeek `hi` 时两类实例均为零；最终固定版再次 `hi` 完成，解析任务数及通用实例数均未增加 |
| Word／PowerPoint | 两用户分别上传 DOCX／PPTX，原生 PDF 画布和文本显示中文／英文；HTTP PDF、PG 摘要与实际 POSIX 字节一致 |
| 隔离与去重 | 两方向跨用户 Session 转换被拒绝，不产生任务；重复同一 RPC ID 返回相同 PDF，每个 ID 只有一条 PG 任务 |
| 解析权限 | 实际 Pod UID 1000、有效 capabilities 为零、无 SA token、无共享存储根；Root 维护探针访问 Platform 超时，deny-all 生效 |
| 取消／损坏文件 | 关闭正在转换的文件取消任务；无效 DOCX 显示原生错误，两者均保存精确停止证明、删除 Pod 并释放槽位 |
| Platform 强制退出 | SIGKILL 后重启同一容器，新进程对账原 Pod UID／containerId 并收回 PDF；不自动创建替代 Pod。原页面显示暂时不可用，点击“重试”以新请求重新预览成功 |
| 原阻断任务恢复 | 两个真实任务自动记录 generation 2 的原 Pod 停止证明、移除 finalizer 并释放槽位；任务因等待超时终结，没有人工改状态或释放槽位 |
| Kubernetes 令牌故障 | 真实 401 后由固定 `renew` 更新同一 SA 令牌，同一容器／原 Pod 自动对账成功；原请求与页面显式新请求均成功预览，无替代 Pod 或盲目重放 |
| 资源回收 | 所有转换终结后无解析 Pod／占用槽；通用 sandbox、cloud execution、desktop execution 均为零 |
| 固定版启停 | 独立 Node／闭包启动、正常停服／重开、最终版真实 hi、两用户预览与重开后 Bob 读回均通过 |

解析 Pod 的网络探针由 Root 使用管理工具执行，用户工具不具备此能力。字体缺失名称已随 PDF 返回；本片只验证样例中文／英文及声明缺失字体，未验证所有文档排版、旧 DOC／PPT 或复杂字体组合。

相关回归为 Office 生命周期／Pod 在第一项修复提交上 36/36，最终宽限期增量的 Pod 回归 12/12、Host／Config 28/28、可选部署及完整接线 14/14，均无跳过；它们使用真实隔离 PG／POSIX及必要的 Kubernetes／PDF 替身，不能替代上表的真实验收。应用类型检查、作者的定向 lint／文档检查和正常 hooks 已通过。私有浏览器证据在本仓库 `output/playwright/native-office-o2-20261005/`，固定 runtime 的 `qa-r5/` 保存最终候选记录，`evidence/` 保留此前通过范围；早期自动化选择器失败与包装探索记录不计为通过。

## 启停与试用

1. 使用 `~/.local/share/power-evolve/trials/native-office-20261005-o2-r5/node/bin/node ~/.local/share/power-evolve/trials/native-office-20261005-o2-r5/backends.mjs start`；同一路径 `status`／`stop` 查询或停止。只操作固定 Host PID／instanceId 和精确 Linux containerId，不删除容器、PG、文件卷或任务。存在未终结解析工作时停止会拒绝，应先从页面关闭预览并确认完成；不通过删除记录绕过。
2. 打开 `http://127.0.0.1:21011/login`，登录后进入 `http://127.0.0.1:21010/native/`。账号 `alice`／`bob`，密码仅在本机 0600 文件 `~/.config/power-evolve/shared-host-native-office-o2-20261005/users.json`，勿分享此文件。
3. Alice 选择 `O2-alice-Office-792099b2` 及已有会话，打开右侧“工作区文件”，展开 `uploads` 和上传目录，打开 `O2-document.docx`；可查看 PDF，再关闭／重开。另一个浏览器会话登录 Bob，选择 `O2-bob-Office-5ac154ef`，查看 `O2-slides.pptx`。
4. 可上传自己的小型 DOCX／PPTX。当前配置输入上限 2 MiB、PDF 8 MiB、转换 120 秒，一个解析槽、1 CPU／3 GiB 限额；这些是资源预算，不是实测峰值或容量承诺。打开现有无效 DOCX 检查错误提示，随后打开正常文件。
5. 正常停止、启动后读回原历史和文件。日志在 `~/.config/power-evolve/shared-host-native-office-o2-20261005/frozen-logs-o2-r5/` 及精确容器的 Docker 日志。Linux Platform 的本地 namespace 限权测试令牌为 12 小时，完整停服后启动会重新签发并原子更新；令牌失效且有未结案解析工作时，使用同一固定启动器的 `renew`：它停下精确 Host／Platform、核验原任务与 Pod、更新同一 SA 身份的限时令牌，再对账原任务；不写入任务结果或盲目重跑。本机启动器依赖已有 PG、Docker/k3s、kubectl 和私有配置。生产使用逐请求读取的 in-cluster 投射令牌，不沿用本机静态令牌方案。

## 保留的范围

数据库终态回执保留历史，派生 PDF 缓存不纳入部署备份；恢复后新请求重新授权并转换，不盲目重放旧任务。缓存缺失及满保留额度已有真实 PG／POSIX＋Kubernetes 替身回归，V32 完整备份恢复尚未实际验收。

下一组接入不可变产物 Office 预览及 Mac 安装应用组合，不增加新的产品页面。当前解析 Pod 使用本机容器运行时；本记录不声称 VM 隔离、生产 CNI／HTTPS、独立物理节点或规模容量通过。OS 目录对话框的真人选择仍待解锁验证，签名／公证／更新、Desktop 报告及通用本机进程连接器保留各自交付范围。
