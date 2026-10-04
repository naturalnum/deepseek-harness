# PowerEvolve execution client

English | [中文](README.zh.md)

This browser plugin extends the native DSH composer with per-submission Cloud or authorized Device selection. Device and directory metadata comes from owner-scoped Host reads. The trusted Platform authorizes the selected target when it durably accepts the prompt; selection alone does not start an execution environment.

## Execution reconciliation

The existing picker opens a read-only view of the current Session's Cloud and Device executions and resolution receipts. It displays the execution target and original commands as text and links the independently authenticated Platform approval page. The Host exposes only list, inspect and status RPCs; the client holds no approval bearer and cannot confirm cleanup.

Requests and responses use [shared validation](../contracts/src/execution-resolution.ts). Inspection, trusted links and stored retry requests retain the target; identical execution IDs in different providers cannot share an attempt or receipt. Closing or changing Sessions aborts reads and rejects late responses. Device closure requires existing verified stop facts and preserves an unknown outcome; the client cannot supply stop evidence. A completed `closed_unknown` receipt means the writer has stopped but the command's side effects remain unknown. It does not report success or authorize command replay. SSH reconciliation is not provided by this view.

## Model experience

Target selection contributes the exact submission hint consumed by the native prompt flow. The read-only reconciliation view adds no model messages. The trusted Platform owns durable acceptance, cleanup and the original Session's unique continuation; see the [execution-resolution implementation plan](../EXECUTION-RESOLUTION-COMPLETION.md).
