# Device lifecycle and official desktop reuse

2026-10-04 · macOS ARM64 · Node 22.22.1 · product source `cd4bb5c8d164fc681ea5b10fa00e3be9a0759e1e`. The [desktop reuse plan](../DESKTOP-COMPLETION.md) retains the official Electron shell; this record covers its Device lifecycle prerequisites, not a delivered Electron package.

## Verification

| Check | Actual result | Infrastructure |
| --- | --- | --- |
| [Private-root lock](../application/tests/device-process-lock.test.mjs) | 5 passed: contention, process death, inode retention and replacement/link refusal | Real macOS native flock and OS child processes |
| [Built Profile lifecycle](../application/tests/device-profile-lifecycle.test.mjs) | 2 passed: rival refused; normal shutdown and failed initialization release ownership | Actual built `dsh` CLI, Device bundle, loopback health and native flock |
| [Owned Docker identity](../application/tests/device-owned-container.test.ts) | 14 passed: immutable IDs/labels, lost acknowledgement, identity mismatch, bounded output and missing observations | Docker command replacements |
| [Public Worker recovery](../application/tests/device-worker-recovery.test.ts) | 7 passed: persistence before start, cold recovery, unknown ownership, stop failure, stale observations, terminal acknowledgement and local-action teardown | Real private files, native flock and loopback HTTP; Platform and Docker replacements |
| Docker identity smoke | 5 assertions passed; original container stopped/removed, foreign same-name container retained, all QA containers subsequently cleaned | Real OrbStack Docker daemon and local ARM64 Runner image |

Commands:

```sh
pnpm exec tsc -b products/power-evolve/application/tsconfig.json --pretty false
node --test products/power-evolve/application/tests/device-process-lock.test.mjs products/power-evolve/application/tests/device-profile-lifecycle.test.mjs
node --import tsx/esm --test products/power-evolve/application/tests/device-owned-container.test.ts products/power-evolve/application/tests/device-worker-recovery.test.ts
```

The real Docker smoke freezes image `sha256:c2fbc8c0b85a00accfd4204ed011a5c970901bf5a0adec6c8c9243cfeae732c0`. It persists the original receipt, renames that container, creates and starts a foreign container under its old name, rejects adoption by name, then starts/stops/removes only the recorded original ID. The original marker is `START\n`; the foreign ID remains running until QA cleanup. The helper and JSON observations are retained privately under `.artifacts/power-evolve/device-reuse-20261004/`; they do not contain product credentials.

TypeScript, selected export JSDoc, selected repository oxlint, all 20 quick documentation checks and normal commit hooks passed. A Profile whose Device plugin fails to activate can retain other Cordis plugins; it emits no Device readiness. The future desktop parent must validate Device readiness rather than accepting WebServer availability.

## Remaining acceptance

No new real PostgreSQL Device stop-receipt flow, account pairing, cross-user desktop task, Electron bridge or off-source installation was tested in this batch. Linux Device process ownership and Windows execution were not accepted by the macOS results. The [Device bundle](../device/README.md) names the remaining platform stop receipts, cross-Device/overlapping-directory reservations and descriptor-relative file access. Missing container identity or legacy journal state remains blocked for review; no inferred stop proof or automatic command replay is introduced.

The frozen [Cloud C1 trial](../TRIAL-CLOUD-EXECUTION-RESOLUTION.md) remains on its recorded image/schema. After these tests its two Host and two Platform replicas are ready, its Runner namespace has no Sandbox/Pod, and only the existing PG and k3d node containers remain running. This batch does not upgrade that trial or claim completion of the full desktop recovery slice.
