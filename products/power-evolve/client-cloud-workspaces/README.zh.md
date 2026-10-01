# PowerEvolve 云 Workspace 客户端

[English](README.md) | 中文

此产品插件以同一个弹窗填充原生 Workspace 选择器的 hero 与侧边栏目录流程。用户可以新建私人目录、浏览经过身份验证的存储空间并选择已有目录，或恢复存储绑定缺失的原 Workspace。目录导航和分页只显示相对于私人存储的规范路径；物理根目录与凭据保留在可信平台。已有非空目录可以选择；平台拒绝与其他有效 Workspace 重叠的目录。

创建通过原生 Workspace Controller，以不透明的 `power-evolve-cloud-selection:` 值传递共享 `workspaceCreateSelection`。创建与 mkdir 在相同输入的结果不确定时保留同一个请求标识。只有原生 owner 明确确认采用成功，才会清除创建的重试记录；随后新建同名工作区的意图使用新标识。两个弹窗入口通过声明的 store 共享交互记录，并接收普通的经过身份验证的操作回调。

恢复保留原 Workspace 与会话标识，精确比较已观察到的绑定代数，并使用持久请求标识查询状态。缺失绑定的元数据携带该标识，用户刷新页面后可以继续查询。已受理或正在停止的请求锁定目标编辑；只有经过验证的 completed 回执才报告成功。确认 blocked 后，用户可以明确选择替代目录并使用新请求标识。Host 的原生 Workspace follow 流更新原条目。关闭弹窗会取消浏览器读取和状态请求，但不会取消平台的持久恢复操作。迟到响应不会更新已卸载的流程。

## 模型体验

此插件不添加模型可见消息或会话事件。会话创建时绑定其 Workspace；选择当前显示的项目不会重新绑定已有会话。确定性回归使用生产客户端 Loader 与原生 Workspace 选择器、共享 Host RPC 记录，以及包内拥有的中英文输出快照。

参见 [S2 接口](../S2-INTERFACES.md)与 [S2 试用](../TRIAL-S2-NATIVE.md)。
