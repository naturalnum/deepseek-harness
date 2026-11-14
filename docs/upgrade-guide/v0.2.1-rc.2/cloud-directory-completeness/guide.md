---
kind: upgrade-guide
description: "Cloud content preparation requires the helper's actual directory completeness capability; bounded listings explicitly report truncation."
---

# Cloud content requires directory completeness

English | [中文](guide.zh.md)

## Change

Cloud's selected ABI8 content group now requires a helper and worker that actually advertise `directoryListingVersion: 1`. An older ABI8 helper without that capability can no longer prepare the group, even for `lstat` or byte reads alone. ABI8 and method presence do not imply the new capability. An unknown version fails the protocol handshake.

`FileSystem.listDir` remains complete-or-fail. Cloud returns `FS_TOO_LARGE` when a bounded scan is incomplete. The additive `listDirectory` method returns required `{ entries, truncated }`; Native WorkspaceFiles preserves provider truncation together with its own answer cap. Existing Local and SSH providers inherit the complete default. A partial subset has no cursor and does not provide complete access to omitted entries.

Optional complete browsing uses the separate `directoryPagingVersion: 1` capability and `WorkspaceFiles.listPages` stream. Unselected paging and older helpers retain bounded listing; no truncated array becomes a resumable page.

## Migration

1. Build and pin a separately named ABI8 helper with both `DSH_FD_TEXT_ABI` and `DSH_FD_CONTENT_ABI`, and deploy it with the matching worker and client. Keep explicit content limits and the original account drain procedure; never add the capability flag to an old binary or infer it in an adapter.
2. Confirm actual helper exports and worker ready messages contain `directoryListingVersion: 1`, then require the original `assertContentAvailable()` before admitting content-dependent recipes. Keep ABI6/7 assets and nonselected content paths unchanged.
3. Consumers requiring completeness keep `listDir` and handle its failure. Consumers supporting partial display can use `listDirectory` and must preserve `truncated`. Do not treat a sorted subset as the directory's globally first names or as a page cursor.
4. Run the normal Linux generation, build and owning regressions, including the existing built-worker content check's 0/63/64/65/129 cases. Confirm old helpers refuse preparation and a truncated result is never accepted by a complete-list consumer.
5. To enable paging, select positive `directoryPaging.idleTimeoutMs`, `totalTimeoutMs` and `maxPages`, deploy the matching helper/worker/client, and expose `workspaceFiles/listPages` as an account-session stream. Verify 65/128/129-entry browsing and last-item file actions, version restart, no-credit cleanup, and Host-confirmed close before preview/download. Keep the original Peer/Use checks; do not add the endpoint to HTTP file-read admission.
