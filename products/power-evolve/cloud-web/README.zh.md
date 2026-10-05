# PowerEvolve Cloud Web

[English](README.md) | 中文

这个私有包复制当前 DSH Web 外壳，并通过 DSH 公开的启动注入 API 组装原生客户端模块。模块清单包含登录后的对话、多个云工作区、按会话授权的文件操作、显式发布与浏览产物、个人账号设置、个人文本技能管理、执行位置选择和产品品牌／关于插件。设置页面外壳来自上游 DSH。插件和连接器管理页面留待 S6 迁入。

运行 `pnpm run build:power-evolve:web` 前，需要先构建上游 Web 页面与客户端模块。产品 Host 在 `/native/` 提供产物，原有试用页面仍在 `/`。可信平台负责登录，并为原生 Session 传输签发限定范围的浏览器凭据。当前云端试用步骤见 [TRIAL-S4-NATIVE](../TRIAL-S4-NATIVE.md)。

构建产物中的 `asset-list.json` 是 Host 静态资源的精确许可清单。启动脚本写入独立文件。原生 DSH 模块加载器使用 `new Function`，因此这个路由的内容安全策略需要允许 `unsafe-eval`；原试用页面仍使用更严格的策略。

原生侧栏 Browser 记录要求固定的 `desktop-browser` 载体。只有具有完整原生浏览器桥的桌面文档才激活它；普通 Web 文档不注册其标签页或快捷键。工厂仍保留在模块表中以供依赖解析。guest 授权与存储隔离由[桌面主进程](../desktop/README.zh.md)负责。

每个原生插件提供物理文件 `client.js` 及同目录的 `client.<name>.js` 分块。入口 URL 保持为 `./plugins/<package>/client.js?rev=<revision>`；动态分块使用相同目录及所属包的版本摘要。包、应用批次和启动图的版本摘要覆盖所有复制的脚本，仅分块内容变化也会更新摘要。启动时的应用批次只包含入口脚本。缺少入口或其引用的同目录分块时，构建会在替换输出前失败。插件源码映射、Node 入口及其他包文件不进入许可清单。
