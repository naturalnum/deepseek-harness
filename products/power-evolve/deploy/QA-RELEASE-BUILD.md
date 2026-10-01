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

`5d499bdcb3719cd1a86bcc238cc0bfe91afeb48a` adds the explicit operator registry reference to SSH and STDIO Runner Pods. The old STDIO implementation refused recovery after Kubernetes injected an `imagePullSecrets` reference from its ServiceAccount. A focused regression first reproduced `mcp_runner_resource_changed`; the change retains exact matching and rejects changed or additional references. Application leaf compilation, ten SSH/STDIO tests, lint and the affected bilingual pair passed. These tests use a Kubernetes/Runner substitute; actual private-registry admission and recovery remain integration checks.

## Remaining work

Host and Platform share one application image; Connector Runner has a separate image. Both still need a current clean-source build and image startup/runtime evidence. The existing S7D application result predates current account configuration. Optional Connector deployment wiring, its namespace/credentials/policies and image pull references must also pass integration before this build group is complete. No current component result establishes a complete release.
