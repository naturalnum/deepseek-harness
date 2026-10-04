# @power-evolve/client-account

English | [中文](README.zh.md)

PowerEvolve's browser account launcher and personal settings section use the native DSH Settings shell. The Host forwards only authenticated product RPCs; the client receives an authorized model list and per-user settings, never provider credentials. The section retains one mutation request ID for retries after an uncertain response and reloads the authoritative settings after a revision conflict.

## Native sign-in lifetime

The plugin checks the personal `/api/powerEvolve/me` endpoint on activation, Connection state changes, browser focus or return online, and when the document becomes visible. The first successful response binds the document to its user ID. A later successful response for another user stops the old Connection and reloads the current document once, independently of login-address lookup, discarding retained views from the previous account. Settings or display-name changes for the same user preserve the document. A confirmed HTTP 401 stops the native Connection generation and its retry loop, then replaces the page once with the Host-configured trusted login address. A Connection loop activated later on that retired page is also stopped. Personal identity reads from the account components report the same confirmed expiry. Network failures, server errors and HTTP 403 preserve ordinary Connection recovery.

The login address comes from `/config` and must be HTTP(S) without embedded credentials. If it cannot be loaded, a localized modal covers retained native views and offers an explicit retry to open sign-in. Successful page replacement disposes the native history view. Plugin disposal cancels identity and navigation reads; late responses cannot stop another login or navigate a disposed page. The plugin requires the browser Connection service's [stop method](../../../packages/client/connection/README.md#connection-generation).

## Trusted account page

The package owns the account management and password forms served at the Platform's `/account` origin. Passwords and account credentials remain in that page's memory; the native launcher receives only read-only capabilities and navigation addresses. An account requiring its first password change sees the personal form before management or product navigation. A completed password change clears the form and requires a new sign-in.

Management retains each request ID and shown account revision while its result is uncertain. Receipt lookup does not retrieve a temporary password; an administrator who lost it starts a new explicit reset. A temporary password is shown only until dismissal or page disposal. A list refresh failure after a successful mutation does not offer to replay that mutation. Permission loss removes management data and returns to account sign-in.

The `./trusted-assets` export provides the built directory URL. Bundling writes `lib/trusted/index.html`, scripts, styles and `asset-list.json`; the Platform serves only files in that list, using its account-page CSP and private response headers. The native Web plugin and the trusted page use separate bundles; the trusted page does not require the Host module loader.

Package tests cover credential boundaries, stable mutation retries and localized component outcomes. After `bundle`, `test:built` verifies the published resource list and boots the trusted bundle with dynamic code blocked. These checks use HTTP fixtures and DOM emulation; deployment acceptance includes real Platform and browser sessions.

## Model experience

This package does not call a model. It only selects a model already authorized by the trusted platform; the platform validates the choice again when accepting and executing a prompt.
