# 技术报告 Word 准备

[English](README.md) | 中文

本 Skill 将已审核报告转换为 Word 并校验版式。[SKILL.md](SKILL.md) 定义完整生成流程与视觉检查要求。

## 已审核 Markdown 输入

提供 `source_report` 时，已审核 Markdown 是摘要、章节、参考文献与附录的唯一来源；来源不可读或不完整时不得选取旧产物。前置中英文双语题名须分别匹配本版 `word_metadata.title_cn` 和 `title_en`。两个题名均位于报告各节之前；其他额外一级标题仍不受支持。

Markdown 可在正文与后置部分之前包含一个非空的 `# 目录` 或 `## 目录` 节。其条目不会成为摘要文本或额外 Word 章节。Word 模板根据已审核标题生成带实际页码的目录。

参考文献来源说明放入连续编号的附录，例如在附录 A 之后使用 `# 附录 B 参考文献来源与获取链接`。其文字与从 `[n]` 连续编号的正式参考文献条目分开保留。

## 验证

[适配器回归](tests/test_orchestration_adapter.py) 覆盖确定性准备、严格拒绝和 Word 段落/表格读回。它们不能证明 LibreOffice 分页或逐页视觉验收通过；这些检查仍属于实际 Word 流程。
