# 账户插件展示

[English](README.md) | 中文

此内部目录将参考迁移分支的搜索、用途分类、已安装筛选、紧凑插件卡片和详情页迁入现有 `pe-cloud-client`。它复用原生 UI 控件，不增加 Loader 入口、传输实现、安装执行器、Profile 编辑器或业务包。

`registerCloudPluginManagement(owner, panelKey, injected)` 只向原生 `main` slot 贡献页面，并返回同步撤回函数，用于移除页面、声明等待和语言字典。现有 Cloud 管理装配提供其 namespace 依赖 fiber、侧栏与 main 共用的路由 key，以及账户注入。该装配持有侧栏与共享 shell 反馈。组件及注册函数仅供包内导入，不增加公开 `/client` 导出。

注入包含稳定的 `hooks.accountPluginCatalog` 数据源，以及可选的 `requestPluginEnabled`、`openPluginConfiguration` 和 `refreshPluginCatalog` 回调。Root 的数据源必须对应捕获的当前账户，随原有页面生命周期撤销，对软件包元数据本地化，并在变化时发布新的缓存快照引用。切换捕获账户前应撤销原贡献，再注册后继贡献。回调必须在调用时重新确认账户和页面仍为当前实例，在服务端执行获批目录约束，在下一请求开始前发布 pending 或 unknown 状态，并由现有 shell toast owner 报告操作结果。UI 不在挂载时发起读取，也不将服务端状态复制到另一个 store。

批准、安装和启用分别展示。`installed: null` 与 `enabled: null` 表示尚未确认；部署批准目录不能证明实际安装。控件只在投影 ready 且未刷新、条目获批且已确认安装、启用状态已确认、操作为 available 且具有真实回调时开放。即使条目标为 available，缺少回调也会关闭控件。刷新失败时保留可读条目，同时关闭修改控件。添加插件按钮保持禁用，不提供 npm、Git 或路径表单，也不调用旧全局 PluginManager 写口。

原页面拥有获批刷新与编辑；版本捕获、应用方式及撤销规则见 [cloud client](../../../../README.zh.md)。

账户插件当前状态接口返回 HTTP 403 时，页面提示管理不可用，不展示插件操作或推断安装条目。其他刷新失败仍显示普通错误状态。
