# 参考计划证据接口

## 新请求与产物

新的 `search_references` 请求，包括用户退回后的修订，固定 `payload.reference_evidence_contract: 2`。响应的 `reference_plan.content` 直接包含生成器登记的 `internet_access`、`items`，可同时保留 `organization_approach` 等组织方案；禁止嵌套 `reference_registry` 或再保存 `references/verified_references` 别名。apply 从 pending 请求取得代际要求，不能接受模型省略字段而降级；通过后在产物顶层记录 `reference_evidence_contract: 2`。

条目及本地字段见生成器的 [引用与证据规则](../../power-grid-technical-report-writer/references/citation-and-evidence.md) 和 [登记 schema](../../power-grid-technical-report-writer/schemas/reference-registry.schema.json)。本地 `local_file_evidence` 只含相对路径、SHA256 和字节数，放在 `content.items` 内；禁止在产物其他层放本地证据或 `source_root`。普通说明文字可讨论本地材料，不构成经过核验的来源条目。

## 显式根目录与两次核验

已授权执行器应明确提供绝对根目录，不从 JSON、当前目录或模型回复取得根。CLI 参数与 Python 参数只传递该上下文，本身不授予文件访问权限。外部来源不需要此参数；含本地来源时缺少参数即拒绝。

```sh
python scripts/workflow_cli.py apply state.json response.json --source-root /authorized/workspace
python scripts/workflow_cli.py confirm state.json reference_plan --source-root /authorized/workspace
python scripts/run_quality_gate.py --references reference-registry.json --source-root /authorized/workspace
```

Python 接口为 `apply_response(state, response, registry, source_root=...)` 与 `confirm(state, target, source_root=...)`。apply 和 confirm 均调用生成器共享校验器，确认时重新读取文件；apply 后源被删、替换、修改或变为链接，不能继承旧核验结果。路径越界、任一目录/文件符号链接、非普通文件、摘要/字节数不符、读取失败或读取中变化均拒绝。叶文件以非阻塞方式打开，FIFO 不会等待写端。失败时 CLI 不写回 state，pending 和 approved_version 原样保留；不自动重放阶段动作。

## 旧状态与后续消费

无新代际的旧请求/旧草稿，仅保留已捕获的非本地 `content.references` 形状；不会补造其缺失元数据或宣称通过新校验。任何本地保留字段、`file:`/`local-file:` 标识不能走旧分支。旧或新内容中的明确占位 HTTP 来源均拒绝，包括大小写或尾点形式的 `.invalid`；外部 URL 格式检查不等于联网真实性核验。

确认后的同一 reference_plan 传给章节材料、计划、生成、修订、正式章节审核、全文生成/审核和 Word 请求。Word 的既有 `references_data` 直接读取 `content.items`；无需第二份登记。完整 `source_report` 存在时，最终 Markdown 的参考文献仍是 Word 文本的权威来源，不会被旧登记覆盖。正式全文审核必须检查最终文本与已确认来源的对应关系；本接口不自动证明任意最终 Markdown 判断为真，也不生成正式审核或逐页视觉通过结果。
