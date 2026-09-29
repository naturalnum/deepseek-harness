# S3 原生 DSH 云端账号设置试用

固定产品提交：`9ac618f5d1`（`power-evolve/native-cloud-client`）。官方 DSH 基线为 `dsh-v0.1.7-rc.2` / `477b4f4205`。本试用使用独立 `native-s3` PG 卷、私有配置、POSIX 工作区和 k3s 命名空间 `pe-shared-host-native-s3`；PG schema 为 11。S1、S2 的试用数据与运行环境保持独立。

## 直接试用

1. 打开 <http://127.0.0.1:19191/login>。从本机私有文件 `~/.config/power-evolve/shared-host-native-s3/users.json` 读取 Alice 或 Bob 的试用密码；不要把密码或模型密钥发送到聊天或提交到仓库。登录后进入原生 DSH Web <http://127.0.0.1:19190/native/>。
2. 点击左下角账号，再点“设置”。Alice 的授权模型为 DeepSeek Flash 与 DeepSeek V4 Pro；Bob 仅有 DeepSeek Flash。各自调整最大输出 token 数并保存。刷新页面，确认本人的选择保持，另一个账号的设置没有改变。
3. 关闭设置，发送字面 `hi`。对话使用刚保存的模型设置；没有运行命令时不创建云沙盒。进入设置修改模型或 token 上限后，下一轮使用新设置，已受理的轮次保留原设置快照。
4. 在两个浏览器会话之间切换，确认会话和账号设置不串用。账号菜单的“退出登录”会撤销当前凭据并返回可信平台登录页；重新登录仍能读取本人设置和历史。

Host、可信平台、受控测试 API 分别监听本机 `19190`、`19191`、`19192`；PG 只监听本机 `18474`。运行状态、日志、静态 Web 快照和不含凭据的验收材料在 `.artifacts/power-evolve/native-s3/`。使用同一环境变量管理该试用环境：

```sh
export PE_TRIAL_NAME=native-s3 PE_DATABASE_PORT=18474 PE_HOST_PORT=19190
export PE_PLATFORM_PORT=19191 PE_TARGET_PORT=19192
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留 PG 卷、私有配置和工作区。试用环境不承载生产数据。

## 实测证据

- 两个全新原生浏览器会话登录并打开同一个 DSH Settings 外壳。Alice 选择 `deepseek-v4-pro`、1024 token，Bob 选择 `deepseek-flash`、768 token，均保存成功。两人发送 `hi` 后分别收到真实 DeepSeek 回复；PG 中两条已完成操作的设置快照分别匹配这两个选择。该阶段 `pe_sandbox_instances` 为 0，k3s 命名空间中没有 Pod。
- 从 Host 产品 RPC 检查：Alice 只列得两个授权模型，Bob 只列得 Flash；Bob 选择 Pro 返回 403，向模型列表请求伪造另一个用户 ID 返回 400。Alice 的一次设置更新使用同一请求 ID 重试返回原 revision 3；该 ID 换内容和新 ID 使用旧 revision 均返回 409。真实浏览器中模拟另一个客户端抢先更新后，旧表单显示冲突并重新载入当前值。
- 重启 Host 与平台后，两个浏览器刷新仍能查看原对话，PG 中各自设置保持；Bob 从原生账号菜单退出后跳回可信登录页。证据快照、浏览器截图和测试日志在 `.artifacts/power-evolve/native-s3/qa/` 及同级日志文件。
- `pnpm run test:power-evolve` 39/39、`pnpm run check:power-evolve`、`pnpm run test:power-evolve:web`、`pnpm run build:power-evolve:web` 通过；最后一次按钮样式调整又通过账号插件 12 项定向测试及类型检查。原生 Web 打包为 35 个客户端模块、230 个静态文件；`npm pack --dry-run` 检查包含账号插件编译产物与 Web 资产。自动测试的外部服务替身与上述真实模型试用分别记录。

## 已知边界

本切片的模型授权由可信平台的私有用户种子在**新建账号时**装入 PG；已有授权不会因重启或更改旧种子而静默恢复。管理员管理模型授权和更广泛的审批／撤销界面仍在后续切片。模型代理在发起调用时核验当前租约与授权；已通过检查的上游流不保证被随后发生的撤销立即中断。多副本、网络出口、容量和长期流故障演练属于 S7。桌面功能保留 S1 的已验收状态，当前开发只推进云端。
