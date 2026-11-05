# Airalogy 归档核心

[English](README.md) | 中文

复制自 `upstream/airalogy/packages/npm/aira-core/src/index.ts`（包版本 0.4.0）。许可证为 Apache-2.0，原许可文本保留为 `LICENSE`。上游源码保持原样。

本地适配：导出已有的 `createStoredZip` 辅助函数，使服务端使用上游 ZIP 实现生成记录包。`src/server/archive.mjs` 负责组装记录清单，再用本核心的 `openAiraArchive(...).validate()` 校验。浏览器使用同一读取器处理上传的 .aira 文件。

本核心实现 Airalogy 归档/记录格式及 AIMD 结构处理。它不安装 Python Airalogy Engine，不执行 model.py/assigner.py，也不同步 Airalogy 云端账号。
