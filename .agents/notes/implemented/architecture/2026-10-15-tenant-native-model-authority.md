# Agent Note: Tenant model configuration and native prepared calls

Status: implemented

English | [中文](2026-10-15-tenant-native-model-authority.zh.md)

## Problem

The cloud Host serves several accounts, while native model plugins normally resolve configuration and credentials from their process. Sharing that process state makes one user's model changes affect another user. Sending keys through Host also gives the presentation service credentials it does not need. Moving dispatch to Platform must preserve the native adapter's prepared-call behavior: capabilities and execution belong to the same configuration generation.

## Decision

Platform stores revisioned native DeepSeek and Pi-AI settings per account, and encrypts credential references and native refresh records under that account's identity. The existing adapters retain protocol selection, request conversion, replay handling and failure classification. Their optional fetch injection uses the existing Platform destination and socket policy. Host carries native options, public metadata and native stream chunks; it receives no provider key.

The native Models page keeps its existing fields and local `credentials.set` default. An optional browser intake adapter supplies remote authority. The product requires this adapter and rejects typed-key submission when it is missing, including during module reload, because falling back to Host RPC would cross the intended credential ownership. The browser obtains a metadata-only ticket and uploads key bytes directly to Platform; receipts reveal only the original outcome.

An expiring, owner-bound preparation stores native public configuration and credential references, without key values. Its identity lets the Host's native prepared closure bind capabilities, image pricing and later dispatch to one configuration generation. Stream admission consumes it once and clears its stored configuration. The original operation, lease, selected model and committed tool declarations still authorize execution; preparation grants none of these permissions. Account credential rotation invalidates outstanding preparations. Capacity and lifetime are operator configuration.

This cloud composition follows the [provider routing decision](2026-07-14-provider-routed-llm-adapters.md) and [native credential records decision](2026-08-13-credential-records-and-authorization-flows.md). Their adapter and authorization semantics remain independently applicable.

## Alternatives considered

**Shared native process settings.** They require no cloud persistence adapter, but cannot isolate accounts served by the same Host.

**Host-side provider keys.** They allow direct native dispatch from Host, but give the presentation process credentials and duplicate Platform's execution authority.

**Independent metadata and dispatch reads.** They are smaller than a preparation record, but a concurrent settings write can make the reported capabilities describe a different endpoint. Rejecting every intervening write also changes the native prepared-call behavior.

**Freezing configuration for the entire operation.** It avoids preparation records, but prevents later native calls in that operation from observing accepted configuration changes.

## Consequences

Configuration and credential storage add an adjacent database generation. A consumed or expired preparation cannot replay inference; a native retry prepares a new call and still needs the original live execution authority. The existing shared operator route remains separately granted for historical accounts. Native HTTP providers use their maintained implementations; explicit WebSocket transports are unavailable in this composition. Cloud model configuration does not add native browser authorization-flow controls.
