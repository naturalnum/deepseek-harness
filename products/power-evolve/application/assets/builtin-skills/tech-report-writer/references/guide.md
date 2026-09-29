# 科技项目技术报告编写 — 参考指南

补充 SKILL.md 的数据结构、模板说明、HTML 示例和操作提示。正式格式要求见 [technical-report-format.md](technical-report-format.md)，两者冲突时以正式格式要求为准。

## 目录

- [运行目录](#运行目录)
- [运行环境](#运行环境)
- [调整已有报告](#调整已有报告)
- [页面与分节](#页面与分节)
- [数据文件格式](#数据文件格式)
- [模板说明](#模板说明)
- [正文格式完整示例](#正文格式完整示例)
- [CLI 命令参考](#cli-命令参考)
- [目录生成说明](#目录toc生成说明)
- [后续操作提示](#后续操作提示)

## 运行目录

从用户当前工作区执行脚本。所有中间 JSON 和最终 DOCX 默认写入当前工作区的 `output/`，不写入 Skill 安装目录。需要覆盖输出位置时，设置 `TECH_REPORT_OUTPUT_DIR` 为目标目录的绝对路径。

## 运行环境

- Python 3.10 或更高版本。
- Python 包见根目录 `requirements.txt`。先运行 `python3 <skill-dir>/scripts/check_environment.py`；缺失依赖时，经用户许可后安装。
- 将 Markdown/HTML 中的 LaTeX 公式或本 Skill 内部公式标记转换为 Word 原生 OMML 时需要 `pandoc`。已有文档中的原生 Word 公式不依赖 `pandoc`。
- 最终视觉检查需使用可将 DOCX 渲染为 PDF 的 Word、WPS 或 LibreOffice，并使用 PDF 渲染工具逐页检查。

## 调整已有报告

只调整已有 Word 报告的格式时，不需要准备 JSON 数据文件。始终将结果另存为新文件：

```bash
mkdir -p output
python3 <skill-dir>/scripts/format_existing_report.py \
  <输入报告.docx> output/<原文件名>_格式调整版.docx
python3 <skill-dir>/scripts/main.py validate-report \
  output/<原文件名>_格式调整版.docx
```

该流程统一页面、分节、页眉页脚、页码、目录样式、标题、正文、图表题及表格格式。默认保留报告的专业内容、图片、表格和原生 Word 公式，不覆盖输入文件。

## 页面与分节

| 项目 | 设置 |
|---|---|
| 纸张 | A4 纵向 |
| 页边距 | 上 30mm、下 25mm、左 25mm、右 25mm |
| 页眉 | 封面至目录不显示；正文可显示中文报告名称，五号宋体、居中、下边框 |
| 页脚 | 封面和审批页不显示；摘要起显示页码，距底边 15mm |
| 前置页码 | 摘要和目录使用小写罗马数字 |
| 正文页码 | 正文第一页从阿拉伯数字 1 重新编号，附录和参考文献连续编号 |

中文摘要、中文关键词、英文摘要和英文关键词按既定顺序排版，可根据实际内容长度自然分页，不要求位于同一页。

## 数据文件格式

所有 JSON 文件放在当前工作区的 `output/`。使用 `json.dumps(..., ensure_ascii=False, indent=2)` 写入，避免 HTML 属性中的双引号破坏 JSON。

### 封面 `cover_info.json`

```json
{
  "report_no": "",
  "class_no": "",
  "secret_level": "",
  "project_source": "国家电网有限公司总部科技项目",
  "title_cn": "中文报告标题",
  "title_en": "English Report Title",
  "project_name": "项目名称",
  "series_no": "",
  "cooperator": ["合作（协作）单位一", "合作（协作）单位二"],
  "report_date": "2026年7月",
  "work_period": "2024.01--2026.06",
  "leader": "姓名",
  "staff": "姓名一、姓名二",
  "writer": "姓名"
}
```

审批页姓名排版规则：`leader`、`staff`、`writer` 的原始 JSON 值无需人为插入空格；生成或格式调整脚本仅在审批页输出时自动处理两字中文姓名，例如 `张三、李四、王小明` 排为 `张 三、李 四、王小明`。三字及以上姓名不变，此规则不作用于报告其他页面。

### 大纲 `outline.json`

```json
{
  "chapters": [
    {
      "num": 1,
      "title": "研究背景与意义",
      "sections": [{"title": "国内外研究现状"}]
    }
  ]
}
```

### 摘要 `abstract.json`

```json
{
  "abstract_cn": "<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>中文摘要正文</p>",
  "keywords_cn": "关键词一；关键词二；关键词三",
  "abstract_en": "<p style='font-family:Times New Roman;font-size:12pt;line-height:1.5;text-indent:2em'>English abstract.</p>",
  "keywords_en": "keyword one; keyword two; keyword three"
}
```

### 章节 `chapter_N.json`

```json
{
  "num": 1,
  "title": "研究背景与意义",
  "content_html": "<h1 style='font-family:黑体;font-size:15pt;page-break-before:always'>1 研究背景与意义</h1><p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>正文</p>"
}
```

### 附录 `appendices.json`（可选）

```json
{
  "appendices": [
    {"id": "A", "title": "补充试验数据", "content_html": "<p>附录正文</p>"}
  ]
}
```

### 参考文献 `references.json`（可选）

```json
{
  "references_html": "<p>[1] 张三, 李四. 电力系统智能调度方法[J]. 电力系统自动化, 2026, 50(1): 1-10.</p>"
}
```

> `references.json` 中的正式条目统一按 **GB/T 7714—2015 顺序编码制**提供。每条从 `[1]` 起连续编号，包含文献类型标识，并以句点 `.` 结束。正文引用序号必须与该列表双向对应。

常见条目示例：

```text
[1] 张三, 李四. 电力系统智能调度方法[J]. 电力系统自动化, 2026, 50(1): 1-10.
[2] 王五. 电力系统分析[M]. 北京: 中国电力出版社, 2025.
[3] 全国电力系统管理及其信息交换标准化技术委员会. 电力系统相关标准名称[S]. 北京: 中国标准出版社, 2024.
[4] 某机构. 在线技术资料[EB/OL]. (2026-01-15)[2026-08-07]. https://example.com/resource.
```

## 模板说明

### 占位符映射（21 个）

| 模板占位符 | 来源文件 | 字段 | 类型 |
|-----------|---------|------|------|
| `{{REPORT_NO}}` | cover_info.json | report_no | 纯文本 |
| `{{CLASS_NO}}` | cover_info.json | class_no | 纯文本 |
| `{{SECRET_LEVEL}}` | cover_info.json | secret_level | 纯文本 |
| `{{PROJECT_SOURCE}}` | cover_info.json | project_source | 纯文本 |
| `{{TITLE_CN}}` | cover_info.json | title_cn | 纯文本 |
| `{{TITLE_EN}}` | cover_info.json | title_en | 纯文本 |
| `{{PROJECT_NAME}}` | cover_info.json | project_name | 纯文本 |
| `{{SERIES_NO}}` | cover_info.json | series_no | 纯文本 |
| `{{COVER_BOTTOM_BLOCK}}` | cover_info.json | 编写单位、cooperator、report_date | 封面正文层中的无边框浮动文本框；每项为独立段落，日期为最后一段 |
| `{{COOPERATOR}}` | cover_info.json | cooperator | 文本或字符串数组；生成时每个单位转换为独立一行 |
| `{{REPORT_DATE}}` | cover_info.json | report_date | 纯文本 |
| `{{WORK_PERIOD}}` | cover_info.json | work_period | 纯文本 |
| `{{LEADER}}` | cover_info.json | leader | 纯文本 |
| `{{STAFF}}` | cover_info.json | staff | 纯文本 |
| `{{WRITER}}` | cover_info.json | writer | 纯文本 |
| `{{ABSTRACT_CN}}` | abstract.json | abstract_cn | HTML |
| `{{KEYWORDS_CN}}` | abstract.json | keywords_cn | 纯文本 |
| `{{ABSTRACT_EN}}` | abstract.json | abstract_en | HTML |
| `{{KEYWORDS_EN}}` | abstract.json | keywords_en | 纯文本 |
| `{{BODY}}` | chapter_*.json | content_html | HTML |
| `{{BACK_MATTER}}` | appendices.json、references.json | 附录和参考文献 | HTML |

> `{{WORK_UNIT}}` 已从模板移除，使用模板默认值"中国电力科学研究院有限公司"。审核审批区保留原样用于手写签名。
> `{{TITLE_CN}}` 同时用于封面和正文页眉。项目来源未提供时默认使用“国家电网有限公司总部科技项目”；系列序号、附录和参考文献均可留空。

### 封面关键段落字体预设

| 段落 | 字体 | 字号 |
|------|------|------|
| 报告编号、分类号、密级 | 黑体 | 10.5pt（五号） |
| `{{PROJECT_SOURCE}}` | 黑体 | 15pt（小三） |
| `{{TITLE_CN}}` | 黑体 | 18pt (小二) |
| `{{TITLE_EN}}` | Times New Roman | 16pt |
| `{{PROJECT_NAME}}`、`{{SERIES_NO}}` | 黑体 | 15pt（小三） |
| `{{COVER_BOTTOM_BLOCK}}` | 黑体 | 14pt（四号） |
| 内容摘要标题 | — | 18pt (小二) |
| ABSTRACT 标题 | Times New Roman | 18pt (小二) |

封面表中指定为黑体的段落，其中西文和数字字体槽同样设置为黑体，且不额外启用粗体属性。

封面中的“中国电力科学研究院有限公司”、合作单位和报告发布日期使用封面正文层中的无边框浮动文本框，在正文宽度内居中，文本框底端定位到下页边距内侧，不使用表格、普通正文段落或页脚。报告编写单位、每个合作（协作）单位和发布日期分别使用文本框中的独立段落，单倍行距、段前段后为 0，不插入空白段落或手动换行符。报告编写单位固定使用中文全称“中国电力科学研究院有限公司”；多个合作单位依次排列在报告编写单位下方，日期为最后一段。

封面右上角的报告编号、分类号和密级三行共用同一个左起点。生成器依据三行实际文本测量最长行宽度，并将最长行的最右字符定位到右页边距内侧，即正文版心右边缘。

### 封面字段处理规则

| 字段 | 处理方式 | 说明 |
|------|---------|------|
| `report_no` | **必须询问用户** | 报告编号 |
| `class_no` | **必须询问用户** | 分类号 |
| `secret_level` | **必须询问用户** | 密级 |
| `project_source` | 从任务书提取或询问 | 项目来源，未提供时使用默认值 |
| `title_cn` | LLM 总结提炼 → 用户确认 | 不能照搬任务书标题 |
| `title_en` | LLM 翻译 → 用户确认 | 对应中文标题 |
| `project_name` | LLM 总结 → 用户确认 | 从任务书提取 |
| `series_no` | 从任务书提取或询问 | 独立报告留空 |
| `cooperator` | 从任务书提取或询问 | 合作单位，非必需；推荐使用字符串数组，多个单位每个元素填写一个名称；旧版顿号、分号或换行字符串仍兼容 |
| `report_date` | 自动生成 | 年月格式（如"2026年7月"） |
| `work_period` | 从任务书提取或询问 | 如"2024.01--2026.06" |
| `leader` | 询问用户 | 多人用中文顿号（、）分隔 |
| `staff` | 询问用户 | 多人用中文顿号（、）分隔 |
| `writer` | 询问用户 | 多人用中文顿号（、）分隔 |

---

## 正文格式完整示例

所有正文内容以 HTML + CSS inline style 输出。

### 一级标题（章标题）

```html
<h1 style="font-family:黑体;font-size:15pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0;page-break-before:always">1 一级标题</h1>
```

- 黑体小三（15pt），段前段后 6pt，1.5 倍行距，首行无缩进
- **每章另起一页**（`page-break-before:always`）
- 编号和文字之间空一格

### 二级标题

```html
<h2 style="font-family:黑体;font-size:14pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0">1.1 二级标题</h2>
```

- 黑体四号（14pt），段前段后 6pt，1.5 倍行距

### 三级标题

```html
<h3 style="font-family:黑体;font-size:12pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0">1.1.1 三级标题</h3>
```

- 黑体小四（12pt），段前段后 6pt，1.5 倍行距

### 正文

```html
<p style="font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em">正文内容...</p>
```

- 宋体小四（12pt），1.5 倍行距，首行缩进 2 字符

### 图标题

```html
<p style="font-family:黑体;font-size:10.5pt;text-align:center">图1-1 图表标题</p>
```

- 黑体五号（10.5pt），居中，置于图下方
- 编号格式：章号-序号

### 表标题

```html
<p style="font-family:黑体;font-size:10.5pt;text-align:center">表1-1 表格标题</p>
```

- 黑体五号（10.5pt），居中，置于表上方

### 正文编号列项

```html
<p style="font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em">（1）编号列项正文</p>
```

### 下一层编号列项

```html
<p style="font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em">1）编号列项正文</p>
```

### 带圈编号列项

```html
<p style="font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em">① 编号列项正文</p>
```

这些编号列项不是标题，不使用黑体或粗体，也不进入目录。

### 图表占位标记

```html
<p style="font-family:宋体;font-size:10.5pt;text-align:center">【此处插入图1-1】</p>
<p style="font-family:黑体;font-size:10.5pt;text-align:center">图1-1 XXX示意图</p>
```

- 输入 JSON/HTML 中仍使用上述文本标记，以便编号校验；
- 生成 Word 时该标记必须转换为白底、黑色细边框、无文字的矩形白框；
- 白框代表待补绘的图像本体，必须放在图题上方，图题置于白框下方；
- 不得在白框内自动写“此处插入图”、图号、说明文字或生成模拟图形。

### 公式

上游最终 Markdown 继续使用标准 LaTeX 数学定界符，例如：

```markdown
节点电压偏差记为 $\Delta V_i=V_i-V_i^{\mathrm{ref}}$。

$$
P_{ij}=U_i I_{ij}\cos\varphi_{ij}\tag{1-1}
$$
```

如果调用方已经提供 HTML，段内 `$...$` / `\(...\)` 和独立 `$$...$$` / `\[...\]` 同样先做公式归一化。Word 转换链固定为“Markdown/HTML LaTeX → 内部公式标记 → `pandoc` 数学转换 → Word 原生 OMML”，而不是把 LaTeX 字符串直接写入普通文本 run。

- `$...$`、`\(...\)` 生成行内 OMML；`$$...$$`、`\[...\]` 生成独立居中 OMML；
- `\tag{1-1}` 从公式体中拆出并写为右侧 `（1-1）`；没有编号的显示公式仍按居中原生 OMML 输出；
- 公式和编号使用五号宋体；变量、英文和数字可使用 Times New Roman；
- 独立公式后的第一个实际文字段落首行不缩进；若紧随公式的是“式中：”说明，该段也不缩进。其后的普通正文恢复首行缩进 2 字符；
- Markdown 行内代码/围栏代码中的 `$...$` 不参与公式转换；
- 最终 DOCX 可见文本中不得残留 `$...$`、`$$...$$`、`\frac`、`\sum`、`V_{i}` 等 LaTeX 源码或 `[[TECH_REPORT_*MATH_B64:...]]` 内部标记。

---

## CSS 格式速查表

| 格式 | CSS |
|------|-----|
| 一级标题 | `font-family:黑体;font-size:15pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0;page-break-before:always` |
| 二级标题 | `font-family:黑体;font-size:14pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0` |
| 三级标题 | `font-family:黑体;font-size:12pt;margin-top:6pt;margin-bottom:6pt;line-height:1.5;text-indent:0` |
| 正文 | `font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em` |
| 图/表标题 | `font-family:黑体;font-size:10.5pt;text-align:center` |
| 公式及编号 | `font-family:宋体;font-size:10.5pt`，公式居中、编号右对齐 |

> **英文/数字与段内符号**：正文中的英文和数字使用 Times New Roman。最终 Word 不再仅依赖字体回退机制，而会在行内公式替换之后执行一次确定性 run 归一化：中文/全角符号走宋体字体槽，西文、数字及 `±`、`×`、`%`、`℃`、比较符号等普通技术符号走 Times New Roman 字体槽，并统一到所在段落字号；字号 XML 同时写入 `w:sz` 与 `w:szCs`，避免 Word/WPS 的 complex-script 字号回退；OMML 公式和上标引用除外。

---

## CLI 命令参考

```bash
python3 <skill-dir>/scripts/check_environment.py
python3 <skill-dir>/scripts/format_existing_report.py 输入报告.docx output/输入报告_格式调整版.docx
python3 <skill-dir>/scripts/main.py current-date
python3 <skill-dir>/scripts/main.py validate-cover
python3 <skill-dir>/scripts/main.py validate-outline
python3 <skill-dir>/scripts/main.py validate-abstract
python3 <skill-dir>/scripts/main.py validate-chapter 1
python3 <skill-dir>/scripts/main.py validate-appendices
python3 <skill-dir>/scripts/main.py validate-references
python3 <skill-dir>/scripts/main.py create-report
python3 <skill-dir>/scripts/main.py validate-report output/报告文件.docx
```

---

## 目录（TOC）生成说明

引擎在生成报告时会**自动在"目录"标题后插入 TOC 域代码，并配置目录格式和分节**。

### 目录格式规范

| 格式项 | 说明 |
|--------|------|
| 目录标题"目  录" | 黑体小二（18pt），模板已预设 |
| 目录条目中文 | 宋体小四（12pt） |
| 目录条目数字/英文 | Times New Roman 小四（12pt） |
| 行距 | 一倍行距（single） |
| 标题与下文 | 空一行 |
| 目录页页码 | 小写罗马数字（i, ii, iii...），五号宋体，延续摘要页编号 |
| 正文页页码 | 阿拉伯数字（1, 2, 3…），从第 1 页重新开始 |
| 目录范围 | 自动采集“内容摘要”“ABSTRACT”及 Heading 1~3 样式的正文标题 |
| 图条目续接域 | 主目录后直接设置，不显示独立标题；条目样式直接复用 TOC 样式，收集“图X-X 图题” |
| 表条目续接域 | 图条目后直接设置，不显示独立标题；条目样式直接复用 TOC 样式，收集“表X-X 表题” |

### 目录字段自动更新

- “内容摘要”和“ABSTRACT”由标题后的隐藏 `TC ... \f C \l "1"` 域提供，不使用固定目录文本；最终格式化阶段会再次补齐，避免模板或中间转换导致标记丢失。
- 图题和表题分别使用 `\f F`、`\f T` 的隐藏 TC 域。采集器只接受真正独占一段、编号与题名之间有明确空格的 `图X-X 图题` / `表X-X 表题`，并清理普通说明段上历史遗留的 F/T TC 域。
- 正文说明不得写成“图1-1应表达……”“表2-1给出……”；生成阶段会优先改写为“该图应表达……”“该表给出……”“上述趋势/上述结果……”等，避免目录误采集。
- DOCX 保存后，若运行环境存在 Microsoft Word，`word_field_refresh.py` 会通过 Word COM 自动更新全部 Fields 以及所有 TablesOfContents，随后保存文档，使主目录、图条目和表条目在首次打开时即为更新状态。
- 无 Microsoft Word 的运行环境不会使用 LibreOffice 去刷新 Word 自定义 TC 目录（该路径不能可靠保留 `\f F` / `\f T` 语义）；文档仍保留 dirty field 与 `w:updateFields=true`，供之后用 Word 打开时刷新。
- 最终视觉 QA 必须检查目录区域，发现“未找到目录项”或存在图题/表题但目录条目未显示时，不得判定交付通过。

### 目录格式说明

- 目录自动采集使用了 Heading 1~3 样式的段落
- 主目录后自动连续插入图、表两个动态 TOC 域；不显示独立的“图目录”“表目录”标题，也不插入额外空行；二者字体、字号、单倍行距、点引导线、制表位和页码右对齐全部复用主目录 TOC 样式
- 只有真正图题、表题会在生成阶段写入隐藏 F/T TC 域；说明段不会写入。Word 可用时生成链自动刷新三个目录域，更新后分别进入紧随主目录的图、表条目区域
- 标题编号和页码自动生成
- 若后续修改了正文标题或图题/表题，重新执行最终 Word 排版/字段刷新步骤，使三个目录域再次自动更新；不要依赖旧缓存结果。

---

## 后续操作提示

生成报告后告知用户：

1. 报告已生成在 `output/` 目录
2. Microsoft Word 可用时生成链已自动更新主目录及其后连续的图、表动态目录域；最终视觉 QA 需确认不存在“未找到目录项”且图/表条目已出现。无 Word 环境仍保留自动更新标志，之后用 Word 打开即可刷新
3. 目录页使用小写罗马数字页码，正文从第 1 页重新开始（阿拉伯数字）
4. 存在附录时，每个附录自动另起一页；存在参考文献时，参考文献自动另起一页
5. 审核审批区需打印后手工填写
6. 图表标记位置需手动插入实际图表
