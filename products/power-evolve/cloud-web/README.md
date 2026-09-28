# PowerEvolve Cloud Web

English | [中文](README.zh.md)

This private package copies the DSH Web shell and assembles native client modules through the public DSH boot injection API. The roster includes authenticated conversation, Workspace file controls, and an execution-target plugin for cloud and paired local directories. Skill and plugin management pages are deferred until the core flows are complete.

`pnpm run build:power-evolve:web` requires the upstream Web frontend and client bundles built first. The product Host serves the output at `/native/`; its earlier slice test page remains at `/`. Login is served by the trusted platform and exchanges a scoped browser credential for the native Session transport.

The build emits `asset-list.json`, which the Host uses as the exact static asset allowlist. Boot scripts are emitted as files. The native DSH module loader uses `new Function`, so this route's Content Security Policy allows `unsafe-eval`; the existing trial page keeps its stricter policy.
