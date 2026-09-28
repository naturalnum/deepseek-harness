# PowerEvolve Cloud Web

[English](README.md) | 中文

这个私有包复制当前 DSH Web 外壳，并通过 DSH 公开的启动注入 API 组装原生客户端模块。模块清单包含对话界面及其依赖，不包含技能和插件管理页面。

运行 `pnpm run build:power-evolve:web` 前，需要先构建上游 Web 页面与客户端模块。产品 Host 在 `/native/` 提供产物，原有试用页面仍在 `/`。静态外壳尚未接入 PowerEvolve 登录和对话传输。

构建产物中的 `asset-list.json` 是 Host 静态资源的精确许可清单。启动脚本写入独立文件。原生 DSH 模块加载器使用 `new Function`，因此这个路由的内容安全策略需要允许 `unsafe-eval`；原试用页面仍使用更严格的策略。
