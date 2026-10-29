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

`CloudAccountApi.prepareCloudProjects(owner, { createProject })` installs one additive `cloudProjects/create` Remote before inventory auditing. Its request contains only an optional display title; an explicit blank title or a title exceeding 256 UTF-8 bytes rejects before allocation. The trusted callback captures account authority, allocates through files, and returns the original native `WorkspaceValue`. Native `workspace/create(path)` retains its existing-directory registration and idempotence. Cancellation joins the actual callback and does not promise rollback; an unknown result must not be replayed. The exact exposure row is `cloudProjects/create`, `native:cloudProjects`, `authenticated-account`.

`CloudAccountApi.createWorkspaceFiles(owner, nativeConfig)` constructs the sole original WorkspaceFiles in its Loader fiber after its complete native inject list is ready. It captures the original binding and the fs, sandboxPolicy, sessions and typert registrations, then rechecks their values, fibers and uniqueness for inventory and workspaceFiles RPC/stream admission. Inventory derives every original Remote marker and mode; the manifest still selects exact endpoints. The native class, DTOs, lookup, file I/O and stream cleanup are unchanged. The deployment must retain the Runtime resolver that requires a trusted Agent or the original Gateway invocation; registration grants no path authority and adds no watch support.

-----

The optional `approvedConfiguration.fields` rows select exact namespace/field pairs and optional finite scalar `values`. Root requires the same complete `allowedSettings` set and one original `settings/mutate` writer. Only active native top-level scalar Settings forms are supported; missing, structured or secret leaves reject. Trusted first-screen preparation retains the original login Peer/AccountUse through the native Controller result. A mutation requires a nonnegative safe-integer `expectedRevision` and unique approved single-leaf paths; alternate methods and unknown original JSON fields reject. The existing `locale/preference` policy still requires exactly `values:["zh","en"]` and permits only one matching `set`. The original Settings, ConfigEditor and account-save barrier own persistence and live application. Pre-replacement refusals settle without containment; post-replacement unknown outcomes remain retained and trigger original account containment. `hasDocument` remains false, and omission preserves readonly behavior.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Under the [runtime debug observation policy](../pe-cloud-runtime/README.md#understand-the-implementation), native `session/follow` records only an actual opening snapshot after its original guards and immediately before yielding it. This metadata does not establish browser receipt or rendering; the original iterator still owns cancellation and cleanup.

The root owns an immutable policy and revokes its audit when its fiber is disposed. The [exposure implementation](src/exposure.ts) uses exact maps without path decoding or prefix grants. The [private native assembly](src/native.ts) registers one subclass of the public SessionController, inheriting its Config, DTOs, Remote markers, and business methods. Create, prompt, and fork await shared project/Preset validation and recheck admission immediately before calling native super. Synchronous cancel checks the actual attached Agent's existing scope, then preserves native cancellation or notfound without loading a Session.

The private [account exposure view](src/account-exposure.ts) selects a subset of the root's frozen manifest with the same recipe. RPC and stream categories, Fetch methods/paths, handlers, guards, and settings fields must match exact root declarations. Each graph owns its inventory audit and disposal invalidation; A's audit or invalidation leaves B and root unchanged. Audit and operation admission check the exact installed AccountBinding and trusted graph/mount-current callback, allowing restricted mounting before ready while rejecting stale or closed graphs. Existing ExposurePolicy consumers accept this view without a new Loader service or global account registry.

Trusted constructor preparation reports provider, bootstrap-policy and inventory phases to the runtime's [private startup observer](../pe-cloud-runtime/README.md#understand-the-implementation). Callback exceptions cannot affect auditing or publication; this callback is not a Loader option or Remote endpoint.

Page and follow await the shared project guard for ordinary Session addresses. Page rechecks admission before the native read and before returning its result. Follow requires the reviewed stream declaration and checks admission and cancellation before each native advance and before delivering its result. The native iterator receives caller and graph-lifetime cancellation and retains history, promotion, and cleanup ownership. Subagent history addresses remain denied pending their separate scope review.

Controller admission uses the installed graph AccountBinding and the same trusted business-ready callback as the actual LLM guard, independently of HTTP/Peer AccountUse lifetimes. External AccountUse also requires business-ready; the view's graph/mount-current audit cannot replace that check. Assembly must declare native dependencies, retain its owning fiber, and exclude a second base Controller. Shared guard failures, stale bindings, revoked exposure audits, or disabled handlers prevent delegation. Native in-process calls preserve thrown guard errors. Shared cloud Remote codes guarantee code and message; each producer owns its details payload. `CloudApiError` retains its code, fixed diagnostic and empty details through native Remote error encoding; unknown errors retain the Gateway's internal-error classification. Native business results and failures remain unchanged.

The Controller requires a fixed `NativeSessionGuards.projectDirectory` capability carrying the exact installed binding and an awaited `prepare(cwd)` operation from trusted files assembly. Its protected native override checks binding, business admission, audited exposure, and handler availability before and after preparation, so late results from closed or replaced graphs cannot create an Agent. The capability uses the existing bounded files lane and independently verifies the approved project; cwd is an input, not a grant. An existing approved S2 project may be validated after registration closes, while new directories retain the provider's original approval requirements. There is no host mkdir fallback, additional files pool, or registration-window reopening in this adapter.

Trusted runtime preparation constructs the public `CloudAccountApi` service with the exact binding, separate mount/business checks, deployment exposure and root-issued save barrier. Its `providers` supplies the fixed native editor and credential constructors, plus the guarded manager when explicitly prepared; its native installation methods retain the existing Controller, AgentLoop and LLM guards. The empty `/account` entry requires that exact prepared `peCloudApi` owner. Service presence and entry activation do not publish account readiness: runtime still owns actual files/Workspace/Preset/model checks, inventory audit and ready publication.

Trusted preparation may supply `inspectRootFetch`, a bounded read of the original Root registrations. Prepared inventory combines these actual facts with native uploads before the existing exposure audit. Fetch dispatch and bootstrap reread the same producer and require exact method, path, handler and guard; withdrawal, mismatch, duplicates or excess entries reject. Missing callbacks cannot certify selected Root routes, and actual entries share the existing native inventory budget.

`auditPrepared(owner, signal?)` requires the factory's original unpublished authority and the same shared policy and finite native-inventory limit. It checks mount/unpublished authority before and after asynchronous policy reads, derives selected handlers from the actual guarded Controller methods and original native Typert markers/routes, and invalidates a previous audit on failure. Inherited unguarded methods cannot satisfy a manifest declaration. It performs no business operation and grants no ready state; business calls still require the separate ready check.

The fixed optional first-screen installation delegates `session/list` and `session/control` to the original SessionController, `workspace/follow` to the original WorkspaceController, and `remoteAccess/follow` to the stock Peer-aware RemoteAccess service. List rows and control frames use the same original AccountPolicy readonly metadata check; it can inspect a published Session before Workspace attachment without issuing command/history authority. Cold ids retain only their existing approved Workspace relationship, and native list rows also verify original project, parent and available projection fields. Workspace feeds validate each exact Registry object through the shared project guard, support multiple approved projects, and require a unique project relationship for every returned Session. Native `workspace/create(path)` only adopts an already registered approved project; directory allocation uses the separate Cloud project capability. Collection count and complete native result/frame bytes have explicit finite limits. The reader also requires `maxQueuedEvents` and `maxQueuedBytes`; it validates and copies these with the frame limit into the original native control queue through `controlBufferLimits()`. The native baseline check can therefore reject before Cloud result inspection. No Remote argument or queue implementation changes here. The original six Session guards remain in place.

`workspace/initializeDefault` calls the original Registry helper with a rejecting directory resolver, so it may reuse only the exact files-owned default Workspace. It cannot open a Documents fallback, create a directory or reopen registration. `settings/describe` and `settings/mutate` replies project only approved native schema leaves and their resolved/base/user values, retaining original revisions and live application. Without writable fields, describe retains the existing readonly `locale/preference` view; missing or replaced providers/locale fibers reject. By default, `writable=false` and `hasDocument=false` describe the operations available through this Cloud API; they do not claim that a physical settings document is absent. Without an explicit approved field policy, `allowedSettings` remains empty. Model selection/catalog and other Settings methods remain closed.

The [readonly event source](src/first-screen-events.ts) attaches the actual Session added/removed/activity/status/error notifications and approved form document updates (readonly locale by default) to the original Gateway's public registration. The Gateway produces `$events` ready/client ids and wire framing with the exact original `profileContext.home`, checked against runtime's expected home. No waterfall or `$events/result` handler is admitted. Required explicit home, event-count, resident-byte and complete emit-frame bounds have no deployment defaults. Source overflow retains its first error, invalidates this account's audit, unregisters listeners and joins the original registration disposer; stop and withdrawal await the same cached work. The same explicit queue/frame values are passed to the original Gateway registration's per-client budgets. A downstream client overflow fails only that actual event stream; the source, API audit, healthy clients and later ready generations remain available. Native dequeue and closure release that queue's resident bytes; the original iterator/carrier still owns actual cleanup and resource settlement.

`assertBootstrapCurrent(owner, signal?)` requires the original shared policy callback and a positive finite `maxNativeInventoryEntries`, with no default. That budget charges all selected exposure rows before traversal, then each visited runtime and fiber before inspection in one scan; excess rejects before policy metadata. It checks mount/business admission, audited exposure, the original Controller/AgentLoop/LLM objects, their unique ACTIVE owning fibers and the actual LLM listener before and after the policy metadata read. Duplicate installations, replacement or listener disposal reject. Omitted callback or budget preserves general preparation but keeps this assertion closed. Cancellation follows the caller and graph lifetime. It resolves to an API-issued synchronous recheck of the original binding, business admission, native guards and audited endpoints; callers invoke it before response publication. It creates no business resources or readiness authority.

Root configuration may additionally supply `approvedConfiguration`: explicit recipe/catalog revisions, finite entry/string/complete-byte limits, a nonempty fixed installed DSH entry or bundle catalog with installation disabled and toggling closed unless the fixed optional control below is selected, closed skills, read-only credentials and no writable fields. The canonical parser detaches and freezes the complete value before the original `ExposureService` retains it. Omission preserves exposure-only composition and supplies no catalog. This is approval metadata; bootstrap must still match the actual account Loader entries, package versions, original modules and configuration plans before projecting public ids. The base catalog enables no installer, writer or endpoint.

The [private AgentLoop factory](src/native-agent-factory.ts) checks the same installed graph binding and awaits shared project/model/Preset admission before native persistence creation or resume write-open. Installation checks the installed graph identity before business readiness; trusted runtime assembly verifies mount authority. Every create, resume and publication requires the separate business admission check. It preserves original setup and its synchronous commit, checking the actual prepared Agent after setup and around that commit. Ordinary root Sessions allow absent or zero delegation depth. Child create/resume additionally requires the original Root capacity callback, shared `withChildPreparation` guard and native Workspace preparation; omission keeps children closed. The guard wraps the original setup Promise and revokes its directory selection before full Workspace preparation; it does not settle original I/O or child capacity. Seeded paths, configured startup agents and direct AgentLoop.create remain closed. The owning recipe declares the native AgentLoop dependencies and excludes a second loop.

Native persistence append can await between setup commit and registry publication. Caller and graph-lifetime cancellation reach the native transaction. The original setup commits once; its synchronous current check runs after append settlement and at native publication checkpoints. Caller cancellation after successful publication keeps its native creation-only meaning and does not cancel the committed Agent. Runtime must retain already admitted work through reconfiguration and actual teardown; a rejected observer alone does not prove that late backend ownership has closed.

The selected child path retains exact parent, Session, Registry, account epoch and graph identities. It reserves the actual runtime depth from the original `RuntimeCapacity` and settles only through native cleanup. Failed Workspace persistence or unknown native cleanup retains capacity; the original resource callback must synchronously close business admission and retain the account owner for drain/quarantine. Settlement must not abort or dispose its own in-flight callback.

The [LLM listener](src/llm-guard.ts) checks the account generation and approved provider/model immediately before the native stream continues. It preserves frozen request options. The account factory must supply the same approved set used by catalog and selection.

Runtime creates and retains one [configuration coordinator](src/config-saves.ts) with explicit global/account running, queue, tracking, nested-work, and observer limits. Admission records responsibility synchronously before invoking the native callback. Saves run serially per account; required nested writes join the executing operation and cannot wait behind themselves. Mandatory apply remains part of the same result.

Pause closes top-level admission but permits enrolled work to finish; only a quiescent, failure-free pause may reopen after runtime re-audits the graph. Stop is terminal. The runtime-owned coordinator can commit one final configuration on its exact stopped, empty, failure-free barrier before graph disposal; nested native hooks use the existing bounded turn, while ordinary admission and resume remain closed. Observer cancellation or deadline expiry returns unknown without releasing actual work or capacity. Failed and unknown outcomes retain sanitized evidence and tracked capacity; this package offers no automatic failure clearing.

The [native adapter](src/native-save-hook.ts) connects public native hooks to that same barrier through internal helpers for account assembly and package-local tests. `installNativeConfigSaveHook` admits default-model saves, Settings writes and legacy rename, and direct ConfigEditor edits; other top-level writer identifiers are refused. The older `installNativeDefaultModelSaveHook` retains its narrower scope; install only one editor hook. `installNativeCredentialSaveHook` observes the local provider's set, unset, modify-record, and delete-record operations without retaining addresses or secret values. Native return values, failures, queues, required publication, and model-selection response timing are preserved.

Both installers require the calling context and its independent root to hold the exact barrier binding, and recheck it before admission and queued submission. Runtime must retain each hook's calling fiber until terminal confirmed quiescence; forced fiber disposal can remove a native hook without passing the explicit disposer guard. Actual Settings/editor nesting shares native admission, while cross-service nested work remains enrolled in the same barrier operation.

The private [prepare-time installation](src/account-install.ts) returns two fixed native subclasses that bind hooks to their actual constructor receivers before initialization. This covers the local credential provider's initial flat-document migration and Settings legacy import without copying native queues or writes. Credentials require an explicit absolute path and watch=false. The handle carries the exact installed binding and root-issued barrier, exposes existing pause/resume/stop controls, and starts with an unaudited exposure view. Withdrawal requires terminal, failure-free settlement, waits for actual native Loader initialization, and neither disposes the account Context nor releases root capacity.

Service-ready hook installation cannot account for earlier initialization writes. The constructor path closes that local migration gap, but runtime must still retain hook fibers and initialization ownership through late settlement, re-audit before resume, and provide actual graph, storage authority, and I/O budgets before opening the account. Failed saves retain evidence; observer cancellation and forced fiber disposal do not establish clean teardown.

Optional native upload assembly inherits FileUploads' streamed route, Agent resolution, receipt binding and retirement. Its original pending-receipt/intake capacity is explicitly selected; the account adapter awaits the controlled store hook before native receipt publication. Encoded file upload and inline encoded images remain closed. Prepared audit checks the unique active owner, unchanged native dependencies and streaming route before exposing the exact POST path. The native Session Controller awaits same-Agent file preparation before its original prompt admission/bind/delivery, and keeps accepted-request deduplication first. No account adapter reimplements upload storage, receipt tables or prompt delivery.

The model-key adapter accepts only Root-approved native references and delegates native set/unset to the existing account save owner. Its strict Typert codecs reject undeclared fields and bound UTF-8 values and complete reply metadata; responses contain only native nonsecret state or confirmed persistence and an opaque version. The original request borrow, business admission, exposure and matching masked environment are checked again inside the existing serial turn before native work. Known read-only refusals settle without a failed-save receipt; submitted failures retain the original owner responsibility.

Approved references still require the existing checked edit; direct unversioned native set/unset remains refused. Native record/OAuth ownership is unchanged. The edit token is graph-local, not a disk revision; persistence stays with the original credentials file lock, atomic writer and notifications.

Production ingress passes its original request/Peer current check as the third argument to `CloudAccountApi.modelKeyAccess`. The adapter repeats that read-only check before and after admission and inside the existing credential save turn, so a queued request whose login closes submits no native write. The callback adds no borrow, release owner or cancellation of submitted work. Omission retains trusted in-process behavior and does not authorize a login carrier. A refusal after native persistence does not undo the save and must not trigger an automatic replay.

Explicit `approvedConfiguration.modelKey.bindings` selects a finite nonempty list of `{ provider, providerEntryId, moduleName, ref }`. The catalog entry/string/complete-byte bounds apply to this data; provider ids are unique. The same selection drives codecs, environment masking, native provider metadata and the save whitelist. Each original module import, active fiber, configurable provider namespace/path, native `credential-ref` schema role and actual `apiKeyEnv` value must match. Metadata retains original redacted schema, model configuration, layers and revisions with settings writes closed. Key policy also requires positive finite `maxKeyBytes`, `maxVersionBytes`, `maxReplyBytes` and `maxMetadataBytes`. Trusted preparation installs the unique `cloudModelKey` service with `metadata`, `describe`, `set` and `unset` RPCs, handler `native:cloudModelKey` and guard `authenticated-account`. Prepared audit requires its original markers and strict generated Typert descriptors. The service checks the original invocation JSON before saving; generated object projection cannot admit extra fields. Native credentials/set and credentials/unset remain closed; settings/mutate requires the independent exact approved native field policy.

`cloudModelKey/metadata` returns `ModelKeyMetadata` from the actual approved providers and native Settings descriptors. It projects each Root-selected binding's actual provider/configuration route and the original redacted Settings schema, resolved model configuration, base/user layers, revision and secret-presence metadata; settings writes remain closed and credential edit versions are omitted. Supported routes use native Models `apiKeyEnv` credential references and `models` declarations; OAuth/record credential support is not expanded. Missing, changed or withdrawn module/config/service facts reject. Root masks all selected references before native mounting and gives them to the existing save owner. Native persistence and subsequent model requests retain their original owners; no validation request, automatic retry or cross-store transaction is added. Authenticated PostgreSQL/ready-Use and browser acceptance remain separate integration requirements.

Explicit `approvedConfiguration.pluginControl` enables the finite approved catalog's generic `cloudPlugins/current` and `cloudPlugins/change` unary group, both owned by `native:cloudPlugins`. Each controlled item fixes its id, native entry, exact module/package/version, entry or bundle `selectionTarget`, operation permissions, maximum impact and ordinary Config paths. The reminder tuple is example data. `current` projects each approved ordinary path through the public native `createConfigProjector`; `configure` accepts a literal JSON value at one approved path. Volatile fields retain the independent Settings live-only path. Native schema and impact checks still decide whether the actual change is supported; catalog approval grants no dependency or lifecycle proof. Complete profile, request, reply and version bytes remain bounded; no package installation, module specifier, profile filename or raw manager RPC is accepted.

Fields report `writable`, an optional `readOnlyReason` and native relative secret-presence markers. Protected fields use an opaque empty schema, so neither secret defaults nor schema constants cross the response; values are omitted, and secret-presence markers reuse Settings redaction. Complete-field writes and terminal acceptance refuse protected or unproven fields before native publication. Pure ordinary objects and arrays remain editable; approve an ordinary child path to edit a mixed container. Secret writes remain closed here, and volatile edits retain Settings.

The original save owner issues and compares opaque epoch-bound plugin edits against the bounded revision of the original patch and manifest together. `if-idle` requires the runtime’s actual exclusive window, applies through the original Manager or ConfigEditor and native prepared plan, then returns `applied` after the original re-audit. Explicit `stop-and-apply` returns only `accepted-rebuild`: the original factory joins the initiating carrier, closes Peers, confirms terminal native/files/execution drain and flush, then applies the checked intent through the old graph’s original writer and stopped save owner before withdrawal or disposal. The replacement claims a new epoch and assembles from that persisted configuration. Clients reconnect and read actual state; acceptance never certifies application. For local updates, confirmed no-publication refusals leave following saves available; unknown native outcomes retain the original save/factory responsibility and forbid automatic replay.

Credential references, the skill directory and the approved plugin profile keep separate edit tokens in the same `AccountSaves`. Skill work and required application/provider disposal retain that turn and prevent an exclusive paused plugin change. Plugin nested writers join the original paused or terminal turn; top-level skills retain ordinary live admission. Failed or unknown saves block reopening, and terminal stop remains terminal. Paused plugin permission grants no raw Settings, credential or manager/package writer authority.

`approvedConfiguration.bundles` approves an exact preinstalled bundle package/version and its complete finite native member identities and package versions. These items permit only `selected`, require `maxImpact: graph` and empty Config fields, and may accompany an empty `plugins` list. Their current state contains original `BundleInfo` as `bundle`; entry items retain `plugin`. Explicit `stop-and-apply` persists once through the stopped original save owner without activating the old graph. New assembly verifies the original intent, persisted revision, fresh versions, actual Entry options and live provider/injection ownership before ready. Default `if-idle` complete-graph selection remains closed.

Explicit account recipe entries can select the original Commands, Goals, permission presets, UserQuestions, feedback and Session-log export through the private runtime builtins. These services retain their native registries, projections, revisions, queues and persistence. Each actual RPC, stream or Fetch registration must match the reviewed exposure and original provider identity; a browser control selection alone grants no operation. Model catalog filtering uses the same approved provider/model routes as prompt dispatch, preserves native effort metadata, and rechecks admission at the native selection commit.

Commands recheck the original account and Agent after attachment admission, immediately before the native handler. Native question waterfalls use the original Remote projector and result protocol; delivered unanswered questions remain charged against the same event and complete-frame byte limits until settlement. Disposal and request cancellation reject pending questions. Feedback uses the native queued JSONL writes and an account-scoped anonymous display identity; a write already started retains its original flush/close responsibility after admission closes.

Permission controls require the enforcing Files/Shell pair and original issued execution port. Only read-only and workspace-write with approval never are supported; retained command/service work or a live descendant blocks switching, and readonly ancestors cannot be broadened by a child. Initial permission seeding requires installed enforcement; public catalog and mutation still require business admission. Native export checks account/project admission before reads and again before sending the ZIP; request, generation and registration cancellation own the stream. ZIP layout and cleanup remain native responsibilities.

</details>

-----

<a id="further-exploration"></a>
### Controlled sample publication

`CloudSkillService` supplies eight concrete strict Remote methods: the legacy `current`/`publish` pair and `installed`, `details`, `install`, `update`, `uninstall`, `download`. Trusted assembly supplies mandatory `managed` API limits, the installed files bundle limits, and the original workspace guard. `skills.mode=managed` requires all eight exact authenticated-account endpoints and explicit `management` limits. The source does not supply deployment defaults. All DTOs are exported by `/types`; Client declarations are generated from these methods.

One files-owned `skills/current.json` catalog and one `AccountSaves` edit cover every installation. Ordinary reads preserve schema1 as the legacy sample. The first schema2 mutation preserves that sample and other immutable versions. `current` observes the entire catalog revision even without a sample; any install, replacement, removal or legacy publish invalidates an older edit. Sample replacement remains the complete two-file `publish` operation; general `update` refuses the legacy sample.

Complete files or ZIP input is passed to files without host filesystem access or resource execution. Files owns package/path/type/link/expansion validation, native CAS, source handles, full ZIP export, working-copy proofs, accounting and reclamation. A confirmed oversized-package refusal before publication returns `cloud/capacity`. Download checks the current installation and content version before entering the original files export borrow inside the save turn. Removing a catalog entry denies later loads; it neither kills scripts nor deletes existing writable project copies.

The original native parser discovers one skill root per installed bundle. Resource Markdown and nested `SKILL.md` remain bundle data. Native `skills.inspect()` supplies effective and overridden relationships; the API projects public origin fields and omits rank, locator and private paths. An optional workspace is resolved through the original registry and ownership guard; it supplies `cwd`, never a fabricated Agent scope. This management list contains catalog installations; it does not grant editing or download rights for unrelated project/runtime contributions. Their original discovery, approved roots and precedence remain native responsibilities.

Provider selection, source borrowing and complete resource preparation begin after original save admission. The prepare resident remains held through native validation and directory commit. Success releases it exactly once after required application/provider disposal; refusal or cancellation releases it after required failure cleanup. Confirmed CAS synchronously switches visibility, invalidates native caches and releases the resident handoff; the same save turn then awaits disposal of superseded native providers. Failed disposal remains charged and failed. Each native provider has a bounded owned lifetime, so replaced or rejected preparations do not accumulate parent abort listeners. Confirmed persistence with failed application returns `persisted:true, applied:false`; an unknown native commit returns `persisted:unknown, applied:false` and retains the original failure responsibility without replay.

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

- Production native inventory extraction, transport routing, project verification, and binding issuance remain integration requirements; this package does not publish ready. Policy tests establish view isolation; separate native Loader tests inspect actual public handler metadata. The installation tests use explicit runtime bindings and owned Node paths, not production owner or storage authority.
- F06 submission coverage for every reachable native writer and runtime assembly remain incomplete. The coordinator and reviewed native adapters do not establish full F06 acceptance; model selection and unapproved configuration writes remain closed in the account entry.
- Other credential providers and arbitrary manager/package writes remain outside the fixed controls. Watch refreshes and optional listener work retain native semantics and are not certified as durable saves by hook registration.
- General F09 impact preflight and arbitrary PluginManager mutations remain closed; managed skill mutations require their separately reviewed catalog capability, the separately selected single-reference key service has its own finite policy.
- Native profile tests cover default-model, Settings, direct editor, local credentials, constructor-time migration, and delayed startup/write settlement. Actual private Controller assembly tests exercise native Gateway dispatch, creation, prompt, fork, synchronous cancel, and the ordering of a resume attempt. Full persisted-account recovery, authenticated Web, and full cloud recipe acceptance remain integration requirements; product builds and those checks belong to the coordinator.
- History tests use real JSONL reads and cold follow recovery. Ordinary AgentLoop activation uses the shared project/model/Preset policy; production readiness additionally requires the original storage owner, prepared audit and actual runtime ready commit. Other activation and child paths remain denied pending their separate scope review.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
