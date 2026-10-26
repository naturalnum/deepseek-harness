# Agent Note: Cloud model keys retain native save and page ownership

Status: implemented

English | [中文](2026-10-22-cloud-native-model-key-editing.zh.md)

## Problem

A shared Node process serves several Cloud accounts. The native Models page expects credential and Settings operations, while Cloud must constrain each write to the original authenticated account and reject a draft opened before another save. Revoking a browser page cannot establish whether an issued credential save finished.

## Decision

The [Cloud API](../../../../packages/cloud/pe-cloud-api/README.md) exposes one approved model-key family through generated native Remote descriptors. The original login Peer retains its existing AccountUse. Version comparison runs inside the original account save turn; the native credential provider owns the document and its atomic write. Confirmed completion advances the opaque edit version. Unknown completion closes admission and retains the original graph, failure and capacity until actual settlement.

The [Cloud page](../../../../packages/cloud/pe-cloud-client/README.md) prepares the original [Models integration](../../../../packages/client/ui-settings-models/README.md) before UI activation. Its stable editing source begins at null and is revoked synchronously. One explicit edit captures its version and callbacks; background metadata reads discard versions. The existing renderer binds the source through framework hooks, and a page or dependency replacement unmounts its drafts. A late response cannot report success into a replacement page.

Settings metadata remains readonly. Cloud omits automatic Welcome and credential onboarding so unavailable acknowledgement settings cannot block manual Models. An application omitting the optional integration retains native behavior. Required native UI modules have one supplier and actual published browser artifacts.

The account environment masks the approved model-key reference in ambient layers before boot. Removing the account's stored key therefore cannot select the shared process key. The native [credential precedence](2026-10-09-stored-credential-precedence.md), [credential boundaries](2026-07-30-credential-boundaries-and-atomic-registration.md) and [authorization records](2026-08-13-credential-records-and-authorization-flows.md) remain the general contracts; this account-specific integration adds no credential store or document format.

## Alternatives considered

**Expose unrestricted native writers.** The page could operate immediately, but its generic Settings and credential operations exceed the approved account field and reference policy.

**Add a Cloud credential store and save queue.** A second persistence and ordering authority would disagree with the provider that performs actual model requests and would complicate drain ownership.

**Refresh an open edit's token after every metadata read.** That would silently turn a stale draft into a current write and remove the intended conflict check.

## Consequences

Users edit or remove the approved key in manual Models. Provider selection, other Settings writes and automatic onboarding remain separate capabilities. A confirmed local save establishes persistence; a subsequent real native model request establishes usability. Component tests and generated contracts do not establish installed browser activation or deployment acceptance.
