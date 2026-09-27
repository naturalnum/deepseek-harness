# 切片 2 试用指南

这个版本在切片 1 的双用户对话上增加文件和个人技能。试用仍由共享 DSH 宿主、可信平台和 PostgreSQL 组成；普通文件操作和读取技能不会启动执行沙盒。

## 启动

需要 Node 22.19+、pnpm 11、Docker 和已保存在私密文件中的 DeepSeek API 配置。在本版本的检出目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
export PE_TRIAL_NAME=slice2 PE_DATABASE_PORT=18433 PE_HOST_PORT=18882 PE_PLATFORM_PORT=18883
pnpm run power-evolve:trial up
```

网页地址为 <http://127.0.0.1:18882/>，登录由 <http://127.0.0.1:18883/login> 完成。PostgreSQL 只监听本机 `18433`。私密配置、测试账号和文件位于 `~/.config/power-evolve/shared-host-slice2/`；`users.json` 包含 Alice 与 Bob 的独立随机密码，请在本机读取，不要提交或粘贴到聊天。模型密钥从同目录的 `model.env` 读取。脚本只在私密文件不存在时创建，不会覆盖已有试用数据。

已有切片 1 试用仍在 `18880`、`18881`、`18432`；两个版本使用不同的 PostgreSQL 卷和私密目录。当前试用的工作区字节在 `workspaces/<workspace UUID>/`，个人技能说明在 `workspaces/extensions/<user UUID>/`，文件清单和归属由可信平台核验。

## 五步体验

1. 用两个独立浏览器标签登录 Alice 和 Bob。Alice 说一句 `hi`，刷新后继续同一对话。
2. Alice 打开右侧“文件”，上传一个不超过 2 MiB 的文本文件；打开文件、编辑、保存并下载。刷新页面后再次打开，内容应保留。
3. Bob 打开“文件”，看不到 Alice 的文件。Bob 可上传自己的文件，Alice 也看不到 Bob 的文件。
4. Alice 打开“技能”，安装一个含特殊代号的个人技能说明，发消息询问其内容。模型应能使用这份说明；Bob 的技能清单仍为空。
5. 执行 `pnpm run power-evolve:trial restart`，刷新两个页面，确认历史、文件和技能仍在。平台 `/health` 的结构版本应为 `2`。

查看状态或停止应用进程：

```sh
pnpm run power-evolve:trial status
pnpm run power-evolve:trial restart
pnpm run power-evolve:trial stop
```

`stop` 不删除 PostgreSQL 卷或文件。日志在当前检出目录的 `.artifacts/power-evolve/slice2/host.log` 与 `platform.log`。不要将自动测试指向试用数据库；产品测试创建独立数据库并在结束时清理。

## 数据升级与恢复

这个版本的表结构为 `2`，原生 DSH Session 格式仍为 `4`。首次启动时，可信平台可以把切片 1 结构从 `1` 事务性升级到 `2`；已有会话与事件保持不变。升级前必须同时备份 PostgreSQL 和对应的 POSIX 工作区，并在恢复时同时恢复两者。切片 1 程序不能直接读取已升级的结构；回退应恢复升级前的数据库备份并启动原版本。当前独立试用数据库从空库创建，不会迁移另一版本的数据。

```sh
mkdir -p .artifacts/power-evolve/slice2/backups
docker exec pe-shared-host-slice2-postgres-1 pg_dump -U powerevolve -d powerevolve -Fc > .artifacts/power-evolve/slice2/backups/database.dump
tar -C ~/.config/power-evolve/shared-host-slice2 -czf .artifacts/power-evolve/slice2/backups/workspaces.tar.gz workspaces
```

备份恢复应先停止应用，并在隔离数据库与目录中校验，再切换平台配置。开发验证曾将一个结构版本 `1` 的备份恢复到临时数据库，升级后核对原用户、会话及事件数量，并确认重复初始化不修改数据。该验证没有迁移旧 PowerEvolve 产品数据库。

## 验证范围

`pnpm run test:power-evolve` 使用真实 PostgreSQL、实际双 Profile 和确定性模型替身，验证文件字节、条件写入、跨用户拒绝、重启恢复、技能启停和任务受理时固定技能选择。真实网页试用另行验证 DeepSeek 响应。文件传输目前每个文件上限为 2 MiB；技能只支持说明文本，不运行技能中的代码。多节点共享挂载、Kubernetes 沙盒、审批、桌面执行和完整的旧版设置/插件界面尚未交付。本机两个服务使用同一 OS 用户运行，生产多租户所需的独立 OS 身份和网络策略也尚未验收。
