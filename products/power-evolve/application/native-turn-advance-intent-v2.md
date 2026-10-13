# Native turn advance intent v2

English | [中文](native-turn-advance-intent-v2.zh.md)

## Summary

Platform integrators use `NativeTurnAdvanceIntentV2.prepare()` to retain a complete continuation candidate from the actual PG state of a closed owned turn. Host supplies its current Writer identity, retained transition identity and candidate token, and the acknowledged seal from its actual `NativeAssistantPublisher`. PG supplies source coordinates, ordered cohorts, consumed origins and the current pending head.

## Table of Contents

- [Use and recovery](#use-and-recovery)
- [Authority and limits](#authority-and-limits)
- [Dev Note](#dev-note)

<a id="use-and-recovery"></a>
## Use and recovery

The caller holds the native before-next-turn hook quiet while it captures the publisher seal, prepares the candidate and calls the existing continuation ([reference](native-turn-continuation-v2.md)) in a new transaction. After an uncertain transition response, it retries that exact candidate unchanged. It does not re-prepare through the old operation bearer after a successful transfer. Host owns publisher retirement and reopening the successor Agent after reconciliation.

An internal `kind: 'reconcile'` preparation instead uses the actual historical consumed-frame provider with the current separately issued storage bearer. PG supplies the original consumption coordinates; the returned request separately retains the current storage epoch. Host resumes the original native Session to persist interrupted closers, installs a refusal before any new turn, and does not wake pending input or install business tools during this repair. It stops and drains operation renewal before sending the prepared transition while retaining independent Writer renewal. The existing operation timeout bounds this recovery and releases occupancy on failure without pretending that an uncertain turn settled.

The preparer refuses an unclaimed frame, an open or mismatched turn, incomplete cohort or claim coordinates, inconsistent pending revisions, a mismatched presentation seal, expired authority or exceeded bounds. The caller preserves native quiescence while reconciling the failure. A later event or presentation watermark invalidates the candidate; continuation rechecks its full proof and clocks before settlement.

<a id="authority-and-limits"></a>
## Authority and limits

The required frame provider reads actual frames through `frames.verifyInTransaction`. Actual TaskStore authorization and independent Writer checks protect the bounded history and ledger reads. Empty continuing cohorts remain in boundary order; canceled changes do not become consumed origins. Pending selection uses the real next-turn head, otherwise the first next-step input, with its latest strictly decoded revision and digest. The preparer validates the presentation seal and retains that presentation.

Preparation reads and locks PG records without changing them, issuing a Grant, renewing leases or settling operations. The returned DTO grants no execution permission. Deployment supplies explicit history, record, cohort, request and presentation bounds. Platform initialization and transport registration remain integration responsibilities; this module adds no schema or endpoint.

<a id="dev-note"></a>
## Dev Note

None.
