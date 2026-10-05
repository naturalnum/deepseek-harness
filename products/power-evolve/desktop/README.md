# PowerEvolve Desktop Cloud carrier

English | [中文](README.zh.md)

## Summary

Open the shared PowerEvolve native DSH application in the official Electron window shell. Login uses the trusted Platform; conversation, history and product client plugins come from the deployed Host. Native keyboard, menus, theme and audio permission reuse upstream adapters. The Cloud document receives no local file paths, Device credentials or command bridge.

## Use this carrier

Build with `pnpm run build:power-evolve:desktop`. Prepare the exact Electron version selected by this workspace's lockfile and set `PE_DESKTOP_ELECTRON` to its executable. Run `pnpm --filter @power-evolve/desktop run start --config /absolute/deployment.json`; development can add `--data-dir /absolute/private-browser-root` for an isolated trial identity. Quit through the native application menu. Restart with the same deployment and data directory, then log in if the browser session has expired.

The deployment file requires these two origins. Native sidebar browsing additionally requires explicit timing:

```json
{
  "hostOrigin": "http://127.0.0.1:20880",
  "platformOrigin": "http://127.0.0.1:20881",
  "sidebarBrowser": {
    "scopeRequestTimeoutMs": 5000,
    "scopeRecheckIntervalMs": 15000
  }
}
```

HTTP is accepted only for numeric loopback. Remote origins require HTTPS. Credentials, paths, query parameters, fragments, extra fields and identical origins are rejected. Main-process configuration is independent of renderer input.

Omitting `sidebarBrowser` disables its native capability; existing two-origin deployments remain valid. Both timing fields are required positive safe integers no greater than 2,147,483,647 milliseconds. Deployment operators choose each authorization request deadline and the delay between completed active-browser recheck cycles. A cycle checks distinct active Sessions sequentially; request time adds to the interval between observations.

## Local Device development

Unpackaged startup can add `--device-config /absolute/device.json`. This separate main-process file selects an already prepared official `dsh --profile` runtime: absolute `nodeExecutable`, `cliEntrypoint`, `homeDir`, `workingDir`, a `profile` name and a distinct numeric HTTP `loopbackOrigin`. It explicitly supplies `startupTimeoutMs`, `requestTimeoutMs`, `quiesceTimeoutMs`, `exitTimeoutMs`, `maxOutputBytes`, `maxMessageBytes` and `maxHealthBytes`. The [parser](src/device-config.ts) refuses environment fields, remote endpoints and unbounded budgets. Packaged startup rejects this development override.

The local menu or native execution picker starts the owned Device child and opens its existing local authorization page in a separate, nonpersistent browser Session. Cloud receives only an opener with no arguments or local return values. The local page receives a directory chooser; its handler checks the current owned window, frame, exact Device URL and child generation before and after the native dialog. A restarted child gets a new local document. Pairing and directory authorization remain explicit local actions; credentials, nonce and paths do not pass through the Cloud bridge.

The [process adapter](src/device-process.ts) validates the owned child PID, per-launch identity, readiness and bounded health response. Private [lifecycle messages](../contracts/src/device-lifecycle.ts) close admission and drain owned actions before termination. Quit waits for actual child exit and local window cleanup. An incomplete drain retains the original records and reports uncertainty; process exit alone does not establish a stopped execution. Quitting does not cancel Cloud tasks.

Installed startup reads a fixed `power-evolve-desktop.json` below main-selected resources and accepts no runtime overrides. The [resource reader](src/installed-config.ts) requires Node, CLI, Python, the file helper and Device bundle within that physical directory; ASAR entries are refused. Worker timing is explicit and the Runner uses an already-local immutable image ID. Cloud startup creates no Device Profile or child. The first local opener [prepares the product Profile](src/installed-profile.ts) in stable private userData paths, preserving Device identity, journals and writer locks. The backend controller owns preparation, concurrent openers and cancellation before spawn. Home-wide overlays and a CLI-selected Device bundle that differs from the descriptor are refused.

Descriptor version 1 retains `appData/PowerEvolve`. Version 2 requires `stateNamespace`: 1–63 lowercase alphanumeric or hyphen characters, starting and ending with an alphanumeric character, selecting `appData/PowerEvolve-<stateNamespace>`. The trusted installer fixes this name across upgrades; a different deployment or replaced database uses a new namespace and enrollment. Main verifies the selected root is a physical current-user-owned 0700 directory before creating an Electron Session. Browser state, Device Home, identity and journal remain separate; every installed namespace retains the existing `appData/PowerEvolve/device-writers` coordinator, so a different installation cannot bypass an unresolved local writer. Configuration reading creates no state.

Profile preparation refuses changing the retained Platform origin or rebuilding a missing product patch over an existing Device identity or journal. It leaves those bytes in place. This check does not identify database replacement behind an unchanged origin; deployment operators must keep a namespace bound to the same database identity. Namespace separation does not protect against another process running as the same OS user.

The installed descriptor requires `device.commandSearchPath`: an ordered list of 1–32 external absolute POSIX directory names, each 1–4096 characters. Colons, backslashes, C0/DEL control characters and `.` or `..` path segments are refused; root `/` and trailing slashes are allowed. These directories select the installed Device child's exact `PATH` and are independent of the package's `runtime` resources. Configuration reading does not probe Docker or directory availability and runs no login shell. The parent environment, `HOME`, `DOCKER_HOST`, fixed interpreters and CLI remain unchanged, and child credential filtering still applies. Development uses its inherited environment.

## Browser and native permissions

Host and Platform share one persistent Electron Session within a deployment. Its partition derives from both origins, so deployments on different loopback ports do not share cookies. Development defaults to `appData/PowerEvolve`; its `--data-dir` cannot override packaged storage.

Only the owned Host main frame at `/native/` receives keyboard, shortcuts, locale and theme synchronization. Every native request checks the current window, main frame and exact Host URL. Platform and preview frames receive no product native bridge. Audio requests also require the owned current Host document, an audio-only main-frame request and macOS microphone authorization; other permissions are denied.

Main navigation permits the configured native Host and Platform login, account and approval pages. Host-root returns normalize to `/native/`. Trusted Platform links requesting a new window navigate the owned window; other popups and external main-window destinations are refused. Redirects and explicit application loads use the same fixed deployment policy. No system-browser action runs automatically for a blocked redirect.

The configured sidebar browser reuses the official DSH tab UI and guest controller. Only a main-issued lease can attach a webview. Every acquire queries the fixed Host through the login Session's Chromium network stack; strict membership records identify the current user, Session and Workspace. The renderer cannot select an owner or storage partition, and its display path is not used for authorization. Guest Sessions share storage only for the same user and Workspace within one owned document generation. Ordinary tab release closes its guest and preserves that Workspace's browser state.

Agent cookie changes, main-document navigation, renderer exit and window close synchronously fence old reservations and abort pending observations. Retirement waits for actual guest exit, connection closure and storage/cache/auth cleanup. Failed cleanup blocks new admission until retry succeeds. Active guests periodically recheck membership; revocation, expiry or unavailable authorization retires them without clearing the product login cookie. Immediate service-side revocation between observations is not guaranteed. Native reservations are current observations, not lasting Platform grants.

Sidebar guests receive no product credentials, preload, Node, device access, downloads or new native windows. Their network and navigation policy rejects configured Host, Platform and Device HTTP/WebSocket endpoints, including loopback aliases. It does not resolve DNS or replace an OS network sandbox. Browser state is process-local; it is cleared on document retirement and application quit. The Web page has no native browser capability and does not activate this product boot row.

## Implementation and checks

[Main assembly](src/main.ts) consumes upstream side-effect-free [assembly](../../../apps/desktop/src/assembly.ts) and [preload assembly](../../../apps/desktop/src/preload-assembly.ts). The main ESM module registers readiness work without awaiting `app.whenReady()` at top level. Development runtime files or fixed installed resources enable the separate local process only after an explicit local opener. [Bundling](tsdown.config.ts) rejects bare imports outside Electron and Node; the sandboxed CommonJS preloads have a smaller runtime import allowlist.

`pnpm run test:power-evolve:desktop` runs source configuration and argument checks. The real Electron policy test uses the built adapters and explicitly requires `PE_DESKTOP_ELECTRON`; absent runtime is reported as skipped. Its loopback HTML services validate native IPC and navigation, and do not replace actual native DSH, PG or model acceptance. See [the desktop completion agreement](../DESKTOP-COMPLETION.md) for the remaining Device and packaging work.

## Known limitations

The [frozen owned-Device trial](../TRIAL-DESKTOP-OWNED-DEVICE.md) has actual native DSH, Profile, model, PG and Docker evidence for two users, Git readback, restart and running quit. Its independent runtime is outside the source tree; it still uses development configuration. The [installed app trial](../TRIAL-DESKTOP-INSTALLED.md) verifies actual packaged startup, LaunchServices, default private storage, Git/Python, restart and account isolation. The [installed Office trial](../TRIAL-DESKTOP-OFFICE.md) verifies four-format artifact preview, local Git/Python, explicit export, immutable artifact readback and independent installed state. These trials retain their captured browser settings. Native OS directory selection and signing/update delivery remain separate steps. External documentation links remain blocked until a user-controlled external-open capability is implemented.
