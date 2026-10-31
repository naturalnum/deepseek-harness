---
kind: upgrade-guide
description: "Custom ModelsSettingsIntegration providers must explicitly select manual setup with onboarding: false."
---

# Use manual setup with Models integration

English | [中文](guide.zh.md)

## Change

The optional browser `modelsSettingsIntegration` input now requires `onboarding: false`. It supplies readonly metadata and protected credential editing to the manual Settings/Models page; it no longer supplies a second protected credential editor inside first-run onboarding. The existing Cloud page already supplies this value and needs no configuration change. Ordinary native applications that omit the integration retain their original Welcome and credential onboarding.

## Migration

1. In any custom `ModelsSettingsIntegration` provider, set `onboarding: false` alongside the existing `reads` and `editing` inputs. Keep the editing source stable and publish `null` on revocation.
2. Open Settings/Models to configure credentials. Confirm the manual page remains available and no onboarding dialog registers before editing admission or after revocation. For ordinary native onboarding, omit the entire integration rather than mixing protected editing with native first-run setup.
3. Verify edit cancellation, successful saves, stale-edit refusal and page revocation through the original callbacks. No profile, user-data or quota migration is required.
