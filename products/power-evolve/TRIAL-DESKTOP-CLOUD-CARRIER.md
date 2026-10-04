# Electron 云端对话固定试用

2026-10-04，产品代码 `853ef836ff` 在官方 Electron 44.0.0 darwin-arm64 中复用原生窗口、快捷键、主题及麦克风权限适配。两个账号通过共享 Host 原生页面与独立可信 Platform 完成真实 DeepSeek 对话及恢复验收。上游无启动副作用的装配接口对应 `43ca0de24a`；当前官方基线没有整体升级。

## 已通过范围

| 路径 | 实际结果 |
| --- | --- |
| 两账号对话 | Alice/Bob 独立 Electron userData；各发送 `hi` 和连续追问，四个真实模型输入全部完成，记忆标记未串用 |
| 进程重启与刷新 | 两个账号各关闭并重新启动实际 Electron，重新登录后从原生侧栏打开本人会话；刷新后历史可读 |
| 历史权限 | 实际 Host `page` RPC 访问本人历史返回 200，Alice 访问 Bob 会话返回 404 |
| 按需执行 | PG 中四个输入关联的 Cloud／Device execution 数量均为零；承载器未启动本机 Agent 或 Device |
| 原生能力 | Host 主 frame 仅获得 keyboard、protocolVersion、shortcuts；没有绝对本机路径注入或目录选择桥 |
| IPC 与导航 | 实际 Electron 独立策略测试 14/14、零跳过：外来窗口、iframe、Platform 和已导航 frame 的原生调用被拒；禁止外部导航与弹窗；固定审批入口可在所属窗口打开 |

策略测试使用真实 Electron、BrowserWindow、WebFrameMain、IPC 和 cookie 分区，但 HTML 是测试服务；它不代替原生应用、PG 或模型验收。双用户对话结果在 `output/playwright/desktop-cloud-carrier/conversation.json`，策略结果在 `.artifacts/power-evolve-desktop/policy-evidence.json`；终态截图已查看。源码配置／参数测试 4/4、桌面叶构建、strict 源码及测试类型检查、选定导出 JSDoc、相关 lint、双语配对及正常提交钩子通过。

## 启动试用

承载器的冻结目录是 `/Users/jingchao/.local/share/power-evolve/trials/desktop-cloud-carrier-20261004`，包含独立 Electron.app、ESM 主入口、沙盒 CJS Preload、启动脚本和摘要 manifest。它是开发试用快照，不是 PowerEvolve 安装包。快照在源码目录外启动，不依赖产品 workspace 包；启动包装脚本仍使用已安装的 Node 22。

```sh
"/Users/jingchao/.local/share/power-evolve/trials/desktop-cloud-carrier-20261004/start-alice.command"
```

第二个账号使用同目录的 `start-bob.command`；两个启动入口选择独立私有浏览器目录。登录账号为 `alice`、`bob`，密码从 `/Users/jingchao/.config/power-evolve/shared-host-device-materials-20261004/users.json` 的私密文件读取，不复制进源码或试用记录。

1. 启动 Alice 窗口并登录，在原生新会话输入 `hi`，随后连续追问。
2. 启动 Bob 窗口并登录，确认侧栏及历史属于 Bob。
3. 从原生菜单退出一个应用，再运行相同入口并登录；选择原会话查看历史。
4. 刷新原生页面，确认已有会话仍可打开。

共享 Host 为 `http://127.0.0.1:20880/native/`，Platform 为 `http://127.0.0.1:20881/login`。这两个服务复用[Device 材料组合试用](TRIAL-DEVICE-MATERIALS-NATIVE.md)的真实 CLI Profiles、独立 PG V31 和 POSIX 根；它们是源码验收服务，承载器快照不冻结整套后台。旧[正式 Cloud 镜像试用](TRIAL-FORMAL-IMAGE-LOCAL.md)的数据、版本和入口保持独立。

配置文件 `/Users/jingchao/.config/power-evolve/desktop-cloud-carrier-20261004/deployment.json` 仅保存上述准确 Origin。Electron userData 位于同目录 `frozen-alice`、`frozen-bob`，不会与官方 DSH 或其他端口部署共享 cookie。日志在 `.artifacts/power-evolve/device-materials-20261004/{host,platform}.log`；终端启动输出由当前终端保存。服务启停遵循组合试用记录中的正式 Profile helper；构建摘要变化时 helper 拒绝沿用旧环境，不能跳过检查。

## 固定产物及恢复

| 产物 | SHA-256 |
| --- | --- |
| `app/lib/main.js` | `aaea0acc9a95cc657cb3936a76a3b9e35a6d0ac5eca24097f2273fc1a932c3d0` |
| `app/lib/preload-cloud.cjs` | `deb86967d2004a34fd69490611155b49afd857711281604f5634f780c9f99cab` |

冻结快照已经通过源码目录外的实际 Electron smoke：Alice 登录原生页面、读取已有本人历史，bridge 范围正确；未创建新输入，退出后自有主／子进程残留为零。结果在 `.artifacts/power-evolve-desktop/frozen-smoke.json`。冻结目录的 `manifest.json` 记录全部启动文件摘要，`evidence/` 保存验收结果及两账号重启后截图。后续构建不覆盖快照；窗口验收结束后均已关闭。原始产品启动命令已实际启动 Electron；Ctrl-C 终止测试启动时返回非零，正常试用从应用菜单退出。

重复启动同一个浏览器目录会聚焦所属应用；两个账号需要分别使用各自入口。后台不可用时保持失败页面，可在后台恢复后重新加载固定地址。不要通过更改 Origin 绕过登录或 IPC 检查。若需要重置试用身份，先正常退出对应应用，再另选新的私有目录；不删除原数据库或工作区来修复登录。

## 未覆盖与下一步

本切片不装配 Electron 所属 Device 子进程、本地配对／目录授权桥、原生侧栏浏览器、Office 预览、产品安装更新或公证。外部文档链接仍受导航限制；它们需要另行实现用户主动打开外部链接的能力。真实系统麦克风交互及安装包权限说明尚未验收；本轮测试覆盖音频许可策略和原生适配装配，不宣称完成录音体验。

下一切片按[桌面复用约定](DESKTOP-COMPLETION.md)接入正式 Device Profile、本地授权窗口和受控退出，验证本地 Git、取消及恢复。父子进程静默、精确容器停止事实和平台回执分别核验；进程退出码不能代替任务停止证明。之后才进行离源码安装包验收。
