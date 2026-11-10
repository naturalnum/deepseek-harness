# 本机候选环境冒烟检查

在独立工作目录使用 Node 24.19.0，先完成 `pnpm install --frozen-lockfile`。脚本复用 `apps/web` 的 Playwright 依赖；首次使用时安装 Chromium：

```sh
pnpm --dir apps/web exec playwright install chromium
```

默认入口是 `http://127.0.0.1:32802`，也可用 `--url` 指定本机候选入口。不要连接试用服务器。

使用现有私密 JSON，选择普通账号 C：

```sh
node deploy/smoke/check.mjs --credentials '<私密JSON>' --account ordinaryUserC
```

文件必须是权限为 0600 的普通文件。支持顶层 `email`、`password`，或账号字段下的同名字段；`--account` 默认是 `ordinaryUserC`。文件若有 `publicOrigin`，其来源必须与本次入口一致。

也可在运行环境中提供 `PE_CLOUD_SMOKE_EMAIL`、`PE_CLOUD_SMOKE_PASSWORD`，然后运行：

```sh
node deploy/smoke/check.mjs
```

口令不放在命令行参数中。`--help` 无需凭据，可查看参数。

## 九项检查

1. 首页返回 200，未登录的 `/cloud/bootstrap` 返回 401。
2. 测试账号登录成功，登录后 `/cloud/bootstrap` 返回 200。
3. 新建对话并收到模型回复。
4. 在沙箱执行一条命令，核对实际输出。
5. 同一对话连续执行五次独立命令，覆盖沙箱更换路径。
6. 创建文件，用文件名搜索和内容搜索工具找到它。
7. 上传文本文件，由模型读取其中的随机内容。
8. 生成文件，在界面预览并下载，核对内容。
9. 退出后重新登录，找到原对话并继续执行命令。

结果逐项打印到终端。九项全部通过且总用时不超过五分钟，退出码为 0；存在失败、未验证或超时，退出码为 1。不依赖失败项的后续检查继续运行。

错误口令负例会在内存中生成随机错误口令；预期登录失败，退出码非 0：

```sh
node deploy/smoke/check.mjs --credentials '<私密JSON>' --account ordinaryUserC --wrong-password
```

MCP 和科研模式检查尚未实现。显式指定 `--mcp` 或 `--research` 时报告未做，并以非 0 退出。

检查会留下一个对话及三个随机命名的小文件供复核，不自动删除。失败时保留终端结果交给评审者，不通过手工改数据库、删除产品状态文件或重启应用来制造通过。
