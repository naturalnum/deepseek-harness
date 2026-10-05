# Tech report writer changes

## 1.1.42

- Keep failed Word command phase, exit status, output directory and bounded actual logs; incomplete DOCX files remain blocked without an artifact.

## 1.1.41

- Accept one nonempty pre-body Markdown contents section and metadata-matched bilingual front titles without changing the final reviewed source; preserve source explanations in consecutive appendices and reject unknown top-level headings.

## 1.1.40

- 逐页验收使用实际渲染页数，页码记录须以整数恰好覆盖 `1..N`；拒绝缺页、重复、越界和布尔值，渲染退出 0 不自动通过。
- 渲染失败或退出非零时，外部提供的视觉通过记录不能覆盖失败；当前 Word 产物和版本绑定保持。
- 产品目录同时声明 Cloud 与 Desktop 执行目标。

## 1.1.39

- 现有无原始 marker 的编号 OMML 表格也在另存格式修复路径校准宽度；严格识别单行三列、纯数学内容和独立式号，含文字标签或其他对象的普通数据表保持。
- 编号显示公式的固定表格同步列网格、表格总宽度与单元格宽度，避免渲染器沿用三等分默认网格而裁切原生数学内容。
- 保留实际五式的奇偶条件、MAD索引范围、精确率/召回率、式号与后续正文；未改已确认 Markdown、Pandoc 转换或公式语义。

## 1.1.38

- 引用 JSON 和最终 DOCX 校验支持 GB/T 7714—2015 附录 B 的数据集 `[DS]` / `[DS/OL]` 标识；已有文献类型和载体规则保持。
- `[DS/OL]` 仍须有真实 http(s) URL 与 `[YYYY-MM-DD]` 引用日期，DOI 不能替代 URL；最终 `[n]` 连续编号和半角结束句点保持。
- 新增真实 QA UCI 数据集引文的 CLI 与 DOCX 引用段落读回回归，覆盖缺 URL、缺日期、错编号、未知标识和不支持的数据集载体拒绝。

## 1.1.37

- Markdown 本地 PNG/JPEG 图片进入 DOCX 媒体；静态 SVG 由现有 LibreOffice Draw 和 Poppler 转换后嵌入。
- 文件型报告的图片相对 Markdown 所在目录解析，该目录须位于当前用户工作区；内联 Markdown 以当前工作区为素材根。拒绝网络地址、绝对路径、上级路径、符号链接和 SVG 外部引用，缺图或无效图阻断生成。
- 图片 alt 中的图题与紧随其后的正式图题只生成一个图题段落；保留审定章节编号、正文、表格和原生公式。
