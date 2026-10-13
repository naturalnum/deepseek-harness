---
description: "Open native account actions and trusted password or account-management pages with account-scoped identity and safe sign-in recovery."
kind: package-reference
---
# @power-evolve/client-account

English | [中文](README.zh.md)

## Summary

Users can open native Settings, change a password on the trusted Platform, and sign out from one account menu. The menu shows an initials avatar, display name and role. Administrators manage accounts on a separate trusted page. Personal metadata and authorized model choices stay account-scoped; provider credentials remain on Platform.

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

The [native cloud Web shell](../cloud-web/README.md) includes this browser plugin. The [Host](../host/README.md) and [Platform](../platform/README.md) own their separate named Profiles, origins and authentication settings; this client exposes no user-supplied configuration fields.

The launcher uses an initials avatar, display name and role. Its three actions open native Settings, navigate to the trusted password page, and sign out. Account management stays on Platform; the plugin adds no Settings section or expiry overlay.

<a id="native-sign-in-lifetime"></a>
### Native sign-in lifetime

The plugin checks the personal `/api/powerEvolve/me` endpoint on activation, Connection state changes, browser focus or return online, and when the document becomes visible. The first successful response binds the document to its user ID. A later successful response for another user stops the old Connection and reloads the current document once, independently of login-address lookup, discarding retained views from the previous account. Settings or display-name changes for the same user preserve the document. A confirmed HTTP 401 stops the native Connection generation and its retry loop, then replaces the page once with the Host-configured trusted login address. A Connection loop activated later on that retired page is also stopped. Personal identity reads from the account components report the same confirmed expiry. Network failures, server errors and HTTP 403 preserve ordinary Connection recovery.

The login address comes from `/config` and must be HTTP(S) without embedded credentials. A failed lookup leaves the Connection stopped and records an unavailable destination; `AccountSession.returnToLogin()` supports an explicit retry. This package does not add a recovery modal. Plugin disposal cancels identity, capability and logout requests. Client replacement clears the launcher identity and cancels pending logout; late responses cannot navigate the replacement client. The plugin requires the browser Connection service's [stop method](../../../packages/client/connection/README.md#connection-generation).

<a id="trusted-account-page"></a>
### Trusted account page

The package owns the account management and password forms served at the Platform's `/account` origin. Passwords and account credentials remain in that page's memory; the native launcher receives only read-only capabilities and navigation addresses. An account requiring its first password change sees the personal form before management or product navigation. A completed password change clears the form and requires a new sign-in.

Administrators can manage accounts on this trusted page; ordinary users retain their personal password action. Platform rechecks the current permission for every management operation.

Repeated sign-out gestures share one pending request. Client replacement or page disposal cancels it, and late replies cannot change the replacement account. A definite sign-out failure preserves the account and permits a new explicit attempt.

Management retains each request ID and shown account revision while its result is uncertain. Receipt lookup does not retrieve a temporary password; an administrator who lost it starts a new explicit reset. A temporary password is shown only until dismissal or page disposal. A list refresh failure after a successful mutation does not offer to replay that mutation. Permission loss removes management data and returns to account sign-in.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Browser identity and trusted-page delivery</summary>

The native launcher registers at priority -10, so disposal restores the official priority-0 contribution. The launcher uses the upstream Menu and explicit MenuItemButton actions, preserving keyboard navigation, shortcut display and disabled or danger states. Host RPC adapters expose authenticated personal metadata and authorized models without provider credentials. The [native entry](src/client/index.ts) owns registration and lifecycle behavior.

The `./trusted-assets` export provides the built directory URL. Bundling writes `lib/trusted/index.html`, scripts, styles and `asset-list.json`; the Platform serves only files in that list, using its account-page CSP and private response headers. The native Web plugin and the trusted page use separate bundles; the trusted page does not require the Host module loader.

Browser source tests use explicit HTTP, Connection and component-port substitutes. Prepared factory checks consume an absolute current `client.js` path through `POWER_EVOLVE_FACTORY_FILE` and reject dependencies outside the native module table. The [cloud-only checker](../scripts/cloud-check.mjs) keeps source and prepared-artifact evidence separate.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform](../platform/README.md) — trusted account and credential ownership.
- [Native Connection](../../../packages/client/connection/README.md#connection-generation) — stopped generations and recovery.
- [Cloud migration scope](../CLOUD-MIGRATION-PLAN.md) — accepted product capabilities.

-----

<a id="model-experience"></a>
## Model Experience

### Account controls

#### What the model sees

The `settings.launcher` controls contribute no prompt text, tools or Session messages. The account API reads authorized models and personal settings; the native DSH controls and trusted Platform own model selection and request admission.

#### Token effect

Account navigation and metadata reads add zero model-request tokens. A model or authorization change affects future request admission through its native and Platform consumers, without exposing provider credentials to this client.

#### KV Cache effect

This browser plugin neither rewrites earlier request tokens nor defines provider cache policy. Native Session consumers own request formatting; provider reuse and eviction remain outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Callers must preserve these account boundaries:

- A failed trusted-login address lookup leaves the native Connection stopped; recovery requires an explicit retry.
- Passwords and temporary credentials belong only to the trusted page. Receipt lookup cannot recover a dismissed temporary password.
- Browser capabilities control presentation; they do not replace Platform authorization or establish deployment acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Keep client, trusted-page and real deployment evidence with their owning checks. A source or factory test alone does not establish real Platform or browser-session acceptance.

</details>
