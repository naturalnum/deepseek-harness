# Account-native Cloud integration

English | [中文](CLOUD.zh.md)

This remains the independent `deepscientist-harness-suite` package with research, Airalogy and workbench plugins. The Cloud adapter adds account-native integration; the original local profile and HTTP service remain separately available. Cloud mode starts no local research HTTP server, uses no global research token, and creates no additional login, Session, Agent or execution controller.

## Responsibilities

| Existing Cloud owners | Research package |
| --- | --- |
| Original authenticated Peer/AccountUse, native Session and approved Workspace/Preset | Research protocols, records, tasks, evidence, routes, reports and immutable execution-package fingerprints |
| Native userQuestions and exact-version human decisions | Existing scientific algorithms, question details and post-answer fingerprint/revision checks |
| Verified preallocated account storage, native FS, project mounts and quotas | One SQLite Store under the files-issued fixed `private/research-suite` directory, with native Session IDs |
| Original managed execution, confinement, command budgets and actual drain | Injectable engine/workflow, OCR and Git transports; existing workbench UI and account-scoped dynamic lab skills |
| Existing sidebar slots and account-bound Connection RPC | Immutable `/research/` assets and a scoped iframe message bridge; no secondary data HTTP transport |

The adapter requires the Host capability-inventory, Session/project, original-Peer and collected-output-release interfaces recorded in the repository's Cloud native patches. Optional Host peer dependencies must resolve to the exact active Host's package instances. Installing a second Harness does not satisfy this requirement.

## Profile composition

Mount `deepscientist-harness-suite/cloud-assets` in the shared Web root with explicit `requestTimeoutMs: 180000`. It serves immutable assets only and injects public addresses; `/research/api` and `/research/auth` do not exist in this mode. Account data always uses the authenticated native `cloudResearch/action` Remote with its actual Session resource.

Use [cordis.cloud.patch.yml](cordis.cloud.patch.yml) for the account graph. Register its complete `research-suite` declaration in Root's approved Preset catalog and make it selectable. Preserve the existing Standard declaration. The Cloud recipe also retains the original workbench and research/Airalogy plugin entries. This feature has no dependency on the separate MCP-management feature.

The sample configuration specifies a 256 MiB SQLite page allowance, 8 MiB request/reply/input-result allowances, two pending workbench requests, 180-second observer/tool budgets, 32 KiB collected command output, and explicit Python/Git executable paths. Native FS read/write and native RPC budgets must separately cover the selected 8 MiB payload/result files. The result file is integrity checked; only its bounded receipt travels through collected stdout. No configuration value alone establishes engine or OCR readiness.

Resource preparation has separate finite concurrency, provider-count, file-count, total-byte, per-file and relative-path limits. The sample selects one concurrent preparation, 64 providers, 1024 files, 32 MiB total, 4 MiB per file and 256-byte relative paths. Bundled previews create no execution. Actual resource copying requires the original native `skill` invocation, original Agent/Workspace admission and the existing managed subprocess. Copies use current-project execution-world addresses, reject symlinks and escapes, preserve user edits, and return a complete source/copy manifest only after all batches succeed. Binary resources retain their bytes. Dynamic lab skills remain opaque, include reviewed evidence, and invalidate only this account's native registry immediately after publication, editing or withdrawal.

Root must explicitly append the following names through `commands.additionalTools` and append the same names in the same order to `allowedTools`, after its existing built-in names. The list does not grant execution outside actual native tool dispatch.

```json
["skill", "research_workbench_execute", "research_engine_status", "research_engine_run", "research_document_status", "research_document_extract", "research_record_update", "research_record_bind_engine", "research_record_submit", "research_task_open", "research_task_import_csv", "research_roadmap_put", "research_project_git_bind", "research_project_git_state", "research_project_git_commit", "research_project_git_working", "research_project_git_checkpoint", "research_project_git_branch", "research_project_git_merge", "research_project_git_revert", "research_project_git_policy"]
```

## Workbench execution behavior

Readonly metadata uses the existing native Remote. A workbench write, computation, CSV import, automatic record recalculation, OCR extraction or Git action submits a bounded, one-time request tied to the original authenticated Peer, account generation and Session. The native conversation records the operation, request ID and parameter hash. Its Agent calls `research_workbench_execute` with that ID; the tool reads the exact saved parameters and runs through the original native execution owner. The UI waits for the actual domain result, and existing execution-history reads expose progress. This adds a visible chat execution intent to button actions. It does not merely fill an input draft.

The request cannot execute after expiry, logout, scope disposal or withdrawal. A missing model/tool response, cancellation or restart reports an unconfirmed operation; pending IDs are not automatically replayed after restart. Refresh the existing records/execution history before retrying with the original domain idempotency key. Actual command cleanup and output reservations remain owned until range and I/O settlement. Source engine terminal observations may be saved during owned cancellation cleanup; revoked requests cannot commit later human record changes.

Direct model-proposed approvals retain the original `userQuestions` flow and exact before/after version checks. A model cannot supply a human token or approve a different version. Published lab skills remain visible across conversations only within their own account. Git association is restricted to the original native Session project; managed research branches live under that project, never under a host-selected directory.

## Scientific image

[Dockerfile.cloud](Dockerfile.cloud) derives from the exact pinned Office workload image. It extends the original runtime venv, constrains all inherited distributions, preserves the Office runtime manifest hash and readonly runtime layout, and writes a separate `research.json` with actual package/model hashes. It does not change Root's workload or SDK-server image allowlists.

The retained executors require Python 3.13 and `airalogy==0.16.0`. The Airalogy release requires Python >=3.13 and pins its own parser/validation dependencies. Native PDF/OCR uses PyMuPDF 1.26.7, RapidOCR 3.10.0, ONNX Runtime 1.31.1 and the inherited NumPy/Pillow packages. RapidOCR's pinned wheel includes the three required offline ONNX models; image qualification loads those actual models. [Airalogy release](https://pypi.org/project/airalogy/0.16.0/), [RapidOCR release](https://pypi.org/project/rapidocr/3.10.0/), [ONNX Runtime release](https://pypi.org/project/onnxruntime/1.31.1/), [PyMuPDF release](https://pypi.org/project/pymupdf/1.26.7/).

Build in an independent backend using this package as the Docker context. The resulting immutable digest requires the original RootDeployment and exact SDK-server/image-policy qualification before deployment. Check actual managed Python version/imports, protocol parsing, variable assignment/validation, workflow transitions, CSV auto-recalculation, generated files and Chinese/English scanned-document OCR. Ordinary readonly runtime mounts cannot install packages during a user command. Missing dependencies keep the corresponding status unavailable and the actual operation fails visibly. The bundled skill catalog does not imply that every third-party scientific service, executable or credential is installed.

## Development and updates

Finish dependency installation in this package's own real `node_modules` before creating Host peer links. From this monorepo, run `npm ci --omit=peer`, then `node scripts/link-cloud-peers.mjs`. Do not run installation commands while those links exist. Build the Host artifacts, build this package with `node scripts/build.mjs`, and typecheck `tsconfig.cloud.json`. From the repository root, run `node node_modules/vitest/vitest.mjs run --config integrations/epri-research/vitest.cloud.config.ts`. The ordinary package tests continue to cover local-mode compatibility.

[cloud-integration.json](source-records/cloud-integration.json) records the imported branch/base and the exact retained scientific files. The accompanying patch changes only executor/fetch transport selection in reused source; original upstream trees and licenses remain preserved. To upgrade, fetch the source branch, review and apply only `git diff --binary OLD NEW -- integrations/epri-research` on a dedicated feature branch, reconcile the documented injection points, update the source record, and rerun independent-package plus Cloud composition tests. Qualify a new immutable image if Python dependencies change. Do not merge unrelated source-root gates over Cloud changes or delete Cloud admission to resolve a conflict.

Component tests cover real Loader/Gateway/native Session composition, one-time workbench requests and a recorded keyless chat/tool transcript, scripted managed computation ownership, account-isolated actual resource copies and edit preservation, and dynamic skill isolation/invalidation. They do not certify a live Linux backend. Final acceptance additionally requires a real authenticated browser button → native chat intent → managed Airalogy computation → original UI result, precise human approval, account A/B isolation, restart/disable/drain behavior and the complete workflow/OCR checks above.
