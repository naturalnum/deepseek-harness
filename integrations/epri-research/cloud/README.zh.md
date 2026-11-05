# 云端接入与本地检查

[English](README.md) | 中文

此目录供接手方将科研套件接入自己的云端多人平台。原生插件的账号、权限与生命周期约定见[插件说明](../../../packages/experimental/epri-research/README.zh.md)。生产部署配置、账号密码和令牌不在源码包中。

## 构建

在仓库根目录安装锁定的 pnpm 依赖，并在 `integrations/epri-research` 单独执行 `npm ci`、`npm run build`。随后回到根目录执行 `pnpm run build:artifacts` 和 `pnpm run build:check`。需要 Node 24.14 或更新版本；使用根目录 `packageManager` 指定的 pnpm 版本。不能仅复制原生插件而省略科研后端、`dist/ui` 或 `upstream` 资源。

科研后端 `dist/server/cloud-plugin.mjs` 由原生插件加载。它不启动单机 HTTP/MCP 服务，不读取单机研究账号凭据，也不使用全局数据目录。生产部署解析锚点的 package.json 必须显式包含原生插件和 `deepscientist-harness-suite`，让平台的包解析器提供浏览器模块；不要给默认 Web 产品增加隐式依赖。

## 配置副本

配置整理脚本位于 `packages/experimental/epri-research/scripts/prepare.ts`。输入 JSON 包含 `root`、`account` 两个已解析的 Loader entry 数组，Linux `installationDirectory`、新的 `recipeVersion`，以及以下显式字段：

```json
{
  "service": {
    "python": "/opt/epri-python/bin/python3",
    "maxJsonBytes": 4194304,
    "maxOutputBytes": 8388608,
    "graceMs": 5000
  },
  "web": { "requestTimeoutMs": 180000, "maxPendingRequests": 8 }
}
```

这些数值是待审核的示例，必须同时满足部署原有的请求、响应、存储与执行容量。输入应来自实际已批准配置；不要将原配置里的表达式当作普通字符串复制进 JSON。脚本要求唯一既有 Preset、托管技能资源提供器以及一致的配方版本。它不扩大原容量，不创建第二套账号、不添加第二个 Preset。

从源码根目录运行：

```sh
node --import tsx/esm packages/experimental/epri-research/scripts/prepare.ts input.json review-output
```

输出目录必须不存在。检查 `root.json`、`account.json`、`dependencies.json` 和新的 Preset 指纹，将账号文件放到 Root 原有 `native.configPath` 指定的位置后，再通过原平台 `dsh` profile 启动。原平台仍负责完整配置校验、Root 配方审核、账号资源分配和登录，脚本输出本身不代表部署已通过验收。

## 云端计算镜像

用本目录 Dockerfile 扩展对方已经批准的 Debian 系 OpenSandbox 基础镜像，并保留该镜像原运行用户：

```sh
docker build --build-arg BASE_IMAGE=APPROVED_IMMUTABLE_IMAGE --build-arg RUNTIME_USER=ORIGINAL_USER -t research-sandbox:review -f integrations/epri-research/cloud/Dockerfile .
```

扩展安装 Airalogy 0.16.0、Git、Poppler、Tesseract 中英文数据及隔离 Python 环境。生产镜像应记录不可变摘要和实际安装清单，由原平台配置选用。Dockerfile 不替换 OpenSandbox 的启动入口。只含 Airalogy 的测试镜像不能代替对方完整的 OpenSandbox 基础镜像。

## 检查范围

科研核心测试通过 `npm test` 运行。原生 Loader、Gateway、双账号隔离、卸载、工具会话回放及配置整理测试位于插件的 `tests` 中，可通过根目录 Vitest 按文件运行。云端模型调用、OCR 和 Git 均使用当前 Session 的原生执行提供器；提供器或账号权限失效时应报错，不能回落到 Host 执行。

正式环境还需核对两个真实账号同时登录、退出后的旧窗口请求、跨账号对象拒绝、技能资源在真实账号项目中的落盘、OpenSandbox 内的计算/OCR，以及账号卸载时的执行清理。这些验证需要实际部署配置和测试入口，不能由本地组件测试代替。
