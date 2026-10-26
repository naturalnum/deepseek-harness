---
kind: upgrade-guide
description: "The Cloud access Root requires explicit authentication database and resource configuration beyond browser access settings."
---

# Configure Cloud authentication resources

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-pe-cloud-access` and `/root` now require Host `AuthRootConfig`, extending the former browser-safe access configuration with mandatory database, pool, secret and startup budgets. Root installs `PeAuthService` and inspects the deployed Better Auth schema. Root ingress requires an explicit positive `ingress.sessionRecheckLeadMs` smaller than `sessionRecheckMs`; missing or invalid values fail before authentication resources initialize. Browser `/schema` and bootstrap wire types are unchanged. Authentication initialization keeps request admission closed pending the root recipe audit and account routing.

## Migration

1. Install the official root `credentials` provider before access/root. Set `authSecretRef` and `database.passwordRef` to its references; keep secret values out of Loader configuration.
2. Provide every database, pool and secret/startup field documented in the [access package reference](../../../../packages/cloud/pe-cloud-access/README.md). Select explicit finite limits and SSL policy; ambient PostgreSQL defaults are not accepted. If `ingress` is configured, set `ingress.sessionRecheckLeadMs` below the maximum login age, for example `2500` with `sessionRecheckMs: 5000`. Keep `authCheckTimeoutMs` separate; a pending recheck never extends login freshness.
3. Review and deploy the pinned Better Auth library's migrations separately. Root rejects any remaining migration or schema problem and never executes DDL during activation.
4. Confirm actual Root startup reports `PeAuthService.observe().phase === 'initialized'` with `requestAdmission: 'closed'`. Keep shared Web traffic closed until the independent recipe, account and transport checks pass. Await `close()` during disposal; a timeout or failed cleanup does not establish resource release.
