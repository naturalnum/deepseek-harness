# PowerEvolve Cloud Web

[English](README.md) | 中文

这个私有包复制当前 DSH Web 外壳，并通过 DSH 公开的启动注入 API 组装原生客户端模块。模块清单包含登录后的对话、多个云工作区、按会话授权的文件操作、显式发布与浏览产物、个人账号设置、执行位置选择和产品品牌／关于插件。设置页面外壳来自上游 DSH。技能和插件管理页面留待核心链路完成后迁入。

运行 `pnpm run build:power-evolve:web` 前，需要先构建上游 Web 页面与客户端模块。产品 Host 在 `/native/` 提供产物，原有试用页面仍在 `/`。可信平台负责登录，并为原生 Session 传输签发限定范围的浏览器凭据。当前云端试用步骤见 [TRIAL-S3-NATIVE](../TRIAL-S3-NATIVE.md)。

构建产物中的 `asset-list.json` 是 Host 静态资源的精确许可清单。启动脚本写入独立文件。原生 DSH 模块加载器使用 `new Function`，因此这个路由的内容安全策略需要允许 `unsafe-eval`；原试用页面仍使用更严格的策略。
