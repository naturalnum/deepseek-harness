# S3 账号生命周期：V25 开发验收

本记录是进行中的账号验收，不是固定试用版。范围及完成条件见 [实施约定](S3-ACCOUNT-COMPLETION.md)。当前云端仍有账号、文件与产物补齐、发布验收三组工作；桌面后置。

## 版本与环境

- 2026-10-01，分支 `power-evolve/native-cloud-client`；当前组合代码 `fe5ad840c2`，本轮运行验收使用 `2af3d43024`。后续两项部署修复为 `2744aa18fc`、`fe5ad840c2`。原生失效处理为 `76a405b77b`，连接停止接口为 `99980121cf`；账号接线为 `b8a15e788d`，租约过期修复为 `256cac514a`，账号 receipt 冲突修复为 `417fec35e1`。
- 两个原生 DSH Host 经 `http://127.0.0.1:19680/` 访问，两个独立 Platform 经 `http://127.0.0.1:19681/login` 访问，受控测试 API 为 `http://127.0.0.1:19682/`。Host 副本端口为 `19683/19684`，Platform 为 `19685/19686`。账号管理在 Platform `/account`。本环境的真实 Sandbox 和 SSH 使用既有 k3d 中的独立命名空间；备份后源服务保持停止，恢复验收尚未完成。
- PG 使用现有容器的独立库 `pe_account_v25_20261001`，端口 `32971`。没有新增容器，仍为两套既有 PG 和一套既有 k3d。
- 私有配置为 `~/.config/power-evolve/shared-host-s3-account-v25-qa`。`users.json` 保存 Alice／Bob 验收凭据，`browser-accountqa.json` 保存浏览器创建的新用户凭据；均不进入版本库。临时密码完成首次改密后已经失效。
- 原 S8、MCP、SSH 固定试用库和 checkout 未迁移。此环境代码仍随本片修复更新，不用于承诺稳定版本。

## 已实际执行

| 路径 | 证据与结果 |
| --- | --- |
| V24→V25 | 从恢复后的 V24 库启动真实 Platform 并迁移；按迁移前摘要核对 50 张业务表，原用户 ID、密码哈希、设置、模型授权、历史与连接器记录一致。检查排除了凭据、登录窗口和 schema 记录，按原用户范围比较；不等同于整个数据库字节不变。 |
| 管理员初始化 | 私有 bootstrap 显式指定已有 Alice ID；Alice 为 ADMIN，Bob 保持 USER。另建一次性空库，以两个真实 Platform 并发首次启动，确认锁等待后释放，用户、有效管理员、bootstrap 和初始化审计各一条。通过实际 HTTP 并发互相降级／停用后仍保留一个管理员；重启不覆盖修改后的角色、密码、设置和授权。一次性库与进程已清理。 |
| 开通与首次改密 | 真实浏览器从可信账号页创建 `accountqa`；临时密码登录产品会跳转可信页面，受限账号只显示改密与退出；改密后要求重新登录，旧密码返回 401。 |
| 原生对话 | 新用户从 `/login` 进入原生 DSH，真实模型回复“账号链路验证成功”。会话 `ef17c547-d500-4b24-ad37-0d163f851235`，操作 `ea581131-60c8-4154-bdda-c6d6c093a777` 完成。PG 的 Sandbox 和云命令记录均为 0。 |
| 文件 | 通过实际 Host 文件接口写入 `account-check.txt`，相同请求重放返回相同结果；原生文件面板预览、编辑、保存、重读成功。进程重启后从平台接口核对完整文件字节及版本一致。本轮文件初次写入为协议操作，不声称完成浏览器文件选择器上传。 |
| 两用户隔离 | Bob 用真实登录凭据读取新用户的会话与文件均返回 404。管理员 Agent／approval 凭据不能管理账号，均返回 401；普通 account 凭据返回 403；错误 Origin 返回 403。 |
| 停用与重启 | 管理页停用 `accountqa` 后，原生 follow 和新输入被拒绝，PG 仍只有原来一个完成操作。停用种子账号 Bob 后重启 Host／Platform，Bob 与新用户均保持停用，旧配置未覆盖状态。 |
| 再启用 | 管理页重新启用两账号；新用户旧浏览器登录仍收到 401，新密码重新登录成功；原生编辑过的文件重启后可读。账号和固定试用数据未删除。 |
| 双副本撤销 | 真实 HTTP 改密后，两个 Host 的原生 WebSocket follow 均终止，两个 Platform 拒绝旧 Agent／approval／account 凭据；新密码有效，Bob 的既有登录不受影响。定向检查 10/10 通过。 |
| 已受理任务连续性 | 真实 DeepSeek 操作 `07b01750-7b45-4960-9932-2dd0177ea842` 在改密前已运行，改密于 UTC `22:23:20.723` 完成，任务于 `22:23:26.232` 完成。该时间关系来自 HTTP／PG 验收；较早的浏览器改密尝试发生在任务完成后，不计作连续性证据。 |
| 管理操作回执 | 两个 Platform 经实际 HTTP 完成 138 次请求、209/209 断言，包括开通、更新、重置、删除空账号、相同请求重放及 receipt 查询；临时密码仅首次返回，冲突及有内容账号删除被拒绝。两个副本各处理 68 次请求，另 2 次错误 Origin 被入口拒绝。已验证最后管理员停用／降级拒绝；不据此宣称真实并发管理员变更已覆盖。 |
| 原生登录失效 | 更新后的原生页面保持已登录历史视图；管理员从真实可信页面停用账号后自动返回 `/login`。重新启用、新登录恢复历史；随后在可信页面个人改密，原生页面再次自动返回 `/login`。临时网络失败和资源拒绝的区分由定向代码回归覆盖。 |
| 执行文件挂载 | 停写并保留 PG／私有目录检查点后，将本验收工作区、Home 和技能包迁入既有共享卷的独立子树。文件字节、链接和模式一致；27 个技能历史版本的 621 个文件通过校验。挂载执行身份为 UID/GID 1000，产物根仍在私有目录。 |
| 云命令运行中停用 | 浏览器提交命令，观察真实 Runner 的开始标记后，通过实际管理 HTTP 停用账号。执行 `bf08e30a-2bc5-4607-8d05-012ce384e2c6` 变为 cancelled/account_disabled，原 Pod 获得 KUBELET_STOPPED 证明并释放执行槽；等待结束窗口后无结束文件、无旧续接。较早的 A 案例已在停用前完成，不计作运行中取消证据。 |
| 云端再启用 | 真实管理页面重新启用、新登录；同一会话显式提交新 Git 任务，新的 Pod 中执行成功并自动续接，Git 提交 `126d7c41a395af14e8c1af7cc638c090df037f49`。旧执行保持取消，没有恢复或重复执行。 |
| SSH 运行中停用 | 浏览器提议并在独立可信页面批准确切命令；观察远端开始标记后，通过实际管理 HTTP 停用 Bob。执行 `a5165c7d-4eac-4432-948e-f6cfc45aa742` 保持 uncertain/account_disabled，连接器资源清理完成，原 Pod／Runner／派发摘要和审批身份保留，旧凭据及授权撤销，无旧结果续接。 |
| SSH 再启用与对账 | 管理页面重新启用 Bob，新登录、新会话和新审批产生执行 `d3e795a0-cb31-49ac-91d6-12b57de0dc42`，exit 0 并自动续接。51 项定向检查通过；旧命令开始标记仅一次。旧远端命令最终仍写入结束标记，证明连接器清理不能保证远端进程停止；旧记录保留不确定状态，不自动重放。此前观察器等待审批超时的一次测试仅记为不完整证据。 |
| V25 停写备份 | 所有源写入者停止、活动记录及云／连接器 Runner 检查通过后，生成 format 2/schema 25 的独立私有 bundle。写入者停止至捕获完成为 2538 ms，共 662 个清单条目；包含账号管理、bootstrap 及原执行密钥。源保持停止；该结果不等于恢复可用或完整服务 RTO。 |

无凭据证据位于 `.artifacts/power-evolve/s3-account-v25-qa/`：`v24-before-migration.json`、`migration-preservation.json`、`first-browser-http-checks.json`、`first-browser-state.json`、`disabled-restart.json`、`native-file-readback.json`、`multi-host-rotation-http.json`、`http-receipt-e1-results.json`、`native-expiry-disabled-dom.txt`、`native-expiry-password-dom.txt`。服务日志在同目录；不能将私有配置复制进该记录。

本轮证据包括 `bootstrap-preparation/evidence-bab94209c1c3baaf8c50.json`、`storage-migration.json`、`cloud-b-running-and-disable.json`、`cloud-b-cancel-reconciled.json`、`cloud-b-reenabled-fresh-work.json`、`execution-acceptance/runs/b7c8daa75e729673/evidence.json`、`ssh-reenabled-fresh-browser.txt` 和 `backup-manifest-summary.json`。私有备份为 `~/.config/power-evolve/backups/s3-account-v25-20261001-a`；其中凭据不得进入文档或日志。

## 回归及发现

账号、执行、客户端实现由隔离工作树集成，主线应用 TypeScript 编译通过。此前账号基础／生命周期／资源围栏的真实 PG 集成检查为 16/16；新增 receipt 冲突在身份分支的生命周期定向回归为 10/10。客户端 47 项检查使用 HTTP 替身和 DOM 仿真，主线已验证构建后的可信资源 2/2；部署配置与清单检查 9/9，不代表真实 Kubernetes 发布验收。

独立审查发现，Session 锁等待可能跨过授权到期时间。真实 PG 负控制先复现了过期 renew、过期事件追加、claim 返回已过期租约和 renew 最终更新窗口；修复使用拿锁后的数据库时钟检查及最终条件更新。主线定向回归 4/4 通过，临时测试库均清理。

原生登录失效修复通过独立身份接口确认 401，停止原生连接并跳转可信登录页。主线连接与账号 TypeScript 编译、账号 bundle、原生静态资源生成通过；主线账号 Node 回归 13/13、原生 Web 构建检查 2/2 通过。开发分支额外的连接／组件／构建后回归总计 53 项通过；真实浏览器结果见上表。

备份要求平台能列出本执行命名空间中的 Sandbox；部署 Role 补充该项，其他列举和跨命名空间权限保持拒绝。部署预检同时修正 `kubectl auth can-i` 的正常拒绝返回码处理。主线部署定向检查 9/9 通过，包括真实预检入口的模拟 Kubernetes 响应；不代表完整生产集群预检已通过。

## 剩余验收

- V25 独立库／文件根恢复、恢复后账号及历史读回、真实新任务、发布资源检查和独立试用快照；源停写备份已完成，不复用或覆盖既有固定试用。

本片全部验收后才进入文件与产物补齐；生产多物理节点、真实共享卷和生产入口仍属于 S7 外部部署验收。
