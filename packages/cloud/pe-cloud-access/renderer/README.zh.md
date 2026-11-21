# 仅 IP 服务预览

[English](README.md) | 中文

管理入口使用 HTTPS IPv4 地址时，PowerEvolve 可在现有的 Browser 标签页中显示已登记的 Session 服务。该标签页从管理源加载受信任的查看器，显示 960 × 640 像素的 PNG 画面，并发送坐标点击、刷新或关闭请求。私有浏览器运行服务页面，可读取其同源 GET 资源。每个打开的视图使用独立的 Chromium 进程和上下文。

在 `pe-cloud-access/root` 中配置 `ipApplicationPreview`，设置受保护的 Unix 套接字路径、画面和中继限制，以及常规视图和响应限制。此模式使用现有的 `cloud:serviceApplication` 启动暴露项。DNS 部署使用其专用的静态 `/cloud/service-preview` 暴露项。公开的 Cloud Client 配置需要 `serviceApplications.mode: ip-render`、确切的 HTTPS IPv4 管理源以及现有的请求、响应和字段限制。原 DNS 内容监听器及其客户端配置继续使用现有的 `applications` 和 `contentOrigin` 字段。

在 Access Root 前启动私有 Worker。

```sh
node renderer/serve.mjs /run/pe-preview/render.sock /opt/pe-preview/node_modules/playwright/index.mjs
```

使用相互兼容的 Playwright 和 Chromium，并启用 Chromium 沙箱。为 Worker 使用独立的 Linux 身份和操作系统级 IP 出站隔离。仅向 Access 服务身份或其专用组开放套接字。由所有者控制套接字目录，并将其放在所有账号工作区之外。在部署宿主上验证浏览器能在上述隔离下启动和清理。在开发机运行此辅助程序仅能验证浏览器和通信协议。

## 授权与回收

原启动入口检查已认证的登录身份、账号、连接代次、Workspace/Session 和已登记的服务。管理浏览器从启动入口只收到视图 id。查看器的请求会重新验证原登录和同一服务分配。私有 Worker 无法取得账号选择器、登录凭据、服务地址或管理请求头。在一次获准操作中，原登记服务能力负责处理它的相对 GET 请求。Access 发出的每项 GET 都使用空请求头列表，并在返回 Worker 前清理服务响应。

退出登录、服务停止、视图过期或显式关闭后，视图立即停止接受操作，并中止尚未完成的 HTTP 响应。Worker 确认浏览器关闭并移除收据后，视图才归还额度。打开前先在内存登记。Worker 在所有者专用的 `<socket-path>.retired` 目录记录票据后，才允许 Chromium 启动，并在原浏览器关闭后将票据标为 `closed`。打开回执丢失时，Access 无需请求画面即可对账。关闭回执或移除确认丢失时，Access 通过新通道对同一票据重试相应步骤。Worker 只移除已关闭的记录。正常更换 Worker 时保留该目录。新建存储，或来自退出未经确认进程的 `.pending` 记录，均无法证明浏览器已关闭。保留此类记录，交给独立的 Linux 监管进程处理。Worker 保留的记录数有上限。

显式关闭若未获确认，会返回账号资源清理状态。视图已撤权时，原登录仍可重试关闭。退出登录、过期或断连后，原视图也会在没有活跃登录的情况下重试回收。每个视图只使用一个重试定时器，退避上限为 30 秒。局部恢复期间，共享入口和其他有效视图仍可使用。Root 关停时停止准入，并在重试期间保持实际排空过程，在最后一项回收确认后结束认证池。直接关闭 Browser 标签页后，由视图生命周期或服务停止触发回收。

为从 Worker 突然退出中恢复，受信任的启动器为每个专用 Linux Worker 进程域提供新的 64 位十六进制 `PE_IP_PREVIEW_WORKER_GENERATION`，并将代次与进程域身份一同记录。Worker 先验证并同步完整的仅所有者可访问记录，再发布至 `.generation`。每张待处理票据都是指向该代次记录且禁止覆盖的硬链接，在 Chromium 启动前同步。两类记录须存放在同一个受保护且支持硬链接和目录同步的 Linux 文件系统上。中断遗留的暂存文件不会发布为代次或票据。同一存储和代次确认未发布票据后，打开失败才可释放其预留。保留已有票据或状态不确定的存储供后续恢复。

可能归属浏览器的待处理票据只能由独立监管进程对账。在同一存储中启动替代 Worker 前，确认确切的原 Linux 进程域及所有后代进程均已退出，并把票据与独立记录的代次匹配。仅退出 Worker PID 无法证明这一点。无法匹配到受监管代次的票据保持待处理状态。将回收目录及代次记录放在租户无法控制的位置。在部署宿主上验证生产启动器及其实际进程退出检查。

试用前，在启用 Linux Worker 隔离的情况下，用普通账号在签封产品 Root 上验证正常的 Session 入口和生命周期。
