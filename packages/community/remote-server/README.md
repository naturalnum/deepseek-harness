---
description: "Account-scoped primitives derived from dsh-remote-server, with explicit cloud ownership and native approval behavior."
kind: "package-library"
---

# @deepseek-ai/dsh-remote-server-cloud

English | [中文](README.zh.md)

## Summary

This private library contains account-scoped remote-server records, generation references, uploaded SSH config parsing, strict OpenSSH arguments and the upstream probe and risk rules. It has no Loader entry, HTTP route, UI registration or automatic activation. The [upstream record](UPSTREAM.json) pins the original source and its MIT license.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [entry point](src/index.ts) exposes primitives for an explicitly prepared cloud integration. `AccountRemoteServers` requires the exact runtime-installed binding and original business, storage and credential-deletion callbacks. It accepts no account selector, host filesystem path, private key or password in server forms. Mutations serialize within the collection; the original storage owner must retain actual writes, capacity and failed outcomes.

Opaque references belong to one live graph and target configuration. Changing or deleting a server revokes its references. Execution checks the target after approval and supplies a current check to the original executor for its own awaited preparation and actual submission. Account lifetimes and original native execution work remain independently owned.

<a id="understand-the-implementation"></a>
## Understand the implementation

Uploaded config is parsed from supplied text through a memory-only reader. Identity paths are discarded, and every candidate requires an independently authorized account key. Include, Match, proxy, forwarding and unsupported directives reject; they never read the application host. OpenSSH ignores ambient config and agents, permits public-key authentication only and requires an explicit known-host entry. Its 16 arguments fit the original managed carrier's argument-count limit.

The gate retains deterministic high-risk rules and deployment/server mandatory approval. Full access supplies no bypass. The cloud API's [native adapter](../../cloud/pe-cloud-api/src/remote-server-approval.ts) uses the exact original Agent, Session, call id, signal and native approval request, including its durable audit pair.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- This library is not an enabled cloud feature. Account-private persistence and credential leases, the original managed execution consumer, audited RPC exposure, management UI, chat mention registration and full real-account/model/browser acceptance remain unimplemented. The SSH fixture qualifies transport with the native local subprocess provider; it does not qualify the cloud execution recipe, resource quotas or authenticated multi-user ingress.

- Native approval policy `never` rejects before dispatching answerers. Mandatory remote approval therefore fails closed under that policy; this API cannot display a one-call mandatory prompt while preserving the original Session policy. The [reproduction](../../cloud/pe-cloud-api/tests/remote-server-native-approval.spec.ts) uses production Agent, Session and approval services. A per-call mandatory native prompt would require an upstream extension; no native code is changed here.

- Cancellation joins the local SSH managed range. It does not establish that an arbitrary remote process stopped. Do not turn that observation into remote cleanup evidence or enable this library as an execution feature without the owning qualification.

<a id="dev-note"></a>
## Dev Note

The upstream package declares Harness `0.2.0-rc.2` or `0.2.1-alpha.1`; this source baseline is `0.2.1-rc.2`. Source-level primitive checks and native approval tests do not establish compatibility of the unmodified upstream plugin or its browser bundle. Keep its original Host routes, global storage and local credential discovery out of cloud compositions.
