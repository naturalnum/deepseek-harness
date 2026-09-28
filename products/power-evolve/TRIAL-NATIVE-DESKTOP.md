# 原生 DSH Web 与本地项目执行试用

这个开发试用环境使用官方 DSH `dsh-v0.1.7-rc.2` 为基线。Host、可信平台和本机设备是独立进程；试用数据位于独立的 `native-upload` PG、私有配置和 `.artifacts/power-evolve/native-upload/`。`native-cloud` 与 `native-exec` 的稳定试用快照不受此环境更新影响。

## 试用步骤

1. 在 <http://127.0.0.1:19081/login> 用私有文件 `~/.config/power-evolve/shared-host-native-upload/users.json` 中的 Alice 试用账号登录，进入原生 DSH Web <http://127.0.0.1:19080/native/>。不要把密码或模型密钥发到聊天中。
2. 在对话输入区点击“配对本地设备”，复制一次性代码；打开本机设备页 <http://127.0.0.1:19083/>，完成配对并授权一个真实的 Git 项目目录。本地绝对路径只保存在设备进程中。
3. 关闭配对弹窗或点击“刷新本地目录”，在“执行位置”中选择该设备和目录。让 Agent 在该项目内运行 `pwd`、`git status` 和测试，修复一个小问题，再运行测试。对话应收到受理和最终结果；变更只出现在授权的本地 Git 工作树。
4. 切回“云端执行”发送 `hi`。它使用同一对话历史，但不应触发本地或云端执行容器。这个开发环境没有配置云端 k3s，因此云端编程任务请使用单独的 `native-exec` 试用环境。

重启或停止本开发环境时使用相同变量：

```sh
export PE_TRIAL_NAME=native-upload PE_DATABASE_PORT=18463 PE_HOST_PORT=19080
export PE_PLATFORM_PORT=19081 PE_TARGET_PORT=19082 PE_DEVICE_ENABLED=1 PE_DEVICE_PORT=19083
export PE_DESKTOP_IMAGE=pe-shared-host-slice4-runner:s4-2ffb04551212
export PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs restart
node products/power-evolve/scripts/trial.mjs stop
```

`stop` 保留数据库、私有配置和本地文件。日志在 `.artifacts/power-evolve/native-upload/`。Web 静态文件为 `native-web` 快照；修改客户端插件后应构建新快照，再重启开发环境，避免影响其他试用版本。

## 已核验结果与限制

真实浏览器中，从原生页面生成配对码、本机设备配对、授权隔离示例 Git 仓库，再选“本地”提交编程任务。平台 PG 将任务目标记为该设备与目录；设备容器将 `src/math.js` 的错误减法改为加法，`npm test` 从失败变为 1 个通过、0 个失败。仓库留下可检查的未提交差异；此试用库有本地执行记录，没有云端沙盒记录。另有真实 PG 回归覆盖跨用户设备拒绝、重复请求换目标被拒绝和无效目标拒绝。

执行工具先返回持久受理回执，完成后再通过原会话追加结果。初次编程试用中，Agent 在等待期间发出过多余的只读探测和重复状态消息。收紧工具提示后，重新启动开发环境并在新会话里通过真实模型执行只读 `pwd && git status`：只提交一次命令，先显示受理状态，随后自动收到可信执行结果并给出实际输出，没有额外探测。这是一次小任务的观察；较长的编程链路仍需继续检查异步任务的呈现。设备凭据是软件令牌，本机和云端路径访问在生产部署前还需按架构文档加固。
