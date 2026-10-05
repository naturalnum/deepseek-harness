# 内置 Skill 发布资源

[English](README.md) | 中文

这九个 Skill（技能）包来自 PowerEvolve 内置目录。PDF 保留其导入版本；Office 和报告包使用产品目录版本。包内附带的 `SOURCE.json` 记录导入来源和本地适配。Office 指令采用直接文件操作和[执行镜像的文档工具链](../../../sandbox/README.zh.md)；报告生成器包含明确的英文元数据，并支持在 Linux 上刷新目录。

通过 `node products/power-evolve/application/assets/builtin-skills/build-catalog.mjs` 重新生成 19 个分发文件。生成器负责包版本；[平台目录 loader](../../src/platform/builtin-skills.ts)固定生成目录的摘要。包发生变化时使用新版本。分发目录更新后，已安装的历史字节和已接受任务的回执仍保留在持久化 Skill 存储中。

PDF 源目录和 ZIP 均保留 `pdf/SOURCE.json` 及其 Apache-2.0 `pdf/LICENSE.txt`。其他源目录与分发 ZIP 一并保留，以便重新生成和审阅已发布字节。

`extractSkillPackage` 和 `readNativeSkillMetadata` 校验器接受全部九个 ZIP，其限额为压缩后 1 MiB、256 个文件、解压后 8 MiB，以及包内 `SKILL.md` 的 256 KiB。平台通过内置目录安装私有的版本化包。任务授权携带 Skill 元数据；指令和资源按需读取，无需创建沙箱。包内可执行资源在获授权的执行镜像中运行。[应用配置](../../README.zh.md)负责库限额、授权和版本选择。

Word、Excel、PowerPoint 和四个 Word 报告套件发布声明 `cloud` 与 `desktop` 目标；PDF 和 LaTeX 仍仅支持 `cloud`。三个 Office 包在两个目标使用同名 `office` 工具。报告脚本及 LibreOffice/Poppler 渲染使用当前获授权目标对应的 `cloud_exec` 或 `desktop_exec`，其 `/workspace` 包含可编辑文件；云端和本机文件保持分离。目录 loader 拒绝不支持的目标列表，以及 release 与 manifest 的目标不一致。目标元数据不代表桌面业务试用已经完成，也不授予 Device 执行权限。
