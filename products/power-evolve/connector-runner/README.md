# Isolated Connector Runner

English | [中文](README.zh.md)

This short-lived process runs one platform-authorized SSH connector call in a dedicated Kubernetes Pod. It has no workspace, Home, skill, database, Kubernetes credential, or generic command HTTP route. The platform keeps durable state and decides which exact command may run; this Runner keeps only bounded in-memory results. After a restart, a changed `instanceId` means an absent call has an uncertain outcome, never permission to replay it.

## Build and deployment

Run `pnpm --filter @power-evolve/connector-runner build`, then `pnpm --filter @power-evolve/connector-runner deploy --legacy --prod --ignore-scripts /private/runner-image-context`. Build the image with `docker build -f products/power-evolve/connector-runner/Dockerfile /private/runner-image-context`. The Dockerfile copies only the deployed package and starts as UID/GID 10001. The Pod must use gVisor, `runAsNonRoot`, a read-only root filesystem, dropped capabilities, no ServiceAccount mount, no user volumes, and a private memory-backed scratch volume if needed. Mount a one-Pod control token file readable by GID 10001; the token value never belongs in an environment variable or Pod description.

Configuration uses `CONNECTOR_RUNNER_TOKEN_FILE` (default `/run/power-evolve/runner-token`), `CONNECTOR_RUNNER_PORT` (default `8080`), `CONNECTOR_RUNNER_ALLOWED_DESTINATIONS` (exact comma-separated `host:port` values), and `CONNECTOR_RUNNER_FORBIDDEN_PROBE` (one exact forbidden `host:port`). Empty allowlist denies every SSH destination. Missing forbidden probe keeps `/health` unready. No user can set these deployment fields. The Pod network policy must allow only its approved SSH target and platform ingress.

The Runner requires three consecutive denied TCP probes before readiness and withdraws readiness when a later probe connects or is inconclusive. It treats `ECONNREFUSED` as inconclusive by default. Set `CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL=1` only when the platform has independently connected to that fixed probe listener from a control Pod and continues to establish its health. A refusal from an arbitrary closed port does not show egress isolation. If the cluster cannot establish this proof, do not dispatch credentials. The platform must additionally test an allowed connection and a forbidden connection in the deployed namespace.

## Wire API

Every request carries `x-power-evolve-runner-token`. `GET /health` returns `{ready,instanceId}` (503 until ready). `GET /calls/{callId}` returns the in-memory state or 404, including `instanceId`; it never returns credentials. `POST /calls` accepts exactly `{callId,instanceId,digest,kind,destination,timeoutMs,maxOutputBytes,...}`. The `kind` is `ssh.inspect`, `ssh.authenticate`, or `ssh.execute`. `destination` contains `host`, `port`, and `username`; authenticated calls also require `hostKeySha256`. Authenticate and execute include a `credential` (`{kind:'password',password}` or `{kind:'private_key',privateKey,passphrase?}`); execute additionally includes `command`. Inspect refuses credentials and never authenticates. A wrong host fingerprint refuses authentication before any command.

The platform computes `digest` with the exported `requestDigest(unsignedCall, podToken)` helper. It is HMAC-SHA256 over recursively key-sorted JSON without the `digest` field, including credential bytes. The token keys the digest so the status response does not expose an offline password verifier. A repeated ID and digest returns the existing state; the same ID with another digest is a conflict. By default, the Runner accepts only one distinct call ID for its lifetime. The platform queries GET before POST, compares both Pod UID and `instanceId` on recovery, and never automatically retries an uncertain SSH write. One Pod serves one approved call, with a fresh token and a short lifetime.

Command input is capped at 16 KiB, combined stdout and stderr at 128 KiB, and deadline at 60 seconds. The Runner has no file transfer, PTY, port forwarding, local shell, or process-based MCP route. These capabilities need separate review and implementation.
