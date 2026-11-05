# DeepScientist / Airalogy 科研套件

[English](README.md) | 中文

云端接入版本：0.2.1-cloud.20261105.1。供本地检查，不包含账号数据或凭据。

云端多人模式的构建、部署副本整理和验证方法见 [cloud/README.zh.md](cloud/README.zh.md)。原生适配器位于仓库的 `packages/experimental/epri-research`，复用对方平台原有账号、唯一已批准 Preset、会话、文件和执行服务。每个账号使用独立科研存储，模型工具与人工操作分别校验权限。单机兼容入口仍保留，云端部署不启动这些入口。

## 本地构建与测试

要求 Node.js >= 24.14.0。在本目录运行：

```sh
npm ci --no-audit --no-fund
npm run build
npm test
```

原生平台构建与组合测试从仓库根目录运行。真实多人登录和 OpenSandbox 部署验收需要对方实际 Root/account 配置及测试入口；本地组件测试不能代替这些验收。`integration.json` 区分源码、组件与部署验证状态。

## 文件导航

- `plugins/workbench`：科研入口、工作台与交付文件收录。
- `plugins/airalogy`：科研工具及原生人工提问审阅流程。
- `plugins/deepscientist`：工程科研技能及资源加载。
- `src/server`、`src/ui`：科研业务和工作台源码。
- `src/reused`、`upstream`：保留来源声明的复用代码与技能材料。
- `cloud`：云端接入说明、镜像扩展和 Linux 执行验收。
- `tests`：使用临时合成数据的回归测试。
- `dist`：由构建命令生成的后端、网页和浏览器模块。

## 许可

本包为 AGPL-3.0-only，保留 LICENSE、NOTICE、licenses 和各技能的许可文本。原生适配器的许可证不替代此后端及复用材料的许可证。
