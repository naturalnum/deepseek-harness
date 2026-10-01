# Current release build evidence

This record covers clean-source image builds and their component checks. It does not replace two-user product acceptance, registry pulls or S7 target-infrastructure acceptance. The [fixed cloud candidate](../TRIAL-CLOUD-CANDIDATE.md) retains its existing checkout, data and images.

## Cloud Runner

| Item | Verified value |
| --- | --- |
| Source archive | `1187733fb144f611288d6fbaeb1b4209cc84e24b`, subtree `products/power-evolve/sandbox` |
| Build | Complete committed `sandbox/Dockerfile`, Linux ARM64; no QA overlay |
| Local image | `pe-release-cloud-runner:1187733fb1` |
| Image ID | `sha256:b8cfe845b320cd35e88717c45b7bcec795ba4618edfe11de510f3f4e62c0e572` |
| Image size | 2,079,449,508 bytes |
| Toolchain | UID 1000, read-only root, writable temporary Workspace/Home/tmp; OfficeCLI 1.0.151, pinned Python venv and system UNO |
| Documents | Chinese PDF extraction/rendering, CTeX compilation, DOCX/PPTX/XLSX creation and validation, Pandoc, and LibreOffice PDF export with text and PNG checks passed |
| Linux Runner | Root Node Runner as PID 1; an unprivileged child using `setsid` was stopped, its output stopped growing, and a subsequent command plus file scan succeeded |

The existing [toolchain script](../sandbox/qa-skills-toolchain.sh) ran in a disposable container limited to two CPUs, 2 GiB and 256 PIDs, with no network. The Linux component check used the same image and limits, an ephemeral Runner token, and the production SETUID/SETGID/DAC_OVERRIDE/KILL capability set. It called the real Runner HTTP protocol inside the container. No model, Platform or Kubernetes controller participated in that component check.

The first Linux probe reached the container before its HTTP listener was ready and failed with connection refused. After adding a bounded readiness check to the local verification driver, the Linux check passed. The already-passing toolchain check was retained. Both containers and the temporary token directory were removed; three existing infrastructure containers remained running.

Local evidence is under `.artifacts/power-evolve/release-build/cloud-runner/`: `source.json`, `build.log`, `toolchain.log`, `linux-runner.json`, and `image-verification.json`. The image has not been pushed; its local image ID is not a registry manifest digest. AMD64 and production registry pulls remain unverified.

## Connector recovery prerequisite

`5d499bdcb3719cd1a86bcc238cc0bfe91afeb48a` adds the explicit operator registry reference to SSH and STDIO Runner Pods. The old STDIO implementation refused recovery after Kubernetes injected an `imagePullSecrets` reference from its ServiceAccount. A focused regression first reproduced `mcp_runner_resource_changed`; the change retains exact matching and rejects changed or additional references. Application leaf compilation, ten SSH/STDIO tests, lint and the affected bilingual pair passed. Those tests use a Kubernetes/Runner substitute; actual admission and recovery are covered by the local k3s check below, while authenticated registry pulls remain unverified.

## Connector Runner

| Item | Verified value |
| --- | --- |
| Source archive | `8a170414c7c31d3a7f43c40248252d68b9d27b71`, complete Git archive without development outputs |
| Package | Frozen-lockfile filtered install, TypeScript build and production deploy inside pinned Linux ARM64 Node 22.23.2; lifecycle scripts disabled for deploy |
| Build | Committed `connector-runner/Dockerfile`, isolated production deploy directory |
| Local image | `pe-release-connector:8a170414c7` |
| Image ID | `sha256:adc21117231b65252e3c85924bba9fc05ed624852b36da091d953bae3b05afdc` |
| Image size | 269,244,922 bytes |
| Container checks | UID 10001, read-only root, no network; unauthorized HTTP returns 401, unavailable egress verification keeps calls at 503, real packaged STDIO child returns its assigned account |
| Formal deployment | `4f62160ee0c42d332b5dab2a45ecd56122f73e58`; 15 focused deployment tests passed after integration |
| Real k3s checks | Eight formal Connector resources, scoped Platform identity, two separate gVisor Pods, live-listener denial, same-Pod recovery, stable duplicate result and changed-account refusal |

The initial package install stopped on npm socket errors before compilation. The same lockfile succeeded with the Connector dependency filter and download concurrency four. Compilation and deploy ran in a disposable two-CPU, 2 GiB container. Image component checks used a separate disposable half-CPU, 256 MiB container. Both were removed.

The new image was imported into the existing single-node k3d cluster and selected by its imported manifest digest, `sha256:d6febdee0e8048816841e1e51dc14a0c79f6d66015083110c2eeeacae1a94778`. An empty Docker credential Secret exercised the configured ServiceAccount and Pod reference; it did not authenticate a registry pull. A fresh orchestrator recovered each existing Pod with its expected reference, while omitting that reference was refused. The forbidden listener stayed healthy through the scoped API proxy while each call Pod received `ECONNREFUSED`; this matches the runtime's independently verified live-listener denial rule. Both calls returned the assigned account, duplicate requests retained their digest, and changing accounts on the same call was refused. Calls, listener, three temporary namespaces and private access files were removed.

The first local test driver incorrectly encoded a kubectl subresource and later required a timeout despite this CNI returning a refusal. These were driver corrections; the committed preflight already uses `--subresource`, and the runtime already requires an independently healthy listener before accepting refusal as denial. Local evidence is under `.artifacts/power-evolve/release-build/connector/`: package/build logs, `image-verification.json`, and `k3s-verification.json`. These are component checks without browser, model or remote SSH execution.

## Host and Platform application image

| Item | Verified value |
| --- | --- |
| Source archive | `40ba53dcbc91f554b103ec3d0e6edea21990ae6f`, complete clean Git archive |
| Build | Complete committed `deploy/Dockerfile`, Linux ARM64; Host, Client, native Web and product compilation passed |
| Local image | `pe-release-app:40ba53dcbc` |
| Image ID | `sha256:432137863ed75bb722f0cf9385f44dec173d17d7147b51c9d11ebc51cda76f1a` |
| Image size | 1,771,834,547 bytes |
| Startup | Real disposable PG 17, separate Host and Platform containers, current account policy; seven checks passed |
| Authority and files | Host UID 10001, read-only roots, no Platform secret/storage/SA mounts; authenticated RPC, SafePosix byte round-trip and traversal refusal passed |
| HTTP resources | Native Web and Platform login pages loaded; this drill does not automate a browser or call a model |

The earlier clean build at `4f62160ee0c42d332b5dab2a45ecd56122f73e58` failed in three client test fixtures: injected-provider factory types, a missing file-mention title, and a generic render-slot mock. The fixture-only correction passed 178 targeted tests; the full client compiler subsequently passed in the image build. No test was excluded and no compiler check was disabled. The corrected archive initially exhausted the 4 GiB builder limit during Host compilation (exit 137 and BuildKit `ResourceExhausted`); the same archive passed with two CPUs and 6 GiB. This is build-time memory, not a per-user runtime allocation.

The [current startup drill](qa-s7d-image-startup.mjs) ran against the new image with its required account policy, temporary private credentials, and bounded containers. It removed all three containers, its network, data volume and private files. The builder was stopped before the drill. Local evidence is under `.artifacts/power-evolve/release-build/application/`: `source-fixed.json`, `build-fixed-6g.log`, `startup.log`, and `image-verification.json`. Cloud Runner source and Connector packaged runtime inputs are unchanged between their recorded archives and the application revision; their existing component evidence remains applicable.

## Remaining release checks

All three local ARM64 images now have clean-source build and component evidence. They have not been pushed or promoted into the fixed candidate. Private-registry pulls, remote SSH through the formal deployment, full product acceptance on the new image composition and target-infrastructure S7 acceptance remain unverified. AMD64 remains unverified. No current component result establishes a complete release.
