---
description: "Prepare the native PowerEvolve Web shell and revisioned client assets for exact allowlisted Host delivery."
kind: package-library
---
# PowerEvolve Cloud Web

English | [中文](README.zh.md)

## Summary

Operators can deliver the native DSH Web shell with PowerEvolve account actions, Skills and plugin configuration at one browser entry. This package combines already-built frontend and client assets for the Host to serve at `/native/`. Missing client resources reject assembly. Platform owns authentication and tenant data; preparing static files grants no runtime permission.

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

The [Host bundle](../host/README.md) consumes this package as prepared static assets. It is not a Profile layer or Cordis mount. Operators prepare the upstream frontend and client bundles before the [assembly script](scripts/build.mjs) writes this package’s `dist`; the [deployment owner](../deploy/README.md) controls named Profile launch.

The browser entry is `/native/`. `asset-list.json` is the Host’s exact public-file allowlist. Missing client entries, unresolved client dependencies or missing literal sibling chunks fail assembly; the builder does not silently rebuild them.

The browser picker lists Platform-owned cloud directory names. Selecting a name never grants access to the Host filesystem. A Workspace adopts one directory and retains immutable Session membership; physical byte storage is resolved by Platform from the account and Workspace identities.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Prepared native graph and static delivery</summary>

The assembly script copies the prepared native shell, resolves the native Web roster and includes the two product clients. It emits revisioned entries and sibling chunks, an ordered module graph, an application batch and external boot scripts. Directory selection uses the official in-page browse picker.

Each package revision covers all copied client scripts. Graph entries use document-relative one-resource combo URLs (`./plugins/??<owner>/client.js&rev=<ownerRev>`), and sibling chunks use `./plugins/<owner>/client.<name>.js?rev=<ownerRev>`; the Host serves their exact bytes over HTTP. The assembly packages the complete internal `client-resource-map.json` with the static assets, but the Host does not serve it. Client requests must match both an exact mapped URL and the physical allowlist; unknown resources and missing or incorrect revisions return 404. The eager application batch contains entry scripts only. Client source maps and Node runtime entries stay outside the allowlist; the upstream frontend’s own browser source maps remain part of its prepared assets.

The Host owns serving and CSP. Its native policy permits same-origin scripts and `unsafe-eval`, with same-origin and blob workers for native previews. The [formal-asset check](tests/native-assets.built.spec.ts) reads the real allowlist, exercises the built Host static handler and executes the prepared native loader; it does not create substitute deployment assets.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host bundle](../host/README.md) — native browser serving and Agent composition.
- [Account client](../client-account/README.md) — account launcher and trusted password page.
- [Extension Center](../client-extension-center/README.md) — existing Skills and bundle configuration.
- [Cloud migration scope](../CLOUD-MIGRATION-PLAN.md) — accepted product capabilities.

-----

<a id="model-experience"></a>
## Model Experience

### Web assets

#### What the model sees

The `/native/` shell, `asset-list.json` and client graph supply browser code only. This package adds no prompt text, model tools or Session messages; the native clients and Host own any user submission or model-facing behavior.

#### Token effect

Preparing or serving static assets adds zero model-request tokens and starts no model call. Client consumers own messages, prompts and tool results.

#### KV Cache effect

Asset revisions change browser resources without rewriting persisted Session messages. This package defines no model cache key or provider policy; native request formatting and the provider determine reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Prepared assets establish only this browser delivery scope:

- The package requires current prepared frontend and client artifacts; it does not enable missing runtime services.
- Static or factory checks do not establish real Platform, SDK, two-user or complete feature acceptance.
- The native sidebar Browser factory requires its upstream carrier and stays inactive when that carrier is absent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Keep prepared-byte, CSP and browser execution evidence in the owning migration records. Assembly preserves upstream browser behavior; runtime permissions belong to the Host and Platform.

</details>
