---
kind: upgrade-guide
description: 受管理技能详情的 strict Remote 答复要求返回根说明正文。
---

# 受管理技能说明

[English](guide.md) | 中文

## 变更

`cloudSkills/details` 在安装元数据之外，以必需的 `markdown` 字段返回完整根 `SKILL.md`。旧 strict 结果 codec 拒绝新增字段，新 codec 拒绝缺少该字段的答复。技能弹窗通过当前账户读取正文，并使用现有下载操作取得完整不可变技能包。

## 迁移

1. 同时构建和部署 `pe-cloud-api` 及其生成的 `pe-cloud-client` contribution，不混用新旧 strict Remote descriptor。
2. 更新自定义 `ManagedSkillDetails` 提供者和测试答复，以 `markdown` 返回实际根说明。保留账户守卫、不可变版本借用和完整序列化答复上限。
3. 刷新浏览器并打开已安装技能，确认说明正常渲染，“下载”返回包含资源的已安装技能包。
