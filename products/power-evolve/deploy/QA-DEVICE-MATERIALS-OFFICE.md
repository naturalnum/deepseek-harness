# Device 技能材料、Home 与 Office 验收

2026-10-04，在源码提交 `31f0ad3bb7744389acece6a4e1bfc7c3e84342f6`，通过公开 Worker、真实 PG、POSIX、Docker、OfficeCLI、LibreOffice 和 Poppler 验收 Device 材料执行。执行镜像使用 `pe-release-cloud-runner:7e2c0067e1-arm64`，不可变 ID 为 `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`。HTTP 路由使用测试 fixture；没有启动实际 DSH Profile、浏览器、Agent 或模型，不将本次结果称为完整产品端到端验收。

## 实际结果

| 场景 | 验收事实 |
| --- | --- |
| 固定版本与二进制 | Alice 受理 `1.0.0` 后安装 `2.0.0`，原执行仍运行旧包；脚本校验包含 NUL 与非 UTF-8 字节的资源，实际容器未挂入新包 |
| 只读与私密目录 | 实际 Docker 挂载只有授权项目、登记对应 Home 和所选 digest 包；改写包失败，私密根未挂入 |
| Home 与两个用户 | 容器写入 `/home/agent`，Worker 重启后再次读回；Bob 使用独立项目、包和 Home，不能读取 Alice 的材料，两个 Home 内容不串用 |
| 下载期间取消 | Worker 取消材料请求，冷恢复永久封存原领取；没有 Docker create/start、容器登记、启动许可、停止或命令结果，原会话仅一次续接 |
| Office | 三包 `1.0.2` 经相同命令守卫执行；Word 正文、Excel 的 `SUM(A1:A2)` 公式及缓存值 42、PPT slide XML 均读回 |
| 保存、渲染与传输 | 实际保存的三个可编辑文件分别转为一页 PDF；三页 PNG 已逐页检查，文字和数值可读，未观察到裁切或重叠；显式上传后字节与本机源一致，Bob 读取拒绝 |

完整 [Docker 协议测试](../application/tests/device-real-docker-protocol.test.mjs) **12/12** 通过、零 skip，耗时约 77 秒；其中保留原有九个 Git、真实进程崩溃、迟到创建、撤销、回执丢失、共享目录写入及传输场景。每条 Office 命令持有原 operation 技能选择，已知停止后至多一次续接。测试分别创建并删除自己的数据库、文件根和容器；完成后只保留既有 PG 与 k3s 两个基础容器，没有增加常驻试用栈。

源码材料与 Worker 回归 **65/65** 通过；真实 PG 材料、内置包与原生 Host 工具／技能事件联合回归 **33/33** 通过。技能事件测试使用真实 native Agent/Skill 库及记录输出，工具调用使用确定性 Runtime 替身，没有真实模型。材料撤销测试覆盖技能、Device、目录、账户、取消、永久封存和容器登记发生在文件读取期间的情况；授权后置复核均拒绝。严格产品／源码测试类型检查、相关 lint、contracts 和 materials 导出 JSDoc 及正常提交 hooks 通过。首次 Office 测试发现 fixture 的 XML 命名空间断言和传输方法名称错误，修正后才执行并通过完整十二项。

内置目录的真实 PG 安装回归 **1/1** 通过；报告套件及真实 PG dump／restore 备份回归 **2/2** 通过、零 skip，耗时约 11 秒，测试临时 PostgreSQL 容器已删除。报告 fixture 原先引用已被新发行目录替换的旧版本，更新到当前实际发行版本后复验；没有改变报告生产实现。原 Skill grants 回归在修正过时 schema25 断言后由独立实现分支验证 **1/1** 通过。Platform 四个整文件的导出 JSDoc 检查仍有 50 条既有缺失，本轮只确认新增／变更 API 无缺失，不声称整仓门禁通过。

## 证据与复现

本机 `.artifacts/device-materials-integration/real-docker.log` 保存完整测试结果。`office-20261004/` 保存三个 OOXML、三个 PDF、三个 PNG、三个文本预览及 `office-evidence.json`；文件大小与摘要来自实际保存字节。Root 使用 `view_image` 检查三页 PNG，并用实际 Poppler 核对三个 PDF 均为一页。这是小型功能成果，不代表复杂 Office 版式或报告套件完成。

先按[应用构建约定](../application/README.md)构建 contracts/application；测试入口为 `node --test products/power-evolve/application/tests/device-real-docker-protocol.test.mjs`，使用 Node 22.22.1。`PE_PRIVATE_DIR` 指向已有私密数据库配置目录，`PE_DEVICE_TEST_IMAGE` 选择上述已存在镜像，`PE_DEVICE_TEST_ARTIFACT_DIR` 可选择保留生成成果的本机目录。数据库 URL 只从私密文件读取，不放在文档或命令参数中。未设置镜像时该文件 skip，不能当作真实执行通过。

## 未覆盖项

正式客户端、真实模型与 DSH Profile 的材料／Office 组合验收仍待完成；本次不替代既有[云端 Office 验收](../TRIAL-S8-NATIVE-OFFICE.md)。Electron 适配器、安装包、本机进程连接器和 Desktop 报告套件仍按[桌面补齐约定](../DESKTOP-COMPLETION.md)推进。

当前 Home 权限为宿主用户 `0700`，镜像执行 UID 为 `1000`。本次实际验证 Mac／OrbStack 的挂载映射；普通 Linux 若宿主 UID 不同，需要部署身份适配。旧 Worker 不消费新增材料派发，发布须对齐 Platform、Host 与 Device 版本；尚无混合版本能力协商。原有固定云端试用镜像、数据库和端口未改变。
