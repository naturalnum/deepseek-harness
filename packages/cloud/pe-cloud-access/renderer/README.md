# IP-only service preview

English | [中文](README.zh.md)

PowerEvolve can show a registered Session service in the existing Browser tab when the management origin uses an HTTPS IPv4 address. The tab loads a trusted viewer on the management origin and displays 960 × 640 PNG frames. It sends coordinate clicks, refresh requests and close requests. The private browser runs the service page and can read its same-origin GET resources. Each open view uses a separate Chromium process and context.

Configure `ipApplicationPreview` in `pe-cloud-access/root` with the protected Unix socket path, frame and relay limits, and the normal view and response limits. Select the existing `cloud:serviceApplication` launch exposure for this mode. The inert DNS-specific `/cloud/service-preview` exposure belongs to DNS deployments. The public Cloud Client config needs `serviceApplications.mode: ip-render`, the exact HTTPS IPv4 management origin and the existing request, response and field limits. The older DNS content listener and its client configuration still use the existing `applications` and `contentOrigin` fields.

Start the private worker before the Access root.

```sh
node renderer/serve.mjs /run/pe-preview/render.sock /opt/pe-preview/node_modules/playwright/index.mjs
```

Use a supported Playwright and Chromium pair with Chromium sandboxing enabled. Run the worker under its own Linux identity with OS-level IP egress isolation. Give only the Access service identity or its dedicated group access to the socket. Keep the socket directory owner-controlled, outside all account workspaces. Verify browser startup and cleanup under that isolation on the deployment host. Running the helper on a developer machine exercises the browser and wire protocol only.

## Authority and retirement

The original launch checks the authenticated login, account, connection generation, Workspace/Session and registered service. The only launch value returned to the management browser is a view id. Viewer requests revalidate both the original login and the same service allocation. The private worker receives no account selector, login credential, service address or management headers. Its relative GET requests are serviced through the original registered-service capability during a single admitted turn. Access builds each GET with an empty header list and sanitizes the service response before returning it to the worker.

After sign-out, a service stop, expiry or explicit Close, the view immediately stops admitting work and aborts any unfinished HTTP response. The view retains its capacity until the worker confirms the browser's closure and receipt removal. A memory-only registration precedes the durable open. The worker records the ticket under its owner-only `<socket-path>.retired` directory before allowing Chromium to start, and changes it to `closed` after the original browser closes. If the open acknowledgement is lost, Access can reconcile the ticket without submitting a frame. If a close receipt or the removal acknowledgement is lost, Access repeats the appropriate step over a new channel for the same ticket. The worker only removes closed records. Keep the directory for a graceful worker replacement. A fresh store or a `.pending` record from an unconfirmed process exit cannot confirm browser closure. Preserve that record for the independent Linux supervisor. The worker keeps a finite number of records.

An unconfirmed explicit Close returns the account-resource cleanup status. The original login can retry Close while its view is revoked. After logout, expiry or disconnect the original view also retries retirement without an active login. A single retry timer per view backs off up to 30 seconds. Shared ingress and other valid views remain available during local recovery. Root shutdown closes admission and retains the actual drain through these retries, ending its authentication pool after the last confirmed retirement. Closing a Browser tab itself leaves reclamation to the view lifetime or service stop.

For recovery after abrupt worker loss, the trusted launcher supplies a fresh 64-digit hexadecimal `PE_IP_PREVIEW_WORKER_GENERATION` for each dedicated Linux worker process scope and records that generation with the scope identity. The worker verifies and syncs the complete owner-only record before publishing it in `.generation`. Each pending ticket is a no-overwrite hard link to that generation record, synced before Chromium can start. Store both on the same protected Linux filesystem that supports hard links and directory syncing. An interrupted staging file is never a published generation or ticket. A failed open may release its reservation after the same storage and generation confirm that no ticket was published. Preserve an existing ticket or uncertain storage for recovery.

Only the independent supervisor may reconcile pending tickets that could own a browser. Confirm that the exact original Linux scope and all its descendants have exited, and match the ticket to that independently recorded generation before starting a replacement in the same storage. Worker PID exit alone provides no such confirmation. Tickets without a matching supervised generation stay pending. Keep the retirement directory and its generation records outside tenant control. Verify the production launcher and its physical retirement check on the deployment host.

Verify the normal Session entry and lifecycle for ordinary accounts against a sealed product root, with the Linux worker isolation in place, before using the feature for a trial.
