# Employee1 Contracts consumer handoff

2026-10-09：新增四份员工1专属 source 测试，最终 **132/132 通过，0 fail、0 skip**；仅 Office 与 file-download 两份 Contracts 源码的 lines/statements/functions/branches 均为 100%，保留原每文件四项 100% 门槛。 本批没有修改生产、旧测试、Manifest、锁文件、构建上下文或配置；Office 原有生产与 CI helper 继续冻结。 独立 wire fixtures 未由 schema.shape 生成，也未复制生产谓词；实际消费入口和边界如下。

| 新测试 | 实际 source 入口 | 验证行为 |
| --- | --- | --- |
| [Office Host](contracts/tests/employee1-office-host.spec.ts) | NativeOfficePreview.render | 来源路径/摘要/generation、状态错误、轮询 job 绑定、完整 canonical base64、字节数/PDF 摘要、输入/输出预算；拒绝不返回内容，发出原 job 或 request 的取消意图。 |
| [Office Platform](contracts/tests/employee1-office-platform.spec.ts) | OfficePreviewService.status/content/cancel/tick | 实际读取私有目录内 PDF/result/failure 文件；拒绝错误 job/nonce/generation/source hash、backend、PDF signature/EOF/hash、混合 selector；独立 stop 缺失时不交付内容。 |
| [Download Host](contracts/tests/employee1-download-host.spec.ts) | apply 安装的真实 Host HTTP、TypertGateway、ProductRemote.filesDownloadPrepare，以及下载解析/转发方法 | 同源 canonical URL 与请求 Session/selection/revision/filename/count/bytes 绑定；不合法响应不暴露下载目标、不请求内容；真实 HTTP 输出、零字节、错误 header、重复参数与 paths JSON。 |
| [Download Platform](contracts/tests/employee1-download-platform.spec.ts) | FileDownloadService.prepare/open | 手写预期 metadata digest、零字节、路径边界、变更 selection/bytes/binding/revision，错误后不打开 stream；open 后来源变更在首 chunk 前拒绝。 |

有效 result/failure marker 与 worker exit 只记录待确认事实：实际 tick 保持 stopping、保留 parser slot、stop_evidence 与 completed_at 为 null，content 拒绝，且不写 stop proof/完成态。 这里没有把“拒绝发布”描述为没有任何持久化：待确认 worker observation/result 可以保存，独立终止确认仍缺失。 取消回复同样只代表取消意图，不能充当 stop certificate。

真实资源为独占 loopback HTTP listener、真实 RuntimeScope/Host/Typert carrier、独占 0700 临时目录及物理 marker/PDF 文件读取。 Platform wire、PG query/row、文件来源与 binding、Kubernetes API 观测为显式 unit substitutes；PG 的公共构造器按 Application package 的正式依赖位置解析，但没有连接数据库。 下载 Host fixture 仅关闭无关 Scheduler 后台 claim，保留被测 RPC、鉴权、Gateway 与 HTTP 方法。 PDF 字节夹具检验该 consumer 的 signature/EOF/hash 接收逻辑；本批未运行实际 Office 转换、PDF 阅读器、真实 PG 锁/持久化、多副本竞态、Kubernetes/runsc stop 或浏览器 DOM。 此前真实转换证据继续归于冻结的 Office 交接，不并入本批 132 项。

合法路径受 512 字符限制，不能达到 6000 字节 URL ceiling。 URL builder 的 exact/one-over 预算用故意未通过路径 admission 的长字符串单独验证；真实 query consumer 仍拒绝它，不能据此声称浏览器接受 6000 字节合法选择。 非法 Content-Length 在真实 HTTP parser 层先拒绝，Host 返回 503/service_unavailable 且无 attachment；其他可读取的错误 metadata 返回其实际公开错误。

官方 cloud 映射规则对这四文件的真实 Host leaf typed lint 为 **exit 0**。 完整 TestHost source program 的最终 tsc 为 **exit 2**，本批四文件诊断为 **0**；该次实际日志有 27 项其他 source/test 诊断，项目类型检查仍未通过。 这些结果只覆盖本批两个协议源文件，不表示所有 Contracts 模块、Host/Platform 源码覆盖率或整个迁移验收通过。 员工3拥有 source-plane 配置，本批未修改它。

最终冻结与检查证据：[机器记录](../../.artifacts/employee1/contracts-consumer-final-proof.json)、[14 个输入 SHA](../../.artifacts/employee1/contracts-consumer-final-inputs.json)、[132 项与 coverage 原日志](../../.artifacts/employee1/contracts-consumer-final4.log)、[coverage 原始转换结果](../../.artifacts/employee1/contracts-consumer-coverage-final4/coverage-final.json)、[typed lint](../../.artifacts/employee1/contracts-consumer-lint-final4.log)、[完整 source types 失败日志](../../.artifacts/employee1/contracts-consumer-types-final4.log)。 最终测试及消费源码/配置输入前后 SHA 未漂移，两份协议源码 SHA 与员工3提案相同。 此前 direct pg import、非法 HTTP header 错误预期、巨大 Buffer deep-equality 超时、自己的 types/lint 与初次两项 coverage guard 失败日志全部保留，没有改门槛或跳过用例。
