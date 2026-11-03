---
kind: upgrade-guide
description: "Cloud workspace download actions require the streamed HTTP routes and updated storage companion."
---
# Cloud workspace transfers

English | [中文](guide.zh.md)

## Change

Cloud downloads use browser-native attachments instead of accumulating byte-range RPC responses in a Blob. New conversation uploads also publish a verified workspace-root copy; canonical private attachments and historical records remain. File-tree uploads can omit conversation receipts.

## Migration

1. Rebuild and hash-pin the staging companion from `packages/cloud/pe-cloud-files/native/staging.c`; it must advertise `workspaceTransfersVersion: 1`.
2. Configure `native.workspaceTransfers` with positive safe integers `maxFileBytes`, `maxFiles`, `maxTotalBytes`, `chunkBytes`, `maxPathBytes` and `timeoutMs`. Match `chunkBytes` to the existing worker read/reply capacities. Native attachment and staging byte limits independently constrain uploads. Keep the actual provisioned disk quotas unchanged.
3. Add exact account-session Fetch declarations for GET/HEAD `/api/workspace-files/download` and POST `/api/workspace-files/directory`, with handler `native:workspaceFiles`.
4. Retain explicit client `maxDownloadBytes`, sized for the intended file limit. It no longer represents a browser allocation budget. Ensure reverse proxies permit long transfers and stream bodies/responses without request or response buffering.
5. Verify a new upload appears at the Session workspace root, the Agent reads the same content through its execution path, and single-file/ZIP browser downloads retain exact bytes. Refresh after an uncertain cancelled upload or directory creation before retrying; a published file may already exist. Do not migrate or delete historical attachments.
