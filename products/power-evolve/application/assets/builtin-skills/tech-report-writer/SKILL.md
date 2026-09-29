---
name: tech-report-writer
description: 编写、重排或校验中国电力科学研究院科技项目、咨询项目技术报告，基于任务书、研究资料、用户说明或已有 .docx，生成符合院技术报告管理办法的 Word 文件；用于新建完整技术报告、调整已有报告格式，以及校验封面、审批页、中英文摘要、目录、正文、附录、参考文献、页眉页脚和分节页码
---

# 科技项目技术报告编写


## 0A. 外部编排兼容层

当请求包含 `orchestration.enabled=true` 时，本 Skill 作为 `report-workflow-orchestrator` 的 Word 排版子 Skill 运行。此模式不改变下文原有的新建报告、调整已有报告和验收规则，只增加统一动作接口与结构化交接。

### 外部动作接口

```yaml
external_actions:
  create_word_report:
    purpose: "把已审核并经用户确认的最终 Markdown 报告转换为规范 DOCX"
  format_existing_word_report:
    purpose: "根据格式校验或视觉验收问题修复当前 DOCX，不改写专业内容"
  validate_word_report:
    purpose: "执行 DOCX 结构校验、渲染和逐页视觉验收"
```

所有动作统一接收：

```yaml
orchestration:
  enabled: true
  request_id: "唯一请求编号"
  caller_skill: "report-workflow-orchestrator"
skill_name: "tech-report-writer"
action: "create_word_report | format_existing_word_report | validate_word_report"
payload: {}
```

### `create_word_report`

输入至少包含：

```yaml
payload:
  source_report:
    artifact_id: "最终 Markdown 报告产物 ID"
    version: 1
    content: "Markdown 字符串或包含 markdown/path 的对象"
  report_context: {}
  word_metadata:
    report_no: ""
    class_no: ""
    secret_level: ""
    project_source: ""
    title_cn: ""
    title_en: ""
    project_name: ""
    series_no: ""
    cooperator: []
    report_date: ""
    work_period: ""
    leader: ""
    staff: ""
    writer: ""
  outline: {}
  abstract: {}
  approved_chapters: []
  reference_plan: {}
  output_preferences:
    output_dir: "调用者工作区下的输出目录"
    output_filename: "可选 DOCX 文件名"
```

执行要求：

1. 只使用已经通过全文审核并经用户确认的版本；
2. 优先使用 `approved_chapters`、`abstract` 和 `outline` 生成结构化 JSON；最终 Markdown 只作为补充或兜底；
3. 在 Markdown/HTML 写入 Word 前执行确定性公式归一化：`$...$`、`\(...\)` 转为行内 Word 原生 OMML，`$$...$$`、`\[...\]` 转为独立 OMML；显示公式中的 `\tag{章-序号}` 拆为公式对象和右侧 `（章-序号）` 编号。不得把 LaTeX 源码或内部公式标记作为普通文本写入 DOCX；转换失败时阻断生成，不得降级为可见 LaTeX；
4. 不改写、删减或补充专业内容；
5. 调用现有 `validate-cover`、`validate-outline`、`validate-abstract`、`validate-chapter` 和 `create-report`；
6. 输出 DOCX 后先执行结构校验，再进入 `validate_word_report`；
7. 返回 `artifact_type=word_report` 的结构化产物。

### `format_existing_word_report`

输入当前 DOCX 路径和上一次校验问题，调用 `scripts/format_existing_report.py` 另存为新版本。不得覆盖上一版，不得修改专业内容。完成后返回新的 `word_report` 产物，并再次进入 `validate_word_report`。

### `validate_word_report`

必须同时完成：

1. `scripts/main.py validate-report <docx>` 的结构校验；
2. 将 DOCX 渲染为 PDF 和逐页 PNG；
3. 在 100% 缩放下检查每一页；
4. 检查封面、审批页、摘要、目录、正文、附录、参考文献、页眉页脚、页码、表格和分页；
5. 只有结构校验通过且逐页视觉检查通过，才能返回 `decision=pass`。

结构化结果：

```yaml
validation_result:
  validated_artifact_id: ""
  validated_version: 1
  decision: "pass | revise | blocked"
  valid: true
  docx_path: ""
  structural_validation:
    passed: true
    errors: []
    warnings: []
  visual_qa:
    status: "passed | failed | blocked"
    page_count: 0
    inspected_pages: []
    render_dir: ""
    issues: []
  revision_instruction: ""
```

没有逐页视觉检查记录时，不得返回 `pass`。

### 外部响应

创建或修复 Word 报告时返回：

```yaml
request_id: ""
skill_name: "tech-report-writer"
action: "create_word_report | format_existing_word_report"
status: "success | blocked | failed"
artifact:
  artifact_type: "word_report"
  artifact_id: ""
  version: 1
  content:
    docx_path: ""
    source_report_artifact_id: ""
    source_report_version: 1
  summary: ""
metadata: {}
error: null
```

校验时返回 `validation_result`，不得用普通文本“已检查”代替结构化结果。

根据用户提供的任务书、研究资料、说明或已有 `.docx`，生成或重排符合中国电力科学研究院技术报告管理办法的 Word 报告。

## 开始前

1. 必须完整读取 [references/technical-report-format.md](references/technical-report-format.md)。
2. 需要数据结构、HTML 样式、模板映射或目录操作时，读取 [references/guide.md](references/guide.md) 的对应章节。
3. 以格式规范为准；指南或模板与格式规范冲突时，按格式规范处理。
4. 先判断任务模式：已有 `.docx` 只需统一格式时走“调整已有报告”；需要从资料生成内容时走“新建完整报告”。
5. 从用户当前工作区运行脚本。所有中间 JSON 和最终 DOCX 默认写入当前工作区的 `output/`，不要写入 Skill 安装目录。
6. 首次执行前运行 `python3 <skill-dir>/scripts/check_environment.py`。缺少 Python 依赖时，先征得用户许可，再按 `requirements.txt` 安装。

## 不可违反的约束

- 在当前对话中直接完成所有总结、分析和撰写，不调用外部写作 API 或子 agent。
- 只依据用户提供的任务书、研究资料和明确说明撰写专业内容。
- 不把模型生成内容冒充真实项目数据、真实试验结果、项目成果、参考文献或已验证结论。对于上游已明确标记为“参考实验/模拟实验/示例数据/参考结果”的内容只负责保留并排版，不得因其不是实测数据而删除、改写或阻塞 Word 生成。
- 只调整已有报告格式时，不改写、删减或补充专业内容；如发现疑似内容错误，只列出问题并请求用户决定。
- 已有报告始终另存为新文件，不覆盖源文件。
- 不自动生成图表。在正文中插入图表占位符，提示用户在 Word/WPS 中替换。
- 由 Word 模板和生成脚本控制页面、页边距、页眉页脚、页码及分节，不仅依赖 HTML 样式。
- 最终 Word 的公式必须是 Word 原生 OMML 数学对象；正文和表格可见文本中不得残留 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`\frac`、`\sum`、`x_{i}` 等原始 LaTeX 表达，也不得残留 `[[TECH_REPORT_*MATH_B64:...]]` 内部标记。
- 每生成一个 JSON 文件立即校验；校验失败时修复并重试，验证通过后再继续。
- 最终必须执行 DOCX 格式校验和逐页视觉检查。

## 调整已有报告

用户提供已有 `.docx` 且主要诉求是统一格式时，执行本节后直接进入“验收”。

1. 确认输入文件，默认将结果写入当前工作区的 `output/<原文件名>_格式调整版.docx`。
2. 保留正文内容、表格、图片及原生 Word 公式，只统一页面、分节、页眉页脚、目录样式、标题、正文、图表题和表格格式。
3. Markdown/HTML 中的 LaTeX 公式或本 Skill 的内部公式标记转换为 Word 原生 OMML 时需要 `pandoc`；已有文档中的原生 Word 公式不依赖 `pandoc`。
4. 运行：

```bash
mkdir -p output
python3 <skill-dir>/scripts/format_existing_report.py \
  <输入报告.docx> output/<原文件名>_格式调整版.docx
python3 <skill-dir>/scripts/main.py validate-report \
  output/<原文件名>_格式调整版.docx
```

5. 按“验收”逐页检查。若校验或视觉检查失败，修复后重新生成，不要把未通过验收的文档交给用户。

## 新建完整报告工作流

### 0. 收集输入

优先读取以下资料：

- 任务书（`.docx`、`.pdf`）
- 研究资料（`.docx`、`.pdf`、`.txt` 等）
- 用户对主题、结构和篇幅的说明

没有任务书时，至少确认项目名称、研究方向、主要内容和期望章节结构。不要用推测补齐专业事实。

### 1. 确认封面信息

从资料中提取可确定字段，并单独询问无法推断的字段：

| 字段 | 处理规则 |
|---|---|
| `report_no` | 必须由用户提供 |
| `class_no` | 必须由用户提供 |
| `secret_level` | 必须由用户提供 |
| `project_source` | 从任务书提取；未提供时确认是否使用默认值 |
| `title_cn` | 根据核心研究内容提炼，不能机械照搬任务书标题 |
| `title_en` | 翻译已确认的中文标题 |
| `project_name` | 从任务书提取或适度提炼 |
| `series_no` | 按资料填写；不适用时留空 |
| `cooperator` | 按资料填写；多个合作（协作）单位使用字符串数组，每个单位独占一行；不适用时留空 |
| `report_date` | 使用当前年月，如 `2026年7月` |
| `work_period` | 从任务书提取或询问 |
| `leader`、`staff`、`writer` | 从资料提取或询问；多人用中文顿号分隔。仅在最终 Word 的审批页中，两字中文姓名须在两个字之间加入一个半角空格，例如“张三”排为“张 三”；三字及以上姓名不加空格，其他页面的人名保持原样 |

汇总展示全部封面字段，等待用户确认。确认后写入 `output/cover_info.json`，数据结构见 [references/guide.md#数据文件格式](references/guide.md#数据文件格式)，然后运行：

```bash
python3 <skill-dir>/scripts/main.py validate-cover
```

### 2. 生成并确认大纲

根据资料设计章节结构。通常包括：

1. 研究背景与意义
2. 研究内容、目标与技术路线
3. 若干核心研究章节
4. 结论与展望

列出章、节标题及每节要点，等待用户确认后再继续。将确认结果写入 `output/outline.json`，然后运行：

```bash
python3 <skill-dir>/scripts/main.py validate-outline
```

### 3. 撰写摘要与关键词

根据已确认的大纲和资料撰写：

- 中文摘要：本排版子 Skill 直接排版上游已经通过内容生成与审核流程确认的中文摘要，不在排版阶段重新裁决或改写其字数、段落数、句数、写作人称和内容要素；上游摘要约束仍由 `power-grid-technical-report-writer` 与编排流程执行。不要重复模板已有的“内容摘要”标题。
- 英文摘要：本排版子 Skill 直接排版上游已经确认的英文摘要，不在排版阶段重新裁决或改写英文词数、段落数、句数及中英文内容对应关系；相关内容约束由上游生成与审核流程执行。不要重复模板已有的 `ABSTRACT` 标题。
- 中文关键词：沿用上游已确认的关键词及顺序，本排版子 Skill 不重新决定关键词数量或内容，仅按版式要求使用全角分号 `；` 分隔。
- 英文关键词：沿用上游已确认的英文关键词及顺序，本排版子 Skill 不重新决定关键词数量或内容，仅按版式要求使用半角分号加空格 `; ` 分隔。
- 摘要与关键词按既定结构顺序排版，允许根据实际内容长度自然分页，不要求中英文摘要及关键词位于同一页。

写入 `output/abstract.json`，然后运行：

```bash
python3 <skill-dir>/scripts/main.py validate-abstract
```

### 4. 逐章撰写正文

按大纲顺序生成 `output/chapter_1.json`、`output/chapter_2.json` 等。每章使用 `num`、`title` 和 `content_html` 字段；完整样式与示例见 [references/guide.md#正文格式完整示例](references/guide.md#正文格式完整示例)。

严格遵守以下排版规则：

- 一级标题使用 15pt 黑体并包含 `page-break-before:always`，保证每章另起一页。
- 二级标题使用 14pt 黑体，三级标题使用 12pt 黑体。
- 正文使用 12pt 宋体、1.5 倍行距、首行缩进 2 字符；**独立公式后的第一个实际文字段落首行不缩进**，该例外仅作用于紧随公式的段落。
- 正文段内的标点、括号、百分号、温度/角度符号、`±`、`×`、`÷`、比较符号及常用希腊字母等普通文本符号，最终 Word 必须由代码统一字体槽和字号：与所在正文保持 12pt，中文/全角字符使用宋体字体槽，西文、数字及常用技术符号使用 Times New Roman 字体槽；不得让单个符号继承 Calibri、Cambria、微软雅黑或模板 theme 字体。OMML 公式、上下标和上标参考文献不套用这一普通文本规则。
- Markdown/HTML 中的行内与显示公式必须在进入 Word 排版器时先转换为内部公式标记，再由确定性转换器写成原生 OMML；该规则同时覆盖正文段落和表格单元格。行内代码中的 `$...$` 不作为公式转换。未编号显示公式仍必须转为居中的原生 OMML，不得因为没有公式编号而保留 LaTeX 文本。
- 只将前三级标题设为标题样式；`（1）`、`1）`、`①` 等按正文处理。
- 标题编号与文字之间空一格。
- 图占位符输入仍放在图题正上方，例如：

```html
<p style="font-family:宋体;font-size:10.5pt;text-align:center">【此处插入图1-1】</p>
<p style="font-family:黑体;font-size:10.5pt;text-align:center">图1-1 技术路线示意图</p>
```

  生成 Word 时，`report_generator.py` 必须把 `【此处插入图X-X】` 确定性替换为白底、黑色细边框、无任何文字内容的矩形图框；图题仍紧接在白框下方。除非用户明确提供真实图片并要求替换，不得在白框内自动绘制技术路线、箭头、节点、文字或模拟曲线。

- 表题放在表格上方；图、表和公式按章连续编号。
- 正文引用参考文献时采用 GB/T 7714—2015 顺序编码制，使用上标 `[1]`、`[2,3]`、`[4-6]` 等格式。

每章写入后立即运行：

```bash
python3 <skill-dir>/scripts/main.py validate-chapter N
```

### 5. 整理附录（可选）

没有附录时跳过。存在附录时：

- 从 `A` 开始连续编号，每个附录另起一页。
- 标题写作“附录 A 标题名称”。
- 附录内标题、图、表和公式分别使用 `A1`、`A1.1`、`图A-1`、`表A-1`、`（A-1）` 等编号。
- `content_html` 只放正文，不重复附录总标题。

写入 `output/appendices.json`，然后运行：

```bash
python3 <skill-dir>/scripts/main.py validate-appendices
```

### 6. 整理参考文献（可选）

没有引用且用户不要求参考文献时跳过，不生成空白参考文献页。存在引用时：

- **统一按 GB/T 7714—2015 顺序编码制整理**，不得混用 APA、MLA、Chicago 或其他文后著录样式。
- 从 `[1]` 开始连续编号。
- 每条空两个汉字起排，回行顶格。
- 每条正式参考文献应包含对应文献类型标识，并以句点 `.` 结束。
- 调整已有 Word 时同样执行该规则；若原参考文献无法仅凭现有元数据安全转换为 GB/T 7714—2015，不得猜测补齐，应返回格式不合规问题并要求补充元数据或由内容生成环节修订。

写入 `output/references.json`，然后运行：

```bash
python3 <skill-dir>/scripts/main.py validate-references
```

### 7. 生成报告

确认所有需要的 JSON 均通过校验后运行：

```bash
python3 <skill-dir>/scripts/main.py create-report
python3 <skill-dir>/scripts/main.py validate-report output/报告文件.docx
```

如果 JSON 解析失败，先运行：

```bash
python3 <skill-dir>/scripts/repair_json.py
```

## 验收

生成或调整格式后，将 DOCX 渲染为 PDF 并逐页检查：

1. 封面和审批页没有页码；仅审批页中的两字中文姓名应在两个字之间加入一个半角空格，其他页面不得套用该规则。
2. 中英文摘要及关键词结构顺序正确；允许根据内容长度自然分页，不要求位于同一页。
3. 摘要与目录使用连续的小写罗马数字页码。
4. 主目录条目结束后必须直接续接图条目和表条目对应的动态目录域；不显示“图目录”“表目录”独立标题，也不插入额外空行。图、表条目的字体、字号、行距、点引导线、制表位和页码对齐直接复用主目录格式，并与主目录同属前置罗马页码部分。只有真正的 `图X-X 图题` / `表X-X 表题` 段落写入 F/T 隐藏 TC 域，说明段不得写入；“内容摘要”“ABSTRACT”必须保留 C 类隐藏 TC 域。
5. 正文第一页从阿拉伯数字 `1` 重新编号。
6. 正文页眉、附录、参考文献和分页符合规范。
7. 文档中没有残留模板占位符或异常空白页。
8. 正文普通文本中的段内符号不得出现单独字体、字号、粗斜体或下划线跳变；该项由末端确定性符号归一化和结构校验完成，不依赖大模型重新判断。字号写入必须同时覆盖 `w:sz` 与 `w:szCs`，不得只写普通脚本字号而让 Word/WPS 的 complex-script 字号槽回退。
9. 正文与表格可见文本中不得出现原始 LaTeX 公式定界符、常用 LaTeX 数学命令、裸露上下标脚本写法或内部公式标记；所有数学公式必须已成为 Word 原生 OMML。任一残留均判定结构校验失败并禁止交付。

最终告知用户：

- 报告位于当前工作区的 `output/`。
- 生成链会在 Microsoft Word 可用时自动更新并保存主目录、图条目和表条目；视觉 QA 必须确认目录区域不再出现“未找到目录项”，且存在图题/表题时相应条目已生成。Word 不可用的运行环境仍保留 dirty field 与 `w:updateFields=true`，供后续 Word 打开时刷新。
- 审批区需要打印后手工填写。
- 图表占位位置需要手动插入实际图表。

## JSON 写入要求

优先使用 `json.dumps()` 或 `json.dump()` 写入 JSON，避免 HTML 属性中的双引号导致语法错误：

```python
import json

with open("output/chapter_1.json", "w", encoding="utf-8") as file:
    json.dump(data, file, ensure_ascii=False, indent=2)
```

直接编辑 JSON 时，使用单引号包裹 HTML 属性值，或正确转义双引号为 `\"`。
