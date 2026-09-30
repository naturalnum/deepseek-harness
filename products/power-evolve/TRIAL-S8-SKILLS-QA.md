# S8 built-in Skills native browser acceptance

Date: 2026-09-30. Base commit: `e452a21d24`; the first trial's Host and Platform were subsequently updated with the focused continuation fix cherry-picked as `d796102f11` from `5f24f311e9`. The second trial later received the Office guide runtime fix cherry-picked as `bf4a93614a` from `0e2f62b05b`. This is a real DeepSeek and k3s Runner trial, not a model or execution fixture. The fixed Runner image is `pe-s8-skills-runner:qa` (`sha256:2e4e19443013095d5d978aea883c40e59bff3c27240840d7e0350d45018c307d`).

## Isolated trials

| Trial | PostgreSQL | Host | Platform | Kubernetes namespace | Purpose |
| --- | ---: | ---: | ---: | --- | --- |
| `s8-skills-qa` | 18552 | 19540 | 19541 | `pe-s8-skills-qa` | Two-user Skills UI, persistence, model discovery, and preserved long-output failure |
| `s8-office-qa` | 18553 | 19550 | 19551 | `pe-s8-office-qa` | Fresh-state Office and PDF file execution |

Each trial has its own private profile, database volume, POSIX workspace root, and namespace-scoped Kubernetes credential. Neither uses the frozen S7 c3 namespace or ports. Both initially used source and compiled artifacts from the clean base commit; focused fixes were compiled and applied only to the named trial processes above. This QA checkout owns its new scripts and this report. Local sanitized JSON/PNG evidence is under `.artifacts/power-evolve/<trial>/evidence/` and `evidence-qa3/` in this checkout. Credential files are outside the repository and are absent from evidence.

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

The Office command script keeps later mutations in the Session and Workspace recorded by its matching `*-create` evidence. An early exploratory `excel-set` accidentally selected a different Workspace with the same title and returned `File not found`; the corrected script does not reuse a title to identify a file's Workspace. An `uncertain` state during Sandbox Pod replacement was transient and later settled to success; the script now waits for an actual terminal execution state.
