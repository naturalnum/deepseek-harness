---
kind: upgrade-guide
description: FileUploads now bounds staged receipts and pending intake together, including zero-byte uploads.
---

# File upload receipt capacity

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-file-upload` previously retained an unlimited number of staged receipts. Its `maxPendingReceipts` configuration now defaults to 128 and counts completed receipts together with unfinished native intakes. A full owner rejects further intake before resolving an Agent or reading upload bytes. Native receipt retirement releases capacity; Session disposal does not release unfinished storage work.

## Migration

1. In the plugin's `cordis.yml` row, set a finite positive `config.maxPendingReceipts` if the default does not fit the deployment's capacity. Direct constructors accept the same configuration as their second argument.
2. Keep normal prompt receipt retirement enabled. After reaching capacity, complete or retire existing pending receipts before submitting another upload.
3. Custom `storeFileStream` overrides must await their actual work. Throw `FileUploadIntakeUnconfirmedError` when source or storage cleanup cannot confirm settlement; the owner retains that slot and closes new intake. Reconcile the original resource owner before replacing the service.
4. Confirm a full owner rejects before pulling the body, and that retiring one native receipt admits one replacement. Existing durable file references and Session logs require no migration.
