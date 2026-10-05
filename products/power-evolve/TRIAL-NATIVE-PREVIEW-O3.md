# 不可变产物原生预览固定试用

本版在现有产物目录中接入原生 DSH 文档侧栏。PDF／XLSX 读取平台保存的不可变字节，DOCX／PPTX 复用 [O2 隔离解析器](TRIAL-NATIVE-PREVIEW-O2.md)；修改原上传文件后，产物预览与下载保持发布时的内容。没有增加产品页面或执行入口。

## 固定版本

Host 源码为 `12673cfbc2cf8255948bb86113cb4b2bc0adfaaf`，PG schema V33。独立 runtime 在 `/Users/jingchao/.local/share/power-evolve/trials/native-office-20261005-o3-r1/`，固定 Node 22.22.1、642 个生产／peer 包、28274 个文件及 515783868 字节；原生目录包含 234 项资源，其中公开静态文件 233 项。含重开证据的 `manifest.json` SHA256 为 `ffd5bc61c8ebe8f39ac7065c82379cb20b40b81da4a05e3795ef2721338fdce7`。启动器核验文件、权限、别名、Profile 与实际服务身份。

Linux Platform 镜像为 `pe-office-app-o3:5d27d2f039-r1`，实际摘要 `sha256:7fe3e004592704f77d0c2bc88a70deb689c6a48c955173e2e4f3dbec0e07e733`，由提交 `5d27d2f03970a0997320ebfc6de86fe168ff8a9c` 的运行文件构建；后续 Host 固定提交的变化为客户端打包、测试及文档。镜像保留已验证的 Linux 依赖闭包，未重新构建完整正式发行镜像。解析器摘要与 O2 相同。本版使用独立 PG、文件子目录、namespace 及平台容器，保留 O1、O2、正式云端及 Mac 安装版本。

## 实际验收

| 真实浏览器／PG／POSIX／k3s 场景 | 结果 |
| --- | --- |
| 普通对话 | Alice 真实 DeepSeek `hi` 完成并从原生历史读回；当时解析任务与通用沙盒均为零 |
| 四格式产物 | Alice 发布 PDF／DOCX，Bob 发布 XLSX／PPTX；替换源文件后，产物仍在原生 PDF／Excel 组件展示 |
| 字节一致 | 下载字节、PG SHA256／大小、实际产物文件一致；重开后源文件仍为替换内容，产物摘要不变 |
| 归属检查 | 两方向跨用户 stat／readBytes／Office 转换与直接下载被拒绝；错误文件名被拒绝，不产生解析任务 |
| 原始会话 | Bob 在同一工作区的另一个会话打开原产物，仍使用产物原始 Session 地址；不可变文档隐藏发布操作 |
| 故障与去重 | Platform SIGKILL 后重启同一容器，对账原 Pod UID／containerId 并终结；同一 RPC ID 只有一个任务、相同 PDF，页面显式重试成功 |
| 独立重开 | 停止源码 Host 和空闲 Platform，使用固定 Node／CLI／Profile 重开；两用户新登录后预览与下载通过 |
| 最终资源 | 共 9 条已成功的解析回执，均有精确停止证明；解析 Pod／槽位、通用沙盒及 cloud／desktop execution 均为零 |

后台定向回归 43 项最终通过、零跳过，使用真实临时 PG／POSIX，Kubernetes／PDF 为替身；包括原文件改删、存储绑定变化、原始会话／摘要／请求身份、损坏字节拒绝、账号撤销与旧请求兼容。Native 读取复查实际 bearer，外层认证后 logout 或 credential version 变更会被事务拒绝；单连接池路径通过。V32→V33 的 5 项真实 PG 迁移检查保留旧行、JSON、时间与停止证明，旧启动器拒绝 V33；升级仍需先停止旧平台进程。Host 原生传输 25/25、客户端目录／发布／成果／API 回归及构建工厂检查通过；应用与客户端类型检查、构建产物门禁、20 项文档检查及正常 hooks 通过。

成功证据在本仓库 `output/playwright/native-office-o3-20261005/`，固定快照 `evidence/` 与 `qa-r1/` 保存验收及重开记录。早期构建与自动化失败不计为通过：浏览器发现的路径工具外置问题已修复并纳入构建工厂门禁；独立审查发现的凭据撤销竞态已修复。选择器、标签页悬停及异步列表等待的失败保留在原始记录中。

## 启停与试用

1. 执行 `~/.local/share/power-evolve/trials/native-office-20261005-o3-r1/node/bin/node ~/.local/share/power-evolve/trials/native-office-20261005-o3-r1/backends.mjs start`；同一命令的 `status`／`stop` 查询或停止精确服务，保留容器和数据。未终结解析任务会阻止正常停服，先从页面关闭预览并等待对账。
2. 打开 `http://127.0.0.1:21021/login`，登录后进入 `http://127.0.0.1:21020/native/`。账号 `alice`／`bob`；密码仅在本机 0600 文件 `~/.config/power-evolve/shared-host-native-office-o3-20261005/users.json`，勿分享该文件。
3. Alice 选择 `O3-alice-Artifacts-332a20f2` 的已有会话；右侧新标签页选择“已发布产物”，预览 `O3-report.pdf`／`O3-document.docx`。上传目录保留验收用替换内容。
4. 另一浏览器会话登录 Bob，选择 `O3-bob-Artifacts-62ba0ea2` 的已有会话；产物范围选择“当前工作区”，预览 `O3-budget.xlsx`／`O3-slides.pptx`。可以在自己的会话上传、预览并明确发布新文件。
5. 停服、重开后再次查看历史和产物。日志在 `~/.config/power-evolve/shared-host-native-office-o3-20261005/frozen-logs-o3-r1/` 及精确容器日志。启动依赖已有 PG、Docker/k3s、kubectl 与私有配置；启动器更新同一 SA 的 12 小时限权令牌，令牌故障伴随未结案任务时使用 `renew` 对账，不重放任务。

## 剩余范围

本片复用 O2 的解析隔离能力，未重新执行网络探针，也未验收复杂 Office 排版、旧 DOC／PPT、V33 完整备份恢复、正式发行镜像、多物理节点或 HTTPS。接下来按[开发计划](DELIVERY-PLAN.md)完成 Mac 安装应用组合；OS 目录真人选择、签名／公证／更新、Desktop 报告与通用本机进程连接器继续保留各自交付范围。
