---
description: "Compose account-owned native Settings, presets and Agent consumers over Platform Session authority."
kind: package-bundle
---
# @power-evolve/native-runtime

English | [中文](README.zh.md)

## Summary

This bundle gives one account its maintained native Settings, Profile editor, permission commands and four Agent presets. The Platform pool mounts it after the base and Web bundles inside that account's isolated Runtime Pod. Native consumers retain their implementations above bounded Platform adapters. PostgreSQL owns Sessions, model credentials and execution grants; the Runtime has only its own revocable account credential and private Profile state.

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

The [deployment launcher](../deploy/README.md) owns the private named Profile and account Pod. It supplies `PE_RUNTIME_USER_ID`, `PE_RUNTIME_ID`, `PE_RUNTIME_TOKEN_FILE`, `PE_PLATFORM_INTERNAL_URL`, `PE_HOST_PUBLIC_ORIGIN`, `PE_PLATFORM_PUBLIC_ORIGIN` and `DSH_HOME`. The Runtime reads its current account model through Platform identity; the launch environment contains no model-provider or shared worker credential.

Port 8080 serves `/native/runtime/invoke`, `/native/runtime/ready`, `/health` and `/native/api/remote.mux`. Unary and multiplexed browser carriers require the original Browser Agent token in `x-power-evolve-browser-token`, plus this instance's own broker token in `x-power-evolve-runner-token`. Health and ready require the broker token. Every admission rechecks Platform revocation, fixed account and generation; readiness reports the actual native service and preset registrations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Profile state and Platform consumers</summary>

[cordis.patch.yml](cordis.patch.yml) replaces local JSONL, provider credentials and execution providers with the [application adapters](../application/README.md). Native base and Web bundles own their Settings, tools and consumer behavior. Native settings and plugin edits save the complete account-private Profile, including its user patch, package configuration and storage. The launcher retains that Profile across Runtime generations while each incarnation owns an independent lifecycle directory; restoring a process does not replay a child prompt.

Filesystem, subprocess and sandbox providers capture the exact initiating Agent's server-issued execution world. Permission mode comes from committed native Session events, and any later mode event invalidates the old generation. The native PTC node bootstrap is `/opt/power-evolve/native-ptc-process.mjs` in the execution image. Platform controls the physical execution Pod; the Runtime does not have Kubernetes or database credentials or a mounted execution Workspace.

The original ToolRuntime registrations and current logged request header freeze each operation's native tool declarations. MCP and STDIO retain their accepted catalogs and schemas, and collisions with native registrations refuse. Native Search preserves the original Messages request, persisted request event and result mapping; Platform fixes its endpoint and credentials. Native event callbacks retain their original Gateway identities while PG supplies durable Session membership.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Application adapters](../application/README.md) — original grants, persistence and consumer authorization.
- [Host layer](../host/README.md) — outer browser routing.
- [Deployment lifecycle](../deploy/README.md) — private Profile ownership and process lifetime.

-----

<a id="model-experience"></a>
## Model Experience

This layer changes consumer providers and account ownership. The maintained native preset and tool packages own model-visible schemas, prompts and result text; this bundle adds no replacement Agent loop or model instructions.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Source and isolated PG checks do not establish physical Linux containment or live PTY/PTC execution. Those results require the deployed execution image and original native consumers. Idle Terminal also requires durable interactive Session authority; an operation-bound provider cannot infer execution permission from a Browser Agent cookie.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

The Runtime pool owns the Pod and stable user Profile; the execution provider owns the separate Workspace Pod. Keep their mount and credential ownership distinct when rebuilding either image.

</details>
