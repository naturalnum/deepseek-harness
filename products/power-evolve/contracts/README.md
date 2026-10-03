---
description: "Shared PowerEvolve wire records for browser clients and the trusted Platform."
kind: "package-library"
---
# PowerEvolve wire records

English | [中文](README.zh.md)

## Summary

This private library supplies account, file-download and execution-reconciliation validation, response records, route names and branded identifiers. Both browser clients and the trusted Platform consume the same definitions. It imports no Platform services or Node APIs and registers no DSH plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Limits](#limits)
- [Dev Note](#dev-note)

## Use this package

Import account records from `@power-evolve/contracts/account`. Zod parsers reject invalid wire values; their inferred types describe validated values. The [account source](src/account.ts) owns the fields and routes. Consumers declare a workspace dependency and a TypeScript project reference to this package.

Import download requests and the same-origin URL builder from `@power-evolve/contracts/file-download`. The [download source](src/file-download.ts) defines canonical relative paths, metadata digests and protocol ceilings. Deployment limits and authorization remain with the Platform; see the [file slice](../S2-COMPLETION.md).

Import Runner observations, verified execution file records and conditional publication requests from `@power-evolve/contracts/execution-files`. The Platform rereads candidates through the authorized Workspace before persisting their size and SHA-256. Records identify versions observed after execution; they do not prove that a command was the only writer. Missing or incomplete scans remain explicit. Publication with an expected digest rejects changed source bytes.

Import private storage selection and Workspace binding recovery records from `@power-evolve/contracts/workspace-binding`. A target identifies an owned storage space and a canonical relative directory, never a physical root. Recovery carries a stable request ID and expected binding generation; only a completed receipt advances it by one. Parsing supplies no storage ownership or stopped-writer evidence.

Import Cloud execution reconciliation requests and receipts from `@power-evolve/contracts/execution-resolution`. A request identifies the original execution, a stable retry ID and a Platform-calculated writer fingerprint. It supplies no result, replacement command or stop evidence. Read-only Host routes and independent approval routes remain separate. A completed receipt requires a confirmed stopped writer; `closed_unknown` retains an unknown side-effect outcome.

## Implementation

Only Zod and the upstream brand utility are runtime dependencies. TypeScript emits browser-compatible ESM and declarations together. The application re-exports these account definitions for its existing internal imports. The package has no process state, credential storage, authorization checks or independent lifecycle invariant.

## Limits

Parsing does not establish identity, ownership or permission. The trusted Platform must authenticate the credential and check the current account inside the resource transaction. A browser role or capability field only controls presentation. The [account slice](../S3-ACCOUNT-COMPLETION.md) defines the integration and acceptance requirements.

## Dev Note

Account and application consumers share the same `UserId` type. Changes to wire records require updating both the trusted page and Platform handlers in the same delivery.
