# 正式 Client typed lint 程序选择诊断

当前正式 Client spec 的失败来自 lint 后端没有选中配置程序。员工7仅提交配置补丁和诊断证据；共享配置尚未修改，当前正式 lint 不能记为通过。冻结 reader／Store 的六个源文件、manifest、lock、官方规则和测试断言均未修改，未安装依赖或使用源码镜像。

## 根因

安装版本为 Oxlint 1.76.0、oxlint-tsgolint 7.0.2001。正式 `scripts/run-oxlint.ts` 原样转发 `--tsconfig tsconfig.power-evolve.test-client.json`，但实际 Go 后端只收到 `headless` 参数，V2 请求没有 tsconfig 字段。后端从源码位置发现 `tsconfig.json` 并遍历引用；实际最近入口 `application/tests/tsconfig.json` 继承 Host 测试配置，242 个 root files 包含 Host spec、排除 Client spec，36 个引用没有正式 TestClient 程序。更高目录的配置也未为该文件找到程序。此策略见 [7.0.2001 配置查找源码](https://github.com/oxc-project/tsgolint/blob/v7.0.2001/internal/utils/find_tsconfig.go) 和 [headless 请求源码](https://github.com/oxc-project/tsgolint/blob/v7.0.2001/cmd/tsgolint/payload.go)；[上游问题 20328](https://github.com/oxc-project/oxc/issues/20328) 也记录了此参数未传入 typed 后端的行为。

保持真实源码、正式 TestClient 和当前官方映射规则执行 type-aware／type-check，未改后端的日志显示该 Client spec 的 tsconfig 为 `<none>`，programs=0、unmatched=1，退出1。本次完整诊断输出有42条 typed lint 和10条 TS2591，包含 Node builtin、process 及其派生 error／any 值错误；数量仅对应本次命令，不改写 root 先前43条记录。

独立读取完整正式 TestClient 程序：44个 root files、715个 compiler source files，全部预编译诊断0，该 Client spec 确实为 root file。四处 process 均为 Process，声明来自实际安装的 `@types/node` globals.d.ts／process.d.ts。配置中的 types=node 和继承 typeRoots 有效；追加依赖或在源码上打断言不能修复后端未选择程序的问题。

## 提交 root 的单文件补丁

将已有 `products/power-evolve/application/tests/tsconfig.json` 改为只含引用的 solution 配置，引用两个正式测试程序。Host／Client 的 include、exclude、compilerOptions 和依赖引用继续由对应正式文件拥有，避免在最近入口复制 Host 配置和引用列表。

```json
{
  "files": [],
  "references": [
    { "path": "../../../../tsconfig.power-evolve.test-host.json" },
    { "path": "../../../../tsconfig.power-evolve.test-client.json" }
  ]
}
```

可应用的补丁在私有证据目录的 `proposed-tests-tsconfig.patch`，完整目标配置为 `proposed-tests-tsconfig.json`。补丁基于最近配置 SHA-256 `f9e74b84edf666365467f62ffe7a1d09ab00f1afb7dcc8556920f52e60b05398`；root 是共享配置唯一写者，员工7未应用补丁。

## 真实源码上的配置覆盖验证

通过现有 OXLINT_TSGOLINT_PATH 入口，用私有透明 adapter 将请求交给未修改的已安装 Go binary，仅在其既有 source_overrides 字段覆盖上述一个配置文件。两个实验均读取原 checkout 中的冻结 spec，没有覆盖或复制任何源码，没有变更规则或诊断开关。每份请求的36项 typed规则、选中的真实文件路径、report_syntactic=true、report_semantic=true全部保留；原请求和覆盖请求逐字段比较一致，唯一差异为配置内容。

| 实际源码 | 后端实际选中程序 | programs／unmatched | typed lint＋type-check |
| --- | --- | --- | --- |
| employee7-native-assistant-read.client.spec.ts | tsconfig.power-evolve.test-client.json | 1／0 | 退出0；1272个后端source files |
| employee7-native-assistant-read.spec.ts | tsconfig.power-evolve.test-host.json | 1／0 | 退出0；1215个后端source files |

这些结果验证补丁能令正式源码进入正确程序，属于配置覆盖诊断，不能代替 root 应用正式文件后的验收。root 应应用单文件补丁后，在不设置 adapter／source_overrides 的条件下分别重跑两面的正式 lint，并将 OXC_LOG=debug 的程序路径纳入证据；完整 cloud source/static/coverage 仍按最终整合输入执行。

## 证据与范围

证据目录为 `/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/employee7/client-typed-lint-diagnosis-20261009/`。`report.json` 汇总；`formal-current-unmodified-backend.log` 保留当前正式失败；`formal-debug.log`、`backend-args.json`、`backend-request.json` 保留首次后端调用和未携带 tsconfig 的请求；`nearest-parsed-program.json`、`formal-program.json` 记录真实程序成员和 Node 类型；`solution-both-actual-config.log`／`solution-both-host.log` 记录配置覆盖后的程序和退出结果；`protocol-comparison.json`、原请求／覆盖请求及 adapter 源码可复核唯一配置差异。当前官方映射配置与此前交付配置一致，`official-rule-equivalence.json` 为比较结果。

1066项记录输入在窗口内0变化／0缺失：1065项正式 Client compiler 实际读取文件、递归 Client 引用配置及明确共享／冻结输入先记录，最近 tests 配置另在实验前补记，各时间保留在 `input-comparison.json`。六个冻结文件和记录的共享配置／manifest／lock一致。此集合未独立枚举 Host 后端完整源码闭包，不据此宣称全量双面固定输入验收。

首次配置覆盖因保护检查发现目标配置已存在而拒绝启动后端，失败保留在 `solution-both.log`；随后仅调整私有 adapter 为核对既有配置摘要再覆盖。首次 mapper 生成误用 Node native strip-only，失败摘要保留为 `mapper-first-failure.json`；采用仓库规定的 tsx/esm 后生成成功。未覆盖任何历史失败、未修改共享文件或正式源文件。本次没有运行 PG、行为测试、Profile、浏览器或模型。
