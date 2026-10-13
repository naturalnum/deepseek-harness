# 原生 turn advance intent v2

[English](native-turn-advance-intent-v2.md) | 中文

## 概要

Platform 集成方通过 `NativeTurnAdvanceIntentV2.prepare()`，从已闭合 owned turn 的实际 PG 状态生成并保留完整 continuation candidate。Host 提供当前 Writer 身份、保留的 transition identity 和 candidate token，以及实际 `NativeAssistantPublisher` 已确认的 seal。PG 提供来源坐标、有序 cohorts、已消费 origins 和当前 pending head。

## 目录

- [调用与恢复](#use-and-recovery)
- [权限与限额](#authority-and-limits)
- [开发备注](#dev-note)

<a id="use-and-recovery"></a>
## 调用与恢复

调用方在原生 before-next-turn hook 内保持静止，取得 publisher seal、生成 candidate，再通过新事务调用现有 continuation（[参考文档](native-turn-continuation-v2.zh.md)）。transition 响应不确定时，调用方准确重试同一个完整 candidate。成功转移后，不通过旧 operation bearer 重新生成意图。Host 在核对结果后负责退休 publisher，并重新打开 successor Agent。

内部 `kind: 'reconcile'` preparation 使用实际的历史 consumed-frame provider 和当前另行发放的 storage bearer。PG 提供原始消费坐标；返回的请求另行保留当前 storage epoch。Host 恢复原始 native Session 以保存中断的 closers，在任何新 turn 前安装拒绝机制；修复期间不唤醒 pending input，也不安装业务工具。发送准备好的 transition 前，Host 停止并排空 operation renewal，同时保留独立 Writer renewal。现有 operation timeout 限定恢复时长，失败时释放占用，不把结果不确定的 turn 视为已结算。

preparer 拒绝未 claim 的 frame、未闭合或不匹配的 turn、不完整的 cohort 或 claim 坐标、不一致的 pending revision、不匹配的 presentation seal、到期权限及超出限额的读取。调用方在核对失败期间保持原生流程静止。之后发生的 event 或 presentation watermark 变化会使 candidate 失效；continuation 在结算前重新核查完整证明和时钟。

<a id="authority-and-limits"></a>
## 权限与限额

必需的 frame provider 通过 `frames.verifyInTransaction` 读取实际 frame。实际 TaskStore 授权和独立 Writer 检查保护有界 history 与 ledger 读取。空 continuing cohort 仍保留在 boundary 顺序中；canceled 变化不会成为已消费 origin。pending 选择使用真实 next-turn head，没有时使用第一个 next-step input，并读取其最新、严格解码的 revision 与 digest。preparer 核查 presentation seal，并保留该 presentation。

准备操作读取并锁定 PG 记录，不改变记录、不发放 Grant、不续租，也不结算 operation。返回的 DTO 不授予执行许可。部署方显式提供 history、record、cohort、request 和 presentation 限额。Platform 初始化和 transport 注册仍由集成方负责；此模块不增加 schema 或 endpoint。

<a id="dev-note"></a>
## 开发备注

无。
