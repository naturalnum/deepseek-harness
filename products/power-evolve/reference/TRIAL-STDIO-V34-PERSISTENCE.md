# V34 迁移与执行兼容性验证

## 范围

2026-10-07，源码固定于 `fe528bbadf2c278329e8df03d9276b4dc666bc87`。V34 DDL SHA 为 `de3acb5bd0b47673b05f34d25f44a4b21e00793f40dcc28b23ccd1623edb6769`。数据库验证使用独立的真实 PG 测试库及合成记录；原 O6 R8 试用仍使用其冻结源码和 schema 33。本轮未运行通用连接器的客户端、审批 API 或真实执行器。

## 结果

- 迁移与兼容性验证 17/17：V33 到 V34、重复初始化、旧命令与 Office 事实保留、raw JSON／escaped NUL、两类执行目标、跨用户配置及设备拒绝、SQL NULL 拒绝、Prepared／决定／许可不可替换。call 的结果与停止记录存在后，仅能使用原请求 ID 续接一次；discovery 无续接。
- 受影响旧链路的真实 PG 回归 75/75，覆盖 Cloud 对账、Device 协议及对账、账户撤销和文件事实。Kubernetes、Runner 和 Docker 使用测试替身，不代表真实停止证明。
- Cloud 分流合成测试 9/9；Device 分流测试 12/12 使用内存 SQLite 执行适配后的消费 SQL，不代表 PG 锁验证。Device `.mjs` 的源码导入已改为 built 导入，并以普通 Node 重验。
- Application 严格编译、四个 Root 源文件的 JSDoc、定向 lint 和正常提交 hooks 通过。独立审查发现的续接请求绑定缺口已修复；最后两个 DDL 增量和账户内容判断复审无剩余阻断。
- 账户服务使用真实登录身份拒绝删除仅有通用配置或管理回执、尚无 Session 的账户；定向测试 1/1，测试后继固定于 `94ecd23a0e`。原试用状态读回为 Host／Platform ready、schema 33、活动 Office job 0。

## 证据与限制

Root 忽略目录中的 `stdio-v34-real-pg-migration-final.log`、`stdio-v34-legacy-real-pg-regression.log`、`stdio-v34-device-consumer-built-final.log`、`stdio-v34-root-build-final.log` 和 `stdio-v34-root-jsdoc-final.log` 保留实际结果。早期测试的错误也保留；不能把启动方式或 fixture 修复前的结果记为通过。独立工程师工作树保留候选提交、定向日志和只读审查。

数据表的唯一性和不可替换约束不等于执行授权。可信入口的身份核验、完整 DTO 与摘要核对、一次性许可首回复、实时执行者复验、断线查询和完整停止证明，以及原生插件页接线仍待实现与端到端验收。旧消费入口拒绝通用任务；通用任务的准备、审批或未知写入者仍占用原执行记录，不能借取消提前释放工作区。
