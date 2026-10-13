---
kind: upgrade-guide
description: "Custom ConnectionHandle implementations must provide the new stop method."
---

# ConnectionHandle requires stop

English | [中文](guide.zh.md)

## Change

`ConnectionHandle` now requires `stop(): void`. Custom implementations and typed test doubles that omit this member no longer compile. The shipped browser implementation withdraws the generation source and prevents automatic reconnection until another source is registered.

## Migration

1. Add `stop(): void` to implementations of `ConnectionHandle`. Withdraw the current source, cancel its controller, and clear the published generation; repeated calls must have no further effect.
2. Call `ctx.connection.stop()` before switching an authenticated account or redirecting after credentials expire. Register a new source only after establishing the next identity.
3. Run the owning client's type checks and verify that stopping an established connection clears its generation and that `reconnect()` cannot resume the withdrawn source. The shipped [generation tests](../../../../packages/client/connection/tests/generation.client.spec.ts) cover this behavior.
