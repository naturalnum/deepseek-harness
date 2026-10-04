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

## Local Device development

Unpackaged startup can add `--device-config /absolute/device.json`. This separate main-process file selects an already prepared official `dsh --profile` runtime: absolute `nodeExecutable`, `cliEntrypoint`, `homeDir`, `workingDir`, a `profile` name and a distinct numeric HTTP `loopbackOrigin`. It explicitly supplies `startupTimeoutMs`, `requestTimeoutMs`, `quiesceTimeoutMs`, `exitTimeoutMs`, `maxOutputBytes`, `maxMessageBytes` and `maxHealthBytes`. The [parser](src/device-config.ts) refuses environment fields, remote endpoints and unbounded budgets. Packaged startup rejects this development override.

The local menu or native execution picker starts the owned Device child and opens its existing local authorization page in a separate, nonpersistent browser Session. Cloud receives only an opener with no arguments or local return values. The local page receives a directory chooser; its handler checks the current owned window, frame, exact Device URL and child generation before and after the native dialog. A restarted child gets a new local document. Pairing and directory authorization remain explicit local actions; credentials, nonce and paths do not pass through the Cloud bridge.

The [process adapter](src/device-process.ts) validates the owned child PID, per-launch identity, readiness and bounded health response. Private [lifecycle messages](../contracts/src/device-lifecycle.ts) close admission and drain owned actions before termination. Quit waits for actual child exit and local window cleanup. An incomplete drain retains the original records and reports uncertainty; process exit alone does not establish a stopped execution. Quitting does not cancel Cloud tasks.

Installed startup reads a fixed `power-evolve-desktop.json` below main-selected resources and accepts no runtime overrides. The [resource reader](src/installed-config.ts) requires Node, CLI, Python, the file helper and Device bundle within that physical directory; ASAR entries are refused. Worker timing is explicit and the Runner uses an already-local immutable image ID. Cloud startup creates no Device Profile or child. The first local opener [prepares the product Profile](src/installed-profile.ts) in stable private userData paths, preserving Device identity, journals and writer locks. The backend controller owns preparation, concurrent openers and cancellation before spawn. Home-wide overlays and a CLI-selected Device bundle that differs from the descriptor are refused.

## Browser and native permissions

Host and Platform share one persistent Electron Session within a deployment. Its partition derives from both origins, so deployments on different loopback ports do not share cookies. Product userData defaults to the separate `PowerEvolve` application directory; development-only `--data-dir` cannot override packaged storage.

Only the owned Host main frame at `/native/` receives keyboard, shortcuts, locale and theme synchronization. Every native request checks the current window, main frame and exact Host URL. Platform and preview frames receive no product native bridge. Audio requests also require the owned current Host document, an audio-only main-frame request and macOS microphone authorization; other permissions are denied.

Main navigation permits the configured native Host and Platform login, account and approval pages. Host-root returns normalize to `/native/`. Trusted Platform links requesting a new window navigate the owned window; other popups, external destinations and webviews are refused. Redirects and explicit application loads use the same fixed deployment policy. No system-browser action runs automatically for a blocked redirect.

## Implementation and checks

[Main assembly](src/main.ts) consumes upstream side-effect-free [assembly](../../../apps/desktop/src/assembly.ts) and [preload assembly](../../../apps/desktop/src/preload-assembly.ts). The main ESM module registers readiness work without awaiting `app.whenReady()` at top level. Development runtime files or fixed installed resources enable the separate local process only after an explicit local opener. [Bundling](tsdown.config.ts) rejects bare imports outside Electron and Node; the sandboxed CommonJS preloads have a smaller runtime import allowlist.

`pnpm run test:power-evolve:desktop` runs source configuration and argument checks. The real Electron policy test uses the built adapters and explicitly requires `PE_DESKTOP_ELECTRON`; absent runtime is reported as skipped. Its loopback HTML services validate native IPC and navigation, and do not replace actual native DSH, PG or model acceptance. See [the desktop completion agreement](../DESKTOP-COMPLETION.md) for the remaining Device and packaging work.

## Known limitations

The [frozen owned-Device trial](../TRIAL-DESKTOP-OWNED-DEVICE.md) has actual native DSH, Profile, model, PG and Docker evidence for two users, Git readback, restart and running quit. Its independent runtime is outside the source tree; it still uses development configuration. Native OS directory selection, actual installed `.app` composition, signing/update delivery and native sidebar browser integration remain separate steps. Source startup and upstream package smoke do not demonstrate an installable PowerEvolve application. External documentation links remain blocked until a user-controlled external-open capability is implemented.
