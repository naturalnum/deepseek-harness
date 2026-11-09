# Account plugin presentation

English | [中文](README.zh.md)

This internal directory renders the migration branch's search, purpose filters, installed filter, compact plugin cards and detail page inside the existing `pe-cloud-client`. It uses native UI primitives and owns no Loader entry, transport, installation runner, Profile editor or business package.

`registerCloudPluginManagement(owner, panelKey, injected)` contributes an **Approved controls** tab through the native `plugins.tab` slot and retains the `main` page for compositions without native plugin navigation. Both entries use the same account projection and edit owner; withdrawing the contribution removes both declaration waits and the dictionaries. The existing Cloud management assembly supplies its namespace-dependent fiber, routing key and account injection, and owns fallback navigation and shared shell feedback. The component and helper are internal imports, with no additions to the package's public `/client` exports.

The injection contains one stable `hooks.accountPluginCatalog` source and optional `requestPluginEnabled`, `openPluginConfiguration` and `refreshPluginCatalog` callbacks. Root's source must represent the captured current account, withdraw with its original page lifetime, localize package metadata, and publish a fresh cached snapshot when data changes. Changing the captured account requires disposing the old contribution before registering its successor. Callbacks must check that same account and page are still current at invocation, enforce the approved catalog on the server, publish pending or unknown state before another request can start, and report operation outcomes through the existing shell toast owner. The UI neither fetches on mount nor copies server state into a second store.

Approval, installation and activation are distinct. `installed: null` and `enabled: null` mean unconfirmed; an approved deployment catalog is not evidence of actual installation. Controls require a ready, non-refreshing projection, an approved and confirmed installed row, confirmed activation state, an `available` operation and its real callback. Missing callbacks close the controls even when a row says `available`. A failed refresh retains readable rows with closed mutation controls. Add plugin stays disabled; no npm/Git/path form or legacy global PluginManager write API is included.

An HTTP 403 from the account's plugin-current endpoint shows management as unavailable and exposes no plugin actions or inferred installation rows. Other refresh failures retain the ordinary error state.

The existing page owns approved refresh and edits; see the [cloud client](../../../../README.md) for version capture, application modes and withdrawal.
