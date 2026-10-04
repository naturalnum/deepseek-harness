# Sandbox document toolchain

English | [中文](README.zh.md)

The Sandbox image retains the existing HTTP runner. Its trusted process starts as root so `runner.mjs` can launch user commands as UID/GID 1000. The deployed pod mounts `/workspace`, `/home/agent`, and `/tmp` as writable volumes, and mounts the image filesystem read-only. The toolchain and OfficeCLI stay in the image; package Skills are mounted separately by the platform.

## Pinned inputs

- Node 22.23.2 Bookworm slim base: `sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`.
- Debian Bookworm and Bookworm security apt repositories: signed snapshots at `20260901T000000Z`. The first apt update uses HTTP because the slim base has no CA certificates; apt verifies signed Debian Release metadata and package hashes with the base's archive keyring.
- Python 3.11 in a private venv: every direct and transitive package version and distribution hash is recorded in `requirements-skills.lock`, generated from `requirements-skills.in`. The `/usr/local/bin/python3` wrapper reaches that venv even though the runner sets a restricted command `PATH`.
- OfficeCLI 1.0.151: the amd64 binary must match SHA256 `8e2512234ae1111e51ad3a9fadbdeca266adfa7f683773469aa45b83fe06dc7f`; arm64 must match `fccb7d7841c9ec93593a62181544c893ee184455421cf15bd76110bf0ad29c41`.

The image includes LibreOffice Writer, Calc, Impress, Math, Python UNO, Pandoc, Poppler, XeLaTeX/CTeX, Noto CJK and Debian's WenQuanYi/TeX fonts. Writer requires Math for editable OMML equation export; PDF export can otherwise omit equations while returning success. The report catalog updater uses UNO through `/usr/bin/python3`; document editing uses the private venv. The image does not install JDK, Maven, Chromium, or Windows fonts. Debian's dated snapshot fixes the apt package set, while the base image digest fixes the initial OS state. The local QA tag is mutable; record `docker image inspect pe-s8-skills-runner:qa --format '{{.Id}}'` for an exact local image ID. A deployable immutable registry digest exists only after the image is pushed.

The runner supplies a fixed child environment and does not forward image `ENV` values. A document command that requires `OFFICECLI_SKIP_UPDATE=1` must set it in that command.

## Isolated Office preview

`office-preview.mjs` handles one parser task with the shared Office preview validators. Its process entry accepts no arguments: `/input/job.json` selects only fixed `source.doc`, `source.docx`, `source.ppt`, or `source.pptx`; `/output` must be an empty private physical directory. The wrapper verifies the actual source size and SHA256, creates a private snapshot, and requires the installed 0.1.1 WASM SDK with `/usr/share/fonts` and disabled font metadata caching. Every converter budget comes from the job. The deployment must omit workspace/Home and credentials; the job cannot select commands, paths, or an image.

After rendering and successful SDK disposal, fixed `/usr/bin/pdfinfo` runs inside the parser isolation with bounded output; cancellation terminates its owned process group and awaits close. PDF size, header, page count and shared result validation precede exclusive publication of `result.pdf` and the final `result.json` marker. Failures publish no success marker. Cancellation before the synchronous commit prevents publication; a completed commit remains successful. The marker binds the job, nonce, generation, source digest, PDF digest/bytes, pages and missing fonts. Consumers also require independently confirmed parser termination and exit zero, then verify PDF bytes; the marker alone does not establish process termination.

The offline `scripts/assemble-office-preview.mjs` helper copies an already prepared physical Linux package closure and built shared validator into a new destination. It reuses the repository Office package selection, requires 0.1.1 WASM, verifies declared engine-file digests, rejects links and nonregular resources, and records copied package identities and hashes. It does not install, download, convert, or build an image. The existing HTTP Runner remains separate. Owner-local tests under `tests/` use real temporary files and child-close events with SDK/Poppler or tiny package substitutes; they do not establish production isolation or native browser acceptance.

## Execution file candidates

Terminal execution responses include optional `fileChanges` with `status`, `files`, and `reasons`. Each file has a canonical path relative to `/workspace`, `sizeBytes` from zero through 2 MiB, and a lowercase SHA256 of the scanned bytes. Candidates are regular files proven new or changed between bounded scans before and after the command; printed paths, unchanged files, timestamp-only updates, and deletions do not produce candidates. An incomplete baseline permits a new-file claim only below a directory whose enumeration completed; a previously observed size change or known digest change can still prove a changed file. The platform separately authorizes and verifies downloads.

The declared scan scope is canonical paths accepted by the file-download contract, with at most 16 segments, 512 UTF-16 units per path, and 100 units per segment. Scans reject links, files with multiple hard links, and special files; skip `.git`, `node_modules`, `.venv`, `__pycache__`, and `.cache` at any depth; and exclude files larger than 2 MiB. Actual exclusions produce `partial` with `excluded_paths`. Exhausted budgets, unreadable paths, and changes detected while reading produce `budget_exceeded`, `read_failed`, and `changed_during_scan`. `complete` requires both scans to finish within this scope without exclusions or errors; it has no reasons. Missing scans produce `unavailable` with no files and `scan_unavailable`. Snapshots describe observed bytes and do not provide an atomic view or identify every artifact a command may create.

The root Runner reads the mounted Runner token; cwd validation, command startup, and scans access user paths only in credential-free UID/GID 1000 children. The Python helper uses directory descriptors and refuses symlink traversal for scans. Commands retain the existing cwd behavior: an internal directory symlink is accepted and an outside target returns HTTP 403. Before scanning, command execution, writer cleanup, and after scanning share one admission fence: another execution ID returns HTTP 409 until they finish. Repeating an accepted ID returns its stored status without executing again. Leader exit triggers cleanup before waiting for inherited output pipes or scanning; unverified surviving writers keep the fence closed. Helper cancellation sends TERM, then KILL after 300 ms, and awaits process close. Cancelling during the final scan preserves the already known command outcome. Scan failure does not change the exit code, timeout, or cancellation result.

The sandbox requires an isolated container PID namespace with the root Node Runner as PID1. Linux cleanup first verifies UID/GID 1000, parent PID1, and PID1's root identity and exact Runner command line; otherwise it refuses a UID sweep. It kills other processes with UID 1000, including descendants that called `setsid`, excludes itself and zombies, and verifies two quiet passes. Background tasks are unsupported. Cleanup has a 2.5-second inner deadline, 4096 process entries per pass, 65536 entries overall, 128 MiB address space, 64 descriptors, and three CPU seconds; its parent deadline is three seconds. The Runner imposes a four-second cleanup deadline and permits 500 ms for pipe closure. Failed verification closes remaining output transport after cleanup attempts, returns `unavailable`, and retains the admission fence until the pod is replaced. It never treats closing output pipes as proof that writers stopped.

These integer environment fields set separate budgets for each scan. Invalid values prevent Runner startup; the final list is always limited to 100 files.

| Environment field | Default | Allowed range |
| --- | ---: | ---: |
| `PE_RUNNER_SCAN_MAX_ENTRIES` | 4096 | 1–65536 |
| `PE_RUNNER_SCAN_MAX_HASH_BYTES` | 33554432 | 1–209715200 |
| `PE_RUNNER_SCAN_TIMEOUT_MS` | 5000 | 1–30000 |
| `PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES` | 1048576 | 1024–4194304 |
| `PE_RUNNER_SCAN_MAX_FILES` | 100 | 1–100 |

The parent caps helper output and permits 500 ms beyond the scan deadline before terminating it. Linux scan children have a 128 MiB address-space limit, 64 descriptors, and a CPU limit of `ceil(timeoutMs / 1000) + 1` seconds; command children do not inherit those scan limits. Focused tests are `application/tests/s2-sandbox-file-scan.test.mjs` and `application/tests/s2-sandbox-runner.test.mjs`. Their macOS fixtures use real POSIX files, Bash, HTTP, and child-close events with the local UID substituted for production UID/GID 1000; Linux privilege isolation, `/proc` namespace cleanup, and Kubernetes deployment require separate integration acceptance.

## Build and smoke test

```sh
docker build --pull=false --progress=plain -t pe-s8-skills-runner:qa \
  -f products/power-evolve/sandbox/Dockerfile products/power-evolve/sandbox
docker run --rm --user 1000:1000 --read-only \
  --tmpfs /workspace:rw,uid=1000,gid=1000,mode=755 \
  --tmpfs /home/agent:rw,uid=1000,gid=1000,mode=750 \
  --tmpfs /tmp:rw,mode=1777 \
  -v "$PWD/products/power-evolve/sandbox/qa-skills-toolchain.sh:/qa-skills-toolchain.sh:ro" \
  --entrypoint /bin/bash pe-s8-skills-runner:qa /qa-skills-toolchain.sh
```

The script performs OfficeCLI file operations and validation; imports the pinned Python packages; creates, extracts, and renders Chinese PDF text; compiles a Chinese CTeX document; and creates/reads DOCX, PPTX, and XLSX files. For each Office format it exports a PDF in a separate directory, checks nonempty bytes and expected text, and renders a PNG with Poppler. The DOCX export must also retain a native OMML equation's text. LibreOffice can return zero without exporting a file, so exit status alone does not establish rendering success. The script also checks Pandoc, writable mounts, and the absence of the excluded executables. This smoke test covers the toolchain; complete built-in Skill workflows and the platform's document command bridge require separate acceptance.
