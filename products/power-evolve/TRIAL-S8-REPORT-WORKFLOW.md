# S8 完整报告流程：本机正式镜像验收

## 验收范围

2026-10-03，应用源码固定为 `20bdcc65efc1d810d12f60bf7bc3eacfc77af047`，官方 DSH 基线仍为 `dsh-v0.1.7-rc.2`。真实 DeepSeek、原生 DSH Web、PG、共享 POSIX 和 k3s Runner 参与流程；材料和封面使用合成 QA 数据。此记录验证报告产品流程，不代表真实业务报告已经获得人工审批，也不代表生产环境部署验收。

原生会话完成项目材料、提纲、三章正文、退回修订、结构化审阅、摘要与关键词、封面确认、最终 Markdown 和 Word 确认。同一最终稿另由 LaTeX 技能导出；该导出不是 orchestrator 子动作，没有新增虚构的 LaTeX 工作流状态。最终 `state.json` 的阶段为 `COMPLETED`，Word 状态为 `confirmed`，待处理动作为空。历史失败和修订记录保留。

## 实际交付

| 成品 | 实际结果 | SHA-256 |
| --- | --- | --- |
| 最终 Markdown，report-1/v2 | 导出前后字节不变 | `a9bd61ebf9c975086d4990a188a4e872765af413b0ae20bbc1ab2d8216ce906e` |
| Word 格式修复版 | 23 页，逐页视觉检查通过，原生文件与不可变产物均实际下载 | `ec3a3db4c023192bde640c22226d86fb1e2a518b2078cbb4a8e1ec597e6c2642` |
| LaTeX PDF | 18 页，全部正式 PNG 重新逐页检查，原生执行产物实际下载 | `a0d6c4feced798e8ef8f8fa114c26a539a1fe5199f3a9861cb3ada93ca487705` |
| LaTeX 工程 ZIP | 7 个安全成员，成员字节与正式文件一致，原生发布并实际下载 | `39c3f3600de86a2001224bf448d1691d5fea7ab8636ac12adb8276241715cdf4` |

Word 使用 `tech-report-writer` 1.1.39。LaTeX 使用 `latex-report-writer` 1.0.5，显式 `portable` 字体模式、两遍 XeLaTeX 和 `-no-shell-escape`；编译、结构和对应字体校验均退出零，无字体告警。中文三段摘要与关键词同页，英文三段摘要正常续页且关键词跟随末段；两图、一表、五个展示公式、四条参考文献及附录完整。此结果不声明 Linux 字体与 macOS 原模板字体完全相同。

可信 PG 核对十次导出与打包执行的真实 Pod UID、Runner instance 和终态；导出清单的 32 个文件及 14 个封面字段与实际字节一致。下载后的 Word、PDF、ZIP 字节匹配 PG 不可变产物记录。Alice 的内容下载返回 200；Bob 的内容、预览和会话产物列表返回 404，匿名内容请求返回 401。Chrome 对 Bob 的二进制直达导航报客户端拦截，不计作产品拒绝证据；拒绝由真实认证 Host 路由确认。

## 试用

报告固定试用已停止，原镜像、schema 27、数据和私有配置保留；当前运行的是[Cloud 结案固定试用](TRIAL-CLOUD-EXECUTION-RESOLUTION.md)。恢复报告试用后使用 <http://127.0.0.1:19934/native/> 及独立可信入口 <http://127.0.0.1:19936/login>，以下步骤适用于该固定版本。测试账号为 `alice`、`bob`；既有密码保存在本机私有投影，不写入本记录。两套应用不能同时启动。

1. 使用 Alice 登录原生入口，打开报告会话及工作区 `report-workflow-live-20261003`。
2. 在原生文件面板展开 `output/word/report-56d7a95315d84799/`，下载 `配电负荷异常识别_QA_技术报告_科技报告_格式修复版.docx`。
3. 在 `output/latex/report-1-v2-a9bd61ebf9c9-r9/` 查看 PDF 或下载 `report-source-r9.zip`；“产物”页保存三份已发布成品。
4. 刷新后查看历史和产物。另一个浏览器使用 Bob 登录；其会话和产物目录不显示 Alice 的报告。

当前原生 Office 文件面板显示预览服务不可用；下载与产物发布正常。Runner 中的 Word 渲染和视觉验收不等于原生 Office 预览已经接通。此预览接线仍属后续产品工作，不以报告成品通过替代。

## 冻结与恢复

正式 `deploy/backup.mjs create` 从在线 2＋2 捕获原 Deployment UID、完整 spec 和副本数，停止 Host 后停止 Platform，并确认没有运行中的任务、Sandbox 或 Connector 写者。format-3 快照位于 `/Users/jingchao/.config/power-evolve/backups/report-final-r9-20261003-a`：schema 27、3,220 个 inventory 条目、73,558,470 字节及全部 34 个历史技能包版本。再次读取快照确认 inventory 与实际文件哈希一致。

该快照实际恢复到新的空库 `pe_report_r9_restore_20261003` 和独立 POSIX 根；源和目标数据库 OID 不同。106 个最新报告、图和导出文件的字节一致，全部历史技能包验证通过，产物、用户技能、历史包、请求及事件五组 PG 记录与来源相同。此窄恢复没有启动第二套应用，也没有重复浏览器或报告生成；既有完整正式镜像恢复证据见 [本机固定试用](TRIAL-FORMAL-IMAGE-LOCAL.md)。

原试用通过同一备份围栏 `resume` 恢复为 2＋2，更新逐 Pod 转发与 loopback 代理。恢复后再次检查本人下载和 Bob 拒绝，三份成品哈希未变。快照包含 PG、四个文件树和私有投影，不包含 OCI 镜像、模型凭据的外部依赖或完整离线工具闭包；不能当作另一物理机器上的灾备已通过。

## 证据与剩余工作

本机证据根为 `.artifacts/power-evolve/release-integration/report-release-r9/`：`export-delivery-verified.json`、`export-delivery-after-resume.json`、`export-manifest-runner-verified.json`、`latex-visual-qa-v2.json`、`final-freeze-verified.json` 及真实浏览器截图；Word 逐页证据保留于 R8 的 `word-visual-qa-v2.json`。R9 的构建、导入和升级记录固定应用与 Runner 镜像引用，并验证升级前后业务数据一致。凭据和备份配置均在仓库外的私有目录。

本机报告切片验收通过。当前版本仍须完成不确定执行的安全结案、设备与目录安全、通用 STDIO、桌面技能及 Office、Mac 正式装配及最终组合验收；生产 HTTPS 和独立物理节点验收保留用户已暂缓的范围。插件数量、单份成品和本机恢复均不代表完整产品已经发布。
