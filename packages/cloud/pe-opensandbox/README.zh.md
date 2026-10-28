---
description: "面向组合维护者的显式关闭云端执行、原生拒绝提供方及能力诊断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-opensandbox

[English](README.md) | 中文

## 概述

组合维护者可以选择原生拒绝提供方，或开发中的 Root 会话执行路径。关闭模式在准备前拒绝每个 Shell 和子进程请求，不创建沙盒或联系后端。受管模式要求原始受保护部署及目标验收；只有空需求列表不能使账户就绪。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dsh` profile 组合中挂载 `/root` 和 `/account`。显式 `mode: closed` 会注册实际根执行拥有者，并为每个账户装配各一个原生 ShellExecutor 与 SubprocessRuntime。仅靠配置不能开启执行；省略模式或声明所选拥有者不支持的必需能力都会阻止启动。

`/types` 入口提供 `ServicePreviewIdentity`，沿用原分配和 Session 的品牌化标识，并声明 `DevelopmentServiceId` 以及有界应用读取和已登记服务的定义。身份不授予权限；访问仍须持有执行拥有者当前签发的能力。访问适配层附加其已审计的 HTTP 暴露项及浏览器响应策略。原生开发服务工具仅将最终有界的任务句柄、操作及进程提交观察投影为展示元数据；基础设施标识和预览 URL 不进入模型结果或元数据。

### 配置与失败

已部署的关闭配方要求显式关闭模式和空能力声明。[schema](src/config.ts) 唯一持有允许的取值；声明不能验证执行能力。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | 省略时启动失败 | `closed`，或开发中的 `session-collect`；后者还须原始且受保护的 Root 部署能力。 |
| `requiredCapabilities` | 必填 | 关闭模式下必须为空；任何必需能力都会阻止装配。 |
| `maxBoundAccounts` | 根入口必填 | 同时开放准入的精确账户代际数量，必须为有限正整数。 |
| `managed` | 受管根入口必填 | 显式受管限额，由严格解析器在构造拥有者前验证；该 JSON 不提供部署授权。 |
| `rootDeployment` | 普通受管 Root 必填 | `{ path, sha256 }` 引用受保护的 Root 输入。缺省时须有原始内部部署能力；同时提供两种来源会被拒绝。关闭模式及在账户图中挂载 Root 均拒绝此引用。 |

开发中的 `session-collect` 路径要求原始 `ManagedExecutionDeployment` 能力。普通 Loader 输入提供显式且受保护的 `rootDeployment` 引用，由 Root 据此构造原始能力；JSON 本身不提供授权。将原始对象作为第三个参数传给 Root `apply` 仅用于可信内部组合。Root 等待实际迁移和恢复检查；账户入口确认原始 port 与所选模式一致，才安装 Shell、subprocess 和固定远端 ShellEnv 提供方。实际部署与原生网页仍待验收，当前生产配方保持关闭。

私有 [Root SDK 工厂](src/bootstrap/factory.ts) 加载随包发布于 `runtime/agent` 和 `runtime/bootstrap` 的九份固定 Python 资产，仅从构建后的 `lib` 模块旁定位。文件缺失、为链接或 hash 不符时，在 HTTP 工作之前拒绝；不回退到源码树，也不下载资产。工厂保留原 bootstrap、认证登记器与 SDK 后端的拥有关系，不提供 files 导出授权或账户准入，也不改变关闭的生产配方。

原 `/root` 入口通过显式 `rootDeployment: { path, sha256 }` 引用在内部[装配部署](src/bootstrap/assembly.ts)。Linux CLI 保持 UID/GID2000，读取只读挂载上 Root 拥有的 `0:2000/0440` 配置，并将原文件描述符和精确字节保留到实际清理。此选择租约记录部署策略，不证明服务器存活。封闭选择固定支持技能资源挂载的服务端镜像，在收养 keeper 或构造 SDK 前拒绝其他镜像摘要。部署 v1 收养原继承 FD4 keeper，绑定 retained exports 及其 epoch 释放检查。observer 关闭结果未知时，须保留未知状态直到进程实际退出；构造本身不会创建 sandbox。

部署 v2 显式选择 `storage.mode: shared-path`，引用 files 既有的受保护存储计划。[共享挂载拥有者](src/shared-mounts.ts) 根据该计划选择稳定的项目和 Session 环境来源，测量当前源目录身份及硬配额，并将目录描述符保留到 allocation 释放借用。此模式不收养 keeper 或 FIFO，也不发布导出清单。计划租约检查受保护配置，每次借用还必须通过原 files/native 当前授权回调。授权失效会拒绝新执行，但保留物理停止责任及未结算借用。持久挂载由部署持有，账户销毁不卸载用户卷；实际原生及网页执行仍须验收。 共享路径 v2 要求单独固定的 Native 服务镜像，支持同一账户的 `projects/<leaf>` 与 `environments/slot-0` 或 `slot-1` 布局；旧 v1 保留原镜像。两者都保留认证的代际及 socket 绑定与物理删除完成检查。受保护的环境池选择 `mode: session-directories` 时，Root 只接受 `bootstrap/deployment-input.ts` 固定的新镜像；Native 守卫还检查环境路径是同一账户原环境池下的直接 UUID 子目录。[镜像覆盖层](runtime/server/Dockerfile)仅修改[守卫模块](runtime/server/completion_view.py)，原 SDK 引导、工作负载镜像及配额保持不变。

runtime 先在独立账户图中安装不可变绑定。原生 prepare 期间，可信工厂将安装后的精确对象及图当前性检查传给根协调器的 `bindAccount`，再在账户入口之前调用 `installAccountExecutionPort`。绑定或 port 缺失、复制、跨图或被影子替换都会失败；重复提供方或容量耗尽也会失败。关闭登记不替代其他账户就绪检查。

可信 bootstrap 装配可调用 `assertClosedAccountExecution(ctx)`，确认原始有效 port 仍持有原始且活跃的原生 Shell 和子进程提供方。缺失、未安装、影子替换、更换或已停止的提供方均被拒绝；此读取不会执行命令、停止 port 或签发 drain 证据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[根拥有者](src/closed-owner.ts) 保留精确登记和永久准入状态，依赖中没有执行后端或进程启动器。停止已知登记时会关闭其 port，并保留该拥有者本代无工作事实的观察；未知或克隆绑定被拒绝。根卸载先关闭全部 port 再撤销参与者；账户卸载只关闭自己的 port。这些观察不能证明较早拥有者或代际的资源。

[原生提供方](src/closed-providers.ts) 共用该 port，拒绝所有方法，包括可执行文件查找和终端准备。spawn 同步拒绝；异步方法返回被拒绝的 Promise，已预先取消的调用者保留原始原因。内部[作用域签发器](src/scopes.ts) 仍单独存在：作用域撤销不能证明分配或进程已停。

私有[分配拥有者](src/allocation-owner.ts) 按账户、原生 Session 和代际合并完整的持久意图、创建及认证准备流程。等待者取消后，迟到或不确定工作仍由它保留；只有后端实际停止和原始终结元数据写入完成，才释放挂载预留。Loader 入口不将此组件开放为已启用的后端。

尚未提交的前台命令可在原有四记录或300秒驻留上限处更换已完全停稳的计算资源。Root 先等待原物理停止、released 元数据及挂载释放完成，再为同一 Session 环境取得新的 files 授权并启动新运行时。活跃服务、运行范围、应用 I/O 及未知引用都会阻止更换。已确认停止的 SDK、bootstrap 和运行时记录可被回收，原 intent 对象保持撤销；未解决记录继续占用容量。

并发计算容量满时，新 Session 可淘汰一个没有在途调用、保留输出、服务或应用 I/O 的 ready 空闲计算资源。Root 只关闭被淘汰 Session 的新准入，等待原 allocation 停止和 SDK/运行时退账完成，再删除缓存选择并准入替代资源。并发调用共享同一退账操作，失败或未知责任继续保留。持久环境数据及原 allocation、记录和作用域配额均不变，空闲历史 Session 不再长期占满计算容量。共享路径的环境布局仍须使用经过审查且显式固定的 Native 守卫。

私有的[旧分配恢复 helper](src/allocation-recovery.ts)有界枚举并冻结精确旧账户/epoch 的全部非终态记录。Root 的可信 verifier 必须证明旧进程/writer 已失效且永久失去迟到启动能力。已接受创建须有精确物理销毁证明，sandbox id 为空时还须独立创建绑定，随后调用原有 stopping/released CAS。严格 v2 见证另只允许 provider 创建前已完成的 `fixed-ttl-bounds` 或 `host-bind-bounds` 拒绝：精确 intent 及拒绝/请求完成/未创建/迟到启动撤销四项引用，只授权原 `failNotCreated` CAS 写入固定 failed/null-id 终态。HTTP500 或空列表本身不能取得资格。未知写入只读对账原捕获 postimage，不重放；未解决责任仍阻止恢复。helper 只向 runtime 独立恢复 CAS 返回覆盖引用，不授予 provider 权限。实际维护、PostgreSQL 与后端验收仍须分别完成。

现有 Root 入口还支持显式关闭的维护装配：`mode: closed`、空 required capabilities、有界 `managed` 元数据预算及唯一受保护 `recovery` 发布引用。它不构造 SDK 执行或账户图。原执行 participant 复核进程死亡及完整不可变 intent 覆盖，经原 store 对账 allocation，再调用 runtime 的精确旧 owner 恢复及独立旧实例关闭。实际工作未知时保留清理责任。发布物通过 SHA256 和只读 Root 持有租约绑定，不使用密码学签名。

私有[命令操作](src/command-operation.ts) 同步提供准备中的 subprocess 句柄，并为 Shell 单独保留提交命令前的发布步骤。直接进程退出且收集流 EOF 后结算 subprocess 的 `done`；完整范围及本地 I/O 结束后结算独立的范围完成凭据。[Shell 投影](src/shell-execution.ts) 等待该完整范围。输出保持有界，直到原生结果拥有者释放；撤销后拒绝公开访问，未知清理仍由 Root 保留。账户内的[工具调用传播](src/native-calls.ts) 将这些操作跨异步等待绑定到原始 registry token、Agent、Session 和项目。

私有[开发服务消费者](src/dev-service-consumer.ts) 要求显式完整的 `commands.services` 策略和原生工具 provider。严格解析配置后，Root 接入原 managed 拥有者的回调；省略策略时该消费者保持关闭。它复用该拥有者现有的工作记录和 subprocess provider，在8000端口运行项目相对路径的 Python HTTP 脚本。启动只报告进程已提交，HTTP 就绪单独判断；状态、有界日志和停止都指向同一保留操作。固定的安装与服务 payload 声明前台命令、已登记服务各一个运行范围，角色由 Root 签发，运行时限分别为150秒、120秒，绝对驻留时限300秒。这四个生命周期记录及已做组件检查的限制，不代表完整 Session 生命周期或真实服务隔离已通过。

原服务记录只绑定一次分配，并独立于工具调用持有有界应用读取。可选的 `commands.services.application` 显式提供全局、账户和服务请求数量及全部 HTTP 传输限额，不授予网络权限。私有 [HTTP 适配器](src/application-http.ts) 只允许通过 Root 选定的服务器执行 GET，使用固定目标身份、有界缓冲区和实际本地 I/O 终结凭据。Root 在传输前预留全局、账户请求数量，并计入命令输出共用的原 resident 字节池。公开的 `withAccountApplicationService` helper 要求原始已安装账户 port 和 provider。固定控制跳显式退出访问续期，不接受调用方提供该控制头。服务停止、作用域释放和记录退休会取消读取，并等待其实际终结；清理未知时保留原记录和容量。缺少 Root 回调时，读取保持关闭。适配器和记录检查不代表已部署代理、浏览器授权或工作负载网络隔离通过验收。

启用开发服务的执行账户条目要求 `inject: ['tools']`；未选择服务及关闭模式条目保留原依赖声明。`accountServiceAvailability(ctx)` 检查原始已安装消费者和应用工厂，不创建工作。工具定义、安装位置或实际消费位置的 Tools provider 被替换时，拒绝检查。

现有 HTTP 定时器扣除原操作、服务角色、原 ingress 请求的剩余时限，以及在首次 bootstrap 前捕获的保守驻留期限。预留和已提交观察均不重新开始计时。物理沙盒到期单独处理：提前到期沿用原请求失败和物理停止确认流程，不能仅因时间到期就释放容量。

私有[受管协调器](src/managed-coordinator.ts) 通过原始延迟原生授权和 files 授权连接这些拥有者，活跃进程槽与保留输出分别释放。Root 启动时先检查持久化的非终态分配，再允许就绪；关闭时等待启动、分配、传输和元数据责任实际结束。[SDK 适配器](src/sdk-lifecycle.ts) 在唯一且受验证的物理 DELETE 前关闭并等待特权启动请求。启动失败本身不表示特权启动仍未结清：有界命令流已初始化、观察到执行完成事件并结束，且原传输实际关闭时，严格输出或错误校验仍可判启动失败，但允许进入原停止链。缺少终结事实、超出观察限额或传输关闭失败时仍保留 unknown 并阻止删除；HTTP 成功本身不证明命令终结或物理停止。[受信运行时登记器](src/trusted-runtime.ts) 保留普通认证请求直到本地实际结束；只有物理删除不能释放命令容量。有界[数据传输器](src/agent-data/index.ts) 保留原始字节坐标与原操作引用。其 Loader 安装仍要求原始受保护部署；组件安装本身不代表原生网页服务执行已通过验收。

私有[语义观察器](src/semantic-audit.ts) 可选地将有界 SDK、bootstrap 及原生操作事实发布给应用导入前安装的受保护接收方。接收方在原 stderr 完整写出后确认且仅确认一次；投递丢失或失败会污染证据。观察保留原 Promise，不授予业务控制能力或恢复权限。

可选的可信 `ManagedExecutionDeployment.skillCopies` 策略提供显式 `maxCopiesPerOperation`，不属于公开 Loader JSON 或模型输入。它要求原 files owner 实现 `prepareSkillProject` 和 `borrowAllBundleWorkingCopies`；缺少枚举方法时，在 allocation 前拒绝。每条命令均由原 owner 从受保护的项目关联中推导包含 legacy 与完整树副本的完整有界集合，并核验已签发的 `SkillBundleOperationCopies`；超限、未知或未取得资格的成员使整个操作拒绝；命令文本、路径和 API 发布缓存不能选择成员。allocation 保留原父目录与 export 借用，每个原命令保留真实 copies 借用，直到实际 range 完成且本地结清，或合格且已 joined 的物理停止。输出保留有独立释放点。 受保护的 `rootDeployment` 文件接受可选闭合对象 `skillCopies: { maxCopiesPerOperation }`，数量须显式为正整数且不超过 2147483647；省略时不注入策略。Assembly 将独立冻结的解析结果传给原 deployment。

[固定副本执行世界](runtime/agent/paths.py) 保留项目 RW 与外层 `.pe` RO 挂载，只增加固定 `.pe/skills` 子目录的 RW export。内层准备捕获实际版本目录 FD，建立只读 scaffold，并仅将这些版本目录绑定为 RW。Guardian 在 PREPARED 前核验实际父目录、副本身份及挂载模式，然后执行原有八 FD 边界检查。公开命令仍严格只有 `argv`、`cwd`、`stdin`；规范化私有事实纳入原 spec hash 和 role HMAC，完整 4096 字节 Guardian frame 包含这些事实。原生 admission 在命令保留和 allocation 前，先为整个配置副本数量计算保守 scalar 字节上界，发送前再次检查实际完整 frame；命令超限时拒绝，即便当时较小的集合可能装得下。原 files 源挂载身份仍在已取得资格的 source context 中核验，容器 mount id 则独立观察。启用此策略前，仍须完成跨 namespace 冷恢复及实际 SDK 嵌套 volume 验收。原生 get 还要求 files 驻留容量同时覆盖保留的源快照、物化以及保留的父目录和操作；只有一次 reservation 容量的配置不能接纳这条调用链。

受管 coordinator 通过原开放账户 port、命令记录及 allocation owner 观察本地修改的空闲条件。在途调用、subprocess 获取、未停后代或进程 I/O、开发服务、应用请求、创建/准备/停止/对账及未知结果均拒绝修改。已结清的 ready 沙盒、缓存 Session 选择及完成后保留的输出可以继续保留，身份、mount 和预算不释放。基础 coordinator 拒绝该观察；终态重建仍通过原 stop/dispose 路径等待全部 warm allocation 与保留结果。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [应用组合](../../../docs/architecture.zh.md)
- [原生子进程语义](../../subprocess/subprocess/README.zh.md)
- [生命周期审核规则](../../../docs/defensive-patterns/general.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 执行准入

#### 模型会看到什么

关闭模式不注册模型工具或 Session 事件。模型不能通过配置或复制作用域来开启执行。若其他已装配的原生工具请求执行，会收到 `Cloud execution is disabled by this deployment.`。开发中的私有消费者只有在 Root 通过原执行拥有者显式安装后才添加 `dev_service`；其启动结果不承诺 HTTP 已就绪。

#### Token 影响

本包不注入提示词内容。调用被拒绝时，原生消费者的错误文本可能进入其对话。

#### KV Cache 影响

本包不修改请求内容、顺序或缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

关闭模式是受限部署配置，不是已验证的远端执行。

- 计算资源更换只在新的前台命令取得执行通道时进行，不启动空闲定时器，也不迁移活跃服务。同一 Session 的环境持久性及原生网页连续运行仍须通过部署验收。
- 默认关闭配方不开放执行。受管操作仍要求持久分配对账、完整部署配置、目标通道与隔离证据，以及受管范围停止。
- 关闭排空观察只覆盖其精确登记的本代，不提供分配、远端停止或恢复证明，也不能清除旧未知工作。账户就绪和恢复仍由 runtime 持有。
- 原生默认 Bash 执行器依据 subprocess 的 `done` 结算，而该值不能证明所有后代均已停止。Shell 准备与作用域完成仍需要显式、兼容的适配器。
- OpenSandbox 的文本命令流不能提供原生 subprocess 所需的完整原始管道/control 或受管范围观察。受限的受管 collect 通道不提供交互管道、终端、宿主回退或自动恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

可移植的[显式启用作用域探针](tests/opensandbox-scope-probe.mjs) 要求明确传入 `--workspace-root`、`--sdk-root`、`--out` 和 `--execute-authorized-once` 参数。它使用固定的缓存镜像，最多创建一个有界 Sandbox 及两个内部作用域。其证据分别描述作用域停止、namespace 安全事实和二进制文件 Range 传输；它不启用执行，也不验证完整的 subprocess 语义。

</details>
