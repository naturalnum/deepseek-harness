# V33 Office 缓存与 PG 恢复校验

## 范围

2026-10-07，在原 O6 R8 试用停止期间，使用真实 PG、原共享 POSIX 文件和 Office 缓存验证备份辅助函数。辅助函数源码固定于 `81f3ae7e9f1f8c200c1fd015fa63825cdd4e54a9`；原试用仍运行 `83e46b3dde7adbdba3f8c70ba6f3d64856b0818c`、schema 33。此次未运行部署或进程试用的完整备份入口，未恢复其全部私有凭据，也未启动恢复目标的服务或预览 API。

## 已验证

- 原冻结启停入口正常停止 Host 和 Platform；真实 PG 的全部活动计数为零，原命名空间无 parser 或其他 Pod。原容器保留。
- 通过原容器的 Docker volume `Subpath` 确认映射：配置中的 `/data/office-previews` 对应 Mac 可见的 `pe-e32-session-shared-posix/o6-report-20261005-r1/office-previews`。两条路径分别保留，原配置字节 SHA 未改写。
- 真实 PG custom dump 与文件快照复制到私有目录，共 1777 个文件记录，其中 Office 缓存 10 个。3 条 Office job 的输入、结果与 PG 元数据逐项核对。
- 将 PG 恢复到独立库 `pe_office_v33_restore_20261007_r1`，文件恢复到独立目录；账户 3 行、会话 4 行、Operation 553 行、事件 8525 行、产物 0 行、Office job 3 行的原始行序列摘要与源一致。工作区、Skill 和产物目录的文件清单一致。
- 原 Office 配置 SHA 为 `fc745b0ae4adcb092dcc07cd94d06c5e152f4ecbda0cbda893f48383ddd4b8b0`；恢复目标单独配置 namespace、volumeSubPath 和 localRoot，其他配置相同。目标缓存与原 PG census 一致。
- 在另一份停止的目标缓存中损坏 PDF，验证失败；对实际恢复 PG 使用缺失 Office 缓存的旧备份描述，验证同样失败。均未启动目标服务，也未重新转换文件。
- 原 R8 冻结入口重新开启 Host 和 Platform；原镜像、容器和 schema 33 保留，没有重放程序或调用模型。

## 证据

Root 的忽略目录 `.artifacts/v33-office-backup-20261007/` 保存预检、停止、复制、恢复、重新开启日志，以及 `receipt.json`（SHA `be3a37055d418a52a489a9cce131050866bcf15560cc336d8db83a6d5fe156e1`）和实际执行脚本。私有 dump、配置及文件快照不进入 Git；回执仅记录摘要、计数、路径和验收范围。

此结果证明所用辅助函数能够保留真实 PG 与文件字节。完整部署入口的停机围栏、凭据恢复、挂载权限、目标启动、授权读回、新预览及 RTO 仍需单独验收；原预览 generation 的历史记录不能当作新配置下的 API 可用证明。
