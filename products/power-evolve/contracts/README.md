---
description: "Shared PowerEvolve wire records for browser clients and the trusted Platform."
kind: "package-library"
---
# PowerEvolve wire records

English | [中文](README.zh.md)

## Summary

This private library supplies account and file-download validation, response records, route names and branded identifiers. Both browser clients and the trusted Platform consume the same definitions. It imports no Platform services or Node APIs and registers no DSH plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Limits](#limits)
- [Dev Note](#dev-note)

## Use this package

Import account records from `@power-evolve/contracts/account`. Zod parsers reject invalid wire values; their inferred types describe validated values. The [account source](src/account.ts) owns the fields and routes. Consumers declare a workspace dependency and a TypeScript project reference to this package.

Import download requests and the same-origin URL builder from `@power-evolve/contracts/file-download`. The [download source](src/file-download.ts) defines canonical relative paths, metadata digests and protocol ceilings. Deployment limits and authorization remain with the Platform; see the [file slice](../S2-COMPLETION.md).

## Implementation

Only Zod and the upstream brand utility are runtime dependencies. TypeScript emits browser-compatible ESM and declarations together. The application re-exports these account definitions for its existing internal imports. The package has no process state, credential storage, authorization checks or independent lifecycle invariant.

## Limits

Parsing does not establish identity, ownership or permission. The trusted Platform must authenticate the credential and check the current account inside the resource transaction. A browser role or capability field only controls presentation. The [account slice](../S3-ACCOUNT-COMPLETION.md) defines the integration and acceptance requirements.

## Dev Note

Account and application consumers share the same `UserId` type. Changes to wire records require updating both the trusted page and Platform handlers in the same delivery.
