---
kind: upgrade-guide
description: "Cloud model-key deployment configuration replaces providerEntryId with explicit native provider/reference bindings."
---

# Declare Cloud model-key bindings

English | [中文](guide.zh.md)

## Change

Deployments that enable `approvedConfiguration.modelKey` must replace its single `providerEntryId` with a finite nonempty `bindings` list. Each binding explicitly selects `{ provider, providerEntryId, moduleName, ref }`. The shared API no longer exports `APPROVED_MODEL_KEY`; codec and environment helpers require selected references. The four model-key RPCs and their request/response shapes are unchanged.

Supported routes use native Models `apiKeyEnv` credential references and `models` declarations; OAuth/record credential support is not expanded. Cloud metadata keeps settings read-only. Its `settings.writable=false` and `settings.hasDocument=false` describe Cloud capabilities, preserve native Settings `hasDocument` semantics and do not establish physical document absence.

## Migration

1. In the Root entry configuration, replace `approvedConfiguration.modelKey.providerEntryId` with `approvedConfiguration.modelKey.bindings`. For an existing native DeepSeek entry named `provider`, the selector becomes `[{"provider":"deepseek-official","providerEntryId":"provider","moduleName":"@deepseek-ai/dsh-llm-deepseek-api-key","ref":"DEEPSEEK_API_KEY"}]`. These are deployment choices; use the actual module, entry id, provider id and configured `apiKeyEnv` reference. Keep explicit positive finite `maxKeyBytes`, `maxVersionBytes`, `maxReplyBytes` and `maxMetadataBytes`.
2. Check each selected native entry's Models declaration and credential-reference schema against its binding. Keep provider ids unique and the bindings within the catalog entry, string and complete-byte limits in the [API reference](../../../../packages/cloud/pe-cloud-api/README.md). Startup rejects missing or mismatched native facts.
3. Replace consumer imports of `APPROVED_MODEL_KEY` with the same trusted Root selection. Pass its references to `modelKeyCodecs(limits, refs)` and `new AccountModelKeyEnvironment(environment, refs)`. Keep codecs, masking before native mounting and the existing native save whitelist on that selection.
4. Confirm prepared `cloudModelKey/metadata` returns every selected route and its original redacted model/settings data. Obtain the current `{ epoch, editToken }` from `cloudModelKey/describe` for a ref edit and retain the returned version after successful set/unset; direct unversioned native edits to selected refs remain refused. The edit token is graph-local, not a disk revision; the original credentials file lock and writer retain persistence. Re-read state after a conflict or unknown outcome; never automatically replay a write.
