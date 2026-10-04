# PowerEvolve Desktop Cloud carrier

English | [中文](README.zh.md)

## Summary

Open the shared PowerEvolve native DSH application in the official Electron window shell. Login uses the trusted Platform; conversation, history and product client plugins come from the deployed Host. Native keyboard, menus, theme and audio permission reuse upstream adapters. The Cloud document receives no local file paths, Device credentials or command bridge.

## Use this carrier

Build with `pnpm run build:power-evolve:desktop`. Prepare the exact Electron version selected by this workspace's lockfile and set `PE_DESKTOP_ELECTRON` to its executable. Run `pnpm --filter @power-evolve/desktop run start --config /absolute/deployment.json`; development can add `--data-dir /absolute/private-browser-root` for an isolated trial identity. Quit through the native application menu. Restart with the same deployment and data directory, then log in if the browser session has expired.

The deployment file contains exactly these two origins:

```json
{
  "hostOrigin": "http://127.0.0.1:20880",
  "platformOrigin": "http://127.0.0.1:20881"
}
```

HTTP is accepted only for numeric loopback. Remote origins require HTTPS. Credentials, paths, query parameters, fragments, extra fields and identical origins are rejected. Main-process configuration is independent of renderer input.

## Browser and native permissions

Host and Platform share one persistent Electron Session within a deployment. Its partition derives from both origins, so deployments on different loopback ports do not share cookies. Product userData defaults to the separate `PowerEvolve` application directory; development-only `--data-dir` cannot override packaged storage.

Only the owned Host main frame at `/native/` receives keyboard, shortcuts, locale and theme synchronization. Every native request checks the current window, main frame and exact Host URL. Platform and preview frames receive no product native bridge. Audio requests also require the owned current Host document, an audio-only main-frame request and macOS microphone authorization; other permissions are denied.

Main navigation permits the configured native Host and Platform login, account and approval pages. Host-root returns normalize to `/native/`. Trusted Platform links requesting a new window navigate the owned window; other popups, external destinations and webviews are refused. Redirects and explicit application loads use the same fixed deployment policy. No system-browser action runs automatically for a blocked redirect.

## Implementation and checks

[Main assembly](src/main.ts) consumes upstream side-effect-free [assembly](../../../apps/desktop/src/assembly.ts) and [preload assembly](../../../apps/desktop/src/preload-assembly.ts). The main ESM module registers readiness work without awaiting `app.whenReady()` at top level. It launches no local Agent or Device Profile. [Bundling](tsdown.config.ts) rejects bare imports outside Electron and Node; the sandboxed CommonJS preload has a smaller runtime import allowlist.

`pnpm run test:power-evolve:desktop` runs source configuration and argument checks. The real Electron policy test uses the built adapters and explicitly requires `PE_DESKTOP_ELECTRON`; absent runtime is reported as skipped. Its loopback HTML services validate native IPC and navigation, and do not replace actual native DSH, PG or model acceptance. See [the desktop completion agreement](../DESKTOP-COMPLETION.md) for the remaining Device and packaging work.

## Known limitations

This is a Cloud-carrier source slice. Device process ownership, the local authorization bridge, signed installation/update delivery, native sidebar browser integration and packaged runtime closure remain separate acceptance steps. Source startup and upstream package smoke do not demonstrate an installable PowerEvolve application. External documentation links remain blocked until a user-controlled external-open capability is implemented.
