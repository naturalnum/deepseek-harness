# Cloud command image

English | [中文](README.zh.md)

## Summary

Run authorized cloud commands against persistent Workspace and Home mounts, with read-only Skill packages. Accepted commands retain their output and status so callers can observe the original execution instead of dispatching it again. Platform owns grants and Kubernetes resource identities. Commands use a fixed credential-free environment; cleanup uncertainty retains the writer reservation. Document tools require separate image, byte and render verification.

## Table of Contents

- [Runtime](#runtime)
- [Toolchain and build](#toolchain-and-build)
- [Verification](#verification)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="runtime"></a>
## Runtime

<details>
<summary>Command admission and writer cleanup</summary>

The authenticated Runner runs as root PID1 in the private image; command and directory children use UID/GID 1000. Platform supplies its private token. Workspace and Home mounts are writable, Skill mounts and the image filesystem are read-only.

Credential-free native execution uses UID/GID 1000. Its Linux-built worker files and directories use mode 0555 so the process can traverse the worker directory while the image remains read-only.

`runner.mjs` supports health, command acceptance, retained status and cancellation under the Runner token. Requests bind the exact Runner instance, execution ID, command, relative cwd and timeout. Repeating accepted input returns its retained status; different input under the same ID conflicts. `PE_RUNNER_MAX_EXECUTIONS` sets the retained receipt limit, default 4096 and maximum 65536; reaching the limit refuses new IDs without forgetting accepted receipts. Output retains at most 64 KiB per stream and decodes split UTF-8 chunks. File publication and artifact observations are absent.

`command-children.mjs` sends bounded JSON to `command-child.py` without provider credentials. Directory admission uses descriptor traversal and permits only links resolved within the Workspace. Commands use Bash and a fixed PATH, HOME, USER and LANG. Cancellation requests TERM then KILL and waits for actual child close. Known command exit remains separate from writer cleanup.

Linux cleanup verifies UID/GID 1000, the root PID1 Runner's exact command line and parent identity before inspecting its private PID namespace. It terminates remaining UID1000 writers, including descendants that changed process groups, and requires two complete quiet observations. It refuses local or unverified namespaces. Cleanup failure retains the writer reservation; closing pipes alone does not free it. Background tasks are unsupported.

The optional STDIO v2 library shares the same writer reservation. `PE_RUNNER_STDIO_V2_CONFIG_FILE` supplies exactly the SDK limits and full reply budget; invalid configuration prevents startup, and an absent setting leaves the STDIO routes unavailable. Approval and current writer authorization remain Platform-owned. See the [connector provider](../connector-runner/README.md).

</details>

-----

<a id="toolchain-and-build"></a>
## Toolchain and build

The Dockerfile fixes its Node base by digest and Debian packages by a signed snapshot. `requirements-skills.lock` pins Python package versions and distribution hashes; OfficeCLI is pinned by version and architecture-specific SHA-256. The Dockerfile selects Git, Python, LibreOffice Writer/Calc/Impress/Math and UNO, Pandoc, Poppler, XeLaTeX/CTeX and Chinese fonts. Command children do not inherit image ENV values; commands that need `OFFICECLI_SKIP_UPDATE=1` set it explicitly.

The [library build configuration](tsdown.config.ts) bundles the prepared connector library for the image. The [Dockerfile](Dockerfile) consumes that artifact and the pinned toolchain inputs. The image owner must verify the complete build and deploy a reviewed immutable registry digest; a local image ID supplies only local evidence. [Deployment tools](../deploy/README.md) own application Profile launch and recovery.

-----

<a id="verification"></a>
## Verification

Run `node --test products/power-evolve/sandbox/tests/runner.test.mjs` on a non-root POSIX account. The tests use actual HTTP, Python, Bash, files and child-close events, with the local UID substituted for production UID1000. They verify command bytes, receipt replay/conflict, output bounds, cwd rejection, cancellation and group cleanup. They do not establish Linux PID1 namespace cleanup, gVisor, deployed Platform authorization or full report workflows. `qa-skills-toolchain.sh` exercises document tools against separate owned mounts; its outputs require byte and render checks rather than exit code alone.


-----

<a id="further-exploration"></a>
## Further Exploration

- [Trusted Platform](../platform/README.md) — operation admission and owned resources.
- [Connector provider](../connector-runner/README.md) — optional STDIO execution.
- [Confirmed migration scope](../CLOUD-MIGRATION-PLAN.md) — current acceptance requirements.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the application tools that submit authorized commands and log their results. This image supplies bounded execution output; the Host and Platform own model instructions, native events and continuation.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Execution and verification have these limits:

- Background tasks are unsupported; uncertain cleanup keeps the writer reservation.
- Local POSIX tests do not establish production UID1000 isolation, Linux PID1 cleanup or gVisor confinement.
- Image build, document rendering and same-version Platform integration need their own current acceptance evidence.
- An absent STDIO configuration leaves those routes unavailable; disabled behavior does not certify enabled execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Keep exact image identities, toolchain results and executed commands in private build evidence and migration records. This reference does not certify an image or a deployed execution environment.

</details>
