---
kind: upgrade-guide
description: "Gateway Node stream transport close now rejects actual cleanup failures after joining all stream and Peer cleanup."
---
# Handle Gateway stream cleanup failures

English | [中文](guide.zh.md)

## Change

`TypertGatewayService.createNodeStreamTransport()` still returns an idempotent `close()`, but close now rejects the first actual cleanup failure after all pending openers, iterator reads and returns, and Peer effect cleanup settle. Previously connection and Peer cleanup failures could be logged and then reported as successful close. Normal logical-stream business errors retain their native error frames.

The optional third argument is `NodeStreamTransportOptions`: `maxFrameBytes` limits complete WebSocket message bytes through ws; synchronous `acquireStream(endpoint)` reserves before logical stream or inbox allocation and returns an exactly-once synchronous settlement callback. Resource refusal closes the physical carrier. `beforeOpen` continues to reject only the logical business stream. Omitting options keeps the existing input limits and business protocol.

## Migration

1. Await and handle `transport.close()` wherever a Node transport is owned. On rejection retain unresolved resource responsibility and report failed shutdown; do not treat a closed socket as proof of completed cleanup.
2. If passing resource options, provide a positive safe-integer `maxFrameBytes` and reserve from the actual stream owner in `acquireStream`. Release only on `confirmed`; retain capacity on `unknown`. A notification failure also fails close. Keep the callback synchronous and never wait for its own transport or Peer close.
3. Verify delayed opener/read/return cleanup keeps capacity until actual settlement and that a cleanup failure makes close reject after unrelated cleanup finishes. Public [Gateway documentation](../../../../packages/api/gateway/README.md) describes the carrier semantics; no wire DTO or Session data migration is required.
