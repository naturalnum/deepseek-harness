# 原生 DSH 桌面复用实施约定

本文固定[交付计划](DELIVERY-PLAN.md)的 Mac 桌面路径，是待实施方案。当前 [`baseline.json`](baseline.json) 所记录官方基线的 `apps/desktop` 与 `apps/desktop-host`，和产品仓中的对应目录树完全一致；复用以该固定源码为依据，不声称核验了远端最新版本。早期桌面实测见[原生桌面试用](TRIAL-NATIVE-DESKTOP.md)，不能替代当前正式 Profile 和安装包验收。

## 复用范围

| 官方组件 | 产品处理 |
| --- | --- |
| [Electron 主入口](../../apps/desktop/src/main.ts)、窗口、菜单、主题及关闭管理 | 保留原生外壳；新增受控产品启动选项 |
| [子进程控制器](../../apps/desktop/src/backend-controller.ts)、[Host 生命周期](../../apps/desktop/src/host-process.ts)与 [Profile 管理](../../apps/desktop/src/project-manager.ts) | 复用启动、失败及退出控制；产品另选 Device Profile、入口和 readiness 协议 |
| [Preload](../../apps/desktop/src/preload-app.ts)与 [IPC 校验](../../apps/desktop/src/ipc.ts) | 固定产品 Origin、所属窗口和主 frame；只暴露必要原生能力 |
| [目录选择](../../apps/desktop/src/directory-picker.ts) | 复用 OS 选择能力，接入 Device 本地授权；云端只获得目录 ID 和标签 |
| [Office 资源](../../apps/desktop-host/src/office.ts)及 [资源解析](../../apps/desktop-host/src/office-engine.ts) | 复用材料和资源定位机制；实际产品执行仍走获授权 Device／Runner |
| [ARM64 打包](../../apps/desktop/scripts/package-target.ts)及 [闭包准备](../../apps/desktop/scripts/prepare-package-set.ts) | 复用目标检查和包摘要；显式收集 Device 产品包，并分别固定产品、上游 runtime 版本及私有目录 |

现有 PowerEvolve cloud-web 已装配账号、工作区、文件、产物、扩展中心及执行位置，桌面加载这些原生 DSH 页面。官方 Mac 使用 Dock，Windows 托盘实现不作为本轮新增 Mac 菜单栏托盘的依据。

## 三个产品适配器

1. **Cloud carrier**：窗口承载固定共享 Host Origin。本轮保留用户授权的 loopback HTTP，生产保留 HTTPS 校验。直接使用产品浏览器认证、cookie、Origin 和 WS 规则；官方 `dsh-app` 本地代理期望不同的启动 cookie，不能原样代替产品登录。导航和原生 IPC 只接受准确 Origin、所属窗口及主 frame。
2. **Device process**：通过 DSH Profile 启动独立 Device，持久保存其 private state、journal 和固定 Runner 版本。产品明确指定 Profile 目录、可信 bundles、安装解析锚点和 Device readiness；官方启动代码固定选择本地 Web bundles 与 desktop-host，不能仅替换服务 URL。Electron 关闭仅处置所拥有的本机执行，不把云任务当作本地子进程。复用原生启动失败、退出等待和重启检查；不在 Mac 启动共享平台或另一套云 Agent。
3. **Local Device bridge**：打开所属 Device 的本地配对及目录授权入口，复用现有 `/api/choose`。本机绝对路径、nonce 和设备凭据留在本机；Cloud renderer 只消费设备／目录 ID 和标签。拖入本机文件时使用明确授权传输或本地目标，不转换为云端可读取的绝对 `@path`。

这些是产品适配代码，不是三个新的 DSH 插件。通用扩展点覆盖桌面入口、Preload／IPC、Profile 子进程和发行闭包；以最小修改补齐，保留官方默认启动方式并记录实际修改文件的升级影响。官方 DeepSeek 账户桥与产品身份、审批凭据分别保留其职责。

## 退出与发行约束

官方[退出检查](../../apps/desktop-host/src/quit-inspection.ts)只观察本机 Agent、jobs 和已加载提醒；[退出确认](../../apps/desktop/src/quit-confirmation.ts)在 backend 未 ready 时允许直接退出。产品检查以 Device 持久 journal 和不可变容器身份为依据，Device 崩溃或状态未知不能视为空闲。退出／更新先停止本地任务准入，再按所选退出策略核实既有任务和停止回执；关闭窗口不会取消云端任务，停止证明缺失时不能把任务标为完成或放行替代写入者。

官方[包校验](../../apps/desktop/src/core-package-set.ts)、[runtime 准备](../../apps/desktop/scripts/prepare-dsh.ts)和[运行验收](../../apps/desktop/scripts/smoke-runtime.ts)绑定本地 Web Host 与同版本 DSH／desktop-host。产品发行另固定 Device 包闭包、产品版本与上游 runtime 版本，并验证离源码启动 Device 和连接共享 Host；官方 smoke 通过不替代产品安装包验收。

## 业务与开发顺序

先完成[Cloud 不确定执行结案](EXECUTION-RESOLUTION-COMPLETION.md)，再补 Device 的不可变容器身份、撤销后受限停止回执、目录描述符访问及同目录写入协调。随后将 operation 固定的技能版本、只读包挂载、Office 和进程连接器接入获授权本机目标。远程 HTTP API 继续由可信平台保管凭据和执行；不能通过放开 Host 本地 shell 补齐桌面功能。

Root 固定共享 DTO、schema、Profile、Electron 扩展点及发行闭包；设备实现者负责 Device/目录/包交付；Host 实现者负责模型工具目标；客户端实现者复用原执行位置与扩展中心。接口与文件归属固定后并行实现，真实端到端验收和版本冻结串行完成。桌面承载器在业务协议稳定前仅做只读审计，不提前合入下一切片。

## 完成出口

- 当前正式原生页面在 Mac 窗口登录两个账号；云端 `hi` 不创建执行容器，刷新及再次启动可恢复历史。
- 本地配对、目录选择／取消、撤销、越界拒绝及显式云／本地传输；云端不能拿到本机路径或设备凭据，外部导航与 iframe 不能调用设备桥。
- 同一产品分别完成云 Git 和本地 Git；技能固定版本及 Word／Excel／PPT 各有真实本机成果读回，连接器显示实际目标并保留审批边界。
- 运行中 Device 断联／重启，不重放原命令；核实停止后原会话至多一次续接，另一个用户不能访问该执行或目录。
- ARM64 产品包离开源码树安装、启动、退出及再打开；固定包闭包、设备镜像、技能版本和独立私有配置，记录实际签名状态。生产公证及独立物理多节点另保留其未验收范围。
