---
kind: upgrade-guide
description: "Cloud profiles serve public login documents through the existing access plugin instead of native frontend-static indexAuth."
---

# Move the public Cloud frontend row

English | [中文](guide.zh.md)

## Change

The native `@deepseek-ai/dsh-host-frontend-static` configuration again requires Connection authentication and has no `indexAuth` field. Cloud profiles with an explicit frontend row using `indexAuth: public` use the existing access package's `/frontend` entry instead. It reuses the original static-file responder; named authentication, bootstrap, API and WS routes keep their original checks. Ordinary native profiles need no change. The fork-only `ordinaryConfigPolicy` and `OrdinaryConfigPolicy` exports leave native Settings; the existing Cloud API owns this policy internally. `ConfigField.onReset` is required again; text-only consumers without an unset operation keep `choices: []` and `overridden: false` and supply a callback that rejects unexpected reset requests.

## Migration

1. Install the updated `@deepseek-ai/dsh-pe-cloud-access` package and its declared native frontend dependency. In the Cloud profile, change only the existing frontend row's `name` to `@deepseek-ai/dsh-pe-cloud-access/frontend`, retain its id and absolute `config.distIndex`, and delete `config.indexAuth`. Do not add another fallback owner.
2. Keep authentication and the original API/WS rows unchanged. Verify that the distribution directory and every index injection contain only public resources. Never point `distIndex` at an account data directory.
3. Start the complete successor profile normally. Confirm `/` and `/index.html` show login, static assets load, unauthorized bootstrap/API/WS requests remain denied, and actual login and logout work. Confirm the original root audit and resource limits pass before exposing the new deployment.
4. Update any custom `ConfigField` consumer that omitted `onReset`; finite-choice fields still require a real reset action. No user-data migration or quota change is required.
