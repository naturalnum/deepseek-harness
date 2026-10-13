---
kind: upgrade-guide
description: "RemoteStreamMuxServer now requires an explicit downlink send deadline."
---

# Remote stream sends require a deadline

English | [中文](guide.zh.md)

## Change

`RemoteStreamMuxServer` now requires a fifth constructor argument, `streamSendTimeoutMs`. Four-argument callers no longer compile. Gateway plugin configurations remain load-compatible: the new `streamSendTimeoutMs` field defaults to 10000 milliseconds and accepts integers from 1 through 2,147,483,647.

Previously, a pending `ws.send` callback could retain a logical stream after cancellation. Each frame now has a deadline covering queue time and callback completion. Cancelling an unstarted frame withdraws it; cancelling or timing out a started write terminates the shared physical carrier and cancels all its streams. Server close waits for source iterator cleanup, and late callbacks cannot resume delivery.

## Migration

1. Add the deployment's send deadline as the fifth argument to every direct `new RemoteStreamMuxServer(open, failure, heartbeatIntervalMs, streamInboxBytes, streamSendTimeoutMs)` call. The constructor has no implicit fallback.
2. Configure `streamSendTimeoutMs` in the `@deepseek-ai/dsh-api-gateway` plugin's `cordis.yml` configuration when the 10000 ms default does not fit expected write latency. Applications owning a separate mux must validate and explicitly pass their own configured value. `streamInboxBytes` remains an uplink limit.
3. Check the owning composition's types and exercise cancellation while a send callback is pending. Confirm that the carrier closes and source cleanup finishes, and that cancelling a queued frame leaves a healthy carrier usable. The [carrier tests](../../../../packages/api/gateway/tests/stream-server.host.spec.ts) exercise these paths over real WebSockets with controlled callback withholding; they do not emulate a slow network. See the [Gateway README](../../../../packages/api/gateway/README.md) for deployment and cleanup obligations.
