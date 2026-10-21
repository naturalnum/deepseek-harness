---
description: "Configure bounded native instruction snapshots through an account-prepared source adapter."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-account-instructions

English | [中文](README.zh.md)

## Summary

File instructions require an account-prepared adapter for trusted Agent/project validation and reserved, restricted source reads. Missing prerequisites produce a configuration error before any instruction file is read. Deployments without that adapter must keep the instruction row disabled. This package does not discover the host home, search above the project root or allocate sandboxes.

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

Account preparation constructs `new AccountInstructionSources(ctx, input)` from `/session` with the exact installed binding, shared active-Agent checks and the files owner's `withSources` operation. That operation reserves complete snapshot storage and supplies each source's independent restricted reader, actual native Workspace id and committed native cwd. The adapter captures cwd with native `WorkingDirectory.get(agent.session)` inside the original Agent/Workspace checks and source reservation; the Session header, project root and home cannot replace it. Construction creates no source authority. `/session` rejects activation with `cloud/invalid-config` when preparation is absent, stale or foreign. Keep the row disabled until the real adapter is connected, and exclude the native automatic instruction loader. The root exports configuration and instruction data types without mounting behavior.

<a id="minimal-configuration"></a>
### Minimal configuration

The prepared owner must exist before the Loader row activates. The [configuration schema](src/config.ts) requires all five limits below; every value must be a positive safe integer. These limits do not substitute for files-owned global/account admission, stream credit or physical storage isolation.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxFiles` | required | Maximum declared candidate directories, including directories without a file. |
| `maxFileBytes` | required | Maximum UTF-8 bytes accepted from one selected file. |
| `maxTotalBytes` | required | Maximum combined UTF-8 source text bytes retained by one load. |
| `maxSnapshotBytes` | required | Maximum UTF-8 JSON bytes of the complete native message, including metadata and repeated text. |
| `maxResidentBytes` | required | Conservative per-snapshot byte/text storage available during preparation and handoff. |

`maxResidentBytes` must cover `32 × maxSnapshotBytes + 4 × maxTotalBytes + 2 × maxFileBytes` before any source I/O. This plan includes sixteen full message equivalents at the UTF-16 upper bound, plus source chunk/concatenation and hash buffers. It covers labels, hashes, metadata, framing, native freezing, log/request handoff and serialization scratch; it does not measure JavaScript object overhead or whole-process RSS.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Session entry derives the complete project-root-to-current-cwd chain from the fixed project reader and captured native cwd. It rejects a parent, sibling or different source cwd. A shared incremental check bounds the whole chain’s count and encoded labels before resolving its remaining directory targets or looking up candidate files. The package-local loader accepts already-authorized directory targets and orders platform, account and project sources. Each directory carries its fixed restricted read-only reader; platform, account and project sources use their respective readers for candidate selection and content streams. Project labels must form the complete root-to-cwd chain; that check does not authorize their targets. For each directory, an existing AGENTS.md, including an empty file, suppresses CLAUDE.md. Only confirmed absence permits fallback through that directory's reader. Provider failures, special files, cancellation and excess bytes fail the complete operation without a partial result. No direct host filesystem access, home discovery, project creation, search above the project root or sandbox allocation occurs.

The snapshot builder measures the complete encoded envelope before joining the rendered text or cloning the final message. It hashes exactly the text retained in each source and stores the complete snapshot under the native producer attribution. `snapshot.totalBytes` counts the rendered model-visible text, including labels and framing; `maxSnapshotBytes` additionally covers all JSON metadata and repeated content.

The pre-step adapter calls the waterfall continuation and prepares one immutable native message per real Session turn. The preparation callback returns the message with a files-owned retained-reservation release operation, after its actual I/O has settled. The adapter releases that reservation when the exact message enters the native `user/message` log; a dropped decision retains it and can offer the same snapshot at a later step. Each entering step rechecks the owner's admission. Cancellation combines turn, account-generation and plugin lifetimes; `turn/end`, generation withdrawal and disposal release any unaccepted result. Disposal cancels preparation and waits for pending preparation to settle, releasing late results. Files still owns actual global reservations and I/O drain; these helpers do not introduce an authorization protocol or context queue.

| Source | Responsibility |
| --- | --- |
| [session.ts](src/session.ts) | Prepared source ownership, native cwd chain and Loader activation. |
| [directories.ts](src/directories.ts) | Incremental chain-label bounds and source ordering before candidate I/O. |
| [load.ts](src/load.ts) | Ordered candidate selection and bounded source-text reading. |
| [snapshot.ts](src/snapshot.ts) | Complete C-09 payload and native immutable message construction. |
| [budget.ts](src/budget.ts) | Encoded-envelope size and conservative copy accounting. |
| [injection.ts](src/injection.ts) | Native pre-step wiring and preparation lifetime. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These references explain the native lifecycle and context consumed by this package.

- [Architecture and extension points](../../../docs/architecture.md) — plugin ownership and the native turn flow.
- [Session subsystem](../../../docs/subsystems/session.md) — durable messages and their producers.
- [Working directories](../../../docs/subsystems/working-directory.md) — current directory and original project identity.

-----

<a id="model-experience"></a>
## Model Experience

### Instruction context

#### What the model sees

With the prepared owner installed, the native consumer appends one instructions-form context per turn, with platform/account/project origins preserved in metadata and headings. An empty source set uses `No optional instruction files are present.` after the same introduction, so the next turn explicitly supersedes earlier optional instructions. Its complete framing is:

##### Complete snapshot framing

```markdown
Complete instruction snapshot for the current turn. Earlier instruction snapshots are historical.

[<kind> "<relativeName>"]
<verbatim source text>
```

#### Token effect

An unprepared entry adds no tokens or model calls. The native consumer adds the complete bounded rendered text once per entered turn; tool continuations and request retries reuse the same snapshot.

#### KV Cache effect

The native consumer appends the current snapshot without rewriting older messages or the system prompt. A new turn appends updated instructions; provider cache availability remains outside this package. An unprepared entry changes no model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployment acceptance still requires the following integrations.

- **Deployment admission** — the component supports nested cwd only when the trusted adapter supplies the actual native current directory. Runtime admission and files project-directory preparation still restrict cwd to the project root; deployments must review those owning checks before opening nested Sessions. The current reader issuer supplies no independent platform source. AccountBinding and WorkspaceId data grant no source authority.
- **Shared budgets and I/O** — the per-snapshot text plan is conservative, is not an RSS measurement or process cap, and does not acquire root files global/account reservations. The real port must reserve the declared bytes, enforce finite stream credit and FD/version restrictions, and retain actual I/O through drain. Files worker buffers, physical quotas and other consumers remain outside this fixture's evidence.
- **Acceptance** — [the package-local native log fixture](tests/fixtures/recorded/session.v4.jsonl) checks encoded messages and native reconstruction with a bounded in-memory reader. The [Loader/native-Agent component tests](tests/loader-nested.spec.ts) check nested selection, unchanged snapshots across tool/cwd changes, next-turn reload and pre-read limits; [source-failure tests](tests/loader-priority.spec.ts) check actual model/log rejection and reservation release. These checks establish no Linux source authorization, physical quota, published-package or Web acceptance. Complete restore/child flows and V-24/V-26/V-28 deployment acceptance remain separate requirements.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
