# Linux 部署镜像可审查方案

2026-10-09；员工4独占 deploy/Dockerfile、cloud-image*.mjs、必要的 cloud-image 构建配置、employee4-image.test.mjs 以及 deploy README／交接。员工2已确认其三个客户端包文档与本目录无重叠；已向员工6通知本边界。官方基线固定为 `dsh-v0.2.1-alpha.1`，具体基线提交记录于 [baseline.json](baseline.json)。不修改共享应用源码、根配置、既有 lib／dist、现有 PG／卷或 namespace。

1. 构建 context 由工具复制显式目录及配置文件，拒绝 symlink、私有文件及源码读取期间改写，记录完整相对路径／SHA 清单。排除所有既有 node_modules、lib、dist、native bin、.env、.git、private、部署输入和测试资源；没有 `COPY .`。固定基线官方源码与当前产品源码分别核读。
2. 多阶段 Dockerfile 固定 Node 22.23.2 Bookworm slim 的实际 digest 与 Debian 20260901 签名 snapshot。新 Linux pnpm store、frozen lockfile、官方 Node-API 编译器／头文件生成真正的 glibc flock。只构建 CLI、产品 Host／Platform、必要 Web 客户端与静态资产；不执行 Desktop 构建或导入 Mac 产物。
3. 镜像只包含冷构建的 Linux依赖和运行文件。入口为现有 deploy/start.mjs，参数为 host／platform 及挂载的私有 deployment JSON；其子进程仍为正式 apps/cli/lib/bin.js --profile power-evolve-cloud-<role>。默认 UID/GID 1000，凭据目录分别挂载：Host仅 worker-token，Platform持有其数据库／provider／connector凭据。凭据从不进入context、镜像层或构建参数。
4. 新 image 测试只创建带随机员工4标识的镜像、容器、network／volume及隔离 PG资源，按精确ID清理。验证Linux构建清单、实际flock竞争与关闭后重获、正式CLI/Profile健康与真实SIGTERM停止，Host无法读取Platform配置，私有输入不进入层。未完成的项保持失败，100%覆盖阈值不降低。
5. 备份工具以实际具备chown权限的Linux进程，在监督两个真实Profile的同一PID namespace中运行。通过真实Profile启停生成停止证据，再执行普通PG角色的备份／独立恢复；不移入Mac stop JSON、不改已有文件所有权、不把部分stage改名成功。完整业务重绑定验收仍按正式部署流程执行。

先执行唯一 owned image 的 no-cache 冷构建，保留依赖安装、原生编译和失败日志；据实际运行修正本目录构建脚本。发布或替换正式部署不属于本轮。
