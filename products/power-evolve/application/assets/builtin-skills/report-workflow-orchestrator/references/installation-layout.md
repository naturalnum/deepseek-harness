# 安装布局

将安装包直接解压到 `.codex/skills/`：

```text
.codex/skills/
├── report-workflow-orchestrator/
├── power-grid-technical-report-writer/
├── report-reviewer/
└── tech-report-writer/
```

`report-workflow-orchestrator/skill-registry.json` 使用相对路径引用三个同级子 Skill。编排脚本位于本 Skill 的 `scripts/`，Schema 位于 `schemas/`。
