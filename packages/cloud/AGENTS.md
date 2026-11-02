# Cloud integration instructions

These instructions supplement [package rules](../AGENTS.md). Read the [Native integration reference](native-patches.md) before changing Cloud integration or requesting a Native patch.

## Seven package responsibilities

| Package | Owns |
| --- | --- |
| `pe-cloud-access` | Authentication, request/Peer binding, owner forwarding and response authorization. |
| `pe-cloud-runtime` | Account Contexts, owner/epoch, business readiness, capacity and account teardown. |
| `pe-cloud-api` | Reviewed endpoint exposure and account authorization for Native controllers and settings. |
| `pe-cloud-files` | Tenant storage ownership, authorized file scope, quotas and actual I/O settlement. |
| `pe-opensandbox` | Session execution environments, mounts, commands and execution resource release. |
| `pe-account-instructions` | Authorized, bounded account instructions supplied to Native turns. |
| `pe-cloud-client` | Login/bootstrap, account-bound transport and assembly of Native pages. |

Native DSH owns Agents, Sessions, conversation titles, Workspace behavior, permission-mode interaction, settings pages, plugin/skill engines, file preview/download and scheduling. Reuse those implementations through their existing providers, registrations and controllers. Cloud policy can restrict capabilities, but the UI must describe those restrictions truthfully.

## Repair method

- Before editing, trace the failing user action through its Native consumer and Cloud provider. Identify whether the cause is missing integration, an incorrect Cloud policy, repeated validation or a generic Native defect. Fix the owning implementation and its affected callers together.
- Prefer completing Native wiring and small refactors within the seven packages. Do not copy a Native engine, rebuild a settings page or add another owner/service to hide an integration error. Record a necessary minimal Native extension in the integration reference and preserve default Native behavior.
- Give each authorization decision one owner. Compose its current check explicitly instead of repeating the same complete Root/account audit in every wrapper. Keep authentication, Session/Workspace scope, cancellation and checks after relevant awaits or before actual response, persistence and release. A check before an await does not authorize later work.
- Update all consumers when an internal admission API changes. Follow the repository's same-process typing rules; do not grow a generic defense against hypothetical hostile Host JavaScript. Tenant, tool, file and process inputs still require their owning validation.
- Preserve account isolation, hard quotas, original data and unresolved resource responsibility. Do not free unknown work or widen limits to make a test pass.
- Verify Native default behavior and the actual Cloud composition. For latency, measure the affected request and compare equivalent operations; aggregate counters and fixtures do not establish current Web acceptance. Report source tests, deployed versions and real browser results separately.
