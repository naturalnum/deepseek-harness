# 沙盒文档工具链

[English](README.md) | 中文

沙盒镜像保留现有 HTTP runner。可信进程以 root 启动，使 `runner.mjs` 能以 UID/GID 1000 运行用户命令。部署时 `/workspace`、`/home/agent`、`/tmp` 是可写挂载，镜像根文件系统只读。工具链和 OfficeCLI 位于镜像内；Platform 另行挂载用户的包技能。

## 固定输入

- Node 22.23.2 Bookworm slim 基础镜像：`sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`。
- Debian Bookworm 及安全更新的 apt 仓库：`20260901T000000Z` 的签名快照。精简基础镜像尚无 CA 证书，所以首次 apt 更新使用 HTTP；apt 仍用基础镜像中的 Debian 归档密钥校验 Release 签名与软件包哈希。
- 私有 venv 中的 Python 3.11：`requirements-skills.lock` 固定全部直接和间接依赖的版本及发行文件 SHA256，由 `requirements-skills.in` 生成。runner 限制命令 `PATH`，`/usr/local/bin/python3` 包装脚本仍会调用该 venv。
- OfficeCLI 1.0.151：amd64 二进制的 SHA256 必须是 `8e2512234ae1111e51ad3a9fadbdeca266adfa7f683773469aa45b83fe06dc7f`；arm64 必须是 `fccb7d7841c9ec93593a62181544c893ee184455421cf15bd76110bf0ad29c41`。

镜像包含 LibreOffice Writer、Calc、Impress、Python UNO、Pandoc、Poppler、XeLaTeX/CTeX、Noto CJK 及 Debian 的文泉驿和 TeX 字体。报告目录更新器通过 `/usr/bin/python3` 使用 UNO；文档编辑使用私有 venv。不安装 JDK、Maven、Chromium 或 Windows 字体。Debian 指定日期快照固定 apt 软件包集合，基础镜像摘要固定初始系统状态。本地 QA 标签可以改变；用 `docker image inspect pe-s8-skills-runner:qa --format '{{.Id}}'` 记录准确的本地镜像 ID。推送后才能获得部署用的不可变 registry digest。

runner 为子进程提供固定环境，不转发镜像的 `ENV` 值。需要 `OFFICECLI_SKIP_UPDATE=1` 的文档命令必须在该命令内显式设置。

## 构建与烟测

```sh
docker build --pull=false --progress=plain -t pe-s8-skills-runner:qa \
  -f products/power-evolve/sandbox/Dockerfile products/power-evolve/sandbox
docker run --rm --user 1000:1000 --read-only \
  --tmpfs /workspace:rw,uid=1000,gid=1000,mode=755 \
  --tmpfs /home/agent:rw,uid=1000,gid=1000,mode=750 \
  --tmpfs /tmp:rw,mode=1777 \
  -v "$PWD/products/power-evolve/sandbox/qa-skills-toolchain.sh:/qa-skills-toolchain.sh:ro" \
  --entrypoint /bin/bash pe-s8-skills-runner:qa /qa-skills-toolchain.sh
```

脚本实际创建和校验 OfficeCLI 文件、导入锁定的 Python 包、生成和提取中文 PDF 并渲染页面、编译中文 CTeX 文档，还会创建并读取 DOCX、PPTX、XLSX 文件。每种 Office 格式均在独立目录导出 PDF，检查非空字节和预期文本，再用 Poppler 渲染 PNG。LibreOffice 可能未生成文件却返回零，因此仅凭退出码不能确认渲染成功。脚本另检查 Pandoc、可写挂载和排除的软件。此烟测覆盖工具链；内置技能完整工作流及 Platform 文档命令桥须另行验收。
