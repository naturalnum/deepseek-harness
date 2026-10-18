---
description: "Review exact cloud API exposure, bound native Session delegation, and model-call admission."
kind: "package-reference"
---
# @deepseek-ai/dsh-pe-cloud-api

English | [中文](README.zh.md)

## Summary

Choose exactly which native RPCs, logical streams, Fetch routes, and settings fields a cloud recipe may expose. Unknown operations remain closed, and a changed native inventory revokes its prior audit. Shared guards run before native Session delegation and actual model dispatch. Account mounting refuses incomplete runtime, project, and configuration-save integration.

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

Mount the root entry in a deployment-owned composition; account mounting requires the complete trusted integration.

### When to choose it

Use this package to enforce reviewed cloud exposure while retaining native Session DTOs and business operations. Authentication, owner selection, project filesystem verification, and account readiness remain prerequisites.

### Minimal configuration

The [executed Loader fixture](tests/fixtures/root.cordis.yml) shows the root configuration with empty lists, which expose no operations. A product composition selects the package's `/root` and `/account` entries; the account entry rejects mounting until its required integration exists.

| Field | Default | Meaning |
|---|---|---|
| `recipeVersion` | required | Exact reviewed recipe identity. |
| `rpcEndpoints` | required | Exact unary endpoint, native handler, and resource guard declarations. |
| `streamEndpoints` | required | Exact logical-stream declarations. |
| `exactFetchRoutes` | required | Exact method, pathname, handler, and resource guard declarations. |
| `allowedSettings` | required | Exact namespace and effective changed field paths. |

An inventory audit compares configured declarations with native mounted handlers. Extra native registrations remain closed. Root matching declares deployment policy; each account must also check its current runtime binding, actual enabled handlers, and resources.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The root owns an immutable policy and revokes its audit when its fiber is disposed. The [exposure implementation](src/exposure.ts) uses exact maps without path decoding or prefix grants. The [private native assembly](src/native.ts) registers one subclass of the public SessionController, inheriting its Config, DTOs, Remote markers, and business methods. Create, prompt, and fork await shared project/Preset validation and recheck admission immediately before calling native super. Synchronous cancel checks the actual attached Agent's existing scope, then preserves native cancellation or notfound without loading a Session.

The private [account exposure view](src/account-exposure.ts) selects a subset of the root's frozen manifest with the same recipe. RPC and stream categories, Fetch methods/paths, handlers, guards, and settings fields must match exact root declarations. Each graph owns its inventory audit and disposal invalidation; A's audit or invalidation leaves B and root unchanged. Audit and operation admission check the exact installed AccountBinding and trusted runtime current callback. Existing ExposurePolicy consumers accept this view without a new Loader service or global account registry.

Page and follow await the shared project guard for ordinary Session addresses. Page rechecks admission before the native read and before returning its result. Follow requires the reviewed stream declaration and checks admission and cancellation before each native advance and before delivering its result. The native iterator receives caller and graph-lifetime cancellation and retains history, promotion, and cleanup ownership. Subagent history addresses remain denied pending their separate scope review.

Controller admission uses the installed graph AccountBinding and the same trusted runtime callback as the actual LLM guard, independently of HTTP/Peer AccountUse lifetimes. Assembly must declare native dependencies, retain its owning fiber, and exclude a second base Controller. Shared guard failures, stale bindings, revoked exposure audits, or disabled handlers prevent delegation. Native in-process calls preserve thrown guard errors; carrier serialization follows existing Gateway rules. Native business results and failures remain unchanged.

Factories supply the real files/Workspace/Preset/model guards, including synchronous active-scope verification without a second approval store. The account entry remains closed until those trusted ports and lifecycle requirements are integrated.

The [private AgentLoop factory](src/native-agent-factory.ts) checks the same installed graph binding and awaits shared project/model/Preset admission before native persistence creation or resume write-open. It preserves original setup and its synchronous commit, checking the actual prepared Agent after setup and around that commit. Ordinary root Sessions allow absent or zero delegation depth; parent/subagent/seeded paths, configured startup agents, and direct AgentLoop.create remain closed. The owning recipe declares the native AgentLoop dependencies and excludes a second loop.

Native persistence append can await between setup commit and registry publication. Caller and graph-lifetime cancellation reach the native transaction; a post-commit abort prevents later publication after actual append settlement. Caller cancellation after successful publication keeps its native creation-only meaning and does not cancel the committed Agent. Runtime must retain already admitted work through reconfiguration and actual teardown; a rejected observer alone does not prove that late backend ownership has closed.

The [LLM listener](src/llm-guard.ts) checks the account generation and approved provider/model immediately before the native stream continues. It preserves frozen request options. The account factory must supply the same approved set used by catalog and selection.

Runtime creates and retains one [configuration coordinator](src/config-saves.ts) with explicit global/account running, queue, tracking, nested-work, and observer limits. Admission records responsibility synchronously before invoking the native callback. Saves run serially per account; required nested writes join the executing operation and cannot wait behind themselves. Mandatory apply remains part of the same result.

Pause closes top-level admission but permits enrolled work to finish; only a quiescent, failure-free pause may reopen after runtime re-audits the graph. Stop is terminal. Observer cancellation or deadline expiry returns unknown without releasing actual work or capacity. Failed and unknown outcomes retain sanitized evidence and tracked capacity; this package offers no automatic failure clearing.

The [native adapter](src/native-save-hook.ts) connects public native hooks to that same barrier through internal helpers for account assembly and package-local tests. `installNativeConfigSaveHook` admits default-model saves, Settings writes and legacy rename, and direct ConfigEditor edits; other top-level writer identifiers are refused. The older `installNativeDefaultModelSaveHook` retains its narrower scope; install only one editor hook. `installNativeCredentialSaveHook` observes the local provider's set, unset, modify-record, and delete-record operations without retaining addresses or secret values. Native return values, failures, queues, required publication, and model-selection response timing are preserved.

Both installers require the calling context and its independent root to hold the exact barrier binding, and recheck it before admission and queued submission. Runtime must retain each hook's calling fiber until terminal confirmed quiescence; forced fiber disposal can remove a native hook without passing the explicit disposer guard. Actual Settings/editor nesting shares native admission, while cross-service nested work remains enrolled in the same barrier operation.

The editor hook can observe legacy import when installed through boot-time injection before Loader settles. Installation after readiness cannot account for earlier writes. Credential injection runs after provider initialization, so the local provider's initial flat-document migration remains outside this hook. Runtime must resolve that startup gap and complete graph, lifetime, and actual I/O budget integration before opening the account.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Runtime inputs](../pe-cloud-runtime/README.md) — account identities and lifecycle ownership.
- [Native Session API](../../api/session-controller/README.md) — commands, history, and streams.
- [Gateway](../../api/gateway/README.md) — native transport and Peer rules.
- [LLM](../../llm/llm/README.md) — actual streaming dispatch.

-----

<a id="model-experience"></a>
## Model Experience

### Model-call admission

#### What the model sees

This package contributes no prompt text or tool schema. The `llm/stream` listener checks `provider` and `model` before the native adapter; rejected calls do not reach it. Approved calls retain the native request and session history.

#### Token effect

The package adds zero request tokens.

#### KV Cache effect

The guard preserves request content and any reusable prefix; provider cache availability remains provider-owned.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The account entry fails explicitly while mandatory integration is absent.

- Native inventory extraction, transport routing, project verification, and binding issuance are external integration requirements; this package does not publish ready. Account-view tests use simulated inventories and establish policy isolation, not actual native UI inventory or bootstrap capabilities.
- F06 submission coverage for every reachable native writer and runtime assembly remain incomplete. The coordinator and reviewed native adapters do not establish full F06 acceptance; model selection and configuration writes remain closed in the account entry.
- Startup credential migration, other credential providers, PluginManager writes, and skill publication/projection remain uncovered. Watch refreshes and optional listener work retain native semantics and are not certified as durable saves by hook registration.
- F09 impact preflight, controlled commit, plugin/key/skill mutation, and version-resource hooks remain closed.
- Native profile tests cover default-model, Settings, direct editor, local credentials, and the startup installation gap. Actual private Controller assembly tests exercise native Gateway dispatch, creation, prompt, fork, synchronous cancel, and the ordering of a resume attempt. Full persisted-account recovery, authenticated Web, and full cloud recipe acceptance remain integration requirements; product builds and those checks belong to the coordinator.
- History tests use real JSONL reads and cold follow recovery. The private AgentLoop adapter guards ordinary factory activation, but production assembly and the trusted project/model/Preset provider remain absent. Other activation and child paths still need review; account assembly remains closed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
