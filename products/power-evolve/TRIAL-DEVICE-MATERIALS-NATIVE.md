# Device 材料与 Office 原生会话验收

2026-10-04，通过实际原生 DSH Web、真实 DeepSeek、PG V31，以及四个官方 CLI Profile（一个共享 Host、一个独立 Platform、Alice/Bob 两个 Device）完成本机组合验收。执行基线为 `9276c83603`；文件传输回执修复及复验对应 `7ad0d4a958`。没有替代 Agent、模型、HTTP 路由或执行服务。前序[协议测试](deploy/QA-DEVICE-MATERIALS-OFFICE.md)保留自己的测试范围。

## 实际结果

| 场景 | 核验事实 |
| --- | --- |
| 登录、对话、技能 | 两个独立浏览器身份全新登录、原生输入 `hi`、通过 native `skill` 读取说明；这些 Operation 没有 Cloud 或 Device 执行记录，Docker 没有新增执行容器 |
| 本机授权 | 原生输入区生成一次性配对码；两个 Device 页面分别配对、手动授权不同物理项目目录；原生下拉选择各自设备／目录 |
| 固定材料 | 从原生技能页启用 Word、Excel、PPT 三包 `1.0.2`；十条成功执行都保留原 selection、派发摘要及三份材料绑定。本机两组缓存的完整 manifest、文件摘要、只读权限与精确目录树均符合原发行包 |
| 编程与 Home | Bob 在真实本机容器创建 Git 仓库、提交 Python 实现并运行 unittest；实际停止、重启 Device Profile 后，另一条原生模型调用读回同一 Home 标记、Git 提交并再次通过测试 |
| 三种 Office | Alice 的原生模型调用 `office` 创建、写入 Word／Excel／PPT；实际 OOXML 分别含正文、`SUM(A1:A2)` 与缓存值 42、slide 文本。随后实际 Desktop 命令将三文件转成各一页 PDF、PNG 与文本；Root 检查三页，内容可读，未观察到裁切或重叠 |
| 结果续接 | 十条成功执行的不可变容器、启动许可、已停止事实和停止请求摘要匹配；每条 native call/result、原输入消费和原会话 continuation 消费均为一，continuation 实际完成 |
| 文件与隔离 | 从 Device 页面显式导出三文件到本人默认云工作区，再导入三个新本机文件，逐字节一致；Bob 访问 Alice 文件、历史和技能均为 404，伪造 Alice 设备／目录的输入为 403。重复原请求仍返回原 Operation，不重复执行 |
| 离线、取消、恢复 | 实际停止 Alice Device，原生模型请求持久排队；Bob 取消为 404，Alice 经实际 Host RPC `executionCancel` 取消及重复取消返回原状态。唯一原会话续接完成；没有派发、容器、启动、命令结果或停止记录。重启 Device 并等待实际心跳后仍未执行，目标文件不存在 |

本轮修正 Device 传输界面的目标显示：导入成功回执显示本机目标，导出显示云端目标。第一次真实导入已经落盘，但旧界面仍显示云端源路径；修正后用新路径完成三文件的实际往返复验。没有新增产品页面。

独立只读校验再次查询 PG，确认验收 Session 的执行集合恰为 **10 条成功＋1 条已取消**，并校验两个不同所有者、完整 native 事件、历史材料版本和 Home dev/ino。取消通过真实产品 RPC 验证，不宣称已经有原生异步执行取消按钮。本轮构建 contracts/application/CLI、Device JS 语法、README 翻译配对及正常提交 hooks 通过；纯注释提交消除了 Platform 四个相关文件原有的 50 条导出 JSDoc 缺失，整文件检查通过。不将这些聚焦检查称为整仓门禁。

## 当前本机试用

这是独立数据库、私密配置和 POSIX 根的源码 Profile 验收环境。已有[正式 Cloud 固定试用](TRIAL-FORMAL-IMAGE-LOCAL.md)的镜像、数据库、文件根和端口保持原版本。当前环境没有创建新常驻容器或镜像；Docker 仍只有原有 PG、k3s 两个基础容器，执行容器已清理。一次空闲测量中，四个 Profile 的 RSS 合计约 470 MiB；该值不是容量或长期内存上限。

| 入口 | 本机地址 |
| --- | --- |
| 原生会话 | `http://127.0.0.1:20880/native/` |
| 账号登录 | `http://127.0.0.1:20881/login` |
| 独立审批 | `http://127.0.0.1:20881/approval` |
| Alice Device | `http://127.0.0.1:20891/` |
| Bob Device | `http://127.0.0.1:20896/` |

账号为 `alice`、`bob`，分别使用独立浏览器身份；口令仅保存在本机 `/Users/jingchao/.config/power-evolve/shared-host-device-materials-20261004/users.json`。模型凭据和数据库 URL 不进入 Host、文档、浏览器或命令参数。

1. 在登录入口登录一个账号，选择对应的 `device-materials-alice` 或 `device-materials-bob` 工作区，再点击原有会话。
2. 询问技能说明或发送 `hi`；不创建执行环境。
3. 将执行位置选为 `Local: QA-alice / project` 或 `Local: QA-bob / project`，提交小型 Office 或 Git 任务；等待平台结果自动续接。整页刷新后执行选择回到 Cloud，提交本机任务前须重新选择。
4. 在对应 Device 页面选择相对路径，明确点击导入或导出；传输当前使用本人的默认云工作区，不能选择其他云工作区。
5. 查看原会话历史和本机成果。Alice 授权项目为仓库 `.artifacts/device-materials-integration/device-materials-20261004/posix/local/alice/project/`；Bob 项目在同一根的 `local/bob/project/`。

当前机器的 Root-owned `.artifacts/device-materials-integration/profile-trial.mjs` 已实际执行 `prepare`、`start` 和按角色 `stop/start`。`start` 核对准备时保存的相关构建及 native-web 摘要；源码后续变化时不能把重启当作原版本复验。`stop` 保留私密状态、数据库、Home 和材料，也不代替未知执行的停止证明。角色日志位于 `.artifacts/power-evolve/device-materials-20261004/<role>.log`，操作日志在该私密配置根；读取日志时不输出凭据。

## 证据与剩余范围

本机 `output/playwright/device-materials-profile/` 保存各阶段 JSON、原生页面快照和 PNG；最后的 `profile-validation-1791101003321-5140e232-8169-4503-a54d-fcb26db78635.json` 记录只读校验，`verified-files-transfer.json` 记录成果大小、摘要和往返结果。Root-owned `native-profile.mjs` 与独立工程师编写的 `validate-profile.mjs` 位于上述 `.artifacts/device-materials-integration/`；前者执行浏览器场景，后者仅核对 PG 和材料／Home。浏览器认证状态留在私密配置根，不进入证据目录。

Runner 固定为 `pe-release-cloud-runner:7e2c0067e1-arm64`，实际镜像 ID 为 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`；模型选择为既有 `deepseek-flash`。验收为小型功能成果；本轮不代表复杂 Office 版式、Desktop 报告聚合、进程连接器、原生 Office 预览或 Electron 安装包完成。Mac／OrbStack 的挂载身份已实测，普通 Linux 的 UID 适配和混合版本能力协商仍保留[协议记录](deploy/QA-DEVICE-MATERIALS-OFFICE.md)中的限制。下一组按[桌面补齐约定](DESKTOP-COMPLETION.md)推进。
