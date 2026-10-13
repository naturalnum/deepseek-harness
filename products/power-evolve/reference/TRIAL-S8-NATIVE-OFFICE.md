# 原生 Office 技能定向验收

2026-10-03，在[正式镜像本机固定试用](TRIAL-FORMAL-IMAGE-LOCAL.md)中，从原生 DSH 输入 Word、Excel 和 PowerPoint 技能指令，经过真实 DeepSeek、OfficeCLI、k3s Runner、PG 和原会话续接，生成、渲染并下载成果。应用镜像源码为 `54c4fe23f57258f53682a4500747e986b097c137`；三包版本均为 `1.0.1`。本次没有更换固定镜像或增加应用栈。

## 实际结果

| 账号／技能 | 实际成果与结构读回 | 原会话 |
| --- | --- | --- |
| Alice／`/word-documents` | `office-native-word-20261003.docx`；标题、副标题、三个正文小节、唯一验收标记及页码域；Writer 渲染一页 PDF | `344329f8-4353-4a78-a04d-857340ae52f4` |
| Bob／`/excel-spreadsheets` | `office-native-excel-20261003.xlsx`；`QA Tasks` 工作表含 18 和 24，`B4` 为真实 `SUM(B2:B3)` 公式，缓存值 42；Calc 渲染一页 PDF | `6add3c7b-d2ae-4b97-8fa9-6573e4dc7c42` |
| Alice／`/powerpoint-presentations` | `office-native-powerpoint-20261003.pptx`；两张 slide XML、标题正文、演讲备注与唯一验收标记；Impress 渲染两页 PDF | `d4766908-2308-46bc-8188-e66f223ed121` |

三个 OOXML 压缩包完整，实际 XML 包含预期文字及公式。从原生文件入口下载四张实际渲染 PNG 后逐页检查，文字、数值及版面可读，未观察到裁切、缺字或重叠。检查的是这三个小型成果，不代表字体与指定模板完全一致或 Office 全部功能通过。

Word、Excel 和 PowerPoint 分别记录 23、11、28 次实际执行，每条执行只有一个已完成的可信续接。共 58 次成功、4 次已知失败；模型读到参数或样式错误后提交了修正命令，失败记录保留。没有将失败记作成功，也没有不确定命令的自动重放。Word 验证器无错误，另有四个首行缩进提示；Excel 和 PowerPoint 验证器无错误或提示。

## 隔离与持久记录

每个原生输入恰有一次技能调用记录、一次持久受理及一次输入处理尝试。使用同一请求标识和同一输入再次提交，返回原 Operation；改写输入但保留请求标识返回 409。三个 Session 均无待处理 Operation，62 条执行的结果和续接在真实 PG 中可核对。

实际下载并核对 13 个文件：三个可编辑文件、三个 PDF、三个文本预览和四张 PNG。原生下载的 PNG 与受控读取及不可变产物记录的 SHA-256 一致；本人的产物下载成功，对方产物、13 次文件读取及三个会话历史访问均返回 404。Alice 和 Bob 使用的实际执行 Pod 不同。

成果保留在两个账号各自的“HTTP 编程验收”工作区。可从[原生应用](http://127.0.0.1:19904/native/)登录，进入表中原会话查看结果，再通过文件侧栏读取或下载相应文件。账号与安全登录方式沿用固定试用文档。

## 证据与未覆盖项

本机证据位于 `.artifacts/power-evolve/release-integration/native-office-complete/`：`office-readback.json` 保存执行、去重、下载摘要和跨用户拒绝；`office-structure-visual.json` 保存 OOXML 结构、公式及四页人工视觉检查范围；三个技能子目录保留实际下载文件，`excel-native-result.png` 和 `powerpoint-native-result.png` 保留原生页面截图。`status.mjs` 和 `readback.mjs` 核对原记录；后者仅重复已受理输入进行去重检查，不重新发起生成任务。

本次补齐三包原生技能入口到真实 Office 成果的定向验收。完整技术报告的生成、审核、退回修改、确认及最终 Word／LaTeX 排版仍待完成；OfficeCLI 自带截图路径、复杂表格及演示设计、桌面 Office 路径保持未验收范围。既有[九包验收记录](TRIAL-S8-SKILLS-QA.md)保留原版本与场景，不能用本次小型 Office 成果替代这些未覆盖项。
