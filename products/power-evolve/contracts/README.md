---
description: "Validate PowerEvolve account, file, Office and cloud execution requests across browser and Platform consumers."
kind: package-library
---
# PowerEvolve wire validation

English | [中文](README.zh.md)

## Summary

Callers can validate account, file-download, Office-preview and cloud execution messages with the same records on the browser and Platform. Branded identifiers distinguish resource identities, and Zod parsers reject invalid wire values. Import the exported subpath for the required operation. Validation supplies no authentication, ownership or execution permission; the trusted Platform must enforce those decisions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Browser clients, Host adapters, Platform handlers and connector workers import the subpaths declared in [package.json](package.json). Declare this private library as a workspace dependency. It registers no plugin and has no Profile installation or mount configuration.

Choose the record family for the operation; the linked source owns its fields and validation rules.

| Consumer operation | Entry point | Owning source |
|---|---|---|
| Account identity and authentication messages | `@power-evolve/contracts/account` | [Account records](src/account.ts) |
| Canonical single-file paths and download metadata | `@power-evolve/contracts/file-download` | [Download records](src/file-download.ts) |
| Owned storage and Workspace registration | `@power-evolve/contracts/storage` | [Storage records](src/storage.ts) |
| Workspace document conversion requests and results | `@power-evolve/contracts/office-preview` | [Office records](src/office-preview.ts) |
| Original Cloud execution inspection and reconciliation | `@power-evolve/contracts/execution-resolution` | [Resolution records](src/execution-resolution.ts) |
| MCP icons, notes and masked environment references | `@power-evolve/contracts/mcp-metadata` | [MCP metadata](src/mcp-metadata.ts) |
| Direct Platform environment upload metadata and bytes | `@power-evolve/contracts/stdio-environment` | [Environment records](src/stdio-environment.ts) |
| Bounded literal STDIO connection configuration | `@power-evolve/contracts/stdio-management` | [Management records](src/stdio-management.ts) |
| Frozen STDIO catalogs, tasks and first-start permits | `@power-evolve/contracts/stdio-mcp` | [Task records](src/stdio-mcp.ts) |
| Worker leases, SDK replies and cleanup observations | `@power-evolve/contracts/stdio-runtime` | [Runtime records](src/stdio-runtime.ts) |
| Deterministic bounded JSON encoding | `@power-evolve/contracts/stdio-mcp-json` | [JSON codec](src/stdio-mcp-json.ts) |

Host-cookie product clients can import `productRpcRequestInit` from the account entry; callers retain routing, error handling and response validation.

An execution-resolution request identifies the original Cloud execution, stable request ID and Platform-calculated writer fingerprint. It supplies no replacement command or stop evidence. A completed receipt needs confirmed stopped writers; `closed_unknown` preserves an unknown side-effect outcome. Office tasks bind the source and converter generation; their result markers do not establish parser termination.

STDIO task, selection and dispatch parsers require deployment-selected SDK and JSON budgets. Complete raw catalogs retain their original fields in PG `json`. Parsing a permit, worker lease or cleanup observation neither authenticates its issuer nor grants a program start. Platform consumers must verify the original dispatch, current lease and exact executor identity before accepting results.

The JSON codec requires positive safe-integer depth, node and UTF-8 byte budgets. It preserves literal strings and array order, sorts object keys by code-unit order and counts repeated acyclic references on each occurrence. It rejects cycles, accessors and non-JSON values without invoking getters or `toJSON`. Invalid data or configuration throws TypeError; exceeded budgets throw RangeError without partial output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Validation and consumer responsibilities</summary>

Zod and the upstream brand utility are the runtime dependencies. Source modules contain shared parsers and records without Platform service imports or credential storage. Their inferred types describe validated values; consumers still own resource transactions, authorization and durable operation state. Image matching helpers accept already parsed Cloud/Linux records and compare architecture, immutable image reference and exact runtime image IDs. Raw wire values first pass the strict schema.

The [build configuration](tsdown.config.ts) emits ESM and also declares standalone browser modules for execution resolution and Office preview. Trusted approval and isolated parser consumers require those prepared artifacts. Source-level validation does not establish that a deployed bundle or image contains the current records.

Node Application and Connector consumers declare matching Contracts peers; their installation root supplies the production provider. Admission compares every ESM subpath, schema reference and Zod entry, including nested helpers. The source manifest keeps Zod as a production dependency, so a private nested Zod copy must be rejected separately. Factories still create distinct schemas and can retain caller-owned mutable budgets. Standalone browser bundles have separate instances; Node peer routing does not unify them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud application](../application/README.md) — authorization and native Session adapters.
- [Connector worker](../connector-runner/README.md) — controlled external execution.
- [Confirmed migration scope](../CLOUD-MIGRATION-PLAN.md) — included capabilities and exclusions.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers that validate model inputs or tool results. This library supplies no prompt text, tools or Session events of its own; consumers own logging and model presentation.

The `model-settings` entry carries native adapter namespace mutations, public discovery metadata and one-use direct credential intake tickets. API key bytes are uploaded from the browser directly to Platform; the Host receives only references, presence facts and original write receipts. A discovery receipt can contain `models` with `saved: false`, because a one-shot draft key is never persisted.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Consumers must respect these validation limits:

- Parsing does not establish identity, ownership, permission or stopped-writer evidence.
- A browser role or capability field controls presentation; the trusted Platform rechecks authorization inside the resource transaction.
- Records do not enable generic STDIO execution or document conversion without their configured services and current acceptance evidence.
- Device, manual artifact publication and binding-recovery APIs are outside this cloud migration's scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Update wire-record consumers together. Keep executed commands and current acceptance results in migration evidence; this reference describes the library's consumer obligations.

</details>
