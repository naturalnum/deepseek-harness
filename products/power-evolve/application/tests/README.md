# S2 Sandbox storage bindings

English | [中文](README.zh.md)

## Summary

Existing Sessions can keep their Workspace identity when private storage changes. The platform blocks new writers during recovery and requires proof that the captured old Pod stopped before changing the binding.

## Table of Contents

- [Mount identity](#mount-identity)
- [Admission and observation](#admission-and-observation)
- [Recovery stop proof](#recovery-stop-proof)
- [Verification](#verification)
- [Dev Note](#dev-note)

## Mount identity

[SandboxManager](../src/platform/sandbox.ts) consumes the full platform-owned [storage binding](../src/platform/workspace-binding-types.ts). Workspace identity remains stable; storage generation and mount-slot generation identify separate changes. The slot and instance retain the same binding snapshot through reservation, readiness, reuse and stopping.

PVC mounts use `workspaces/<rootKey>/<rootRelativePath>` as kubelet `subPath`. QA hostPath mounts use only the registered `workspaces/<rootKey>` root; the relative directory goes into `subPath`, omitted for an empty path. The platform derives the root from owned metadata. The Sandbox template and actual Pod must both retain the exact Workspace, Home, Skills, token and scratch mounts.

## Admission and observation

Any recovering or blocked Workspace fences new Sandbox reservations and command dispatch for its owner. Admission locks the account, Workspace, mount slot and instance in that order. Kubernetes requests run outside these PostgreSQL transactions.

The recovery worker owns writer cleanup through this fence. Idle recyclers yield under the account lock; a recycler already stopping the Pod rechecks recovery ownership and its captured stopping slot before each cleanup mutation and final release.

[ExecutionService](../src/platform/executions.ts) observes an already captured Pod and Runner identity through `observeReady`; it does not provision storage for observation. Status and cancellation remain available through the recovery fence. A new command POST requires `assertDispatchAllowed` immediately before dispatch. A missing execution on an old Runner does not authorize replay through a blocked binding.

## Recovery stop proof

`stopForRecovery` handles only the durable request's captured target. A free target requires the unchanged mount generation and no live instance. A Pod target requires the captured Session, Pod UID, Runner identity and mount generation; a Pod 404 alone cannot release the slot.

The manager persists the kubelet stop evidence and old identity before removing the finalizer. The slot and instance retain this evidence after release so a restarted recovery worker can verify the same stopped writer. Lease callbacks validate the request outside transactions and reuse the supplied client when the manager already holds the account lock. The storage service owns lease validation and the final binding generation update; see [storage recovery](../../S2-STORAGE-BINDINGS.md).

## Verification

[Binding tests](s2-sandbox-bindings.test.mjs) exercise mount tampering, generation changes, admission fences, captured writer mismatches, missing stop proof, expired leases, retained evidence and old execution observation/cancellation against isolated PostgreSQL databases. [Handoff regressions](s2-mount-handoff.test.mjs) retain the existing serial writer and mount checks.

One composition case uses the actual FileService and StorageBindingService worker with SandboxManager. It verifies captured Pod stopping, lease checks with the held client, the binding generation update, preserved Git HEAD bytes and the same Session mounting the replacement directory.

The shared [fixture](sandbox-binding-fixture.mjs) substitutes Kubernetes and supplies a FileService adapter. These tests validate manager decisions and persisted identities; they do not establish actual kubelet subPath behavior. Real cluster mount and native browser acceptance belong to the combined C acceptance.

## Dev Note

Non-authoritative acceptance tracking: combined C acceptance records the real cluster mount and browser results.
