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

The prepared Cloud page disables the native Workspace delete action for the lifetime of its page root because this composition does not expose the delete RPC. The menu and any open confirmation show a localized reason; this display restriction does not replace Host authorization.

The `/schema` export provides browser-safe public configuration validation; `/types` contains its configuration types. Its empty runtime leaf is published at `lib/types/types.js`; unbundled browser compiler output is not part of the publication. The Host entry declares the browser package and optionally injects public Web deployment inputs, without business services or authentication routes.

### When to choose it

Import this public `/client` namespace from the original native module table, then use `PreparedCloudPage.prepare(input, signal)` before Cordis activation. Its `ready` promise yields a decoded page owner after the bootstrap request settles; it does not certify a server account graph. Construct `AppWebEntry(container, { ...page.nativeOptions, modules })` with that same table and await `page.start(entry)`; do not call the bootstrap facade's `create()` twice. Retain the preparation and await `preparation.dispose()` before replacing the page. Only the Cloud `/client` entry installs Connection; the Host declares the original Connection module with `registerClientPackages(..., { activate: false })` so its ordinary plugin is not activated.

### Minimal configuration

Controlled preview navigation additionally requires explicit `client.servicePreview` policy (management/preview origins, exact `/cloud/service-preview` path and field/URL byte limits), a bootstrap `servicePreview: available` observation, and an application-owned `previewNavigation` port in `PreparedCloudPage.prepare`. Missing inputs leave the optional `servicePreviewNavigation` callback absent; no policy is added to C11. The callback accepts only the framework Session and recorded service handle, captures the original page C02 values, and contains navigation/refusal failures. The application port supplies synchronous ordinary GET navigation and localized feedback; server authentication, native Session authorization and registered-service checks remain required.

The Cloud Web application captures its document's navigation function before preparation and opens previews in a separate tab with `noopener,noreferrer`. Local refusal appears in the existing localized page chrome. The browser plugin contributes the native `dev_service` tool row only while the prepared callback, capability and page are current. It derives the action from bounded recorded task metadata and the framework Session; neither a history row nor process submission establishes authorization or HTTP readiness. Page revocation and slot withdrawal disable mounted callbacks.

The optional Host `web` field selects the existing `apps/web` Cloud entry through one structured `__DSH_CLOUD_WEB__` global. Omission preserves ordinary startup. `parseCloudWebManifest` requires explicit `client`, `decodeLimits`, `persistenceLimits`, `fields` and `auth`; authentication budgets are `requestTimeoutMs`, `maxRequestBytes` and `maxResponseBytes`. The fixed bootstrap path is `cloud/bootstrap`; binding fields must match access configuration. Unsupported identity, token and current-account fields reject.

A Host Loader row with `web` must explicitly declare `inject: ['clientModules']`. The declaration consumes the original registry and its Loader tree's trusted resolution base to register native Connection with `activate: false` and a fixed set of BFF browser services with `activate: true`. Their Host services are not loaded. The same dependency scope owns every registration and the public injection. Actual registration completes before the Cloud row activates; unloading joins async withdrawal. A missing dependency declaration or failed registration rejects without publishing the public manifest. Without `web`, the declaration requires no registry and registers no module. Browser inputs cannot select package names or resolution paths.

The fixed services include the original `fileUpload` browser provider required by Conversation's dependency declarations. Supplying that provider grants no upload route or RPC permission; its native Worker starts only when an upload is requested. Deployment still selects the UI Host declarations, and `PreparedCloudPage` remains the sole Connection installer.

The application owns localized Cookie login and exit controls. It consumes bounded authentication response bodies to completion before using the original dynamic factory and canonical preparation. A canonical `cloud/login-active` 409 shows a localized instruction to use the existing explicit sign-out action before signing in again; other conflicts and unfinished responses remain unknown, without automatic sign-out, Cookie removal or login replay. `/client` re-exports the same factory's `ClientFailure` and `ClientFailureCode`. Logout revokes and joins the original page before real sign-out. Unknown mutations are not replayed; explicit status recovery reloads for read-only bootstrap. The server rejects identity replacement while a login Cookie is presented, including stale Cookies and cross-tab requests. Ordinary refresh preserves its generation cache. A document retained in BFCache stops its old native graph and requires explicit status recovery.

While Cloud bootstrap is pending, the Web entry shows the original native boot page without starting its Loader or touching page storage. A temporary socket loss remains on the native reconnect loop. When a Cloud page closes, the entry waits for its original graph, carrier and cache cleanup before offering an explicit document reload; an unconfirmed cleanup stays visible. A later 401 returns to login after cleanup, and an accepted explicit sign-in reloads the document before starting another native module system.

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
| `nativeSessionControls` | no default | Optional unique selection of `commands`, `models`, `permissions`, `goals`, `plan`, `feedback`, `export`, and `attachments`; omission supplies no additional controls. |
| `nativeManagement` | no default | Optional unique selection of `plugins`, `presets`, and `automations`; supplies the original management modules without granting Host operations. |
| `nativeSubagentSettingsNamespace` | no default | Optional actual Subagent Settings entry ID, 1–128 ASCII namespace characters; binds the native card without granting field access. |

The Subagent card uses this namespace with the current account's advertised fields. Native Settings and C04 still authorize reads and writes; omitted fields remain hidden. Removing the page binding withdraws the card's account-specific subscription.

### Native Session controls

`client.nativeSessionControls` supplies the selected original browser plugins without replacing their controllers or projections. Models, permissions, plan, feedback and export also require `commands`. The parser rejects unknown groups, duplicates and incomplete command dependencies; package names are fixed by the application. Host services, Agent-preset plugins and exact account admission must be composed separately. Selecting a browser group grants no method or filesystem authority. Permissions include the original approval dialog. Agent presets use the original roster, blank-Session selector and Settings default selector; Cloud supplies no read-only roster replacement.

Selecting `export` provides the original download plugin's HTTP and navigation integration before native activation. Its HEAD preflight uses the page's captured authenticated fetch, and its GET download uses the captured account/generation navigation binding. The original download controller still owns state, cancellation and disposal; an ended page rejects both integration operations. See [Session log export](../../session-query/session-log-export/README.md) for the native download contract.

### Native Models key editing

`modelSettingsRequestTimeoutMs` is an optional finite positive native model-settings RPC observer deadline, bounded by the platform timer range; omission keeps this feature closed. The original `PreparedCloudPage` provides the typed Models integration before UI activation. Its editing source starts at `null`, accepts only callbacks captured from the original dependency scope, and is synchronously revoked before page cleanup waits. Page, Connection and dependency-fiber replacement reject old callbacks around awaited work; withdrawal never claims an issued save was cancelled. UI identity uses the original connection generation and dependency fiber, independently of metadata and edit tokens.

The explicit `client.modelSettingsRequestTimeoutMs` enables the original prepared page's Models integration. The existing generated API contribution is mounted once; the adapter consumes its actual `cloudModelKey.metadata/describe/set/unset` namespace. Native metadata feeds the original Models store. When the native Settings policy approves the DeepSeek model catalog, the original provider editor writes the captured revision; credentials remain separately versioned, and unconfirmed writes keep the draft closed to retry. Opening an edit describes once and captures that version for set or key-only unset; background reads never replace it. Only the native validated `persisted: true` result confirms a save. Failures use localized fixed messages. Page or dependency revocation publishes null and invalidates old callbacks before asynchronous cleanup. Cloud fixes `onboarding: false` in this immutable page input before UI activation, so neither Welcome nor credential onboarding registers, including while the editing source is null or revoked. Configure the key manually in the original Settings/Models panel. The native Web search card can prepare an edit of that same approved account key through the existing Models callbacks. Each detail view owns its captured version; failure or page withdrawal closes the key input without a generic credential fallback.

Configuring this deadline additionally declares the native `ui-settings-models` browser entry, using the deployment's existing `ui-settings` base. An explicit service-preview policy additionally declares `ui-tool`, which owns the tool-call card and its keyed tool views. These packages must be included in the actual publication scope with rebuilt browser artifacts; declaration alone does not prove browser activation or a rendered panel. Keep one supplier for each declared package. The general package owns the Settings panel; `ui-settings-shell` is a separate shell preference feature.

### Native skill management

The Skills page has one Import skill package action, a full-width search, purpose filters and an installed-only switch, without recommended cards. Description cards expand from one column on narrow panels to multiple columns on wider panels; switches and installation controls stay independent of opening the detail dialog. Only actual source, version, state and native coverage observations are shown. Known native source codes are localized; mutable account imports use the Imported category, and the native `dsh-office` and `dsh-reports` bundled providers use Writing & office. Other bundled providers retain the Other category. Immutable content identifiers appear only under Package information in the detail dialog; they are never shown as release versions. The native interface currently supplies no semantic package version. Invocation flags are read-only package/deployment policy, including Currently not invocable when both are false; neither policy nor catalog visibility proves execution dependencies are available. This account interface supplies no invocation-policy mutation, so managed rows display no enablement switch.

`client.skillSettings` and bootstrap `configuration.skills.manage` enable the original `power-evolve-skills` panel and native sidebar. Registration makes no RPC. Selecting or reopening the Skills panel reads the complete bounded `cloudSkills.installed` view into `PreparedCloudPage.skillVersionEditing`; a source attached after selection is read once when it becomes available. Explicit Refresh reads again, while failed reads do not retry until another selection or refresh. the generated namespace dependency, native slots, locale dictionaries and shared feedback host remain the original owners. Limits come from the actual account response without browser defaults. Rows report installed versions and native source/coverage observations, not approved-catalog installation guesses or client priority calculations. A confirmed change invalidates other rows’ coverage observations and requests an explicit refresh; it never recalculates priority or renews an open edit.

Opening an installation reads `details` once and captures its directory edit version. Install, complete update and uninstall use that captured version for one attempt. Refreshing the list never renews an open edit. Cards open a native dialog with actual metadata, description and root `SKILL.md` rendered as inert Markdown when supplied by `details`. The footer Download action calls the captured complete-version capability. View details opens its file inventory. For immutable bundled skills only, its exact root `SKILL.md` reuses the original text from the same authorized details snapshot after UTF-8 round-trip, byte-length and SHA-256 checks against that response’s root metadata. Original account/observer checks run before and after hashing. A changed or removed selected content version on explicit refresh revokes this readonly view; close and scope withdrawal discard late results. A fresh details version is authoritative even after an older list observation. Other members and mutable or non-bundled skills retain the original exact-version `readFile` operation and file limit; no new route, quota or archive extraction is introduced. Listing or opening metadata never preloads every file. UTF-8 instructions and scripts are displayed inertly; binary files remain available through ZIP download. Closing or changing files aborts the old observation. Complete package replacement remains an explicit dialog action, alongside file browsing. ZIP export reads the selected exact content version. Installation IDs and native names remain distinct, and opaque versions remain in captured callbacks.

Import skill package opens the native ZIP/.skill picker directly. Cancel makes no request. Selection uses the existing `installZip` owner to read the current directory version and submit once; pending or unknown imports cannot be resubmitted. An existing installation can instead be updated from a complete directory, complete file set, or ZIP/.skill package. The browser checks finite path/file/directory/byte limits and strictly decodes the selected root `SKILL.md`; it neither parses skill metadata nor extracts archives. Original browser Files remain unchanged while instructions are edited separately. Submission reads every selected resource and replaces only the root instructions with edited bytes; it never executes scripts. Files/account owns actual decoding, path/link/type and expanded-size checks, immutable version issuance and resource lifetime. Removal stops future discovery/loading; it does not promise to erase history, remove existing project copies or stop scripts.

Confirmed persistence and native application remain separate. A new edit clears an earlier confirmed success while it opens; a failed installation-source read is shown separately from an invalid ZIP. A confirmed invalid-package refusal reports that the bundle was not published and asks for a corrected package, while preserving the draft without automatic retry. It does not emit a generic account-permission failure, and opening another edit does not retain an invalid-ZIP banner. A confirmed capacity refusal is shown as not installed; conflict, uncertain completion and withdrawal retain the local draft and consume the write attempt. No mutation, prompt, replacement token or failed read is automatically replayed. Drafts may remain only in the same account/page/dependency scope. A different scope clears both generic and legacy selected content; late reads or writes cannot update it. Cancellation ends browser observation and does not assert server rollback or settlement.

Skill package uploads and downloads use Base64 JSON and complete packages in memory, bounded by account `maxArchiveBytes` and complete request/reply byte limits. They do not provide a large-file binary stream. Downloads use complete bounded ZIP replies and a temporary browser Blob URL; the adapter releases its anchor and URL after requesting the browser download. A download failure is reported separately from local package validation. The displayed result confirms browser initiation, not operating-system file persistence. Reply checks happen after the native transport receives its bounded JSON; they are not a streaming allocation limit. Backend authorization, source integrity and resident accounting remain authoritative.

The legacy sample remains in the shared skill catalog and its generated `current/publish` API retains `slot: 'sample'` and complete `SKILL.md/resource.bin` inputs. The skills page does not display a separate sample editor. `maxFileBytes` in `skillSettings` continues to bound the two-file inputs; generic package limits come from installed capability metadata. Public Client declarations retain their generated API Remote type dependencies without mounting another contribution.

-----

The prepared page installs native file-tree management and preview download icons when `maxDownloadBytes` is explicit and preview is available. Downloads perform an account-bound HEAD preflight and then navigate to a captured account/generation GET attachment URL. File and ZIP content stays outside browser JavaScript memory; the browser owns progress, cancellation and persistence. Success adds no permanent toolbar message, and a failed preflight shows a short localized error. Disposal cancels the preflight; a browser download already handed off is controlled in the browser. Uploads use File bodies and preserve selected folder paths; picker limits come from the server and the original intake and disk quota remain authoritative.

The [workspace upload helper](src/client/workspace-file-upload.ts) computes SHA256 from bounded Blob slices before sending the original File through the captured account fetch. The caller supplies the page and operation signals and explicit file, read-chunk and complete metadata budgets. Management selects this path only from the original HEAD preflight protocol, normalizes Native absolute tree directories against that same server-selected root, and retains folder creation and collision results. Its hash slice is bounded by the server chunk ceiling, page metadata budget and file limit. Without that installed protocol, existing Native workspace upload behavior remains selected. Success requires the exact Cloud publication kind, byte count and digest, with the original name or a native numeric collision suffix in the requested directory; it grants no conversation attachment reference. Cancellation during hashing joins the current bounded read. After HTTP submission, only the canonical refusal confirms no publication; other failures remain unconfirmed and are never replayed automatically.

The common management assembly presents the original bootstrap-approved plugin catalog through the generated `cloudPlugins/current/change` namespace and the existing sidebar and shell feedback. Selecting the plugin panel or explicitly refreshing reads each approved identity in catalog order; an unread catalog is distinct from an unavailable one. Opening an entry enablement, bundle selection or ordinary configuration edit reads once more and privately captures that original epoch/edit token. Published native metadata supplies each card's localized text and operation permissions; Preinstalled bundle selection uses the same approved identity and original `selected` operation. Its native `BundleInfo.enabled` supplies manifest selection, `installed` supplies the profile dependency declaration, `availability` supplies readable-file origin, and `version` supplies the published native version. A bundle without an Entry has no fabricated module or entry activation state. Bootstrap capability and actual operation permission are both required; this selection path exposes no package installer. Read-only entries keep empty operations/fields and need no maxImpact value. Application startup, field selection, draft editing and locale changes do not read the account catalog. When the original account management read reports a live managed Shell provider, the native Terminal card shows its actual timeout, maximum timeout and per-stream output cap as read-only values. The card is withdrawn with the account page.

Ordinary configuration uses native JSON Schema metadata and the shared `ConfigField`/`JsonTree` controls. Each submission writes one approved path and a literal JSON value; the native validator owns schema acceptance. Schema limitations and omission metadata remain visible. Native field writable/read-only metadata governs every field. Redacted secret set states remain visible; existing secret values never initialize drafts, and secret/protected/volatile or unproven fields remain unavailable for ordinary writes. Loader expressions, prototype-control keys, raw Profile and YAML editing are unavailable. The current DTO has no unset operation, so restoring a default is unavailable and JSON null remains an explicit value.

Every submission requires an explicit `if-idle` or `stop-and-apply` choice. The latter visibly explains that account activity stops and reconnection may follow. The original page, dependency scope, Connection and current-issued version are rechecked; a consumed edit cannot submit twice, and old callbacks cannot alter a replacement. Applied, accepted rebuild, busy, conflict, unavailable and unknown remain distinct. Native persistence or `restart-required` does not become application in the browser. Accepted rebuild leaves selection unchanged until reconnection, bootstrap and explicit current reads confirm actual state. An unconfirmed result closes that item's controls until the result is closed and an explicit refresh establishes current facts; no operation is replayed or escalated. Updating one item preserves other catalog rows. Withdrawal closes admission synchronously and discards late replies. Package installation and removal require an actual approved account flow; the page preserves capability metadata without inventing that flow.

When the original bootstrap approves remote management, the native Settings Servers section supports ordered account CRUD, uploaded key/known_hosts files and text-only SSH config import. Facts stay unknown until a real chat probe; refresh reads observations. The native `@` source offers only configured current references and rechecks them before message serialization. Account-page withdrawal removes the section/source and clears local form/file state.  The server instructions explain that cancellation and timeout stop local waiting while the remote program may continue; users must check remote state before retrying.

<a id="understand-the-implementation"></a>
## Understand the implementation

The package keeps bootstrap request outcomes and native carrier lifetimes separate from authoritative account and Session state. The native Agent Presets adapter reads the inventory through its injected Remote owner. Missing or replaced dependencies keep that adapter read-only and reject pending reads until the current owner is available.

An explicitly installed account-bound release binary capability can preflight the exact version before exposing a download callback. The consumer checks bounded length and SHA-256 metadata again before handing off the captured account/generation attachment URL. The server verifies complete archive bytes and SHA-256 on the original response route; browser JavaScript does not buffer the archive. The browser owns subsequent progress, cancellation and persistence, so handoff does not confirm a saved file. Missing or refused capability preserves the unavailable UI and existing JSON action limits. Independently bounded inventory reads do not require archive download availability.

`/client` exports `PreparedCloudPage` for the pre-Cordis owner, plus the existing `CloudPageLifetime` and `CloudPagePersistence` components it reuses. Preparation calls access's canonical `decodeCloudBootstrap`, creates exactly one fixed lifetime and cache port, and exposes native options containing the required port, pre-activation owner binding and synchronous pre-disposal storage and carrier admission revocation. The real Loader `apply` verifies that owner before invoking public `installConnection` with captured hooks; it never writes a global current account or global transport.

The Web entry supplies its existing joined cleanup and Cookie logout through the optional preparation `signOut` callback. Its account launcher occupies the original `settings.launcher` seat at the sidebar foot, displaying the canonical bootstrap name and a default avatar. The upward native menu offers only Settings and Sign out; Settings opens the same shell-owned panel. Sign out checks the original page and active dependency, latches once before dispatch, and withdraws with page revocation. No DeepSeek account sign-in service is added. Normal native pages hide the standalone top exit; stopped or failed entry pages retain the existing recovery controls. Preparations without the callback retain the normal Settings fallback.

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
