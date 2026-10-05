# Mac 安装版与云端 Office 组合试用

本版在实际 `PowerEvolve.app` 中复用原生 DSH 页面，完成云端四格式产物预览、本机 Git／Python、显式文件导出、产物发布及重开。App、Host 运行文件位于源码目录外；平台容器、PG、文件子目录和 k3s namespace 沿用 [O3](TRIAL-NATIVE-PREVIEW-O3.md)，没有复制数据库或执行迁移。不同安装命名空间保存各自浏览器和 Device 状态，并共用本机写入协调根。

## 固定材料

App：`/Users/jingchao/.local/share/power-evolve/trials/desktop-office-20261005-o4-r1/PowerEvolve.app`，桌面实现及 CLI／Device 闭包固定源 `ecaf1855303dc7fa5f32e9972d3e5bef33e84571`，Electron 44.0.0、Node 22.22.1、Python 3.12.14。实际安装模式为 `isPackaged=true`；v2 描述符选定 namespace `office-o3-20261005-r1`。34,094 文件的安装清单 SHA256 为 `969f5f6088af06a408384a777ad6ee580cb6fb4331c0baf9cdca1b6b7d7462ae`，装配记录 SHA256 为 `78765ea832a55d2d7f170a6364de131e7c23140e1d6068ee85c91267fa85803b`。产品签名、公证均未执行。

Host：`~/.local/share/power-evolve/trials/native-office-20261005-o4-r1/`，固定源 `c0cc2443e78069891c1006d9ea5333e63e21c07f`，manifest SHA256 为 `bd80ce629c0c838d4afc36e9fa1e387708650f47e84a3ebf1fe054a47de2e22a`，PG schema V33。平台镜像和解析器仍为 O3 所记录的固定摘要；新 Host 在相同 Origin 连接相同数据库。O3 runtime 保留，但两个版本不能同时占用这些入口；回退先正常停止 O4，再通过 O3 启动器重开。

## 实际验收

| 实际安装应用／模型／PG／Docker／k3s 场景 | 结果 |
| --- | --- |
| 四格式产物 | Alice 查看 PDF／DOCX，Bob 查看 XLSX／PPTX；原生 PDF／Excel 组件显示内容，下载大小与不可变产物 SHA256 一致。首次预览没有 Device Profile 或子进程 |
| 普通对话 | 两账号真实 DeepSeek 输入完成；对应输入没有 cloud／desktop execution，Cloud 页面不启动 Device |
| 本机编程 | 包内 Node／CLI 启动所属 Device；实际 Git 初始化、Python 加法断言及 Git 提交成功，精确容器确认 `Running=false`，原会话唯一续接 |
| 文件与产物 | 本地 1,232 字节合成 DOCX 显式导出到默认云工作区，随后预览、发布、预览产物并下载；本地字节、传输 revision、解析源摘要、PG 元数据与实际 POSIX 产物一致 |
| 用户隔离 | Bob 本人历史 200、Alice 历史 404、设备列表为空；Alice 产物 stat／readBytes／Office RPC 返回业务拒绝，直接下载 404，不新增解析任务 |
| 退出及重开 | 实际应用退出并等待所属 Device OS 进程结束；重开后保留同一配对，读回原 Git 提交和 Python 结果，没有重放原写命令 |
| 安装状态 | 旧安装的 Device 身份与 journal 字节、inode 保留；新安装独立保存状态，共享 writer 槽空闲。业务后完整 App 清单通过，LaunchServices 无驱动参数启动及空闲退出通过 |
| 导航修复 | 旧 Host 实际复现选择工作区后立即 New Session 落入旧工作区；新 Host 在真实 `session/create` 回执暂缓时立即 New，仍只请求所选工作区，新输入绑定该工作区并在原生页面显示回复，无执行沙盒 |

导出原调用已成功，首次列表验收因会话绑定错误工作区而失败。恢复保留原传输回执，没有重放 create-only 导出；导航缺陷随后修复并在独立 Host 上复验。失败记录保留，不能计为通过。合成 DOCX 是已有测试输入，本片不证明本机报告生成或完整报告审核流程。

同一 App 的编程、导出恢复、Bob XLSX／PPTX 和重开先使用 O3 Host 验收；O4 Host 只改变原生工作区导航，新版本复验覆盖慢响应新建会话、Alice PDF／DOCX 及 Bob 越权拒绝。平台、解析器、数据库和 App 字节保持同一版本，材料分别标明 Host 来源。

源码安装配置／Profile 回归 33 项、装配文件系统回归 15 项、真实 Electron 安装分支回归 13 项通过且零跳过。后两组的 Mach-O 材料或 CLI／HTML 服务使用替身，不代替上表的实际应用、模型与执行验收。导航所有者回归 71 项通过；GUI 检查 587 个测试文件通过，9,247 项通过、1 项平台条件测试跳过。叶包类型检查、客户端构建及正常提交 hooks 通过。

## 启停与试用

1. 执行 `~/.local/share/power-evolve/trials/native-office-20261005-o4-r1/node/bin/node ~/.local/share/power-evolve/trials/native-office-20261005-o4-r1/backends.mjs start`；`status` 查询，`stop` 正常停止精确服务并保留数据。存在未终结解析任务时先关闭预览、等待对账；不要同时使用 O3 启动器。Host 为 `http://127.0.0.1:21020/native/`，Platform 为 `http://127.0.0.1:21021/login`。
2. 双击上述 App，或执行 `open ~/.local/share/power-evolve/trials/desktop-office-20261005-o4-r1/PowerEvolve.app`。账号 `alice`／`bob`，密码仅在本机 0600 文件 `~/.config/power-evolve/shared-host-native-office-o3-20261005/users.json`；勿分享该文件。过期登录重新认证，通过原生账号菜单切换账号。
3. Alice 查看 `O3-alice-Artifacts-332a20f2` 中 PDF／DOCX；Bob 查看 `O3-bob-Artifacts-62ba0ea2` 中 XLSX／PPTX。右侧新标签页选择“已发布产物”，范围选择“当前工作区”。Alice 默认 `Workspace` 中还有 `O4-local-report-r1.docx` 文件和产物，可以查看而无需重复导出。
4. Alice 打开本机授权入口，使用已授权项目，在原会话查看 Git／Python 历史，或选择本地执行做新的只读检查。项目在本仓库 `.artifacts/device-materials-integration/desktop-office-20261005-o4-r1/alice/project/`。正常退出、重开，核对配对、历史和成果；勿同时打开相同 namespace 或占用 Device 端口 `18891` 的候选应用。

新安装状态在 `~/Library/Application Support/PowerEvolve-office-o3-20261005-r1/`；共享协调根在 `~/Library/Application Support/PowerEvolve/device-writers/`。日志在 `~/.config/power-evolve/shared-host-native-office-o3-20261005/frozen-logs-o4-r1/` 和精确平台容器日志。保留私有状态和未知执行记录，不通过删除 journal 或 writer 槽绕过恢复。启动仍依赖外部 Docker、已有本机 Runner 镜像、PG、k3s 和私有配置。

原始组合证据在本仓库 `output/playwright/desktop-office-20261005-o4-r1/`，独立 App 试用目录的 `acceptance/` 保存对应快照。早期 O3 证据与 O4 复验来源分别记录；新 Host manifest 中保留的 O3 历史材料不替代 O4 实际验收。最终核对 schema V33、14 个解析任务全部成功且取得 `KUBELET_STOPPED`／空解析槽、零解析 Pod、零未完成输入、零云沙盒及云执行；两次本机执行成功并确认停止，Device journal 和共享 writer 槽空闲。O4 Host／Platform 已 ready；两套确认空闲的旧桌面／O1 试用后台已停止，数据与 runtime 保留。

## 剩余范围

Mac 原生 OS 目录对话框真人选择／取消、产品签名／公证／更新、原生侧栏浏览器、完整 Desktop 报告及通用本机进程连接器继续按[桌面约定](DESKTOP-COMPLETION.md)推进。运行中退出仍使用已有[所属 Device 验收](TRIAL-DESKTOP-OWNED-DEVICE.md)的证据，本片未重做；复杂 Office 排版、旧 DOC／PPT、V33 完整备份恢复、生产 HTTPS 和多物理节点也未新增验收结论。
