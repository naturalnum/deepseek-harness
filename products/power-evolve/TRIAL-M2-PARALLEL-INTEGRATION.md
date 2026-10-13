# 并行集成构建与附件用户路径

2026-10-09，Asia/Shanghai。本记录对应固定官方 `dsh-v0.2.1-alpha.1`／`5badb15009ae1756c3afe0ae0cef1faafc290ccc` 上的未提交迁移版本。来源工作树和旧运行数据保留。验证通过范围为当前正式构建、原生附件与两用户模型读取；M0—M5 整体尚未交付。

## 构建输入与产物

正式构建前停止精确识别的旧 Host／Platform launcher，并归档旧应用、连接器及两个客户端 lib 和静态 Web。旧启动器均以 0 退出。新部署使用新的私有 dshHome，保留旧所有者和停止记录。整个构建期间 208 个生产源码及构建配置文件 SHA-256 保持一致；具体清单为 `post-review-formal-source-before.json`。

| 检查 | 当前结果与证据 |
| --- | --- |
| 实际类型程序 | 重新解析 156 项引用图，更新真实 root files；Host、Client、Test Host、Test Client 四程序通过，`post-review-four-type-programs-refreshed.log` |
| 正式类型发射 | `tsc -b tsconfig.power-evolve.host.json tsconfig.power-evolve.client.json` 通过，`post-review-formal-types-build.log` |
| 应用、连接器及客户端 bundle | 四个 tsdown 构建通过；应用输出 132 个文件，`post-review-formal-application-bundle.log` 及三个对应 bundle 日志 |
| 正式原生 Web | cloud-web 构建通过，`post-review-formal-cloud-web.log` |
| 实际 built factory | 账号与插件中心各 1 例通过，两个 `post-review-*-built-test.log` |
| 实际 built 原生运行组合 | Scheduler／AgentLoop／Scope／Session／持久化组合 2 例通过，`post-review-native-scheduler-built-test.log`；Platform 和模型适配器为测试输入，不算真实连接器验收 |
| 实际 built Skills 目录 | Node 导入正式 loader，核验当前目录及九个 ZIP；固定目录摘要和私有安装测试见[Skills 记录](TRIAL-M2-CLOUD-SKILLS.md) |

`post-review-formal-artifacts.json` 冻结 509 个 JS／MJS／JSON／HTML／CSS 工件，其中包含类型程序发射；该数量不能当作应用 tsdown 输出数。审查后的源码切片、15 个附件生命周期用例及 5 个 Skills 用例记录在 `post-review-source-slice-checkpoint-integrated.json`。证据位于仓库外 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence`；私有配置、PG 内容和浏览器记录不进入 Git。

## 正式 Profile 与真实用户路径

新的 Host 实例为 `bce65f22-2fd6-450e-85c1-56a467b6eb68`，Platform 为 `458fd282-a89b-45de-98f0-b0efcbf947be`；各自经当前正式 DSH CLI／Loader 和具名 Profile 启动，独立 health 为 ready。持久生命周期保存 launcher／child 的出生身份，当前运行身份和就绪证据为 `post-review-profile-ready.json`。当前数据库为 PostgreSQL 16.14、cloud-native Schema 2、71 表。

Alice 与 Bob 的独立原生浏览器上下文重新加载当前静态产物，账号菜单各显示本人身份。两个用户通过真实配置的模型分别调用 `cloud_file_read`，读取自己的历史原始附件；PG 中的 tool/call、成功 tool/result 和 turn/end 与完成的 operation 对应。Alice 分支仍引用父 storage Session，Bob 的文件保持独立。证据为 `post-review-model-operations.json` 与两份 `post-review-*-browser.txt`。

Alice 在当前构建中新上传 `post-review-upload.txt`，92 字节，SHA-256 `f8b7598489f9b71a75fd3886fc7b2c7da7b856026421a8da0e3c3f42731eb66f`。实际模型读回第二行唯一标记，再调用 `cloud_file_copy` 创建 `附件验收/集成修复副本.txt`。operation `8527eff8-614b-4da1-bd54-40623749a337` 完成；独立调用正式 `FileService.readInWorkspace` 读回三行、92 字节和同一摘要。PG 回执、21 个原生事件和独立副本读回保存在 `post-review-new-upload-copy.json`，浏览器记录为 `post-review-new-upload-copy-browser.txt`。

上传使用实际隐藏 file input 的 File／change 事件，经过原生客户端 worker、网络、Platform 和文件存储。此路径没有验证操作系统文件选择器。新构建的真实模型调用使用用户授权的私有 Key 文件，证据不包含 Key 的值。

## 尚未通过的完整验收

Office、Cloud Sandbox、远程 MCP、SSH 和 STDIO 在该运行部署仍为 disabled，不能算作 enabled 执行验证。现有私有 Skills 安装未自动升级；图片、steering／queue、单文件下载与适用预览、完整报告流程、2 Host＋2 Platform、当前全量备份恢复及正式镜像交付仍需同版本验收。

完整质量入口仍失败，逐文件 lines／statements／functions／branches 四项 100% 阈值不变。并行新增测试和后续生产修改不属于本次冻结构建的输入，必须在下一集成记录重新核验。独立审查和当前切片通过不替代所有 18 项能力及 M5 完成标准。
