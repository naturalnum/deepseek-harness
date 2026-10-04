# PowerEvolve Cloud Web

English | [中文](README.zh.md)

This private package copies the DSH Web shell and assembles native client modules through the public DSH boot injection API. The roster includes authenticated conversation, multiple cloud Workspaces, Session-scoped file controls, explicit artifact publication and browsing, personal account settings, personal text skill management, execution target selection, and a product brand/About plugin. The Settings shell comes from upstream DSH. Plugin and connector management pages remain for S6.

`pnpm run build:power-evolve:web` requires the upstream Web frontend and client bundles built first. The product Host serves the output at `/native/`; its earlier slice test page remains at `/`. Login is served by the trusted platform and exchanges a scoped browser credential for the native Session transport. The current cloud trial is described in [TRIAL-S4-NATIVE](../TRIAL-S4-NATIVE.md).

The build emits `asset-list.json`, which the Host uses as the exact static asset allowlist. Boot scripts are emitted as files. The native DSH module loader uses `new Function`, so this route's Content Security Policy allows `unsafe-eval`; the existing trial page keeps its stricter policy.

Each native plugin contributes its physical `client.js` and same-directory `client.<name>.js` chunks. The entry URL remains `./plugins/<package>/client.js?rev=<revision>`; dynamic chunks use the same directory and owner revision. Package, application-batch and boot-graph revisions cover every copied script, including chunk-only changes. The eager application batch contains entries only. Missing entries or referenced sibling chunks fail the build before replacing its output. Plugin source maps, Node entries and other package files are excluded from the allowlist.
