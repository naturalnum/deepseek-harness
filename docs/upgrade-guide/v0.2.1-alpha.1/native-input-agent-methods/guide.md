---
kind: upgrade-guide
description: "Custom Agent implementations must provide native input settlement and owned activity capture methods."
---

# Custom Agents settle complete native input claims

English | [中文](guide.zh.md)

## Change

The PowerEvolve patch on v0.2.1-alpha.1 extends the public `Agent` interface with required `onAfterClaim()` and `captureInboxActivity()` methods. Custom Agent factories and test doubles implementing that interface must supply them. The maintained AgentLoop provides both methods. The patch preserves existing SDK wire commands and Session event formats.

`runMaintenance()` accepts an optional Inbox scope for idle or model-streaming input commands. Its holder finishes command commit and mirror cleanup before release. Other running stages reject acquisition; ordinary calls still require idle. See the [Agent contract](../../../../packages/core/agent/README.md#reserve-running-native-input).

## Migration

1. Update custom `Agent` implementations against [runtime-types.ts](../../../../packages/core/agent/src/runtime-types.ts). Settle the complete claim before prompt assembly, retain cancellation cleanup and the first failure, and return activity captures from the exact live owner. A no-op settlement implementation cannot provide cloud durability.
2. Use [Session.forPlanning and synchronizeCommitted](../../../../packages/core/session/README.md) for detached command planning and validated committed mirrors. The external adapter still proves the commit and synchronizes its writer cursor and carrier; these methods do not grant execution authority.
3. Rebuild changed native packages and check both SDK recovery projections through their maintained [snapshot and smoke workflows](../../../testing.md).
4. Confirm native settlement and running cleanup with `pnpm exec vitest run packages/core/agent-loop/tests/native-input-seams.spec.ts packages/core/agent-loop/tests/running-inbox-maintenance.spec.ts`. This validates native APIs; product Profile, queue and recovery acceptance use the [migration record](../../../../products/power-evolve/TRIAL-M3-NATIVE-WRITER.md).
