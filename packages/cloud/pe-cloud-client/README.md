---
description: "Validate cloud browser limits and inspect captured native carriers without starting an unbound client."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-client

English | [中文](README.zh.md)

## Summary

Prepare one Cloud page from a bounded canonical bootstrap response before starting the native `AppWebEntry`. The `/client` Loader entry consumes that exact prepared owner and installs the existing native Connection with captured account/generation carriers. Missing or stale preparation fails closed. The [Web entry](../../../apps/web/src/cloud-web.ts) owns the PowerEvolve login presentation over the existing email/password Cookie authentication. This package does not implement a login form or prove backend account readiness.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

The Cloud Loader also mounts the generated API project-creation contribution and fills both native Workspace directory-flow slots with a localized title form. The shared modal presents a centered folder icon, project-name field and paired Cancel/Create actions. It adopts the returned native Workspace path through the original `onPicked` callback, preserving native idempotent registration. Blank and overlong titles do not submit; each open reports at most one successful allocation. Cancelling aborts the request signal and ignores late adoption while the original transport and server owner retain actual work. A failed or cancelled submitted creation disables resubmission in that flow instance and directs the user to refresh and inspect projects; no unknown allocation is replayed.

-----

<a id="use-this-package"></a>
## Use this package

The `/schema` export provides browser-safe public configuration validation; `/types` contains its configuration types. The Host entry declares the browser package and optionally injects public Web deployment inputs, without business services or authentication routes.

### When to choose it

Import this public `/client` namespace from the original native module table, then use `PreparedCloudPage.prepare(input, signal)` before Cordis activation. Its `ready` promise yields a decoded page owner after the bootstrap request settles; it does not certify a server account graph. Construct `AppWebEntry(container, { ...page.nativeOptions, modules })` with that same table and await `page.start(entry)`; do not call the bootstrap facade's `create()` twice. Retain the preparation and await `preparation.dispose()` before replacing the page. Only the Cloud `/client` entry installs Connection; the Host declares the original Connection module with `registerClientPackages(..., { activate: false })` so its ordinary plugin is not activated.

### Minimal configuration

Controlled preview navigation additionally requires explicit `client.servicePreview` policy (management/preview origins, exact `/cloud/service-preview` path and field/URL byte limits), a bootstrap `servicePreview: available` observation, and an application-owned `previewNavigation` port in `PreparedCloudPage.prepare`. Missing inputs leave the optional `servicePreviewNavigation` callback absent; no policy is added to C11. The callback accepts only the framework Session and recorded service handle, captures the original page C02 values, and contains navigation/refusal failures. The application port supplies synchronous ordinary GET navigation and localized feedback; server authentication, native Session authorization and registered-service checks remain required.

The Cloud Web application captures its document's navigation function before preparation and opens previews in a separate tab with `noopener,noreferrer`. Local refusal appears in the existing localized page chrome. The browser plugin contributes the native `dev_service` tool row only while the prepared callback, capability and page are current. It derives the action from bounded recorded task metadata and the framework Session; neither a history row nor process submission establishes authorization or HTTP readiness. Page revocation and slot withdrawal disable mounted callbacks.

The optional Host `web` field selects the existing `apps/web` Cloud entry through one structured `__DSH_CLOUD_WEB__` global. Omission preserves ordinary startup. `parseCloudWebManifest` requires explicit `client`, `decodeLimits`, `persistenceLimits`, `fields` and `auth`; authentication budgets are `requestTimeoutMs`, `maxRequestBytes` and `maxResponseBytes`. The fixed bootstrap path is `cloud/bootstrap`; binding fields must match access configuration. Unsupported identity, token and current-account fields reject.

A Host Loader row with `web` must explicitly declare `inject: ['clientModules']`. The declaration consumes the original registry and its Loader tree's trusted resolution base to register native Connection with `activate: false` and a fixed set of BFF browser services with `activate: true`. Their Host services are not loaded. The same dependency scope owns every registration and the public injection. Actual registration completes before the Cloud row activates; unloading joins async withdrawal. A missing dependency declaration or failed registration rejects without publishing the public manifest. Without `web`, the declaration requires no registry and registers no module. Browser inputs cannot select package names or resolution paths.

The fixed services include the original `fileUpload` browser provider required by Conversation's dependency declarations. Supplying that provider grants no upload route or RPC permission; its native Worker starts only when an upload is requested. Deployment still selects the UI Host declarations, and `PreparedCloudPage` remains the sole Connection installer.

The application owns localized Cookie login and exit controls. It discards bounded authentication response bodies, then uses the original dynamic factory and canonical preparation. `/client` re-exports the same factory's `ClientFailure` and `ClientFailureCode`. Logout revokes and joins the original page before real sign-out. Unknown mutations are not replayed; explicit status recovery reloads for read-only bootstrap. The server must reject identity replacement while a valid login Cookie remains, including across tabs. Ordinary refresh preserves its generation cache. A document retained in BFCache stops its old native graph and requires explicit status recovery.

The native browser Loader creates entries with `{ name }` and no per-entry configuration, so `/client` accepts empty configuration and rejects overrides. Supply every field below in the preparation input's `config`; `/schema` owns validation and supplies no production defaults. Preparation additionally requires explicit `decodeLimits`, `persistenceLimits`, binding field names, real storage, fetch and WebSocket factories. No native cache read or Connection is admitted before the prepared owner is bound by `prepareContext`.

| Field | Default | Meaning |
|---|---|---|
| `bootstrapPath` | required | Document-relative static bootstrap route, without query or fragment. |
| `bootstrapTimeoutMs` | required | Result deadline; actual request cleanup remains tracked separately. |
| `maxBootstrapResponseBytes` | required | Maximum bootstrap response bytes consumed before decoding. |
| `maxErrorResponseBytes` | required | Maximum inspected HTTP 409 response bytes. |
| `maxPendingFetches` | required | Maximum fetches waiting for headers or owned error-body handling. |
| `maxSockets` | required | Maximum sockets owned by one captured carrier. |
| `closeTimeoutMs` | required | Close-observation deadline; expiry does not confirm cleanup. |
| `maxDownloadBytes` | no default | Optional positive safe-integer download acceptance cap; omitted keeps both download actions unregistered. |
| `modelSettingsRequestTimeoutMs` | no default | Optional finite positive native model-settings RPC observer deadline; omitted keeps this integration closed. |
| `skillSettings` | no default | Optional `{ requestTimeoutMs, maxFileBytes }`; both fields are positive safe integers, with the deadline within the platform timer range. Omission keeps skill management closed. |

### Native Models key editing

`modelSettingsRequestTimeoutMs` is an optional finite positive native model-settings RPC observer deadline, bounded by the platform timer range; omission keeps this feature closed. The original `PreparedCloudPage` provides the typed Models integration before UI activation. Its editing source starts at `null`, accepts only callbacks captured from the original dependency scope, and is synchronously revoked before page cleanup waits. Page, Connection and dependency-fiber replacement reject old callbacks around awaited work; withdrawal never claims an issued save was cancelled. UI identity uses the original connection generation and dependency fiber, independently of metadata and edit tokens.

The explicit `client.modelSettingsRequestTimeoutMs` enables the original prepared page's Models integration. The existing generated API contribution is mounted once; the adapter consumes its actual `cloudModelKey.metadata/describe/set/unset` namespace. Readonly metadata feeds the original Models store. Opening an edit describes once and captures that version for set or key-only unset; background reads never replace it. Only the native validated `persisted: true` result confirms a save. Failures use localized fixed messages. Page or dependency revocation publishes null and invalidates old callbacks before asynchronous cleanup. Cloud fixes `onboarding: false` in this immutable page input before UI activation, so neither Welcome nor credential onboarding registers, including while the editing source is null or revoked. Configure the key manually in the original Settings/Models panel.

Configuring this deadline additionally declares the native `ui-settings-models` browser entry, using the deployment's existing `ui-settings` base. An explicit service-preview policy additionally declares `ui-tool`, which owns the tool-call card and its keyed tool views. These packages must be included in the actual publication scope with rebuilt browser artifacts; declaration alone does not prove browser activation or a rendered panel. Keep one supplier for each declared package. The general package owns the Settings panel; `ui-settings-shell` is a separate shell preference feature.

### Native skill management

`client.skillSettings` and bootstrap `configuration.skills.manage` enable the original `power-evolve-skills` panel and native sidebar. Registration makes no RPC. Explicit refresh reads the complete bounded `cloudSkills.installed` view into `PreparedCloudPage.skillVersionEditing`; the generated namespace dependency, native slots, locale dictionaries and shared feedback host remain the original owners. Limits come from the actual account response without browser defaults. Rows report installed versions and native source/coverage observations, not approved-catalog installation guesses or client priority calculations. A confirmed change invalidates other rows’ coverage observations and requests an explicit refresh; it never recalculates priority or renews an open edit.

Opening an installation reads `details` once and captures its directory edit version. Install, complete update and uninstall use that captured version for one attempt. Refreshing the list never renews an open edit. Details contain complete file metadata, not published instruction bytes; the panel reports that limitation rather than inventing a document. ZIP export reads the selected exact content version. Installation IDs and native names remain distinct, and opaque versions remain in captured callbacks.

Choose a complete directory, complete file set, or ZIP/.skill package. The browser checks finite path/file/directory/byte limits and strictly decodes the selected root `SKILL.md`; it neither parses skill metadata nor extracts archives. Original browser Files remain unchanged while instructions are edited separately. Submission reads every selected resource and replaces only the root instructions with edited bytes; it never executes scripts. Files/account owns actual decoding, path/link/type and expanded-size checks, immutable version issuance and resource lifetime. Removal stops future discovery/loading; it does not promise to erase history, remove existing project copies or stop scripts.

Confirmed persistence and native application remain separate. Conflict, uncertain completion and withdrawal retain the local draft and consume the write attempt; no mutation, prompt, replacement token or read is automatically replayed. Drafts may remain only in the same account/page/dependency scope. A different scope clears both generic and legacy selected content; late reads or writes cannot update it. Cancellation ends browser observation and does not assert server rollback or settlement.

Downloads use complete bounded ZIP replies and a temporary browser Blob URL; the adapter releases its anchor and URL after requesting the browser download. The displayed result confirms browser initiation, not operating-system file persistence. Reply checks happen after the native transport receives its bounded JSON; they are not a streaming allocation limit. Backend authorization, source integrity and resident accounting remain authoritative.

The folded legacy sample editor retains generated `current/publish` with `slot: 'sample'` and only complete `SKILL.md/resource.bin` inputs. It shares the original page source with the multi-skill view; its updates preserve generic rows and an explicit refresh observes later directory changes. The API keeps this legacy item in the same catalog authority. `maxFileBytes` in `skillSettings` continues to bound this two-file editor; generic package limits come from installed capability metadata. Public Client declarations retain their generated API Remote type dependencies without mounting another contribution.

-----

The Cloud entry installs downloads into the native document preview actions and unpreviewable slots only when explicit `maxDownloadBytes` is present and bootstrap filePreview is available. The registered adapter uses the framework-injected SessionId and owner.absolutePath with native `sessionFileAddress`, captures one original readBytes method and the prepared transport signal, and never reads global Session selection. Its independent `CloudFileDownload`/`FileDownloadButton` request complete bytes and save only an `application/octet-stream` Blob. A smaller consumer acceptance cap does not replace native read/body memory limits. One read remains owned until settlement; page revocation, declaration withdrawal, replacement and unmount discard late results, and temporary anchors/Blob URLs are released. Locale dictionaries belong to cloud-file-download and leave with the Cordis scope. A browser save request does not confirm an operating-system write or permit rollback of an issued request. Legacy seven-field inputs remain valid and keep downloads closed; native preview and server authorization remain authoritative.

The common management assembly presents the original bootstrap-approved plugin catalog through the generated `cloudPlugins/current/change` namespace and the existing sidebar and shell feedback. Explicit refresh reads each approved identity in catalog order. Opening an entry enablement, bundle selection or ordinary configuration edit reads once more and privately captures that original epoch/edit token. Published native metadata supplies each card's localized text and operation permissions; Preinstalled bundle selection uses the same approved identity and original `selected` operation. Its native `BundleInfo.enabled` supplies manifest selection, `installed` supplies the profile dependency declaration, `availability` supplies readable-file origin, and `version` supplies the published native version. A bundle without an Entry has no fabricated module or entry activation state. Bootstrap capability and actual operation permission are both required; this selection path exposes no package installer. Read-only entries keep empty operations/fields and need no maxImpact value. No account read occurs on mount, field selection, draft editing or locale change.

Ordinary configuration uses native JSON Schema metadata and the shared `ConfigField`/`JsonTree` controls. Each submission writes one approved path and a literal JSON value; the native validator owns schema acceptance. Schema limitations and omission metadata remain visible. Native field writable/read-only metadata governs every field. Redacted secret set states remain visible; existing secret values never initialize drafts, and secret/protected/volatile or unproven fields remain unavailable for ordinary writes. Loader expressions, prototype-control keys, raw Profile and YAML editing are unavailable. The current DTO has no unset operation, so restoring a default is unavailable and JSON null remains an explicit value.

Every submission requires an explicit `if-idle` or `stop-and-apply` choice. The latter visibly explains that account activity stops and reconnection may follow. The original page, dependency scope, Connection and current-issued version are rechecked; a consumed edit cannot submit twice, and old callbacks cannot alter a replacement. Applied, accepted rebuild, busy, conflict, unavailable and unknown remain distinct. Native persistence or `restart-required` does not become application in the browser. Accepted rebuild leaves selection unchanged until reconnection, bootstrap and explicit current reads confirm actual state. An unconfirmed result closes that item's controls until the result is closed and an explicit refresh establishes current facts; no operation is replayed or escalated. Updating one item preserves other catalog rows. Withdrawal closes admission synchronously and discards late replies. Package installation and removal require an actual approved account flow; the page preserves capability metadata without inventing that flow.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package keeps bootstrap request outcomes and native carrier lifetimes separate from authoritative account and Session state.

`/client` exports `PreparedCloudPage` for the pre-Cordis owner, plus the existing `CloudPageLifetime` and `CloudPagePersistence` components it reuses. Preparation calls access's canonical `decodeCloudBootstrap`, creates exactly one fixed lifetime and cache port, and exposes native options containing the required port, pre-activation owner binding and synchronous pre-disposal storage and carrier admission revocation. The real Loader `apply` verifies that owner before invoking public `installConnection` with captured hooks; it never writes a global current account or global transport.

The cache accepts finite positive safe-integer `maxKeys`, `maxKeyBytes`, `maxValueBytes`, `maxTotalBytes`, and `maxNamespaceBytes`. Byte budgets use UTF-8; total includes the physical namespace key and serialized envelope. Keys are logical and enumeration exposes only that namespace. Account/generation tuples use JSON encoding without delimiter collisions. No legacy unpartitioned cache is restored. Each mutation atomically replaces one bounded envelope; concurrent same-account/same-generation pages use last-writer-wins whole snapshots and may lose independent updates. Revocation is local to the issued port; it makes no cross-tab global-revocation claim.

`dispose()` synchronously revokes the old port, stops the captured carrier and native graph, joins their actual cleanup, then removes and verifies only the old namespace. Automatic 401/stale-generation closure and cache failure enter the same sequence. Late native subscriptions cannot write or delete through a revoked port. A failed stop leaves the namespace uncleared; a failed removal remains unconfirmed. A hung native disposer remains pending. Cleanup errors remain observable through the returned promise, page/cache snapshots and default-enabled console reporting. Same account/generation refresh restores its own cache; a different generation receives another namespace.

<details>
<summary>Implementation internals — click to expand</summary>

The internal bootstrap attempt performs one same-origin, document-relative GET with no automatic retry. Its caller supplies the owner's decoder; this package defines no replacement bootstrap DTO. The result rejects on cancellation or deadline while `settled` tracks actual fetch/body completion and `cleanup` separately records confirmation or uncertainty. Late bytes cannot invoke the decoder. Responses have an explicit byte limit.

The internal native transport captures the access package's `RequestExpectation` and `BindingFieldNames`. It preserves native RPC bodies and correlation, adds dedicated headers to HTTP, and adds dedicated query fields to native WS and navigation URLs. Conflicting expectations, external origins, and requests outside the app mount are rejected before sending. HTTP 401 and `cloud/stale-generation` invalidate the captured lifetime; other 409 responses retain their bytes for native handling. It never replaces a request's expectations or replays a mutation. While open, each socket closure requests a canonical bootstrap identity check; at most one check remains active until its actual fetch and body cleanup settle. HTTP 401 headers revoke the old page immediately, and a decoded account or generation mismatch also invalidates it. Same identity and transient failures, including network errors, timeouts and HTTP 503, retain the captured binding and native reconnect policy. Unconfirmed response cleanup still stops the carrier with a cleanup failure.

Closing rejects new operations immediately, aborts pending fetches and identity checks, and requests socket closure. It joins each check's actual settlement, including late response cancellation, rather than treating its prompt result as cleanup completion. Missing acknowledgement produces `unconfirmed`; pending work remains tracked and can later establish actual closure. This is carrier cleanup, not proof of Agent cancellation or account drain. Limits bound pending header fetches, sockets, bootstrap bytes and inspected error bytes; successful response-body and native subscription lifetimes remain with the native application.

A fetch body already errored by the exact captured abort reason is settled without source cancellation. A source cancellation rejection still leaves cleanup unconfirmed, even if it returns that same reason. The distinction uses the original reader’s closed/errored completion and retains actual cancellation work.

| Source | Role |
|---|---|
| [Browser entry](src/client/index.ts) | Consumes the prepared owner and installs original Connection. |
| [Bootstrap attempt](src/client/bootstrap.ts) | Tracks result, settlement, and cleanup separately. |
| [Captured carrier](src/client/transport.ts) | Adds access expectations around native carriers. |
| [Behavior tests](tests/transport.client.spec.ts) | Exercise native Connection envelopes and lifetime rejection. |

One approved configuration section consumes the original shared ConfigForms and schema service. It stages supported scalar leaf fields from the intersection of immutable bootstrap approval and current Host schemas; unknown or complex fields remain unavailable. Saves keep the revision captured when editing began and repeat original page checks at actual queued dispatch. The General Settings shell is supplied independently of model or skill editing. Ordinary ConfigEditor fields, nested paths, remount and graph-rebuild editing are not provided by this form.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these owners for the account checks and native browser behavior this package consumes.

- [Cloud access](../pe-cloud-access/README.md) — request expectation and authentication ownership.
- [Native Connection](../../client/connection/README.md) — native HTTP/WS carriers and connection generations.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — native application boot and state ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Browser transport without model context

#### What the model sees

Nothing from this package. `/client` registers no prompt or tool, and `BoundTransport` adds consistency values only to HTTP headers or WS/navigation query fields while leaving the native RPC body unchanged.

#### Token effect

Zero direct tokens. Bootstrap validation, binding capture, and carrier cleanup add no system text, tool declarations, retained Session content, or independent model request.

#### KV Cache effect

The package appends or replaces no model-request tokens and issues no independent model request. It adds no prefix-changing content; model composition and provider cache availability or reuse remain outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits remain outside local bootstrap and native-entry wiring.

- The canonical decoder validates metadata, not authentication, generation issuance or actual provider availability. Root must serve bootstrap only after its real authenticated account admission.
- The native Web kernel must await `prepareContext` before `bootClient`. Missing owner, wrong port, duplicate Connection provider and stale page lifetimes reject; lexical plugin order grants no preparation authority.
- Resources, upload Worker and downloads still require coordinated admission through the same binding. This package adds no independent mux or replacement Session UI, and does not publish complete Web acceptance.
- Production browser composition and S1/S2 acceptance require independent integration evidence. Component cleanup and cache tests do not establish full account admission or server drain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The cloud client consumes the existing access binding types through the package's `/types` export. Root source aliases, compiler aggregates, lockfile registration, public bootstrap fields, and build artifacts are coordinated outside this package.

</details>
