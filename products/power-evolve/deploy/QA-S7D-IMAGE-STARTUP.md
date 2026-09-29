# S7d image startup drill

This is a local, disposable Docker drill of the Host and Platform application image. It is not a production release or cross-machine Kubernetes acceptance.

## Scope and reproduction

The original S7d image (`pe-s7d-build-check`, built from `0a2691005f`) contains `python3` only in its build stage. `SafePosix` invokes `python3` during Platform startup. With a new PostgreSQL container, private credentials, a writable `/data` volume, a read-only root filesystem, and constrained capabilities, the original Platform bundle reports `workspace_unavailable` and does not become ready. The reproducible command is:

```sh
node products/power-evolve/deploy/qa-s7d-image-startup.mjs --image pe-s7d-build-check --expect-missing-python
```

The runtime stage now installs `python3` using Debian packages with `--no-install-recommends`. The build stage retains the compiler toolchain; the runtime stage does not receive it. Docker's tmpfs defaults to `noexec`, which prevents DSH's native addon loader from loading a staged `.node` file. The QA runner explicitly uses an executable `/tmp`, matching the rendered Kubernetes `emptyDir` volume. This was a QA harness issue, not an application image dependency.

## Validation contract

`qa-s7d-image-startup.mjs` creates random, single-use Docker names and an explicit unused subnet. It starts its own real PostgreSQL 17, creates two seed users and disposable credentials, starts the existing DSH Platform/Host bundles, runs HTTP checks, then removes its containers, network, volume, and private files. The Host receives only a worker token. The Platform receives the database/provider keys, a data volume, and a startup-only ServiceAccount placeholder; no Sandbox execution request is made.

The script checks Platform `/health` and `/live`, Host `/health`, Host UID 10001, both read-only root filesystems, Host absence of Platform secrets/PVC/SA token, an authenticated Host RPC over its internal Platform URL, SafePosix file write/read and `../` denial, plus the native Web and Platform login pages. It does not verify NFS, gVisor, real Kubernetes ServiceAccount authorization, CNI policy, TLS ingress, or two physical machines.

## Result

| Item | Observed result |
| --- | --- |
| Source revision archived into image | `f35f91e846f88e8d54acfb5bd5fc9a862b2a8ab6` (includes Host internal Platform route commit `8dc235181f`) |
| Application image | local `pe-s7d-image-startup-check`, `sha256:d5dd2dd73285b487e6f4618750d9cfc4d2f8c3a0e97cd3276f2ae71e83176c5f`, 1,913,165,351 bytes |
| Build | `git archive HEAD` context, `SOURCE_COMMIT` build argument; Docker build completed after DSH Host/Client, native Web, and PowerEvolve application compilation |
| Original image | `pe-s7d-build-check`, `sha256:efcc97c18bf92935d3b9988785729cf6bf454444a7d56a2944ac30dc40d22fc0`; baseline script passed its expected SafePosix failure check |
| Fixed image | all seven QA checks passed; containers, Docker network, data volume, and private files removed by the script |

```sh
node products/power-evolve/deploy/qa-s7d-image-startup.mjs --image pe-s7d-image-startup-check
```

The passing output recorded runtime Python, isolated PostgreSQL, both Platform probes, Host UID/read-only/mount boundaries, an authenticated Host RPC through the internal Platform address, SafePosix byte round-trip with path denial, and the native Web/login pages. The final QA script and this report were edited after image creation; no runtime source or Dockerfile changed, so the image source remains the revision shown above.

One Host and one Platform container ran on one physical machine. PostgreSQL used a private Docker network without production TLS. `/data` was a local Docker volume, and the ServiceAccount file was a startup placeholder; no Sandbox call was made. Public TLS Origins were configured but not reached through an Ingress. The separate NetworkPolicy/RBAC probe is owned by the parent task. This result does not close the cross-machine, NFS, CNI, ingress, image registry, or failure-recovery gates in `README.md`.
