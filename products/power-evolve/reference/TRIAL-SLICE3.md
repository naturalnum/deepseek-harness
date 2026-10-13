# 切片 3 试用指南

此版本在双用户对话、文件和个人技能上增加受控远程 API。`trial_notes_list` 直接查询便签；`trial_notes_append` 只提交待审批申请。独立可信页面确认后，平台派发写入，并在原对话中自动续接结果。普通查询、申请和审批都不创建执行沙盒。

## 启动和入口

需要 Node 22.19+、pnpm 11、Docker，以及私密目录中的 DeepSeek 模型配置。从此版本的检出目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
export PE_TRIAL_NAME=slice3 PE_DATABASE_PORT=18434 PE_HOST_PORT=18885 PE_PLATFORM_PORT=18886 PE_TARGET_PORT=18887
pnpm run power-evolve:trial up
```

对话入口为 <http://127.0.0.1:18885/>，登录入口为 <http://127.0.0.1:18886/login>，独立审批入口为 <http://127.0.0.1:18886/approval>。可信页面要求再次登录，使用独立审批凭据。`~/.config/power-evolve/shared-host-slice3/users.json` 存放 Alice、Bob 的随机密码；从本机私密文件读取，不提交或发送到聊天。模型密钥从同目录的 `model.env` 读取。首次准备只创建不存在的私密文件，不覆盖已有账号或试用数据。

## 五步体验

1. 在网页中以 Alice 登录，发消息让 Agent 查询自己的远程便签。右侧“操作”可显示动作状态；查询不出现待审批记录。
2. 请 Agent 写入一条容易辨认的便签，例如“今天读一本书”。它应给出待审批提示，远端此时尚未写入。
3. 打开独立审批页，用 Alice 再次登录，核对原文和指纹，然后批准。返回原会话，应看到可信平台的结果消息和 Agent 的续接回复；再次查询应读到便签。拒绝另一条申请，确认其没有被写入。
4. 在独立审批页关闭写入权限，再让 Agent 申请一条便签。请求应被拒绝，不出现新的待审批动作。以 Bob 登录另一浏览器，确认他看不到 Alice 的审批记录和便签。
5. 重新启用写入权限，创建一个待审批动作，运行 `pnpm run power-evolve:trial restart` 并刷新页面。动作仍应待审批；批准后结果继续回到原会话。

查看状态、重启或停止试用进程：

```sh
pnpm run power-evolve:trial status
pnpm run power-evolve:trial restart
pnpm run power-evolve:trial stop
```

这些命令使用上面的四个环境变量。`stop` 保留 PG 卷和私密文件。日志位于 `.artifacts/power-evolve/slice3/`；`api.log` 属于单独的本机试用目标，`host.log` 和 `platform.log` 属于产品服务。PostgreSQL 只监听本机 `18434`，目标 API 只监听本机 `18887`。平台 `/health` 的结构版本为 `4`。切片 1 和 2 的试用分别仍使用自己的端口、数据库卷和检出目录。

## 数据与恢复

产品表结构从 `2` 经过 `3` 升到 `4`，迁移在平台启动时的同一事务中完成；原生 DSH Session 格式仍为 V4。升级已有数据库之前，必须同时备份 PG 和对应的 POSIX 工作区。旧版本不能直接读取升级后的表结构；回退需停止服务并同时恢复升级前的数据库与文件备份。当前独立试用从空库创建，不会修改切片 1、2 的数据。

```sh
mkdir -p .artifacts/power-evolve/slice3/backups
docker exec pe-shared-host-slice3-postgres-1 pg_dump -U powerevolve -d powerevolve -Fc > .artifacts/power-evolve/slice3/backups/database.dump
tar -C ~/.config/power-evolve/shared-host-slice3 -czf .artifacts/power-evolve/slice3/backups/workspaces.tar.gz workspaces
```

重启后，待审批动作仍待审批；已批准但响应不确定的动作先按同一动作 ID 查询远端，再决定是否重试。自动续接保存为原会话的一条持久操作，不恢复旧进程栈。试用目标按同一动作 ID 去重，并保存写入结果。

## 验证范围与限制

`pnpm run test:power-evolve` 使用真实 PG、两个实际 DSH Profile、确定性模型和受控远端 API，覆盖身份、审批与 Agent 凭据区分、跨用户隔离、指纹校验、重复决定、权限撤销、待审批重启、超时对账，以及结果在原会话续接。真实模型网页体验另行验证。远端服务是本机受控试用 API，并非生产第三方连接器；当前没有通用插件授权目录、云沙盒、桌面执行或多副本部署。本机两个产品进程共享 OS 身份，生产所需的进程权限及网络隔离尚未验收。
