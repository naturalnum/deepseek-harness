---
kind: upgrade-guide
description: FileUploads 开始统一限制暂存收据与未完成上传的总数，零字节上传同样计数。
---

# 文件上传收据容量

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-file-upload` 原来可保留无限数量的暂存收据。新增 `maxPendingReceipts` 配置默认值为 128，将已完成收据和未完成原生上传合并计数。达到上限后，在解析 Agent 或读取上传字节前拒绝新上传。原生收据退休释放容量；Session 销毁不会释放尚未完成的存储工作。

## 迁移

1. 如果默认值不符合部署容量，在该插件的 `cordis.yml` 条目中显式设置有限正数 `config.maxPendingReceipts`。直接构造时，第二个参数接受相同配置。
2. 保留正常 prompt 收据退休流程。达到容量后，先完成或退休现有待处理收据，再提交新上传。
3. 自定义 `storeFileStream` 覆盖必须等待实际工作完成。源或存储清理无法确认结算时，抛出 `FileUploadIntakeUnconfirmedError`；原 owner 继续占用该槽，并关闭新上传。替换服务前先核对原资源 owner。
4. 确认达到上限时不会读取请求体，退休一张原生收据后可接受一个新上传。现有持久文件引用和 Session 日志无需迁移。
