# 用户退回修订

本入口只接收用户对当前尚未确认版本的明确修改意见，包括下述当前章节修订上限耗尽后的单次恢复。调用应用负责取得真实用户指令；本地文件CLI不提供账号认证。模型发现问题时应向用户说明并等待指令，不能自行以用户名义退回或确认。用户反馈不代表 `report-reviewer` 审核结论。

## 调用

先保存只含一个字段的UTF-8 JSON反馈文件，例如 `{"feedback":"修正首次引用顺序，并用机构正式名称。"}`。文件仅被读取，不被修改；反馈不能空白，不接受 `decision`、审核分数等额外字段。

```sh
python scripts/workflow_cli.py request-revision state.json chapter:1 \
  --artifact-id chapter-1 --version 1 --request-id user-ch1-r1 \
  --feedback-file user-feedback.json
python scripts/workflow_cli.py next state.json --request-out revision-request.json
```

Python接口为 `request_revision(state, target, artifact_id, version, feedback, request_id)`，返回新状态而不修改传入对象。`request_id`由调用方固定，为用户反馈的幂等编号；`next`另生成 `orchestration.request_id=req_…`，修订响应必须绑定后者。反馈文件应使用工作区私有文件权限，CLI摘要不输出反馈正文。不要把反馈直接拼入命令行。

同一个用户请求编号及相同参数重复调用，返回原状态，不追加反馈、版本、历史或子请求；即使该请求已应用或已失败，也只返回已记录结果。复用同编号但改变任何参数会被拒绝。新的请求必须匹配当前待确认目标及最新 `artifact_id + version`；有进行中的子请求或另一用户退回、目标已确认、目标/版本不符时拒绝。拒绝不写入状态文件。操作必须串行执行，不提供多进程文件写入仲裁。

## 支持矩阵

| 待确认目标 | 已有生成器动作 | 新版本后续 |
| --- | --- | --- |
| `project_profile` | `build_project_profile` | 原项目前置检查与显式确认 |
| `argument_architecture` | `build_argument_architecture` | 原章节映射校验与显式确认 |
| `outline` | `revise_outline` | 原目录确定性门、`review_outline`、显式确认 |
| `reference_plan` | `search_references` | 原来源约束与显式确认 |
| `chapter_plan:ID` | `revise_chapter_plan` | 原计划约束与显式确认 |
| `chapter:ID` | `revise_chapter` | 原字数、过渡、小结门、`review_chapter`、显式确认 |
| `abstract` | `generate_abstract` | 原双语、篇幅、结构、结果元数据门与显式确认 |
| `report` | `revise_report` | 原Markdown清洗、`review_report`、显式确认 |
| `word_report` | 不支持本入口 | 既有结构/视觉失败修复流程继续使用formatter |

本入口不重开已确认目标，不回退其他产物或依赖，不取消自动质量修订轮次上限。用户退回计入独立反馈记录，不伪装成一次正式审核或清空已有自动修订计数。项目档案、架构、参考方案、计划和摘要沿各自已有确认规则，不新增它们原本没有的正式审核动作。

## 章节修订上限耗尽后的单次恢复

仅当阶段为 `AWAITING_USER`、`pending_action=null`、没有待执行用户退回，且 `last_error.chapter_id`、当前章节和 `chapter:ID` 一致时支持。最新正文尚未确认，基线产物编号和版本必须匹配，失败计数必须保留；末条审核必须对应该最新版本且决定为 `minor_revision|major_revision|revise`。允许的 `last_error.message` 与审核来源精确配对如下：

| 上限理由 | 对应末条失败审核 |
| --- | --- |
| `chapter length gate revision limit reached` | `deterministic_chapter_length_gate` |
| `heading bridge gate revision limit reached` | `deterministic_heading_bridge_gate` |
| `chapter summary gate revision limit reached` | `deterministic_chapter_summary_gate` |
| `chapter revision limit reached` | 绑定最新 `reviewed_artifact_id + reviewed_version` 的结构化正式章节审核，不接受确定性门记录替代 |

例如当前 `chapter-2` 的版本3因小结门耗尽而等待用户，可明确提出新反馈后使用 `request-revision state.json chapter:2 --artifact-id chapter-2 --version 3 --request-id user-ch2-limit-1 --feedback-file user-feedback.json`。不编辑阶段、不清空计数、不提高全局上限。历史确定性门记录没有产物编号时，保留其既有按章节槽与版本绑定的语义。

`next`只为这条反馈持久化一个 `revise_chapter` 子请求；重复反馈编号或重复 `next` 不额外授权。新正文和图使用版本4的新路径，`apply`重算字数、章首过渡、小结及既有附属门。任一门仍失败会保留新增失败计数，回到 `AWAITING_USER`；全部确定性门通过后必须对版本4执行真正的 `review_chapter`，正式审核再次要求修订也会继续等待新用户反馈。新反馈必须绑定新的最新失败版本；重放旧反馈不能产生另一轮。旧审核不能确认新版本，只有该版本正式审核通过后才可等待用户显式确认。

错章节、错基线、缺失败审核/计数、`chapter review blocked`、缺字数目标或其他 `AWAITING_USER` 理由、`FAILED`、已确认目标和进行中的请求仍拒绝。子Skill返回 `failed|blocked` 保留原错误处理，不能借此入口泛化恢复；响应身份、版本或历史路径不合法则拒绝应用并保留原pending请求。用户反馈不替代任何业务质量或正式审核规则。

## 版本与证据

状态代际保持 `schema_version=1.1.3`；`user_revision_requests`是新增可选数组，旧状态无需迁移。每条记录包含用户请求编号、目标、基线产物编号/版本、反馈、`feedback_source=user`、请求时间、原阶段以及 `requested|applied|failed` 状态；应用后记录新版本及子请求编号。原正文、原审核和确认记录保持不变。

`next`把 `base_artifact`、独立 `user_feedback`、`revision_instruction`和新版本要求传给真实生成器。目录、章节、全文的 `review_result`仍是已有正式审核原文，其 `pass`不会改写为用户意见。修订必须保留原来源、范围、目录及字数锁；完整返回同一 `artifact_type + artifact_id` 的下一版本。正文和图文件必须使用新路径，不覆写历史输出；即使图内容未变，也应复制到新版本路径并更新正文链接及图元数据。`apply`拒绝声明的旧版本、错误目标和复用历史文件路径，并重新计算已有质量指标。

生成失败保留反馈记录为 `failed`，进入既有失败/用户处理状态，不自动重发。同一反馈编号重放不会触发再生成。版本追加成功后进入该产物的原校验和复审链；绑定旧版本或其他产物的审核不能应用，新版本未取得应有的正式审核 `pass`不能确认。子Skill的自检不能充当正式审核。不得直接编辑 `state.json`、历史正文或旧review来绕过修订。
