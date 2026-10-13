# Agent Note: Native input settlement and running reservations

Status: implemented

English | [中文](2026-10-10-native-input-settlement.zh.md)

## Problem

A cloud Session has one native input log and a separately committed input ledger. The loop emits claim removals synchronously before prompt assembly, but an asynchronous event observer cannot settle a complete claim before model or tool admission. A running command also needs the live owner's cancellation and position while PostgreSQL commits its canonical input.

## Decision

The fixed PowerEvolve baseline carries explicit native API patches. `Agent.onAfterClaim()` awaits every registered settlement listener for the complete claim before prompt assembly. Cancellation and an earlier listener failure preserve later settlement and the first failure. The callback receives detached frozen messages; existing historical message objects remain unchanged.

`runMaintenance(task, { scope: 'inbox' })` reserves the native prefix while idle or model streaming. The captured owner supplies phase, position, cancellation and cursor checks. Streaming remains transient; durable model settlement waits for command commit and cleanup. `Session.forPlanning()` preserves the exact prefix without lifecycle markers, and `Session.synchronizeCommitted()` imports a validated committed suffix without publishing it again. The cloud adapter owns ledger, presentation, receipt, persistence-cache and carrier synchronization.

These patches remain separate from the fixed official version. An upstream replacement must preserve complete settlement, original message identity, cancellation cleanup, prefix ownership and both SDK projections before the local implementation can be removed. Package contracts belong to the [Agent README](../../../../packages/core/agent/README.md) and [Session README](../../../../packages/core/session/README.md); the [migration integration record](../../../../products/power-evolve/TRIAL-M3-NATIVE-WRITER.md) owns product acceptance.

## Alternatives considered

**Only observe Session events.** Native claim publication precedes asynchronous observer completion. Two removals can reach PostgreSQL separately and cannot establish one atomic cohort before inference.

**Cancel the active turn for each input command.** This changes the user's running work and native cancellation behavior. A command must preserve that owner while accepting or editing pending input.

**Recreate an Agent from persisted status.** The replacement lacks the original phase, signal and model owner. Persisted history cannot manufacture those facts.

## Consequences

Custom Agent implementations provide the new public methods, and both SDK recovery fixtures exercise the loop after rebuilding shipped artifacts. Settlement callbacks finish their own cleanup without waiting for the same Agent's idle state or disposal. Running reservations currently accept model streaming only; prompt assembly, post-claim, pre-step and tool stages still reject. Product queue, continuous generation changes and multi-replica recovery remain separate integration work.
