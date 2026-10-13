# 原生 PDF／Excel 预览固定试用

本版可从原生 DSH 工作区文件侧栏打开 PDF 和 Excel。使用真实共享 Host、独立可信 Platform、PG 和 POSIX 文件；预览、上传和历史读取不创建执行沙盒。它是独立浏览器试用版，未替换已有正式云镜像或 Mac 安装应用。

## 固定版本与实际范围

源码固定 `4c30b87c5bd8ce8b6c6a5c95a6543a44271360ef`，数据库为 schema V31，本片没有新增迁移。独立 runtime 位于 `/Users/jingchao/.local/share/power-evolve/trials/native-preview-20261005-o1/`，包含 Node 22.22.1、Python 3.12.14、643 个生产／peer 依赖包及 233 项原生静态资源。服务通过固定 CLI 的正式 DSH Profile 启动，不读取源码目录的运行包或静态资源。

`manifest.json` SHA256 为 `05f90d95a867c5b218ae6da031f770da0accae3b376aa99acd6892444ca28be7`。闭包清单记录 28,247 个文件、515,356,812 字节；包外另核对固定解释器、操作脚本和验收记录。启动器检查完整文件字节、权限、相对别名与独立 Profile 摘要。PG、私有配置、文件根和 macOS 是外部依赖，未复制凭据进 runtime。

| 真实原生浏览器／PG 验收 | 结果 |
| --- | --- |
| 对话与上传 | Alice 的真实 DeepSeek `hi` 完成；Bob 新建工作区后在首次对话前立即上传成功 |
| PDF | 原生 PDF Worker 显示文档文本和画布；关闭／重开成功，关闭后 Worker 终止 |
| Excel | 显示中文工作表与单元格；D4 读回缓存公式结果 520，保留原生公式提示 |
| 动态资源 | PDF／Excel sibling chunks 实际 HTTP 200；两者均使用 owner revision `aa605a54f3dce009` |
| 损坏文件 | 无效 PDF 显示解析错误，关闭后释放 Worker，随后可打开正常文件 |
| 双用户与去重 | 同名 PDF 的字节、内容和所属工作区不同；两个方向越权读取被拒绝；重复上传返回同一结果，PG 只有一项文件 mutation |
| 同浏览器换号 | 另一标签登录 Bob 后唤醒原 Alice 页面，身份探测触发完整页面重载；旧 PDF 与用户缓存消失 |
| 无执行环境 | PG 的 sandbox instances、cloud executions、desktop executions 三表均为零 |
| 固定版重启 | 独立 runtime 读回原 `hi` 历史和 PDF；授权 API 字节摘要与实际 POSIX 文件一致，预览和 Worker 回收正常 |

换号验收在真实页面切到前台后显式派发 focus 事件，身份查询、页面重载和拒绝结果均来自真实服务。它不声称覆盖所有系统窗口唤醒方式。Excel 本片验证已有缓存结果，不宣称重新计算公式。

替身回归单独记录：HTTP／FS CSP 6/6、模块 loader 98/98、物理静态资源构建 6/6、账号生命周期 13/13、文件 GUI 6/6 和上传客户端 2/2，均无跳过。相关叶类型检查、包构建、lint、JSDoc、双语记录及正常提交 hooks 通过；真实试用结果以上表为准。私有浏览器证据在本仓库 `output/playwright/native-preview-20261005/`；`render.json`、`bob.json`、`frozen.json` 为通过记录，早期探索失败另保留，不计作通过证据。

## 启停与试用

1. 执行 `~/.local/share/power-evolve/trials/native-preview-20261005-o1/node/bin/node ~/.local/share/power-evolve/trials/native-preview-20261005-o1/backends.mjs start`。同一路径的 `status` 查询状态；`stop` 只停止本版经 PID 与 instanceId 验证的 Host／Platform，保留库和文件。不要再启动原源码试用 Profile 占用相同端口。
2. 打开 `http://127.0.0.1:20985/login`，登录后进入 `http://127.0.0.1:20984/native/`。账号为 `alice`／`bob`，密码仅保存在本机 0600 文件 `~/.config/power-evolve/shared-host-native-preview-20261005/users.json`，勿分享该文件。
3. Alice 选择 `O1-Alice-Preview` 工作区及已有会话，打开右侧“工作区文件”，展开 `uploads` 下的上传目录，分别打开 `O1-report.pdf` 和 `O1-budget.xlsx`。可查看 PDF 页面和中文预算表，再关闭、重开。
4. 在另一浏览器会话登录 Bob，选择 `O1-Bob-Immediate`，查看同名 PDF 的不同内容。可新建工作区立即上传小型 PDF／Excel；当前受控读取上限为 2 MiB。使用已有损坏 PDF 可检查错误提示及正常文件重开。
5. 正常停止、重启本版，再登录原账号查看历史和文件。日志位于 `~/.config/power-evolve/shared-host-native-preview-20261005/frozen-logs-o1/`，配置及独立 Home 在相邻私有根内。启动失败时先检查日志与资源状态，不删除 PG 或文件根来绕过恢复。

## 尚未完成

Word／PowerPoint 到 PDF 的原生转换、不可变产物的 Office 预览，以及上述能力在 Mac 安装版中的组合验收继续按[桌面约定](DESKTOP-COMPLETION.md)推进。本片没有给 Host 开放本地 Office 进程，也未修改原生预览页面。Mac OS 目录选择／取消、产品签名／公证／更新、Desktop 报告和通用本机进程连接器仍保留各自交付范围；本机 HTTP 结果不替代生产 HTTPS、物理多节点或容量验收。
