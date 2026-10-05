# Desktop 完整报告纵切面

本片在[桌面浏览器固定版](TRIAL-DESKTOP-BROWSER.md)之后推进，复用已有原生技能、执行位置、本机授权、文件导出和产物入口。先交付三章 Word 报告的完整业务流程；LaTeX Desktop 出口继续保留，不能由 Word 结果宣称通过。此文是实施约定，功能未验收时不标为完成。

## 固定接口与归属

| 所有者 | 修改范围 |
| --- | --- |
| Root | contracts Device DTO、共享 `device-report-suite.ts`、Profile／schema、版本集成、真实组合验收与安装材料冻结 |
| Platform／Host | `platform/skills.ts`、`runtime-skills.ts`、`devices.ts`、`host/skills.ts` 及定向测试；保持 Cloud 套件原语义 |
| Device | `device/materials.ts`、`worker.ts` 及材料、请求摘要和旧 journal 回归；Device README 配对 |
| 报告资产 | 四包的确定性质量门、状态保存及测试；目录生成脚本和生成材料；不修改 DTO／Profile／schema |

Device dispatch／job／claim 增加可选 `reportSuite`：`schemaVersion=1`、SHA256 `digest` 和固定顺序的四个 `{role, skillId}`。角色依次为 `report-workflow-orchestrator`、`power-grid-technical-report-writer`、`report-reviewer`、`tech-report-writer`。描述必须引用同一 dispatch 的 `materials`；摘要由共享函数覆盖每个角色及完整 material binding。缺字段的旧记录保留 JSON 与请求摘要，不把缺字段补成空套件。新描述需要支持它的 Device，旧 Worker 不能消费它。

Platform 根据已受理 Operation 的四个包及真实内置安装回执解析描述；名称相同不足以取得套件身份。每个包继续按当前用户、固定版本和撤销状态校验。完整合格套件的 Host 路径为 `/opt/power-evolve/skills/report-suites/<digest>/<role>`；不完整选择保留普通包路径。Desktop 不创建 Cloud 套件文件，也不启动执行环境来读取技能说明。

Device 验证描述摘要，复用原来的逐包缓存和授权读取，把四个已验证的 `skill/` 目录各自只读挂到上述同级目录；原逐包挂载及持久 Home 保留。描述纳入原请求摘要，重试和恢复核对原材料；描述本身没有执行权限。

## 用户流程与验收出口

1. 安装并启用四个报告技能，选择本人 Device／授权目录。普通说明仍无执行环境；真实模型通过 `desktop_exec` 在授权项目内使用文件化工作流，不增加报告页面。
2. 使用新任务书和研究材料完成四问、项目档案、论证架构、目录、章节计划、三章正文和结构化审核。实际退回一章并形成新版本；确认由用户明确推进，审核失败不能跳过。
3. 完成全文、摘要、封面和 Word 排版，生成真实 DOCX、PDF／PNG。结构校验与逐页检查绑定当前 Word 版本，页码必须恰覆盖 `1..N`；渲染退出 0 不代替视觉检查。状态保存采用同目录临时文件、文件同步、原子替换和目录同步。
4. 显式导出 Markdown、DOCX 和检查 PDF，原生文件入口预览、发布不可变产物并下载。核对实际本机字节、传输 revision、PG 元数据及下载摘要；不宣称已有 Cloud 成果行支持所有 Desktop 成果。
5. Alice 完成三章及修订，Bob 完成本人独立小型报告；跨用户文件、历史、设备和产物拒绝。阶段间正常退出／重开，以及一次执行中退出按原停止事实恢复，不盲目重放未知写命令。

定向测试覆盖缺包／伪造内置来源／撤销、摘要变化、旧 dispatch、缓存损坏、状态提交失败及缺页／错页／旧版本审核。真实 Docker 验证四个只读同级挂载和跨包质量门；真实 App／模型／PG 验证上述业务流程。确认执行、解析器、journal 与 writer 槽收尾后，固定独立试用；替身测试不能代替这些验收。
