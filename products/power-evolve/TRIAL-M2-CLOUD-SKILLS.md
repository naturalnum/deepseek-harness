# 云端内置 Skills 后继目录检查

2026-10-09，Asia/Shanghai。当前源码的内置目录为 [generated-cloud-v2](application/assets/builtin-skills/generated-cloud-v2/catalog.json)，固定摘要 `1b10a73cb75e9867dc460dcfeb2cc85da6dbd31d62b0967a2ac90145fd4f4056`。九个 release 与 manifest 均只接受 cloud。Office 活跃指令仅使用获授权云端执行，保持同一个 `/workspace`。导入的 generated 和较早分发代际保持原字节；明确安装后继版本不覆盖旧私有安装字节或已接受任务回执。默认预置协调不会自动升级已有安装或恢复已撤销包。

[生成器](application/assets/builtin-skills/build-catalog.mjs)对已有路径使用创建式写入，遇到不同字节直接失败。当前后继只修改需要改变目标或活跃说明的产品包，并给这些包新版本；PDF 和 LaTeX 保留原版本。包内历史修改记录仍保留原说明。[目录 loader](application/src/platform/builtin-skills.ts)同时核验目录摘要、具名条目、manifest、ZIP 大小与摘要，并拒绝额外文件和 symlink。

[真实验证文件](application/tests/builtin-cloud-skills.spec.ts)包含 5 例，全部通过、0 skip：全部九个 ZIP 原生提取／元数据；目录篡改与多余文件拒绝；损坏和 symlink ZIP 拒绝；九个私有包真实 PG 发布、服务重建不重复安装、原始字节读回、Bob 独立目录、幂等安装及跨用户 requestId 冲突；导入代际摘要保持。日志为私有证据目录中的 `builtin-cloud-skills-validation-fixed.log`。初次运行在夹具删除只读发布目录时失败，失败日志 `builtin-cloud-skills-validation.log` 保留；测试仅对自有临时目录恢复可删除权限后完成回归，不改变产品发布权限。

当前正式构建的 `BuiltinSkillCatalog` 已从 generated-cloud-v2 读取并核验全部九个 ZIP；新具名 Platform Profile 使用这份构建。构建输入、产物、Profile 与用户路径证据见[并行集成验收记录](TRIAL-M2-PARALLEL-INTEGRATION.md)。原有 Alice／Bob 的已安装包没有被此次测试自动升级。实际现有安装升级、真实 Office／报告执行、完整 Skills 用户路径、逐文件 100% 覆盖率和全量恢复演练尚待完成，因此 F12／M3 尚未整体验收。
