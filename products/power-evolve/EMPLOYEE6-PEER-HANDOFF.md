# 员工6：具名 cloud PEER 实施交接

本轮已落实授权切片：[30项显式 account runtime 桥接](application/src/account-contracts.ts)保留 `export type *`；Application／Connector 使用匹配的 Contracts peer＋dev；Host／Platform 显式提供 Contracts、Connector 和 Zod 4.4.3。Application 的发布文件补齐 Schema v2 SQL 与 manifest。四份 package.json 自2026-10-09 11:33:21 +08:00起冻结，后续安装、构建与新 Profile 验收由主线程串行执行。

[具体 diff](employee6-peer-implementation.patch)以本轮操作前的私有原件为基准，可直接审阅；实际修改已经在工作区中，不要再次应用。Contracts src、官方 SAFE／DUP／PEER 定义与[旧13项SAFE补丁](employee6-export-policy-proposals.patch)未改，旧补丁不应用。本轮没有 install、锁文件写入、生产构建、Git add／commit或现有2＋2服务操作。

## 策略与真实导入

[独立 cloud 策略](scripts/cloud-peer-policy.mjs)的103项来自显式桥接后的真实官方 collector，不依赖历史计数。Application 源码有271处 Contracts runtime 使用；新 `stdio-v2-cloud-worker`、`cloud-capture`、`cloud-runtime` 和 `worker-store` 的导入均已纳入。表只增加具体 peer 分类，所有原 SAFE／duplicate-safe 字段和官方 peer 条目保持不变。

员工3已在[cloud 检查器](scripts/cloud-static.mjs)接入同一 overlay：生成 `peerRequiredHostDependencies` 事实和最终 combined 官方 export collector 都用该策略，官方 read state 仍使用原 policy。当前实读结果为 import／section／integrity 错误均0、Contracts 未分类项0；Connector 的24项和官方的54项未知导出仍产生78项拒绝。它不是全套绿色验收，旧76项不是当前计数。

| 导出 API | 调用与拒绝要求 |
|---|---|
| `createCloudPeerPolicy(original)` | 只追加 cloud 具名 peer 表，其他字段保留原引用 |
| `cloudPeerPolicyErrors(policy, original, managedUses, workspaceNames)` | 使用实际 product managed Host facts；拒绝 unknown provider、unused、重复、无界名称和原策略改动；仍执行官方 collector |
| `cloudProtocolManifestErrors(manifests)` | 拒绝缺 matching peer＋dev、缺 Host／Platform 生产 provider 和缺 pinned Zod |
| `cloudProtocolResolutionErrors(input)` | 使用实际 resolver entries、peer 声明、linkedRoots、完整 source import corpus与已加载 ESM 观察；拒绝缺映射、路径／入口／版本／runtime 身份不同 |

## 执行证据

永久测试位于 [policy](application/tests/employee6-peer-policy.test.mjs)、[resolver](application/tests/employee6-peer-resolver.test.mjs) 和 [pack](application/tests/employee6-peer-pack.test.mjs)。下列命令16／16通过，没有 skip 或 todo；5组 README 双语配对、10份 README links／wrap／Summary与新策略的官方 JSDoc 检查也通过。

```sh
node --import tsx/esm --test products/power-evolve/application/tests/employee6-peer-policy.test.mjs products/power-evolve/application/tests/employee6-peer-resolver.test.mjs products/power-evolve/application/tests/employee6-peer-pack.test.mjs
```

正式 resolver 测试启动9个新的独占 Node 进程，使用真实 Contracts 源码的私有 ESM 输出和实际 Application／Connector manifest、源码导入及祖先查询位置。Host 与 Platform anchor 正例分别通过，每个进程观察162份输入、124或125条 ESM edge，覆盖全部9个 Node协议子路径、119个runtime导出、88个静态schema和30个bridge导出。实际服务初始化由只导入协议的观察模块隔离；这不是完整 Application 服务启动。

| 场景 | 结果 |
|---|---|
| Host anchor共享provider；Platform anchor共享provider；nested peer helper | 接受：路径、版本和全部runtime引用一致 |
| 缺 provider；缺 consumer peer；遗漏 linkedRoot | 拒绝 |
| nested private Contracts helper；Contracts 内部私有 Zod | 拒绝，即使 package version 相同 |
| provider映射版本与真实manifest冲突 | 拒绝 |
| 已发布provider版本热换 | 官方resolver要求进程重启 |

共享工厂函数仍生成不同的逐次 schema；调用者修改被保留的预算仍可改变校验。Node证明不涵盖浏览器bundle、CJS／ESM跨入口身份或跨进程schema地址。

真实 `pnpm pack` 已输出 tarball；从归档读取的 Schema v2 SQL（736字节）和manifest（16267字节）逐字节等于源码，Contracts peer正确重写为 `~0.2.0`，不在production dependencies。包内既有lib／web不是本轮新构建证据。私有 `pack-report.json` 与日志记录这一限定。

证据目录为 `/Users/jingchao/agent_work/private/employee6-peer-implementation-20261009`，权限0700。`peer-test-report.json`、`peer-tests-final.log`、`actual-dependencies.json`、`current-contracts-uses.json`、`pack-report.json`、`implementation-input-snapshot.json` 和检查日志保存实际输入与结果。首次探针的错误stderr也保留：最初restart断言使用错误的message正则，路径比较未统一macOS `/var`／`/private/var`别名，且负例错误要求bridge仍共享；修正后最终16项通过。没有证据支持先前“native resolve绕过拦截”的推测。私有输出的observer仅记录实际 `import.meta.url`，比较时剔除observer导出。

## 冻结输入与锁交接

| 输入 | SHA-256 |
|---|---|
| application/package.json | `fa27b401df124e5003dacf36a449177b495ccf3248439d0d48c39481f8d7c951` |
| host/package.json | `4b7f0c3ad77ba472691241e988bedc42cc0c17b3499c9a9b7ed4a7c3f595d308` |
| platform/package.json | `1fbfe7317ec5b2a41bff09f38da6e300a5fde4568e94ae46aa4a77cd3c22c2e2` |
| connector-runner/package.json | `cda3132b5d9d847935dcc18d3eb21bb70911450c6d14746c07763c97e953dffd` |
| account-contracts.ts | `d26fa2f87efadaa3f612d3519756c63389f55dc9117104e362cb64cf21ccb174` |

拟锁更新只涉及四个importer：Application移除production Contracts link、增加dev link；Connector同样移至dev并将specifier从 `workspace:*` 改为 `workspace:~`；Host／Platform新增Contracts、Connector link与Zod 4.4.3。已通知主线程以 `node node_modules/pnpm/bin/pnpm.cjs install --lockfile-only --ignore-scripts` 串行处理全workspace。主线程反馈其before锁已包含这些关系、parsed锁无差异，因此不把该次命令记录为新增锁修改。

员工6本轮首次实读锁SHA为 `24d22b5bc00c16cb79ef5e60d8dc9aea10b995c4d5e826d455a2b1c07db2b269`，文件mtime为11:16:28 +08:00；读取时间是11:31后，mtime不是当时hash快照。操作前基线没有保存锁，不能归因写入者。实际pack发生在11:22:58，晚于该mtime。锁最终冻结由主线程控制。

## 生产闭包与下一步

声明和上述源码探针已完成；真实生产安装闭包、fresh lib／image、新正式 Profile 和实际worker验收仍待主线程完成。受控安装必须关闭自动peer安装，并核验Application、Connector、Contracts与每个传递helper实际解析至同一Node ESM provider，记录正式resolver的declarer与linkedRoot。Contracts和Application／Connector自身Zod仍是普通production dependency，清单本身不能排除嵌套副本。

独立worker不能借用Host／Platform的生产清单；它自己的安装根或单一构建闭包必须显式提供Contracts／Zod，再核验所有入口。CJS、mini或其他Zod入口需要各自的身份与全局状态审查。已加载provider不热换；新目录或版本以新进程接受。浏览器bundle保留单独实例，不通过Node peer检查宣称单例。

主线程确认同版本生产依赖闭包后执行全套cloud-only build／checks及独占新Profile接受；现有2＋2服务保持原运行代次。未分类78项、SQL／真实PG／镜像等其他owner未完事项均不能由本切片测试代替。
