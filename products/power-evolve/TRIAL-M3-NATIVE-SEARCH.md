# 原生搜索历史文本兼容试验

2026-10-09，Asia/Shanghai。本次修复已通过24项源码行为测试及专项检查；结论只覆盖历史文本搜索，不表示官方当前消息视图、完整迁移或正式部署已验收。完整范围仍由[迁移方案](CLOUD-MIGRATION-PLAN.md)定义。

## 当前行为

[搜索实现](application/src/platform/native-session-search.ts)在只读 repeatable-read PG 事务中读取本人会话，每批最多64个会话、每个事件块最多256条。分页保留 PostgreSQL 时间戳原始精度，按更新时间降序、会话身份升序前进。读取先核对物理行数、原生记录及物理序号，再使用事件；无效 header、身份不符、负事件计数、缺行及损坏记录拒绝。

搜索读取用户消息的 content 与已组装助手消息的 message.content，只匹配 text block 的字面文本，忽略 reasoning。大小写转换在应用中完成，不使用 PostgreSQL JSON 文本提取，因此保留历史 NUL、孤立代理项、字面转义和 emoji。摘要按原文本的 Unicode code point 限长，大小写转换扩展字符后仍从正确的原文位置取摘要。每个会话返回最新匹配消息，超过配置结果数才返回 hasMore。

[原会话命令](application/src/platform/native-session-commands.ts)仅把 search 委托给该实现；标题和分支实现没有更改。事件原 JSON、Session 格式、DDL、清单和锁文件没有改变。

## 执行结果与版本

[新增回归](application/tests/native-session-search.spec.ts)共14项真实 PG 用例，另执行原会话命令4项及原生 JSON 文本6项，最终24／24通过、没有 pending。fixture 为每个用例创建并删除独占数据库及文件根，使用已有私有试验 PG 管理连接；此结果不代表普通数据库角色或真实 Profile 验收。

旧 SQL 的首轮10项回归中3项通过、7项失败，实际复现 Unicode escape 异常、助手消息漏查和损坏事件未拒绝。独立审查随后发现负事件计数被误判为空历史；真实 PG 的单项回归也复现该失败，该过滤运行的13项 pending 没有算作验收。修复后完整选择的24项全部通过，原失败报告保留。

| 当前输入 | SHA-256 |
|---|---|
| native-session-search.ts | `ad75b4ad623bd8e3cf92fdacb6202e2950c81658638f4df5414751affdf7aebf` |
| native-session-commands.ts | `c34f4ad63f1ee192ac43da3c79d203613173ec9205a75a8e13f6a84264ba79d7` |
| native-session-search.spec.ts | `3b7b999650af07acabc086e18800210bdab55745001df6e91e824383db2f20e3` |
| pnpm-lock.yaml | `24d22b5bc00c16cb79ef5e60d8dc9aea10b995c4d5e826d455a2b1c07db2b269` |

最终测试窗口递归解析的526份仓库输入没有变化或缺失；24份外部 node_modules 模块文件及正式构建产物不在该摘要内。新搜索文件的行、语句、函数及分支分别覆盖45／45、63／63、5／5、36／36，均为100%，没有 skipped；覆盖阈值只统计这一份新文件，不能外推至 commands 或全产品。

三份根文件的源码专项 noEmit 类型检查退出0，保留上游、Contracts 和 Connector 引用，排除 Application 对自身已构建声明的引用；三文件专项官方映射 lint 退出0。两份生产文件的官方 JSDoc 检查无违规，Application 双语 README 配对检查退出0。首次测试 fixture 多传了官方助手消息工厂自行提供的 kind，导致类型检查失败；已只修 fixture 并保留失败日志。首次临时覆盖配置的相对路径错误也保留，没有当成运行通过。

最终执行使用直接 Node CLI，没有 install 或修改锁文件：

```sh
PE_TEST_DATABASE_URL_FILE=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/database-url pnpm_config_verify_deps_before_run=error node node_modules/vitest/vitest.mjs run --config .artifacts/root-native-search-v1/vitest.config.mts products/power-evolve/application/tests/native-session-search.spec.ts products/power-evolve/application/tests/native-session-commands.spec.ts products/power-evolve/application/tests/native-json-text.spec.ts --coverage --reporter=json --outputFile=/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-search-v1/after-tests-v4.json
```

私有证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/root-native-search-v1`。最终报告是 result-v4.json，输入记录为 inputs-before-v4.json／inputs-after-v4.json，coverage-v2 保存最终 v4 覆盖输出，production-freeze.json 保存最终摘要；各轮测试、类型、lint 和旧实现失败分别留档。该命令记录本机试验入口，独立最终构建仍由云端检查与镜像验收入口负责。

## 未完成的搜索语义

官方 [Session 搜索](../../packages/api/session-controller/src/list.ts)要求 current surface 并接收查询 provider 的排序结果；当前实现扫描历史 text block，沿用更新时间及最新事件排序。官方完整 surface fold 依赖连续完整日志，不能逐块独立折叠或以反向数值序号区间模拟替代，合法 replacement 的顺序也不一定等于物理序号顺序。该差异仍须完成兼容设计和验收。

64／256 的批次限额约束单批读取与内存，不限制整次搜索的会话数量、耗时或取消。现有 Pool 的单 statement timeout 也不是整次搜索 deadline。整次工作预算、原生取消、正式 Linux 构建／Profile、浏览器入口及完整原生搜索语义仍未通过，本记录不能关闭这些项目。
