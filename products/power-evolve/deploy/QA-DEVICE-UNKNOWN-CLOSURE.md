# Device 未知结果可信结案验收

2026-10-04，代码固定为 `8b80dc4d21e331a3e3914ef3740eb65d202777ba`。本轮补齐[Device 派发与停止协议](QA-DEVICE-DISPATCH-STOP.md)的已停止未知结果结案，复用原生执行区域及既有独立审批台。它不增加 DSH 插件、产品页面或后台队列；已有完整停止事实时，结案、唯一续接与回执在一个 PG 事务内完成。本轮没有部署新版本到[Cloud 固定试用](../TRIAL-CLOUD-EXECUTION-RESOLUTION.md)，也未交付 Electron 或完整桌面切片。

## 实际验证范围

| 检查 | 结果及范围 |
| --- | --- |
| [Device 结案](../application/tests/device-execution-resolution.test.mjs) | Root 8 项通过；真实临时 PG、真实身份服务，Docker receipt 为合成数据；覆盖独立 approval、异主拒绝、NUL 输出、全部身份关联、重复及并发请求、撤销、停用、回滚与唯一续接 |
| [迁移](../application/tests/device-execution-schema.test.mjs) | Root 1 项通过；真实临时 PG，从 V28 保留原结果及续接事实，经 V29 后升级 V30，旧执行不自动生成派发、停止或结案记录；snapshot 为 lossless json |
| [显式提供者路由](../application/tests/cloud-execution-resolution-routes.test.mjs) | Root 6 项通过；服务为替身，验证同 ID 不回退、列表有界合并、准确 Origin、禁止浏览器提交停止证明 |
| [共享校验](../application/tests/cloud-execution-resolution-contracts.test.mjs)与[静态资产](../application/tests/cloud-execution-resolution-browser.test.mjs) | Root 6 项通过；实际浏览器 ESM 构建、静态 HTTP allowlist／CSP 与 wire parser；没有操作真实浏览器或运行正式 Profile |
| [Device wire](../application/tests/device-execution-contracts.test.ts)与[Host 只读客户端](../client-execution-target/tests/execution-resolution-client.test.ts) | Root 共 9 项通过；Device 不能报告 closed_unknown 为命令结果，平台原清理 ACK 可带该状态；客户端响应与 HTTP 为替身 |
| [可信审批 DOM](../application/tests/execution-resolution-approval.test.mjs) | Root 36 项通过，包含子用例；JSDOM／HTTP 替身，覆盖目标、稳定 bytes、失 ACK、刷新及状态先查重试，不计作真实浏览器验收 |
| [原生执行区域](../client-execution-target/tests/execution-resolutions.client.spec.tsx) | 隔离客户端实现树 4 项通过；React／JSDOM／HTTP 替身；Root 完成对应类型与发行 bundle 构建，没有重复该已通过组 |
| [受影响 Cloud 服务](../application/tests/cloud-execution-resolution.test.mjs) | Root 聚焦 6 项通过，包含子用例；实际临时 PG、Sandbox／Runner 为替身，覆盖 approval、停止未知、成功／失败／取消及 NUL |
| [真实 Device Docker 链路](../application/tests/device-real-docker-protocol.test.mjs) | Root 聚焦 2 项通过；实际 PG、Docker、公开 Worker、真实身份认证和生产审批路由；HTTP 服务是测试入口，不是完整 Platform／Host Profile，也没有真实模型或 Electron |

真实 Docker 复用本机 ARM64 镜像 `pe-release-cloud-runner:7e2c0067e1-arm64`，没有拉取或重建。登记响应丢失后，原命令的 marker 文件始终不存在；精确 created／non-running 事实持久化后，普通 Agent 凭据、Bob 的审批凭据及错误 Origin 分别被拒绝。结案事务提交后再次注入响应丢失，查询得到原 completed／closed_unknown 回执，同 bytes 重试仍是原回执；原 stop、result 和 digest 未修改且原续接只有一条。随后同授权目录的新命令生成 AFTER 文件，原 marker 仍不存在。运行中撤销场景只留下 START，没有 END；撤销 Device 凭据仍可回报原精确停止记录并在结案后取得相同清理 ACK，原续接仍为一条。

两个实现 Agent 在隔离分支提交候选，Root 固定共享 DTO、邻接迁移、路由及集成。源码独立审查未发现本次新增误放行；这不替代实际运行证据。Root 完成 Application／原生执行区域类型构建、共享浏览器与客户端 bundle、受影响 TS／TSX lint、6 个源文件导出 JSDoc、双语记录、20 项文档检查及正常提交 hooks。JSDoc 第一次误把 `--` 当文件参数而失败，改用工具实际支持的参数形式后通过；没有绕过检查。

## 复验与剩余工作

先运行 `pnpm --filter @power-evolve/contracts build` 及 `pnpm exec tsc -b products/power-evolve/application/tsconfig.json products/power-evolve/client-execution-target/tsconfig.json`。PG 用例通过 `PE_PRIVATE_DIR` 读取私有 `database-url`，或使用 `PE_TEST_DATABASE_URL`；只创建和删除随机测试库。真实 Docker 另设 `PE_DEVICE_TEST_IMAGE`，用 `node --test --test-name-pattern='lost real registration|revoking a running real' products/power-evolve/application/tests/device-real-docker-protocol.test.mjs` 复验本次两项，不把数据库 URL 或凭据写进命令记录。

结案只接受平台已有的完整停止事实；无停止记录、旧身份不全及冷领取意图仍受阻，不以人工勾选补造停止证明。跨 Device／重叠目录协调、本地目录物理身份与描述符访问、缺少停止事实的冷领取核验、本机 Office／技能／连接器及 Electron 三处适配仍须继续完成。正式 Profile 的两用户原生浏览器组合验收和离源码 ARM64 安装包尚未完成本次验证，详见[桌面复用约定](../DESKTOP-COMPLETION.md)。

测试资源由各自持有者清理；结束后只保留原 PG 容器和原 k3d 节点。既有 Cloud 固定试用保持原镜像、schema 和数据，新 V30 仅进入隔离测试库。
