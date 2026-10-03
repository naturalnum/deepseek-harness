# Tech report writer changes

## 1.1.37

- Markdown 本地 PNG/JPEG 图片进入 DOCX 媒体；静态 SVG 由现有 LibreOffice Draw 和 Poppler 转换后嵌入。
- 文件型报告的图片相对 Markdown 所在目录解析，该目录须位于当前用户工作区；内联 Markdown 以当前工作区为素材根。拒绝网络地址、绝对路径、上级路径、符号链接和 SVG 外部引用，缺图或无效图阻断生成。
- 图片 alt 中的图题与紧随其后的正式图题只生成一个图题段落；保留审定章节编号、正文、表格和原生公式。
