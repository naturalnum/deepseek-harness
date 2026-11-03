---
description: "Account-scoped primitives derived from dsh-remote-server, with explicit cloud ownership and native approval behavior."
kind: "package-library"
---

# @deepseek-ai/dsh-remote-server-cloud

English | [中文](README.zh.md)

## Summary

This private library contains account-scoped remote-server records, generation references, uploaded SSH config parsing, native tool registrations and the upstream probe and risk rules. It has no Loader entry, HTTP route or automatic activation; the cloud packages own management UI and lifecycle assembly. The [upstream record](UPSTREAM.json) pins the original source and its MIT license.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [entry point](src/index.ts) exposes primitives for an explicitly prepared cloud integration. `AccountRemoteServers` requires the exact runtime-installed binding and original business, storage and credential-deletion callbacks. It accepts no account selector, host filesystem path, private key or password in server forms. Mutations serialize within the collection; the original storage owner must retain actual writes, capacity and failed outcomes.

Opaque references belong to one live graph and target configuration. Changing or deleting a server revokes its references. Execution checks the target after approval and supplies a current check to the original executor for its own awaited preparation and actual submission. Account lifetimes and original native execution work remain independently owned.

<a id="understand-the-implementation"></a>
## Understand the implementation

Uploaded config is parsed from supplied text through a memory-only reader. Identity paths are discarded, and every candidate requires an independently authorized account key. Include, Match, proxy, forwarding and unsupported directives reject; they never read the application host. The cloud execution consumer ignores ambient config and agents, permits public-key authentication only and requires uploaded verified known_hosts. Its fixed Python helper keeps keys in sealed memory descriptors inside the original managed range; the unchanged complete carrier budget still applies.

The gate retains deterministic high-risk rules and deployment/server mandatory approval. Full access supplies no bypass. The cloud API's [native adapter](../../cloud/pe-cloud-api/src/remote-server-approval.ts) uses the exact original Agent, Session, call id, signal and native approval request, including its durable audit pair.

<a id="model-experience"></a>
## Model Experience

### Tool schemas and selected references

#### What the model sees

Explicit installation registers [`remote_exec(server, command)`](../../../docs/tool-catalog.md#deepseek-aidsh-remote-server-cloud) and `remote_server_info(server)`. Their descriptions require the exact current reference selected by the user and describe approval and cancellation. The native mention codec serializes only the selected alias and opaque reference into the user message; private keys and known_hosts are excluded.

#### Token effect

Fixed schema cost while installed; each selected reference adds a small user-message value. Registration and management make no model requests.

#### KV Cache effect

Schemas remain stable while installation and visibility are unchanged. Selected references change user-message content and the prefix from that message.

### Tool results

#### What the model sees

Results contain `detail` and `ran`: a refusal reason or bounded actual SSH outcome, output and exit status. The fixed probe returns machine facts. Timeout text explicitly says remote descendants may still be running.

#### Token effect

Output cost follows the actual bounded result. Probe output and commands consume the same original execution and output quotas.

#### KV Cache effect

Results append to the Session conversation. New output changes the prefix from that result; the integration does not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Activation is explicit through the cloud catalog, account recipe and original managed execution provider. Source qualification covers native private storage, actual Loader codecs, two PostgreSQL-authenticated accounts, real SSH through the original managed provider and native model/tool turns. Production Root SDK, storage export and deployed Web qualification remain deployment responsibilities.

- Native approval policy `never` rejects before dispatching answerers. Mandatory remote approval therefore fails closed under that policy; this API cannot display a one-call mandatory prompt while preserving the original Session policy. The [reproduction](../../cloud/pe-cloud-api/tests/remote-server-native-approval.spec.ts) uses production Agent, Session and approval services. A per-call mandatory native prompt would require an upstream extension; no native code is changed here.

- Cancellation joins the local SSH managed range. It does not establish that an arbitrary remote process stopped. Do not turn local cleanup into remote process-termination evidence.

<a id="dev-note"></a>
### Dev Note

The upstream package declares Harness `0.2.0-rc.2` or `0.2.1-alpha.1`; this source baseline is `0.2.1-rc.2`. Source-level primitive checks and native approval tests do not establish compatibility of the unmodified upstream plugin or its browser bundle. Keep its original Host routes, global storage and local credential discovery out of cloud compositions.
