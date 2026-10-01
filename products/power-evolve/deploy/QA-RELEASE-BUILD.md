# Current release build evidence

This record covers clean-source image builds, component checks and local authenticated registry pulls. It does not replace two-user product acceptance or S7 target-infrastructure acceptance. The [fixed cloud candidate](../TRIAL-CLOUD-CANDIDATE.md) retains its existing checkout, data and images.

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

Local evidence is under `.artifacts/power-evolve/release-build/cloud-runner/`: `source.json`, `build.log`, `toolchain.log`, `linux-runner.json`, and `image-verification.json`. Its local image ID is not a registry manifest digest; the [local registry check](#private-registry-authentication) retains the verified manifest. AMD64 and production registry pulls remain unverified.

## Connector recovery prerequisite

`5d499bdcb3719cd1a86bcc238cc0bfe91afeb48a` adds the explicit operator registry reference to SSH and STDIO Runner Pods. The old STDIO implementation refused recovery after Kubernetes injected an `imagePullSecrets` reference from its ServiceAccount. A focused regression first reproduced `mcp_runner_resource_changed`; the change retains exact matching and rejects changed or additional references. Application leaf compilation, ten SSH/STDIO tests, lint and the affected bilingual pair passed. Those tests use a Kubernetes/Runner substitute; actual admission and recovery are covered by the local k3s check below, and authentication by the [registry check](#private-registry-authentication).

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

## Application requalification

The SSH metadata image was rebuilt from the clean archive `447938c23258b36a63e6b9913fc3df6cf586857c`, including the fenced SSH connection metadata and operator preflight correction. The complete committed Dockerfile passed Host, Client, native Web and product compilation under the same two-CPU, 6 GiB limit. The builder was stopped after export.

| Item | Verified value |
| --- | --- |
| Local image | `pe-release-app:447938c232` |
| Image ID | `sha256:523ccf22ac29463ca9ca0a58679368ffe85bcc602f1543f4706653ceb90aa72d` |
| Image size | 2,431,284,107 bytes |
| Imported manifest digest | `sha256:c63cf1cb9d191c4fe5ffa13fa98fe2a216888a853aaccbdd3c4530260f5bb703` |
| Composition checks | Three ready QA Pods used this digest; real-model SSH approval, execution, one Session continuation and Connector cleanup passed |

The first attempt ended before compilation because the local driver started the build before BuildKit's socket was ready. A bounded bootstrap check corrected the driver; the original attempt's archive and logs remain separate. Read-only package inspection located the image-size increase in three lockfile-declared optional packages: Linux ARM64 Codex, Claude Agent SDK and LibreOffice WASM. Earlier install logs contain socket failures for those packages, and the previous image lacks them. The lockfile and Dockerfile are unchanged. This build includes them; the size increase is packaged dependencies, not runtime memory allocation.

Evidence is under `.artifacts/power-evolve/release-integration/`: `application-requalified-attempt-2/build.json`, its complete `build.log`, `application-package-size.json`, `application-requalified-rollout.json` and `ssh-requalified-proof.json`. The [composition record](QA-RELEASE-COMPOSITION.md#application-requalification) distinguishes earlier full protocol evidence from the checks after this image update. Cloud Runner and Connector images are unchanged.

## Private-registry authentication

The three exact ARM64 images were exported as OCI archives and published to an isolated, bcrypt-authenticated TLS Registry 3 fixture. Each remote manifest digest matched its recorded imported digest. The publisher was the official Darwin ARM64 `regctl` v0.11.6 binary, verified against SHA256 `5b52b71861abc300ab513e87a4c3794cff6508035ac7f6b6bdfa1fa5688c0040`. Its configuration, CA and login were confined to a temporary private directory, with Docker credentials disabled. [regctl supports OCI archive import](https://regclient.org/cli/regctl/image/import/) and [an explicit configuration path](https://regclient.org/cli/regctl/config/).

Six real kubelet checks passed in three disposable namespaces. With `imagePullPolicy: Always`, an untrusted certificate, missing credentials and wrong credentials each produced `ErrImagePull`. Correct namespace-scoped pull Secrets admitted through the rendered ServiceAccounts then started the application, Cloud Runner and Connector images with exit zero and UIDs 10001, 1000 and 10001. Both execution images used the existing `gvisor` RuntimeClass. The Pods had read-only roots, no API tokens or credential volumes, and deny-all Pod networking. Existing image layers were cached; this verifies remote TLS/authentication and manifest resolution, not cold-cache layer transfer or the organization's registry.

The node trusted only the fixture registry's CA through a temporary per-registry `hosts.toml`; it contained no login credential. [containerd documents this host configuration](https://github.com/containerd/containerd/blob/main/docs/hosts.md). No OS/browser trust change or cluster restart occurred. The registry was limited to half a CPU and 256 MiB. The namespaces, private files, pulled reference aliases, registry and node CA directory were removed; existing application Deployment identities, generations and images remained unchanged.

Evidence is under `.artifacts/power-evolve/release-integration/`: `registry-pull-proof.json`, `registry-pull-qa.mjs` and `registry-driver.json`. Earlier failed drivers and partial checks remain in `registry-pull-*-attempt-1` through `-attempt-3`. The first `ctr` publisher stalled with zero-byte uploads while a small request using the same CA and authentication succeeded; its precise cause is unknown. Later driver corrections applied CA configuration before login and used the actual RuntimeClass name. These corrections did not change product code.

## Creation recovery image

The application from clean archive `33bceb039ea2e00a95f53345a938affebb181f85` adds the interrupted Sandbox creation and undispatched-command recovery fixes. The complete Dockerfile again passed Host, Client, native Web and product compilation under two CPUs and 6 GiB. Its image ID is `sha256:6b3fc28f7f170b78d353c7f7ccbe1c4d041c5e6e6826a3fdcb2ea092442ac8b5`, size 2,431,326,482 bytes, and imported manifest digest `sha256:965360ec17b75e3316cf89b5764bd42fe5c93e1c68835979cd9e037b43229dc1`. All three QA application Pods became ready with this digest before the cancellation image below replaced it. The builder stopped after export. Evidence is in `application-creation-recovery/build.json`, its build log and `application-creation-recovery-rollout.json`; [composition evidence](QA-RELEASE-COMPOSITION.md#creation-recovery-and-online-programming) records the actual recovery scope, two-user online programming and fresh-login readback. Runner images remain unchanged. This digest has not repeated the private-registry pull check; that check retains the earlier application digest above.

The private-registry drill also left three kubelet image credential records keyed by these earlier image config IDs. The node enables `KubeletEnsureSecretPulledImages` with `NeverVerifyPreloadedImages`; records containing only the temporary registry repository made its original local-image references require remote verification. CRI references and overlayfs unpacking remained valid. [The kubelet pull manager caches records and reconstructs residual intents at startup](https://raw.githubusercontent.com/k3s-io/kubernetes/v1.35.5-k3s1/pkg/kubelet/images/pullmanager/image_pull_manager.go). A controlled restart of the existing QA node restored its preloaded-image use after exact, private backups and removal of only those three test records; four other records, image bytes and the verification policy remained unchanged, and no pulling intent was present. The restart replaced the Pending Pod, so it cannot establish recovery of the original Pod. `qa-image-cache-restoration.json` and `online-post-cache-identities.json` retain that outcome. This is local test cleanup, not a production registry configuration.

## Creation cancellation image

The clean archive `6a8630491a69b9ceef1cbe943154f67075176229` includes the creation-cancellation cleanup and its bilingual application contract. The complete committed Dockerfile passed Host, Client, native Web and product compilation under two CPUs and 6 GiB. The Linux ARM64 image is `pe-release-app:6a8630491a`, image ID `sha256:1ff2fd55a4778a6ede6119e39fea3a8f78a738ae2ca608e0ddf0f4cf5ff141c7`, size 2,431,403,353 bytes, and imported manifest digest `sha256:da89a887b537fed451174727af1d24d0a542429b3f4eee1893840fb565530e50`. Only the QA application image references changed after existing work settled; Host, Platform and the TLS proxy became ready. Runner images, data roots and the fixed candidate were retained. The builder stopped after export. `application-creation-cancel/build.json`, its build log and `application-creation-cancel-rollout.json` retain the build and requested rollout; the [composition record](QA-RELEASE-COMPOSITION.md#creation-cancellation-and-account-revocation) records actual cancellation, revocation and subsequent execution. This application digest has not repeated registry authentication or the earlier online-programming check.

## AMD64 application component checks

The same clean source archive `6a8630491a69b9ceef1cbe943154f67075176229` passed the complete committed application Dockerfile for Linux AMD64 on the Apple Silicon Docker host, with the existing builder limited to two CPUs and 6 GiB. Host, Client, native Web, product and Linux x64 native-module compilation passed. The image is `pe-release-app:6a8630491a-amd64`, image ID `sha256:d7c662de9a3033e552a3131f9460ff252d07756f08d8b38f721fe9fb08aedc8e`, size 1,890,616,094 bytes. Its archive SHA256 is `bbcd4cddec09ee938d2cf890d19ab85bff5431fcf5bd1340bdd844f79ce6f0ee`. This image ID is not a registry manifest digest.

After the builder stopped, two sequential, offline containers checked the image itself. A half-CPU, 512 MiB container called the actual native flock addon to acquire, refuse contention and reacquire a lock; the Python helper wrote and read binary bytes and refused a symlink path. Compiled Platform modules loaded and both deployment profiles rendered without starting Platform. A one-CPU, 1 GiB container then launched the formal DSH Host entry point as UID 10001, with a read-only root, no network, no capabilities and only a disposable worker token. Host reported zero Agents, Sessions and grants; its native shell, CSP and built JavaScript response passed. Explicit TERM stopped it with exit zero without timeout or OOM. Both containers and private temporary files were removed. No PG, model, Platform, Kubernetes or browser participated; the running ARM64 QA composition was retained.

Install logs retain npm socket retries. Read-only inspection found the optional Codex and Claude Agent SDK x64 native packages absent, accounting for part of the size difference from ARM64. The selected PowerEvolve Host and Platform profiles do not load those SDK integrations; their availability is not established by this build. Evidence resides in `.artifacts/power-evolve/release-integration/application-amd64/`: `build.json`, `build.log`, `component-proof.json`, component/Host logs and `optional-package-inspection.json`. These are AMD64 user-space checks through host-provided emulation, not native physical AMD64, execution-image or target-infrastructure acceptance.

## Remaining release checks

The ARM64 images have the build and component evidence at their recorded revisions; registry evidence retains its exact digests above. Their [local composition](QA-RELEASE-COMPOSITION.md) also passed real-model native HTTP requests, files, PVC-mounted cloud Git, online dependency installation, SSH and restart checks through the formal deployment entry points with explicit local resource overrides. Browser acceptance remains blocked by the local certificate's trust status. The images have not been promoted into the fixed candidate or an organization registry. Complete browser acceptance, AMD64 execution images and native target acceptance, cold-cache production pulls and target-infrastructure S7 acceptance remain unverified. These results do not establish a complete release.
