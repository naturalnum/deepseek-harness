# 本机候选环境打包、启动、更新和回滚

这些命令只用于已有的本机候选环境 `http://127.0.0.1:32802`，不连接试用服务器。它们更新现有安装，不创建容器或重新分配账号存储。

## 前置条件

在独立工作目录中使用 Node 24.19.0，并先完成 `pnpm install --frozen-lockfile`。本机 Docker 必须可用；冒烟检查还需要已安装的 Playwright Chromium 和一个可用测试账号。账号输入要求见 [冒烟检查说明](../smoke/USAGE.md)。

候选环境必须已有 Linux 原生依赖、账号配置要求的 SSH 命令插件，以及位于沙箱绑定路径上的实体 ripgrep 程序。产品包保留这些已安装依赖；外部依赖不一致或工具未就绪时，更新在停止应用前被拒绝。

产品源码需已提交。打包命令会构建主工程及科研模式，并把产品文件和清单输出到仓库之外；它不构建沙箱镜像。

## 候选环境锁

几个工作线同时操作时，先按开发指导的 `tools/parallel.sh lock` 取得候选环境锁，再给启动、更新和回滚命令传 `--line '<工作线名>'`。已有锁时，工作线名必须与锁持有者的工作线相同；其他工作线或未传 `--line` 的命令会在操作候选环境前拒绝执行。没有候选环境锁时，仍可省略 `--line` 使用原命令。

命令自身的操作锁只防止同一时刻重复运行，不能替代整个验证期间持有的候选环境锁。

## 外置原生组合状态

原生组合不保存为普通更新状态，旧版入口会被阻挡。新控制器只通过下面的固定匹配检查处理原生更新和回滚；未知格式、混合状态或不匹配的 JavaScript、FD 模块和 profile 在环境动作前被拒绝。

原生交付的权威记录位于独立的 Root 私有目录，宿主状态只用于阻挡普通入口。固定控制流程在解除绑定、建立绑定、封存和首次启动前同步同一份责任记录；写入、关闭、同步、读回、绑定或启动结果不能确认时保留操作锁或独立待确认阻挡，不自动启动、重试或回退。没有当前应用或启动回执不代表首次启动未提交。保留记录和阻挡供原操作负责人复核，不手工改为普通成功状态或删除阻挡。

操作完成后，控制器先把独立的 `native-release.pending` 文件同步、读回并关闭，才删除操作锁、同步并关闭目录。任一收尾未确认时，待确认文件保持存在，三个默认入口及下一次原生操作均拒绝继续。只有这些步骤全部确认后，最后一次原子改名才发布完成凭据；此后没有新的关闭或同步步骤。崩溃若丢失这次改名，只会恢复成待确认阻挡，不自动清除。后续原生入口还须核原操作的准确完成凭据；这份凭据只确认宿主锁收尾，Root操作阶段仍由原记录决定。

本页命令不接受任意原生资产、profile 或复制目标。原生交付需要当前批准的固定文件、单 profile 绑定和匹配读取方输入；普通产品包对 `.node` 的排除及保护继续适用。

首次交付由环境维护者提供一份权限为 0600 的私有固定输入，在正常更新命令中追加 `--native-input '<私有JSON>'`。输入只包含已审单线资产的本地来源、准确字节数和摘要、现有资产父目录身份、原 profile/FD 身份、原路径和资产上限，以及匹配兼容产品包目录；`native-update.mjs` 拒绝额外字段。profile沿现有JSON patch数组格式，仅定位唯一insert项中id为files-root的config.helperPath，替换该字符串token，使用原token逆向逐字节还原。其它插件的helperPath保持原字节，重复files-root、重复JSON键、表达式或歧义格式拒绝，不重写整个配置。

首次成功后，不带新描述符的普通 `update` 和 `rollback` 自动读取该操作的私有匹配记录，实际检查安装的产品字节、原生文件和只读 profile 绑定，仅允许记录中的普通包或兼容包。回滚安装匹配的兼容读取方，保留同一 FD/profile，不恢复旧的、不兼容的备份。原生状态下的 `start` 拒绝自动重启，由原操作负责人核对持久阶段；缺失启动回执或当前进程不能作为首次启动未提交的依据。

### 同一 FD/profile 的后继读者对

已有原生操作完成验证和正常释放后，可在正常 `update <新普通包>` 中追加 `--native-successor '<私有JSON>'`。它与首次 `--native-input` 互斥，只用于更新，不用于 start、rollback 或已结束操作的接续。私有输入须为当前用户独占的 0600 普通文件，固定内容如下；前驱值应来自原操作已确认的交付记录，兼容路径指向另一份真实正常产品包，不接受手填 manifest、FD 或 profile。

```json
{
  "format": "pe-cloud-local-native-successor/v1",
  "predecessor": {
    "operation": "<已完成操作>",
    "descriptorSha256": "<原描述符摘要>",
    "targetTupleSha256": "<实际已安装组合摘要>"
  },
  "compatibleBundle": "/absolute/path/to/new-compatible-bundle"
}
```

控制器在新责任开始前、锁内任何准备前，以及新 Root reserve 前新鲜核原释放凭据、原完整 verified Root 记录、宿主阻挡投影、私有描述符、实际安装 tuple 和原 namespace/keeper。两份新包均经原归档校验器取得完整 manifest；外部依赖及科研锁须与已装前驱相同，正常数据格式检查保留。新普通、兼容及原安装必须形成三种不同 tuple；三组完整继承前驱同一只读 FD 和封存 profile，不发布、重新加载或重编原生资产，不解除或重绑 profile。

新描述符绑定完整前驱、释放身份、原 namespace/keeper、同一 FD/profile 与两份新 manifest 派生的 tuple；新操作在独立 Root 目录取得新责任，旧记录和旧私有输入保持原样。旧入口阻挡确认后才沿原 checkPair、停止、备份、安装、受限启动、就绪和冒烟检查，起前与验后都检查准确新 tuple。未知保存、关闭或效果保留锁和实际阶段，不重试、重复启动或自动回退。完成后仍用原释放护栏；后续无新描述符的互切和 rollback 只认新 pair，旧 pair 不自动成为可回退组。

### 更换正式目录资产与 profile

已验证并正常释放的原生组需要更换为正式目录资产时，在正常 `update <真实普通包>` 后追加 `--native-asset-successor '<0600私有JSON>'`。它与前两个原生参数互斥，仅用于 update。输入固定包含 format=`pe-cloud-local-native-directory-asset/v1`、predecessor（operation、descriptorSha256、targetTupleSha256）、assetFile、provenanceFile、sourceManifestFile、compatibleBundle，以及 directoryPaging 的 idleTimeoutMs、totalTimeoutMs、maxPages。后三值必须显式选择为 1 至 2147483647 的整数；不接受配置正文、任意选择器、允许组、版本字典或其它字段。

此入口只复用已审正式三宏编译的 143776 字节目录/技能 ARM 原件及原 provenance、source.sha256，不重编或重标旧包。两份正常产品包通过原 verifyBundle，四 C 和读者来源从各包真实 sourceCommit 的 Git 对象读取，记录 tree、blob、摘要及依赖闭包；控制器自己的提交不代替产品来源。对应产品源对象必须先经原正常源交付流程到件，缺失时在新 stage 前停止。只有 deploy 控制源改变且产品闭包实核相同，可复用已经真实产出的两正常包及其原 sourceCommit，不为控制器新提交再打包或改标签。

原 Root 的完整 verified 记录、释放、私有输入、实际已安装组及 namespace/holder 在新准备前和 reserve 前重新确认。新 original 取当前选中组的真实 FD/profile，保原资产父身份和全部上限；新资产路径及来源旁件已存在时拒绝，不覆盖或认领。新操作、新 journal 和 assetBinding 单独承担原 fd-profile 九步，不能借用只换 JS 的 successor-js，也不重开旧操作。两份新包、原正式资产来源、精确协议、三个预算、stream、容量和候选 profile 摘要共同绑定；资产旁件的 sourceSha256 继续是原四 C 清单摘要；新读者/配置派生回执另有 originSha256。后续普通互切与同 FD 后继仍核这些来源，目录同 FD pair 使用单独固定格式承诺 origin 与 facts 摘要，旧 pair 的固定字段和三组同 FD/profile 条件不放宽。

正常有界 facts/preview 只读取已确认当前 profile 与五个固定保护输入。它通过正常包解析关系定位 profile 内唯一 Exposure Root 提供者；实际提供者位置不在支持的 JSON insert 配置中、来自受保护 account-base 继承项、重复或表达式均在 stage 前拒绝。WorkspaceFiles 的实际 maxEntries 从原 account-base 中唯一 `pe-cloud-workspace-files` 提供者，按原 entryListSchema 和原 Native Config 的 resolveConfig 正常解析；不猜测数字。当前与两份新产品源的 Config 声明必须逐字节相同，实际默认若由该原工厂提供也留来源承诺；三个新分页预算始终必须显式给定，不设默认或执行预算表达式。配置仅替换唯一 files-root helperPath、严格三键 directoryPaging 及精确 `workspaceFiles/listPages` / `native:workspaceFiles` / `account-session` stream，保 recipeVersion 与其余原字节，完整逆变换须还原原件。五保护输入保持原值，不要求维护者手工修改配置后再继续。

容量预览沿原 content、实际 reader maxEntries、worker/root/lane/技能保留量和完整帧上界检查安全整数、lookahead、JSON 名字转义及有限页数；未能在原限额内覆盖验收目录时拒绝，不提高任何限额。新 loader 精确要求原七版本/方法、ABI8、listing1、paging1 及三个枚举方法，保原 UID/GID、零能力、NNP、seccomp、FD3–10 禁止继承、argv/输出/超时限制。真实受限 require、Node/N-API/libc/内核身份与原只读 openat2 探针另留回执，不能以静态 ELF 顶替目标加载或实际分页。

未知加载、关闭、发布、绑定、启动或释放仍保新责任/intent/锁，停止后续，不自动回退或重试。原 continue-native-publish 只接受原旧格式，不接续本新资产格式。慢读 idle 沿原停止语义等待旧流 closed 及实际结算，随后显式新建流从第一页重读，不自动续旧 cursor；完整目标 worker、普通九项和 Web 验收仍分别需要真实结果。

发布新模块后，控制器先使用现行 Node、UID 2000、零能力、no-new-privileges 和原 seccomp 条件加载模块，确认本单线导出，再正常停止原应用。加载子进程由Node显式禁止继承管理员FD，按固定argv直接启动，不依赖shell解释多位FD关闭语法。此步骤核固定导出及目录协议的只读内核探针，不签发账号或工作区读权；当前应用不因加载失败而停止。新模块、候选 profile 和责任记录独立保留，现有文件不覆盖、不删除。

## 同一未确认发布的一次接续

专用入口为 `node deploy/local/update.mjs continue-native-publish <原operation> --line <原调用线>`，只接受原责任，不接受包、资产、profile、私有输入或其它阶段参数。默认 update、rollback 和 start 对未知状态的拒绝继续生效。现场执行仍由原主线负责人在准确正常源、必要测试和同案结论齐备后完成。

入口只读持有原 operation.lock，核原候选持有者、私有 prepared 输入、原 app exec/PID/start、keeper/ns、产品只读条件、完整原组和 prepared 产品计划及源文件；不会重新 prepare、reserve 或发布资产，不比较服务运行中正常变化的用户数据。已存在模块及来源从固定 FD10 只读核实，候选须尚不存在。

原 FD9 内固定 `native-publish-continuation.intent.json` 以独占创建、同步、关闭、目录同步及读回关闭确认一次新尝试；任何已有或部分文件永久拒绝再次尝试。意图分别绑定原记录、原组/资产来源与新控制器正常保存点和实际程序摘要，明确前次加载未知。随后只做一次新的受限只读加载和原函数的独占候选创建，新退出、信号、原始 stdout/stderr、缺失/超限事实及候选结果保存在同目录私有 receipt，不补造旧调用日志。

只有新 receipt 确认后才按准确 expected-record 追加 published（保原三项 history 前缀），再正常保存原私有输入并由 Root 事实投影 latest；上述动作及桥关闭任何未知均不停止原应用，不自动回退、不重新加载、不倒退实际 Root 阶段。只有本次成功调用能继续原 stop/backup/install/profile/start/ready/smoke，已有 published 不能作为另一次恢复入口。最终 verified 后才沿原释放护栏处理同一个操作锁，候选锁仍由主线完成原额外验收后交还。

控制器源在原产品两包之外：新正常保存点/程序摘要与原包 manifest/sourceCommit、原 prepared 输入及原生产模块分别绑定；原两包不重打、不改名或改来源标签。本入口不包含后继新 JavaScript 读者对或目录协议扩展。

## 只启动当前版本

```sh
deploy/local/start --line '<工作线名>'
```

应用已停止、原挂载命名空间仍由保留进程维持时，用这条命令启动当前安装的产品文件并等待入口就绪。它不替换产品文件，不恢复数据库或账号文件。

正常停止返回非零退出码时，不重复发停止信号，也不直接再次更新；由评审者复位后明确通知，再执行 `start`。启动失败就停止，保留状态和日志供复核；启动成功后再执行更新。迭代 002 的首次启动也须在评审者明确通知复位完成、代码与测试完成后执行。

## 打包和更新

在工作目录根目录运行：

```sh
deploy/bundle --output '<仓库外产品包目录>'
deploy/local/update '<产品包目录>' --line '<工作线名>' --credentials '<私密JSON>' --account ordinaryUserB
```

不指定 `--output` 时，产品包放在工作目录上一级的 `bundles/` 中。口令不放在命令行参数里；也可预先提供 `PE_CLOUD_SMOKE_EMAIL`、`PE_CLOUD_SMOKE_PASSWORD`，省略凭据文件参数。

要验证更新前的已有对话仍可继续，在更新命令后成对追加以下参数：

```sh
--continue-session '<已有对话标识>' --continue-marker '<旧回复中的标记>'
```

更新会先检查安装条件、准备产品回滚资料并保留现有挂载命名空间，再正常停止应用、备份数据库和账号文件、替换产品文件、启动并等待未登录 `/cloud/bootstrap` 返回 401，随后运行冒烟检查。

停止只发送一次 SIGTERM，等待应用原有的 120 秒关闭预算，再留 30 秒供启动包装进程收尾，并由原启动记录确认退出码为 0。正常退出不能确认时停止更新，不强杀、不重复发信号，也不继续替换产品文件。

## 回滚

```sh
deploy/local/rollback --line '<工作线名>'
```

回滚使用最近一次更新保存的测试账号参数；需要更换时可追加 `--credentials '<私密JSON>' --account ordinaryUserB`。已有对话参数仍需成对提供。

回滚恢复上一个版本的产品文件，启动后运行冒烟检查。检测到数据格式变化时，在停止应用之前拒绝自动回滚，由评审者处理。数据库和账号文件备份仅留存，不自动恢复。更新、回滚和再次更新是否通过，以本次迭代记录的实际结果为准。

## 状态、日志和失败处理

命令会打印阶段结果、应用日志路径和备份位置。运行状态与私密备份保存在 `pe-cloud-work/local-state/`，位于仓库之外；状态目录权限为 0700，备份文件权限为 0600。它们用于恢复，不应提交到 Git 或公开输出。

应用继续使用 `/run/dsh-feature-root` 中已有的根配置和存储计划。维持其挂载命名空间的保留进程在启动、更新、回滚成功或失败后都不释放；不通过重启应用容器重新生成这些文件。容器重启后的恢复另属后续迭代，不由这些命令处理。

可在工作目录运行 `node deploy/local/inspect.mjs`，只读查看进程身份、命名空间、产品挂载和日志路径。失败时保留状态、备份及终端结果供复核，不手工改数据库、删除产品状态文件或重启容器来制造通过。

## 原操作的验证接续

`node deploy/local/update.mjs continue-native-verify 1de3c28b-bb13-46da-91bb-950cb3073133 --line 主线` 只接受这次已安装目标、原应用/keeper、原绑定与 phase12。它重读原完成 job 和原 provider 完成记录，随后用原账号参数运行一次新的正常冒烟；只有退出0且前后实际 tuple 相同，才通过原 CAS 进入 verified13 并正常释放部署锁。旧失败记录、合法 ready 分配及原认证会话仍由原 owner 保管，不重放旧业务、不停止应用或归还账号/SDK资源。验证前独占持久保存新的 verify-attempt 记录，失败仍保留，已有记录拒绝再发。失败保留原意图与锁，不自动重试；这不是其他阶段或操作的恢复入口。
