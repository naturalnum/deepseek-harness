# S8 built-in Skills native browser acceptance

Date: 2026-09-30. Base commit: `e452a21d24`; the first trial's Host and Platform were subsequently updated with the focused continuation fix cherry-picked as `d796102f11` from `5f24f311e9`. The second trial later received the Office guide runtime fix cherry-picked as `bf4a93614a` from `0e2f62b05b`. This is a real DeepSeek and k3s Runner trial, not a model or execution fixture. The fixed Runner image is `pe-s8-skills-runner:qa` (`sha256:2e4e19443013095d5d978aea883c40e59bff3c27240840d7e0350d45018c307d`).

## Isolated trials

| Trial | PostgreSQL | Host | Platform | Kubernetes namespace | Purpose |
| --- | ---: | ---: | ---: | --- | --- |
| `s8-skills-qa` | 18552 | 19540 | 19541 | `pe-s8-skills-qa` | Two-user Skills UI, persistence, model discovery, and preserved long-output failure |
| `s8-office-qa` | 18553 | 19550 | 19551 | `pe-s8-office-qa` | Fresh-state Office and PDF file execution |

Each trial has its own private profile, database volume, POSIX workspace root, and namespace-scoped Kubernetes credential. Neither uses the frozen S7 c3 namespace or ports. Both initially used source and compiled artifacts from the clean base commit; focused fixes were compiled and applied only to the named trial processes above. This QA checkout owns its new scripts and this report. Local sanitized JSON/PNG evidence is under `.artifacts/power-evolve/<trial>/evidence/` and `evidence-qa3/` in this checkout. Credential files are outside the repository and are absent from evidence.

## Current acceptance summary at `ba1307f14d`

The current catalog has nine packages. Both users' built-in instructions and owner boundaries were checked; five changed packages were explicitly upgraded through native browser API, and `tech-report-writer` was upgraded again to `1.1.33`. Actual DeepSeek, Office tool, k3s Runner, PG, trusted continuation, and native browser evidence covers representative actions below. The earlier base-version matrix remains below as a historical record; its pending statements do not override these later results.

| Built-in package | Current version | Real evidence | Remaining boundary |
| --- | --- | --- | --- |
| Word | `1.0.1` | Explicit upgrade; direct Office DOCX create/add/validate and Writer PDF visually checked under the earlier runtime fix; full upstream guide plus stateless prefix read in Session | Full authoring and native slash-to-Office on `1.0.1` not repeated; OfficeCLI screenshot path unavailable |
| Excel | `1.0.1` | New qa3 Session used Office create/set/formula/validate; Calc PDF showed `21 42` | No broad spreadsheet feature matrix or native slash-to-Office test |
| PowerPoint | `1.0.1` | New qa3 Session used Office create/add/validate; Impress PDF showed slide title and body | No presentation design matrix or native slash-to-Office test |
| PDF | `1.0.0` | Native `/pdf`, real cloud execution, PDF text and PNG readback | One-page smoke only |
| LaTeX report writer | `1.0.1` | Native slash, packaged sample, two-pass XeLaTeX, validator, ten-page PDF and PNGs | Linux font fallback warning; no supplied real report or exact template fidelity |
| Power-grid report generator | `1.1.31` | Native instruction read; orchestrator's real Runner quality gate executed this package's `validate_outline.py`, 0 errors and 6 warnings | No full chapter generation or evidence-grounded report |
| Report reviewer | `1.1.0` | Native slash produced structured blocked `review_outline` for incomplete evidence, with must-fix fields | No pass/revise/approval loop |
| Report orchestrator | `1.1.21` | Native slash, registry resource, suite mount, state init, intake confirmation, next generator request, quality and consistency gates | No complete multi-stage project workflow |
| Word report formatter | `1.1.33` | `1.1.32` Session generated/validated/rendered a six-page DOCX/PDF sample; new `1.1.33` Session passed the formerly failing consistency gate | DOCX generation has not been repeated on `1.1.33`; no sourced final report |

The older backup/restore trial separately demonstrated disabled Word persistence and revoked PDF read refusal for its then-current versions; see [that report](TRIAL-S8-BACKUP-RESTORE.md). This QA did not rerun those lifecycle cases on every upgraded version. Exact Word/LaTeX template fidelity and a complete sourced report workflow remain open.

## Verified

- Alice and Bob logged in through the trusted Platform page and separate native browser contexts. Each received nine enabled, ready package Skills. Native My/All cards, search, Word detail preview, Alice Word disable/enable, one Alice-only text Skill revoke, and persistence across a Host/Platform restart passed. Bob remained enabled during Alice's toggle. Cross-user `skillsRead` returned 404.
- All nine package instruction bodies were read through each owner's native cookie. Their SHA-256 matched the listed digest, the same package bytes appeared under distinct owner-specific Skill IDs, and all 18 opposite-owner read attempts returned 404. The My/All previews and read-only metadata operations created zero Sandbox Pods.
- Real DeepSeek operations completed for Alice and Bob `hi`, Alice `/word-documents`, and Alice `skill_resource` listing for `word-documents`. Durable events confirm `hi` used no tools, slash invocation injected `word-documents`, and `skill_resource` was actually called. Sandbox rows remained 0 before and after these four operations.
- Bob's real DeepSeek Session called `skill_resource` for `report-workflow-orchestrator/skill-registry.json`. The returned 5,297-byte package text matched its SHA-256, named the generator, reviewer, and formatter children, and created no Sandbox row. This verifies packaged reference access, not the report scripts.
- In fresh `s8-office-qa`, native browser prompts caused real Office tool calls in k3s. Bob's saved XLSX has `A1=21` and `B1` formula `A1*2` with cached value `42`; create, set, formula, validate, and trusted continuations completed. Alice's saved DOCX has a `Heading1` paragraph `S8 Word`; create, add, validate, and continuation completed. Alice's PPTX has one slide with `S8 PPT` and `Real office tool`; create, add, validate, and continuation completed. Each ZIP's OOXML was read back from the actual POSIX Workspace.
- Alice `/pdf` injected the built-in PDF Skill and used `cloud_exec` in a real k3s Pod to create `s8-pdf.pdf`. The cloud execution and trusted continuation completed. `pdfinfo`, `pdftotext`, and PNG rendering confirmed a readable one-page PDF containing `S8 PDF`.
- Alice's real `cloud_exec` ran LibreOffice Writer inside the same k3s Sandbox to convert `s8-word.docx` to a 7,140-byte PDF. The one-page PDF passed `pdfinfo` and `pdftotext`; rendered PNG inspection showed the `S8 Word` heading without clipping.
- After the Office guide runtime fix, Alice's new native Session called `office load_skill word`. Its Runner stdout was 42,760 characters, starting with the fixed PowerEvolve stateless runtime instructions. The remaining 42,222 characters matched the original upstream guide from the first trial verbatim. Trusted continuation completed. The same Session then used the direct `create /workspace/s8-guide-word.docx --locale en-US` Office command and produced a 5,135-byte file with a completed continuation.

These are small integration probes. They do not establish production-quality Word layout, spreadsheet breadth, presentation design, or full report generation.

## Per-package compatibility at the base commit

| Catalog ID | Native name | Catalog, owner read, digest and isolation | Real functional evidence | Current verdict |
| --- | --- | --- | --- | --- |
| `builtin.word` | `/word-documents` | Passed | Slash invocation; direct Office DOCX create/add/validate, XML readback, LibreOffice PDF visual check | Small-task pass after continuation fix; wider layout untested |
| `builtin.excel` | `/excel-spreadsheets` | Passed | Direct Office XLSX create/set/formula/validate and XML readback | Partial: native slash-to-Office and visual rendering await next Runner |
| `builtin.powerpoint` | `/powerpoint-presentations` | Passed | Direct Office PPTX create/add/validate and XML readback | Partial: native slash-to-Office and visual rendering await next Runner |
| `builtin.pdf` | `/pdf` | Passed | Native slash, `cloud_exec`, PDF render and text readback | Small-task pass |
| `builtin.latex-report-writer` | `/latex-report-writer` | Passed | Instruction read only; legacy Markdown conversion is reported to hardcode three headings | Full workflow pending corrected package |
| `builtin.power-grid-technical-report-writer` | `/power-grid-technical-report-writer` | Passed | Instruction read only | Full workflow pending corrected package |
| `builtin.report-reviewer` | `/report-reviewer` | Passed | Instruction read only | Full workflow pending corrected package |
| `builtin.report-workflow-orchestrator` | `/report-workflow-orchestrator` | Passed | Instruction and `skill-registry.json` resource read, digest verified without Sandbox | Full workflow pending corrected package |
| `builtin.tech-report-writer` | `/tech-report-writer` | Passed | Instruction read only; legacy cover code is reported to fail for a valid project source and the old QA misses a blank main TOC | Full workflow pending corrected package |

The five report-package statements above are pending independent E2E retest against the next explicit catalog version. They are not acceptance claims for their current executable workflows.

## Published catalog and qa3 follow-up on `b7157ed7a2`

The isolated QA checkout merged the published `59b736bafe` mainline at `b7157ed7a2`. The catalog SHA-256 is `a83063fea6ca0b35aab0bf28c3aaee8d8e36e29d927ecdf684dfb42a8ffa97df`. The qa3 Runner tag `pe-s8-skills-runner:qa3` resolves to image ID `sha256:ceaf2b51bc789a2284b532bfa9b4a887ec4e55a4c4cf1637319b574a5b7ccf71`. It was imported only into the isolated k3d probe cluster. The second trial's Platform profile was regenerated and restarted with that image; Kubernetes Pod status reported the same full image ID for the actual executions.

Alice and Bob separately used trusted Platform login and native `skillsInstallBuiltin` to explicitly upgrade Word, Excel, PowerPoint, and LaTeX to `1.0.1`, and `tech-report-writer` to `1.1.32`. All ten installs returned success. Each user's Skill ID stayed stable; previous version receipts and immutable package files remained readable. New instruction bodies passed SHA-256. Alice's disabled PowerPoint state stayed disabled across its upgrade; it was then re-enabled through the native API.

With newly claimed qa3 Pods, Bob's native Office Session created an XLSX, set `A1=21` and `B1=A1*2`, and validated it. `cloud_exec` then converted it using LibreOffice Calc to a one-page PDF. `pdftotext` and PNG inspection both showed `21 42`. Alice's native Office Session created a one-slide PPTX with `S8 PPT` and `Real office tool`, validated it, and `cloud_exec` converted it using LibreOffice Impress to a one-page PDF; extracted text and the rendered page contained both strings. Both chains had one real execution and completed trusted continuation per command. This resolves the original Runner's Calc/Impress rendering gap for these small files. OfficeCLI `view ... screenshot` remains a separate unproven path.

Bob invoked `/report-workflow-orchestrator` in a real DeepSeek Session. The native event supplied the authorized four-package suite path under `/opt/power-evolve/skills/report-suites/7d84dcd7f7362b5e284a58b2dbb9292794e521b810fe261217461bac8188718a`. In that same Session, actual `cloud_exec` calls in qa3 initialized the workflow state, returned `project_intake`, passed the example outline quality gate, confirmed the formatter environment, generated a sample DOCX through `tech-report-writer/scripts/main.py create-report`, passed `validate-report`, and rendered a six-page PDF with six PNGs. The rendered catalog had three visible entries with correct Roman and Arabic page numbers and no missing entries. The cover, approval, Chinese and English abstracts, catalog, and body were visually inspected. A synthetic four-answer intake then advanced the state to `build_project_profile` through `workflow_cli.py` in the same Session. This is a workflow entry and output smoke, not a full project report with sourced chapters and formal reviewer approval.

A new `/report-reviewer` Session returned the required structured `review_outline` response for an intentionally incomplete outline: `status=blocked`, `decision=blocked`, the submitted artifact ID and version, required missing inputs, and specific `must_fix` items. It did not invent project evidence or pass the outline. A `/latex-report-writer` Session loaded the upgraded package and, through qa3 `cloud_exec`, copied its sample source to the Workspace, compiled twice with XeLaTeX, validated a ten-page A4 PDF, and rendered ten PNGs. Cover, catalog, body, and references pages were inspected. The validator exited zero after sample placeholders were replaced or removed. It warned that the actual embedded fonts were Noto CJKjp and TeXGyreTermes fallbacks, so exact Songti/Heiti/Times visual fidelity is **not** accepted in this Linux image. The sample reference entry is synthetic and is not a sourced final report.

The real suite rule-consistency gate **failed** on this published combination. `validate_rule_consistency.py` requires the literal phrase `Microsoft Word` in `tech-report-writer/scripts/word_field_refresh.py`; version `1.1.32` has functioning Word COM branches and `TablesOfContents`/`Fields.Update`, but its module docstring says `Word COM`. The actual Runner returned `tech-report-writer/word_field_refresh.py: 缺少Word自动更新能力 Microsoft Word`, exit 1. Mainline subsequently published a corrected `1.1.33`; this QA did not waive the gate. An exploratory attempt to run the entire formatter compatibility unittest as one `cloud_exec` hit the 60-second execution limit after three tests passed, so its fourth result is unverified; focused create/validate/render calls above all completed. A long base64 fixture command was copied incorrectly by the model, and an initial synthetic intake file had host-only `0600` permissions; both were corrected for subsequent short probes without changing PG rows.

### Repaired catalog and V21 replay on `124113e277`

Before V21, the `s8-office-qa` schema-20 trial was backed up to `/Users/jingchao/.config/power-evolve/backups/s8-office-qa-pre-v21-20260930`. The backup tool completed a 3,272 ms writer freeze and published a format-2 bundle containing a 544 KiB PG custom dump and 849 inventory entries; every listed file size and SHA-256 was independently checked. The tool's subsequent automatic restart failed because that invocation omitted this trial's existing external Docker network. All API processes were stopped. Starting with its original `pe-shared-host-slice5_default` network succeeded. No restore was needed.

The QA branch then merged fixed mainline `52f52cff13` at `124113e277`, compiled the application, and verified PG schema `21`. The new catalog SHA-256 is `2a8ffa998a876b298822e5281e3ea736d9344d21ae2ef8f5e05750ca80f706e6`. Alice and Bob each explicitly upgraded `tech-report-writer` to `1.1.33` through the native browser API; both retained their Skill ID and the `1.1.32` receipt. Bob's earlier accepted report operation still records `1.1.32`. A newly created Session selected `1.1.33` and resolved a different suite mount, `/opt/power-evolve/skills/report-suites/cab8954a3af1d73bf80f1219d6677d95faf615d315a558741f9b81dae2a165fe`. Its real qa3 `cloud_exec` ran `validate_rule_consistency.py` from that new mount and returned exit 0 with `rule consistency validation passed: 0 errors`; trusted continuation completed. This closes the earlier literal-string mismatch for the new package version without changing the old accepted selection.

### Real NUL output after Runner response fix at `ba1307f14d`

Mainline `631f8062e3` was merged into this QA branch at `ba1307f14d`; only `s8-office-qa` Host and Platform were rebuilt and restarted. A real Alice browser Session caused one qa3 `cloud_exec` command to write the same 19-byte sequence to stdout and stderr: `A`, NUL, `中文`, emoji, literal backslash `u0000`, `Z`. PG `result` is `json`; both streams matched the expected byte length and SHA-256, with no truncation. The trusted continuation completed. The persisted native event matched the full Operation input for this small result, survived page refresh, and Bob's read of Alice's Session returned 404.

Another new Session wrote 65,536 bytes to **each** stream: NUL padding ending in `中`, emoji, and literal backslash `u0000`. The actual Pod image ID was `sha256:ceaf2b51bc789a2284b532bfa9b4a887ec4e55a4c4cf1637319b574a5b7ccf71`. Both PG streams matched the expected 65,536-byte SHA-256, `stdoutTruncated=false`, `stderrTruncated=false`, exit 0, and there was exactly one execution row in that Session. The full trusted Operation input is 786,541 characters and contains both complete escaped streams. The persisted native event intentionally uses `continuation-input.ts`'s `Internal result truncated.` and `[... omitted ...]` markers; its 224,584-character text retains matching head and tail, with JSON-encoded size exactly 262,144 bytes. The continuation completed, a refreshed Alice browser read back the exact persisted event, and Bob again received 404. This verifies lossless durable result plus bounded model-visible text at the legal dual-stream output cap.

An initial full-size probe also executed once and completed successfully, but this QA script incorrectly asserted that its bounded native event must equal the complete Operation input. That assertion failed after the platform work had succeeded. The corrected script intentionally created a second independent Session to finish native refresh and cross-user checks; each Session has one execution, and there is no automatic duplicate or command retry. The original failed QA assertion and first successful execution remain recorded in the isolated database.

### Health-only final check at `92dfac1b4c`

The mainline health fix `5f1cf19fdc` was cherry-picked into this QA branch as `92dfac1b4c`. The application compiled, and only the `s8-office-qa` Platform was restarted with the trial's existing external Docker network. Its `/health` returned `ready:true` and `schema:21`, matching a direct read-only `SELECT version FROM pe_schema` result of `21`. The trial Host and API `/health` endpoints both returned `ready:true`. This follow-up checked health and the running source version only; it did not repeat Skills, Office, report, or NUL execution probes or change trial data.

The verified startup command for the current trial, including its required existing Docker network, is:

```sh
PE_TRIAL_NAME=s8-office-qa \
PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-s8-office-qa \
PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default \
PE_DATABASE_PORT=18553 PE_HOST_PORT=19550 PE_PLATFORM_PORT=19551 PE_TARGET_PORT=19552 \
node products/power-evolve/scripts/trial.mjs up
```

The QA browser scripts also use `PE_S8_EVIDENCE_DIR=/Users/jingchao/agent_work/main_agent/power-evolve-parity-audit/.artifacts/power-evolve/s8-office-qa/evidence-qa3`. No password or key value is in these commands or the tracked report.

## Blocking findings

### Long Office guide initially left a queued operation and starved other continuations; fixed and replayed

In `s8-skills-qa`, Alice's model called `office` with `load_skill word`. The real k3s execution `604ff19a-f7a3-4e3e-afbd-1791fd40ad4d` succeeded with exit code 0 and a 42,222-character guide. The trusted `sandbox_result` operation `e27bb4bc-033d-4879-a8a7-72e56b9b1c4f` contains 43,574 characters, but remained `queued`, `attempts=0` for more than four minutes and after Host restart. `grant.text` in `contracts.ts` allows at most 16,384 characters; `TaskStore.claim` parses the oversized continuation inside its transaction, so it rolls back and selects the same oldest task again.

Bob then issued `office create /workspace/s8-excel.xlsx --locale en-US` in a separate Session. Its k3s execution succeeded and wrote a real file, but its 280-character continuation also remained `queued`, `attempts=0` because Alice's older unclaimable task was repeatedly selected first.

After the focused `5f24f311e9` source fix was cherry-picked into this QA branch as `d796102f11`, the application compiled with `pnpm exec tsc -b products/power-evolve/application/tsconfig.json`. Only this first trial's Host and Platform were stopped and restarted. Both original queued operations naturally completed with one claim attempt. Durable `user/message` text equaled the original PG input byte-for-byte in each Session, including Alice's full 43,574 characters. Both received an assistant response. Neither Session had another tool call after its continuation message, and each original user operation still had exactly one cloud execution row. No PG row was manually changed and no Office command was resubmitted.

### Office guide lifecycle conflict found and runtime guidance verified

The built-in Word, Excel, and PowerPoint Skill wrappers tell the model to load the installed OfficeCLI guide. That guide teaches `open <file>` and `save <file>` around edits. This product's `office` tool executes each call independently with no resident state. Its parser rejects all three concrete commands `open /workspace/s8-word.docx`, `open /workspace/s8-excel.xlsx`, and `open /workspace/s8-deck.pptx`, explaining that direct `get`, `query`, `view`, `create`, `add`, `set`, `remove`, or `batch` must name the file. `save /workspace/s8-word.docx` did succeed, but cannot provide cross-call resident semantics.

The `0e2f62b05b` runtime fix prepends fixed product instructions to `load_skill` output while preserving the upstream guide. The real Alice replay verified both exact guide preservation and a later direct file write in the same Session. The three catalog Skill wrapper revisions are still pending their next explicit package version; this runtime proof does not imply full document workflow acceptance.

### Visual renderer availability in the original Runner

The real Office command `view /workspace/s8-word.docx pdf --out /workspace/s8-word-preview.pdf` exited 1 with `No exporter plugin found for .docx → .pdf`. OfficeCLI `view ... screenshot` exited 1 for all three formats: Word and PPTX reported `No headless backend available`; Excel's clipped range reported `clip mode requires a Chrome-family browser`. The original image has LibreOffice Writer. Its Writer conversion passed for Word, but the same LibreOffice command for XLSX and PPTX exited 0 while printing `Error: source file could not be loaded` and creating no PDF. File existence and PDF magic checks prevented a false success claim. The qa3 follow-up above passed LibreOffice Calc/Impress PDF rendering in real Sessions.

## Reproduction scripts

Run against an already prepared trial with `PE_PRIVATE_DIR`, `PE_HOST_PORT`, `PE_PLATFORM_PORT`, and `PE_S8_EVIDENCE_DIR` set to that trial's own paths/ports. The first script also needs `PE_S8_NAMESPACE`.

| Script | Action |
| --- | --- |
| `qa-s8-skills-browser.mjs seed` / `verify` | Two-user native Skills UI, owner boundaries, revoke, and restart persistence |
| `qa-s8-nine-read.mjs` | Nine instruction digests and 18 cross-user 404s |
| `qa-s8-model-browser.mjs smoke` | Real DeepSeek `hi`, native Word slash, and `skill_resource` without Sandbox |
| `qa-s8-office-command.mjs <alice\|bob> <action>` | One real Office command, execution receipt, trusted continuation, and saved file |
| `qa-s8-pdf-browser.mjs` | Native PDF slash, real cloud Sandbox PDF, and durable result |
| `qa-s8-cloud-render.mjs <alice\|bob> <word\|excel\|pptx>` | Actual LibreOffice conversion in the matching file's Sandbox Session and PDF magic check |
| `qa-s8-office-guide-browser.mjs` | Real prefixed `load_skill word`, full upstream guide comparison, and same-Session direct write |
| `qa-s8-report-resource.mjs` | Real `skill_resource` of the orchestrator registry, SHA check, zero Sandbox rows |
| `qa-s8-upgrade-browser.mjs` | Two-user explicit five-package API upgrade, stable IDs, old receipts, disabled state, and SHA checks |
| `qa-s8-report-session.mjs` / `qa-s8-report-command.mjs <action>` | Native report slash, actual suite path, workflow and formatter commands in k3s |
| `qa-s8-specialist-session.mjs <latex\|reviewer>` | Native LaTeX and reviewer Skill invocations |
| `qa-s8-latex-command.mjs <action>` | Real XeLaTeX build, validation, and PDF render through cloud Sandbox |
| `qa-s8-report-rule-hotfix.mjs` | V21 schema check, two-user `1.1.33` API upgrade, old/new accepted selection comparison, and new-suite Runner gate |
| `qa-s8-lossless-browser.mjs small\|full` | Real dual-stream NUL/Unicode, PG JSON bytes, bounded continuation, native refresh and cross-user 404 |

The Office command script keeps later mutations in the Session and Workspace recorded by its matching `*-create` evidence. An early exploratory `excel-set` accidentally selected a different Workspace with the same title and returned `File not found`; the corrected script does not reuse a title to identify a file's Workspace. An `uncertain` state during Sandbox Pod replacement was transient and later settled to success; the script now waits for an actual terminal execution state.
