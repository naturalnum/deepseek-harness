# S4 云端个人技能接口

S4 在原生 DSH Web 的侧栏加入一个“技能”入口。迁移旧 PowerEvolve `main` 的技能页布局、卡片、说明详情和相关交互；数据改接当前产品的认证 RPC。这个客户端包在 S6 扩展“插件”页。旧版扩展市场、ZIP 导入、卸载、试用按钮和桌面设置依赖尚未接入的平台能力，不进入本片。

## 页面和数据

`@power-evolve/client-extension-center` 在原生 `sidebar.panellist` 和 `main` keyed slot 注册相同的技能页 ID；不替换 DSH Web 外壳，不装载上游的全局 `ui-skill` 或 `ui-plugin-manager`。页面显示本人的技能清单、搜索、启用状态、说明详情，并允许安装一份纯文本技能说明及启停。中英文文案由客户端 locale 字典提供。说明作为文本渲染，不能把其中的 HTML 或代码作为页面脚本执行。

| 产品 RPC | 请求 | 响应 |
| --- | --- | --- |
| `skillsList` | `{}` | `{ items: [{ skillId, name, description, enabled, revision }] }` |
| `skillsRead` | `{ skillId: UUID }` | 清单项加 `instructions` |
| `skillsInstall` | `{ requestId: UUID, name, description, instructions }` | 新清单项；同一请求 ID 重试返回同一技能 ID 和当前启停状态 |
| `skillsToggle` | `{ skillId: UUID, enabled: boolean }` | 更新后的清单项；重复设置同一值不增加 revision |

页面调用同源 `/api/powerEvolve/*`，经 Host 当前浏览器凭据转发到可信平台。客户端安装请求在不确定网络结果时复用同一 `requestId` 和正文；409 同名或 ID 冲突、413 数量限制、401 登录失效、404 无权技能均显示可理解的状态。Host 不读取 PG，也不直接挂载技能库。

## 会话和版本

平台只从凭据解析用户身份，以 `user_id` 查询技能。安装内容写入平台私有 POSIX 技能库，PG 存元数据和内容摘要；当前内容在该技能 ID 下不可修改。`revision` 表示安装后的启停状态修订，不是可升级的内容版本。操作受理时按用户冻结已启用技能的 ID、摘要、名称和修订；执行时平台核对摘要并把说明作为该操作的用户内容交给 Agent。已受理操作继续使用受理时的选择，下一操作才反映启停变化。文本说明读取和普通问答不启动执行沙盒；S5 才接入带代码的技能包与云沙盒执行。

原生 DSH `skill-filesystem` 按 Host 文件路径扫描，不具备产品用户身份，不能直接装进共享 Host；原生 `ui-skill` 的冷会话目录也没有当前产品的用户鉴权适配。S4 使用已存在的产品技能 RPC 和操作快照。后续若需要原生技能工具，须以 Agent grant 限定 provider，并为冷会话目录另加认证接口与技能技术名映射。

## 验收

两个独立原生浏览器会话分别安装不同说明，查看清单和详情、搜索、禁用、启用、刷新与重启后恢复。一个账号不能读取或切换另一个账号的技能；同一安装请求重试不重复创建，冲突请求受拒绝。对话中询问本人的已启用技能说明，核对操作冻结的技能摘要和真实模型回复；禁用后的新对话不再选用它。整个说明读取和对话过程没有执行沙盒实例或 Pod。平台和 Host 的构建、类型检查、相关测试与原生 Web 打包通过后，固定提交和独立试用环境。
