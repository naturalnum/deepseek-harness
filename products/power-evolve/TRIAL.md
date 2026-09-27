# 切片 1 试用指南

## 运行条件

需要 Node 22.19+、pnpm 11、Docker，以及可用的 DeepSeek API 配置。首次在新检出目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run power-evolve:trial up
```

试用地址为 <http://127.0.0.1:18880/>，登录在可信平台 <http://127.0.0.1:18881/login> 完成。PG 仅绑定本机 `18432`，Compose 项目名为 `pe-shared-host-slice1`。既有 PowerEvolve 试用的端口与数据库不参与本版本。

配置保存在 `~/.config/power-evolve/shared-host-slice-1/`，目录权限为 `0700`，文件权限为 `0600`。`model.env` 接受 `DEEPSEEK_API_KEY=...`；准备脚本只在文件不存在时生成配置。已有模型配置不会被覆盖。两个测试账号为 `alice` 和 `bob`，各自随机密码保存在该目录的 `users.json`，请在本机读取，勿提交到仓库或聊天中。不要更改文件内密码来重置已有账号；初始化不会覆盖 PG 中已有的密码。

## 五步试用

1. 打开两个独立标签页，分别登录 Alice 和 Bob。浏览器令牌保存在各标签页的 `sessionStorage`，登录后即清除 URL 中的令牌。
2. Alice 新建对话，发送“hi，我的代号是青松，请记住”；Bob 新建对话，发送“hi，我的代号是海蓝，请记住”。
3. 分别追问“我的代号是什么”。两边应使用自己的历史，对话列表也应不同。
4. 刷新两个页面，再打开已有对话。历史仍在，可以继续追问。
5. 等待回复完成，重启服务，再刷新并继续。普通对话期间只运行共享宿主、可信平台与 PG。

## 生命周期与数据

在启动该版本的检出目录执行：

```sh
pnpm run power-evolve:trial status
pnpm run power-evolve:trial stop
pnpm run power-evolve:trial up
pnpm run power-evolve:trial restart
```

`stop` 只停止本版本记录且能验证身份的应用进程，保留 PG 与数据卷。日志在 `.artifacts/power-evolve/host.log` 和 `platform.log`；各服务的 `trial/<服务>/ready.json` 记录进程身份与地址。所有应用配置文件和日志都属于当前检出目录，数据库与私密配置独立保存。

切片 1 使用新建数据库，不迁移旧版 PowerEvolve 数据。表结构版本为 `1`，Native Session 格式为 `4`；启动拒绝不支持的结构版本。升级前备份数据库，并保留能读取原结构的固定提交。当前结构内恢复可使用相同数据卷与配置重新启动；不承诺跨未来结构变更直接回退。

```sh
mkdir -p .artifacts/power-evolve/backups
docker exec pe-shared-host-slice1-postgres-1 pg_dump -U powerevolve -d powerevolve -Fc > .artifacts/power-evolve/backups/slice1.dump
```

恢复时先停止应用，恢复到新的数据库进行校验，再修改可信平台的 `database-url` 文件切换。不要用自动测试覆盖试用数据库。测试为每次运行创建独立数据库、临时配置和随机监听端口，完成后删除自己的资源。

## 回归与限制

```sh
pnpm run test:power-evolve
```

该命令使用真实 PG、真实 Profile 和确定性模型响应，不消耗真实模型额度。会话快照的用户输入、模型回复与完整事件记录共同参与回放，只有显式执行 `PE_RECORD_SNAPSHOT=1 pnpm run test:power-evolve` 才重写快照；提交前审查差异。

已消费但未完成的模型请求在重启后显示中断，用户可发送新的输入继续。`accepted` 表示持久受理，尚未表示生成完成。模型输出达到本账号上限会显示对应结束状态。

本版本是本机双进程试用，尚未验收集群中的网络策略、独立 OS 身份与密钥挂载隔离。网页使用独立的产品入口；原生 DSH 网页中的全局配置和本机执行入口不在其中。文件、技能、审批、编程沙盒和桌面执行按后续切片交付。
