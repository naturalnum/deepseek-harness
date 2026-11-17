---
kind: upgrade-guide
description: "升级产品包之前，将 Cloud 报告资源配置改为产品自有包中的目录。"
---

# 使用产品自有报告资源

[English](guide.md) | 中文

## 变更

完整报告资源从 `packages/skill/skill-office/assets/reports` 移至 `packages/cloud/pe-opensandbox/assets/reports`。脚本、模板、图片、说明与生成的打包载荷保留原始字节。从源码树复制报告资源的部署需选择新根目录。原生文件系统发现、技能版本、包下载和执行继续作为消费者。

Cloud 登录布局与样式现在通过静态 `pe-cloud-web` 包交付。Cloud 品牌图标归 `pe-cloud-client` 私有，仓库消费者不再从原生 UI 基础组件导入 `LightningMark`。

ARM64 候选的精确镜像组合和资源哈希见[内容镜像记录](../../../../deploy/upstream/report-content-arm64-image.json)。已有合格组合继续保留；新增组合只接受记录中的 workload/server 配对。既有运行时标题编号适配的两行差异继续单独记录，原始归档保持不变。

Root 的 TypeScript world 参数与冻结 Python 启动器现在同时包含 `MALLOC_ARENA_MAX=1`，完整 guardian 字节预算也计入该参数。升级需同时交付这些修复及对应回归向量；原有 4 KiB 命令上限、4 GiB 存储预分配和 3 GiB 父目录余量保持不变。

## 迁移

1. 按现有部署流程构建并校验正常产品包。在租户可写存储之外准备新版报告目录，保留所有文件及权限，同时保留原始来源和许可说明。
2. 使用 [Cloud 覆盖配置](../../../../apps/cli/config/examples/cloud-builtin-skills.cordis.yml) 时，将 `DSH_BUNDLED_REPORT_SKILLS` 设为新版 Host 目录。已有显式 `bundledSkillDir` 也需选择同一发布。guest `bundledExecutionRoot` 保持 `/opt/dsh/skills/reports`；[当前 Docker 配方](../../../../packages/cloud/pe-opensandbox/runtime/office/Dockerfile) 读取新源码根。沿用正常 Root 封存、排空和部署生命周期。
3. 在工作树运行 `python3 deploy/upstream/package-builtin-skills.py --check` 与 `node deploy/upstream/content-check.mjs`。确认目录发现、完整归档下载、安装和更新，再通过独立候选环境的产品生成并打开报告。切换共享部署前验证相关导出和旧会话继续操作。
4. 候选验收完成前保留旧部署。不得为了移动源码资产而改写持久化 Session 日志或替换存储归属记录。

正常产品包提交 `5475be51bba4241291c28045245811b4b480e0f6` 已在独立 ARM64 Cloud 候选完成验收：两个独立浏览器账号、六套完整归档下载、技能安装更新、密钥编辑删除、插件状态隔离、刷新与退出重登，以及原生 Linux 工具生成并经认证接口下载 DOCX/PDF。PDF 两页均已渲染检查。测试使用确定性工具驱动和测试密钥，没有调用外部模型 API；原有部署与存储归属记录未改写。
