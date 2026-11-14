---
kind: upgrade-guide
description: "Cloud Office preview moves from officeToPdf to the upstream officeKit namespace."
---

# Cloud Office preview uses officeKit

English | [中文](guide.zh.md)

## Change

The Cloud account adapter uses the upstream `@deepseek-ai/dsh-office-kit` provider. Its selected RPC endpoints are `officeKit/render` and `officeKit/generation`, with handler id `native:officeKit`. The removed `officeToPdf` namespace and package are no longer selected. Session and account authorization, PDF byte limits and unresolved cleanup ownership remain required. The Cloud adapter does not enable the provider’s new image, saved-file conversion or recalculation methods.

## Migration

1. In the deployment exposure manifest, replace `officeToPdf/render` and `officeToPdf/generation` with `officeKit/render` and `officeKit/generation`, and use `native:officeKit` for both handler ids. Keep their respective `account-session` and `authenticated-account` guards.
2. Replace direct imports of `@deepseek-ai/dsh-office-to-pdf` with the corresponding OfficeKit types and provider. The existing private `pe-cloud-office-to-pdf` Loader builtin selector remains unchanged.
3. Regenerate the normal Host and Client type catalogs and update clients together. Verify authorized PDF preview and rejection of a foreign account or Session; a missing selected method must still prevent readiness.
