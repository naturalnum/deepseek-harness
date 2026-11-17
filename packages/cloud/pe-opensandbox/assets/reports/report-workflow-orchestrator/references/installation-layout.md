# 安装布局

DSH 发布载荷将四项技能放在同一只读资源根目录下：

```text
/opt/dsh/skills/reports/
├── report-workflow-orchestrator/
├── power-grid-technical-report-writer/
├── report-reviewer/
└── tech-report-writer/
```

`report-workflow-orchestrator/skill-registry.json` 使用相对路径引用三个同级子 Skill。编排脚本位于本 Skill 的 `scripts/`，Schema 位于 `schemas/`。
