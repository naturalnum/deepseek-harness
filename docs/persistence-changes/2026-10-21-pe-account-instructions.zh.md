---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-pe-account-instructions

[English](2026-10-21-pe-account-instructions.md) | 中文

## 概述

确认已交付C03的pe-account-instructions source分支对四个持久消息根的影响，包括标题请求对Message[]的引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-pe-account-instructions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "0aa710e261979c74618477e371ee2c71d4e6eac3c82da0ed80e43faec1bf3667"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "68f880510996dc99a1b47790468bcf291d9dcbac49da6340c6f881791951ae7e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "89cd059576d133ef09838f1a13c0765cb4b7dac8383088f0c03189463c2528d5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "e4e0a3eadeff94e8c0504c954d4bbdbfd838e3d8accbbcb93a93580af9ed9ab8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有source分支与旧记录保持不变。新reader保留其正文、角色和source元数据；没有C03记录的旧历史保持原有含义。C03之前的V4 codec与核心Session reader接受user/developer消息中的非空producer kind，并保留未知JSON元数据，因此不依赖C03 producer也能保留已记录正文及归属。snapshot不授予账户或文件权限，也不回放文件系统读取。未安装C03的旧产品不会因此获得实时账户指令注入；本决策只覆盖已记录消息读取，不承诺该运行能力。V3 reader不在本确认范围内，也不承诺降级。当前producer写入user角色；developer/message与标题messages[]仅因共享MessageSource而传递变化，并非新增标题写入逻辑或事件布局。Session格式仍为V4。

<a id="verification"></a>
## 验证

`node node_modules/vitest/vitest.mjs run --cache=false packages/cloud/pe-account-instructions/tests/injection.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/session/session-format-v3-to-v4/tests/relationships.spec.ts packages/session/session-title-llm/tests/llm.spec.ts`：4个文件、96个测试通过。producer测试重新打开已提交的V4日志并核对指令正文与snapshot哈希；codec测试覆盖未知source保留及恢复前拒绝，标题测试保留既有请求形状。独立结构审查只发现同一source kind新增。核心Session reader、V4 codec/source遍历与标题writer在C03父提交和本次审阅checkout之间逐字节相同。

<a id="dev-note"></a>
## 开发备注

无。
