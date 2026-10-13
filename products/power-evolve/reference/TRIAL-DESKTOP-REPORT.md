# Mac 安装版报告与云端文件验收

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

## 固定范围

2026-10-07，实际 Mac ARM64 `PowerEvolve.app` 通过原生 DSH 会话、真实 DeepSeek、所属 Device、PG、Docker 和 k3s 完成 Alice 的本机合成报告流程及显式云端导出。后台源码固定为 `83e46b3dde7adbdba3f8c70ba6f3d64856b0818c`，schema V33；安装应用固定源为 `54282f247cc4c254836ea4204496e608a6c21c9c`。官方基线仍由 [baseline.json](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/baseline.json) 固定。

报告确认由合成 QA 测试账号执行，不是用户的人工业务批准。Alice 的工作流为 `COMPLETED`，Word v3 验证通过且对应 artifact 的 approved version 为 3；旧版本、失败和章节批准记录保留。Bob 的本机 CH1 确认及 Alice 文件越权拒绝已有真实证据，未将其计为第二份完整报告。

## 实际结果

| 场景 | 结果 |
| --- | --- |
| 本机报告 | 材料、提纲、章节及修订、审阅、摘要、封面、Markdown 和 Word 沿正式技能工作流执行；最终确认使用正式 CLI，没有直接改写 state |
| Word 验证 | 原始导出 PDF 的 34 页逐页接受 Root AI 视觉检查；正式 apply 保留对应渲染与验证记录，没有声称人工批准 |
| 显式传输 | 本机授权 UI 的三个导出按钮分别传输 Markdown、DOCX、PDF；实际 PG 回执、云端读回和原文件大小、SHA-256 一致 |
| 原生预览 | Alice 从默认工作区原生文件栏点击 DOCX，出现已绘制 canvas；点击前 baseline 外只有一个新 Office job，绑定当前 owner、Session、Workspace、源摘要和固定解析器 |
| 实际下载 | 点击文档头部下载按钮，原 Electron Session 收到一次 `will-download`，文件实际完成；120,061 字节及 SHA-256 与原 DOCX 相同，没有用 API 字节代替下载 |
| 跨用户拒绝 | Bob 新登录后请求 Alice 精确 Session 的文件下载、stat、readBytes 和 Office render，均拒绝且无文件字节；Office 全量记录未变化 |
| 正常退出 | 两个安装应用依次正常退出，exit 0、signal null，无强制终止；最终零未完成输入、云端执行、桌面执行或解析任务 |

三个云端文件均在 Alice 原默认 Workspace；本轮没有发布不可变产物。

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `alice-o6-v3-20261007-r8.md` | 46,590 | `4e368b8fcff499aca46c068e486c7cdcc3c7c1980be1830dc5b3d008abcbec31` |
| `alice-o6-v3-20261007-r8.docx` | 120,061 | `a019531d3e889ab5817d4f220f5defee2a3d35d4988a67fed7833912a1cca112` |
| `alice-o6-v3-20261007-r8.pdf` | 358,079 | `82c89f6db4c33cba77abc8d883ec2e5424f652f6bc078d49bc6e2596911b2048` |

原生 Office 转换使用固定 WASM 解析器，其 PDF 为 36 页并报告 Tahoma、Calibri、宋体、Times New Roman、黑体替代告警；这是可见预览验收，不是与原始 34 页 PDF 的排版一致性或逐页视觉验收。原始 PDF 与下载的 DOCX 字节不变。该字体范围需要独立处理，不能隐去告警宣称一致。

第一次预览测试未捕获预期 HTTP 响应而超时，但实际解析任务成功并停止；旧 partial 保留且不计通过。新测试以真实文件点击、绘制后 canvas 和完整绑定的新 PG job 验收，明确未直接捕获 HTTP 响应或独立读取转换 PDF 字节。解析 worker 实际 exit 0；PG 保存原 Pod、容器和镜像的 `KUBELET_STOPPED`，parser slot 为空。

Bob 早期 CH1 测试含一次旧路径失败，后续正式确认已成功；只读对账保留这两个事实，没有重发原 Send、清除 journal 或把旧全成功条件改为通过。

## 启停与试用

后台快照为 `~/.local/share/power-evolve/trials/native-report-20261006-o6-r8/`。使用其中 `node/bin/node backends.mjs start|status|stop|renew`，实际命令从该目录运行；正常停止保留数据。Host 为 `http://127.0.0.1:21040/native/`，可信登录入口为 `http://127.0.0.1:21041/login`。访问令牌需要按快照启动器续期，状态检查只证明检查时 ready。

1. 打开 Alice 应用 `~/.local/share/power-evolve/trials/desktop-report-20261006-o6-alice-r3/PowerEvolve.app`，使用现有 `alice` 账号重新登录。凭据在 `~/.config/power-evolve/shared-host-desktop-report-o6-20261005/users.json`，不要分享该文件。
2. 选择默认 `Workspace` 的已完成报告会话，在右侧文件栏打开上述 DOCX 或原始 PDF，下载并查看成果。
3. 正常退出 Alice 应用，再打开 Bob 应用 `~/.local/share/power-evolve/trials/desktop-report-20261006-o6-bob-r3/PowerEvolve.app`。账号为 `bob-o6-report`；现有安全登录文件在同一私有根的 `qa-accounts/bob-o6-report/`。Bob 只能查看自己的会话和工作区。
4. 正常退出后查询后台状态。不要同时打开同一 namespace 的应用；保留配对、原 journal 和共享 writer 记录。

日志归同一快照的 `backends.mjs` 及私有后台日志目录；实际 App、输入配置和证据具有独立文件 SHA 校验。本机试用依赖已配置的 Docker、PG、k3s、固定镜像和私有凭据；签名、公证、更新发行及其他部署环境保留其实际验收范围。

## 证据

本机证据根为 `.artifacts/desktop-report-o6-20261007/`。`alice-r8-word-v3-validation-apply/actual-native-step/receipt.json` 保存验证 apply；`alice-r8-word-v3-confirm-export/actual-native-step/receipt.json` 保存正式确认及三个实际导出，SHA-256 为 `21f2bfab151becc09e9f67a3d982818c72625ca34aa1a1cf551dda21a896e5fc`。

`alice-bob-r8-native-files-office-r2/actual-trial/receipt.json` 保存两安装应用、预览、真实下载、四个拒绝及正常退出，SHA-256 为 `a3bc7f9a070d1a92a1484466eee8e9c2e6c4f33f27247c6b1c7fa0b916850e4f`；同目录保存实际截图和下载文件。`bob-r8-chapter1-reconciled/actual-read-only-reconciliation/receipt.json` 保存旧执行的只读对账，不重放业务动作。

本记录不替代通用 STDIO、当前 schema 的完整备份恢复、取消及未知执行结案剩余路径、OS 选择器或桌面发行验收；完整产品继续按[交付计划](DELIVERY-PLAN.md)推进。
