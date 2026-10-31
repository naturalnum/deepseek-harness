---
description: "Cloud package map for maintainers assembling account isolation, ingress, storage and remote execution with native DSH services."
kind: "package-group"
---

# cloud/ — Cloud account integration

English | [中文](README.zh.md)

## Summary

The cloud packages provide components for an explicitly configured multi-account deployment. Use this map to find account ownership, request binding, endpoint policy, file admission, remote execution, instruction snapshots and browser binding. Native DSH services retain Session, Agent and conversation state. Each package README describes its activation requirements and unavailable integrations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The package references own configuration and activation requirements.

| Package | Role |
|---|---|
| [`pe-cloud-access`](pe-cloud-access/README.md) | Authentication integration and account/generation request consistency. |
| [`pe-cloud-runtime`](pe-cloud-runtime/README.md) | Account identity, ownership, capacity and lifecycle coordination. |
| [`pe-cloud-api`](pe-cloud-api/README.md) | Audited native endpoint exposure and account policy. |
| [`pe-cloud-files`](pe-cloud-files/README.md) | Bounded file work and storage activation requirements. |
| [`pe-opensandbox`](pe-opensandbox/README.md) | Session execution scope and remote execution activation requirements. |
| [`pe-account-instructions`](pe-account-instructions/README.md) | Bounded instruction reads and native pre-step snapshots. |
| [`pe-cloud-client`](pe-cloud-client/README.md) | Browser bootstrap and account-bound native transport lifecycle. |

<a id="related-documentation"></a>
## Related documentation

- [Cloud account reference](../../docs/subsystems/cloud.md) — shared account identities and lifecycle obligations.
- [Native integration maintenance](native-patches.md) — patch ownership and upstream upgrade procedure.
- [Native API packages](../api/README.md) — the controllers and transports used by cloud adapters.

<a id="dev-note"></a>
## Dev Note

None.
