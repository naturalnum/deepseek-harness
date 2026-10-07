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

Import current browser membership from `@power-evolve/contracts/desktop-browser-scope`. A request selects only a native Session; the response identifies its currently authenticated owner and immutable Workspace. It carries no credential, path or lasting grant. The trusted Platform must verify the Agent credential and membership together; the main process must reject an observation after its document or account changes and retire the old guests before another account can acquire a partition.

Import download requests and the same-origin URL builder from `@power-evolve/contracts/file-download`. The [download source](src/file-download.ts) defines canonical relative paths, metadata digests and protocol ceilings. Deployment limits and authorization remain with the Platform; see the [file slice](../S2-COMPLETION.md).

Import Office preview requests, task views and isolated parser records from `@power-evolve/contracts/office-preview`. These records bind stable request keys, source digests and converter generations; they accept no user identity, physical root, command or image selection. Explicit parser budgets remain below fixed source/PDF protocol ceilings. A result marker is not Pod termination evidence; consumers must independently verify byte digests, current authorization and exact parser termination before releasing capacity.

Import canonical native artifact paths from `@power-evolve/contracts/artifact-document`. Paths identify one publication and its literal filename, never its mutable Workspace source. The Office source-admission parser accepts either the original Workspace request or an artifact request fixing that publication, filename and SHA-256; mixed sources are rejected. Platform consumers must check the original Session, owner, metadata and verified bytes. Path parsing does not authorize publication access or permit relative resource resolution.

Import Runner observations, verified execution file records and conditional publication requests from `@power-evolve/contracts/execution-files`. The Platform rereads candidates through the authorized Workspace before persisting their size and SHA-256. Records identify versions observed after execution; they do not prove that a command was the only writer. Missing or incomplete scans remain explicit. Publication with an expected digest rejects changed source bytes.

Import private storage selection and Workspace binding recovery records from `@power-evolve/contracts/workspace-binding`. A target identifies an owned storage space and a canonical relative directory, never a physical root. Recovery carries a stable request ID and expected binding generation; only a completed receipt advances it by one. Parsing supplies no storage ownership or stopped-writer evidence.

Import Cloud and Device execution reconciliation requests and receipts from `@power-evolve/contracts/execution-resolution`. A request selects its provider and identifies the original execution, a stable retry ID and a Platform-calculated writer fingerprint. Inspection and status requests without a target retain the original Cloud routing; explicit targets never fall back to another store. Requests supply no result, replacement command or stop evidence. Read-only Host routes and independent approval routes remain separate. A completed receipt requires a confirmed stopped writer; `closed_unknown` retains an unknown side-effect outcome. Device closure requires complete, matching stop records already persisted by the Platform.

Import Device dispatch, container registration and stop reports from `@power-evolve/contracts/device-execution`. Enrollment identifies a persistent Device; each claim binds a separate process generation and Platform-issued dispatch. Start permission is issued once after exact container registration. Stop reports carry the original dispatch, a stable retry ID and a non-running observation; unknown command effects remain distinct from stopped writers. These records do not attest the local OS or Docker daemon.

Import private parent/Device lifecycle records from `@power-evolve/contracts/device-lifecycle`. Requests correlate one owned launch, expected service instance and stable request ID. Readiness requires successful Profile boot and parent verification of its actual child PID and fixed loopback URL. A quiescent snapshot describes stopped local asynchronous work; residual entries separately carry persisted exact-container stop observations, permanent no-start receipts or unconfirmed facts. These IPC records carry no local paths, nonce, credentials or commands and authorize no resource operation. They are not a browser API.

Device dispatch records accept optional immutable skill references in `materials`. Absent references preserve the original JSON representation and request digest; supplied references bind the accepted skill, version, archive, manifest and instructions. Package reads identify the original execution, enrollment, process and dispatch, and accept no user ID, storage path or download URL. One response contains the original manifest and at most 256 regular files expanding to 8 MiB; the JSON response has a 20 MiB wire ceiling. Consumers must verify every decoded byte digest before execution; parsing is not authorization. Earlier workers do not support these references and cannot consume such a dispatch.

Optional `reportSuite` describes four fixed sibling roles from the same immutable `materials` selection. The dispatch, job and claim reject missing member references; consumers also verify the digest against every role and complete package binding. The descriptor grants neither installation nor execution authority. Omitting it preserves earlier JSON and request digests; workers without this field cannot consume a report dispatch.

Import the browser-safe [STDIO v2 JSON codec](src/stdio-mcp-json.ts) from `@power-evolve/contracts/stdio-mcp-json`. All depth, value-node and UTF-8 byte limits are required positive safe integers. Root depth is zero; repeated acyclic references count on every occurrence. The codec emits object keys in code-unit lexical order, including numeric keys, preserves array order and strings without normalization, and retains escaped NUL and literal `__proto__`/`constructor` data. It rejects non-JSON values, cycles, nonplain objects, accessors, symbols, nonenumerable object fields and sparse/extended arrays without invoking getters or `toJSON`. Invalid data/configuration throws TypeError; exceeded budgets throw RangeError without returning partial JSON. Hashing, domain selection and authorization belong to its consumers.

Import generic STDIO requests and frozen tasks from `@power-evolve/contracts/stdio-mcp`. Discovery selects an explicit Session and target and has no Agent operation; calls retain the accepted complete raw catalog, descriptor and arguments. Task, selection and dispatch parsers require deployment-selected SDK/JSON budgets; complete raw fields require PG `json`, not `jsonb`. Prepared records retain exact executor image kinds, original resource identities and writable Workspace/Home observations. A catalog's image must match the trusted deployment pin before a call; a parsed first-epoch permit binds one action, execution, process/instance, task/prepared digests and expiry. Parsing does not issue or consume the first start response, authenticate an executor or establish stopped descendants. The Platform must durably enforce those decisions. These exported records do not enable generic STDIO execution in a product Profile.

## Implementation

Only Zod and the upstream brand utility are runtime dependencies. TypeScript emits browser-compatible ESM and declarations together. The package build also produces standalone ESM in `lib/browser/execution-resolution.js` and `lib/browser/office-preview.js`. The trusted approval page imports the first through the Platform allowlist; the isolated parser consumes the second as a fixed physical resource. Consumers require the package build; these modules have no external runtime imports. The application re-exports these account definitions for its existing internal imports. The package has no process state, credential storage, authorization checks or independent lifecycle invariant.

## Limits

Parsing does not establish identity, ownership or permission. The trusted Platform must authenticate the credential and check the current account inside the resource transaction. A browser role or capability field only controls presentation. The [account slice](../S3-ACCOUNT-COMPLETION.md) defines the integration and acceptance requirements.

## Dev Note

Account and application consumers share the same `UserId` type. Changes to wire records require updating both the trusted page and Platform handlers in the same delivery.
