# 内置 Skill 发布资源

[English](README.md) | 中文

这九个 Skill（技能）包来自 PowerEvolve 内置目录。PDF 保留其导入版本；Office 和报告包使用产品目录版本。包内附带的 `SOURCE.json` 记录导入来源和本地适配。Office 指令采用直接文件操作和[执行镜像配置](../../../deploy/README.zh.md)；报告生成器包含明确的英文元数据，并支持在 Linux 上刷新目录。

通过 `node products/power-evolve/application/assets/builtin-skills/build-catalog.mjs` 在 `generated-cloud-v2` 中生成当前 19 个分发文件。生成器负责包版本；[平台目录 loader](../../src/platform/builtin-skills.ts)固定生成目录的摘要。包发生变化时使用新版本。生成器拒绝在已有发布路径写入不同字节。导入的 `generated` 和较早目录代际均保持原样。分发目录更新后，已安装的历史字节和已接受任务的回执仍保留在持久化 Skill 存储中。

PDF 源目录和 ZIP 均保留 `pdf/SOURCE.json` 及其 Apache-2.0 `pdf/LICENSE.txt`。其他源目录与分发 ZIP 一并保留，以便重新生成和审阅已发布字节。

`extractSkillPackage` 和 `readNativeSkillMetadata` 校验器接受全部九个 ZIP，其限额为压缩后 1 MiB、256 个文件、解压后 8 MiB，以及包内 `SKILL.md` 的 256 KiB。平台通过内置目录安装私有的版本化包。任务授权携带 Skill 元数据；指令和资源按需读取，无需创建沙箱。包内可执行资源在获授权的执行镜像中运行。[应用配置](../../README.zh.md)负责库限额、授权和版本选择。

当前九个发布均只声明 `cloud` 目标。Office 使用获授权的云端 `office` 工具；报告脚本及 LibreOffice/Poppler 渲染通过 `cloud_exec` 在可编辑文件所在的 `/workspace` 执行。目录 loader 拒绝其他目标列表以及 release／manifest 不一致。既有私有安装保留固定版本，预置协调既不升级它们，也不恢复已撤销的包。明确安装已验证的后继版本时，历史包字节和已受理任务回执仍保留。
