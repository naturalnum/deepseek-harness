---
kind: upgrade-guide
description: "Custom Agent implementations must provide before-turn registration and pending wake methods."
---

# Agent requires turn preparation and pending wake

English | [中文](guide.zh.md)

## Change

`Agent` requires `onBeforeTurn(listener): () => void` and `wakePending(): void`. Custom implementations and typed test doubles must provide both methods. The default loop retains synchronous turn opening and input claim when no preparation listener is registered.

## Migration

1. Implement ordered, effect-owned `onBeforeTurn` registration before turn opening, input claim, and prompt assembly. Preparation failure reports `agent/error` and preserves unclaimed input without writing a turn boundary; cancellation follows `keepInbox`.
2. Implement `wakePending` without inserting or retargeting input. An empty inbox does nothing; maintenance and aborted activity retain the existing wake behavior, including parked disposed activity.
3. Run the owning type checks and exercise the [public lifecycle tests](../../../../packages/core/agent-loop/tests/employee6-before-turn.spec.ts). Test doubles that never drive work may provide no-op methods. The [Agent README](../../../../packages/core/agent/README.md#use-this-package) documents registration ownership and listener cancellation.
