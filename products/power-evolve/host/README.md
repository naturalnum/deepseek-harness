---
description: "Compose native PowerEvolve conversations, Skills and bounded Platform access in a dedicated cloud Host Profile."
kind: package-bundle
---
# @power-evolve/host

English | [中文](README.zh.md)

## Summary

A dedicated cloud Host Profile lets users continue native DSH conversations with their authorized models, Skills and controlled tools. This layer combines the native Agent services with PowerEvolve's Platform adapters. Operators prepare it through the product deployment launcher and keep its configuration separate from Platform. The Host needs the trusted Platform for admission, history and external actions; it receives operation grants rather than database or provider credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [deployment launcher](../deploy/README.md#profile-lifecycle) prepares a separate named Host Profile with this bundle. Its private deployment document owns the Host origin, Platform URL, worker-token file and row overrides. Read the launcher's ownership and recovery rules before rendering or starting a Profile. Built application and native Web artifacts must match that deployment.

The Host supplies native Agent execution and authenticated browser access through the [application adapters](../application/README.md). Login and independent approvals remain at Platform. The bundle declares native Skill services with an Agent-scoped Platform provider; it does not scan Host filesystem Skills or load user package code into the Host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Profile composition and operation grants</summary>

[package.json](package.json) declares a `dsh.bundle.patch` layer, and [cordis.patch.yml](cordis.patch.yml) inserts the native Agent services and application adapters over a standalone Profile. This layer does not inherit the native local execution Profile. Each inserted package owns its service behavior and lifecycle.

A later Profile patch replaces an entry's complete configuration; it does not merge individual fields. The runtime adapter makes bounded Platform requests, while persistence and model adapters keep durable state and credentialed requests at Platform. An unavailable Platform prevents those operations; a Host process alone does not establish cloud execution readiness.

`PE_HOST_WORKER_ID` supplies the runtime row's `workerId`, an operator-selected UUID matching Platform's private native-input owner mapping. Omission generates a new process-local UUID, which has no static routing entry. Each simultaneously running Host needs a distinct configured UUID. The native queue receiver accepts commands only through the current operation's registered Coordinator; unavailable or replaced owners refuse.

The eight native mutation families persist their complete original request at Platform before execution. Scheduler reconciles shared requests before claims, including originals from a previous Host identity. Historical receipts never install a Grant or replay a model or tool. Successful generation retirement or writer close confirms validated local receipts; cleanup then runs in bounded maintenance. Cold cleanup requires a nonrevivable original operation and no live Session Writer. `nativeIntentReconcileLimit` defaults to 32 records per scan, while `nativeIntentMaxLocalReceipts` defaults to 65,536 pending acknowledgements. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.1/power-evolve-retained-intents/guide.md) for coordinated Host and Platform changes.

Scheduler bounds accepted-input polling with `nativeInputPollMs` (default 100 milliseconds) and `nativeInputBatchSize` (default 16). Each active Session keeps one independent Writer across operation handoffs. Cloud Agents select `disposeOptions.keepInbox` before creation so caller, factory and structural-owner teardown preserve durable pending inputs; ordinary native callers retain their default cancellation behavior.

The production manifest explicitly provides Contracts, Connector Runner and pinned Zod for the application peer graph. A linked development Profile must record each consumer root in the formal resolver; a packaged installation must retain one physical ESM provider for every protocol import. Peer declarations alone do not establish that installation. Provider directory or version changes require a new process.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud application](../application/README.md) — native Session behavior and authorization.
- [Trusted Platform layer](../platform/README.md) — identity, storage and controlled dispatch.
- [Deployment lifecycle](../deploy/README.md#profile-lifecycle) — owned launch and recovery.
- [Confirmed migration scope](../CLOUD-MIGRATION-PLAN.md) — included capabilities and acceptance.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the inserted native services and [application adapters](../application/README.md#model-experience). Their packages own model instructions, tools and native Session events. The bundle patch selects the system-prompt configuration; accepted operation grants bound the model and tool selections.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Profile composition has these operational limits:

- The trusted Platform must be available for admission, task claims, history, model calls, personal Skills and controlled external actions.
- Overrides replace complete row configurations; operators must restate required settings.
- Cloud, Office and connector paths require private deployment configuration and independent real-service acceptance.
- This cloud layer supplies no Device, Desktop or Host-local execution Profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Use the fixed official release and [product instructions](../AGENTS.md). Record Profile installation, launch and integration results in current trial evidence. This document does not certify a running deployment.

</details>
