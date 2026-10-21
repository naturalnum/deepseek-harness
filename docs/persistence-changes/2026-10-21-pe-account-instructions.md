---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-pe-account-instructions

English | [中文](2026-10-21-pe-account-instructions.zh.md)

## Summary

Records the delivered C03 pe-account-instructions source variant in four shared durable-message roots, including the title request Message[] reference.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-pe-account-instructions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "0aa710e261979c74618477e371ee2c71d4e6eac3c82da0ed80e43faec1bf3667"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "68f880510996dc99a1b47790468bcf291d9dcbac49da6340c6f881791951ae7e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "89cd059576d133ef09838f1a13c0765cb4b7dac8383088f0c03189463c2528d5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "e4e0a3eadeff94e8c0504c954d4bbdbfd838e3d8accbbcb93a93580af9ed9ab8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source alternatives and old records are unchanged. New readers preserve their content, roles and source metadata; absent C03 records retain existing history behavior. Pre-C03 V4 codecs and the core Session reader accept nonempty producer kinds on user/developer messages and preserve unknown JSON metadata, so they retain this recorded text and attribution without requiring the C03 producer. The snapshot does not grant account/file authority or replay filesystem reads. An older installation without C03 does not acquire fresh account-instruction injection; this decision covers recorded-message reading, not that runtime capability. V3 readers are not covered and no downgrade is promised. The current producer writes user-role messages; developer/message and title messages[] change transitively through MessageSource, rather than through a new title writer or event layout. Session format remains V4.

<a id="verification"></a>
## Verification

`node node_modules/vitest/vitest.mjs run --cache=false packages/cloud/pe-account-instructions/tests/injection.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/session/session-format-v3-to-v4/tests/relationships.spec.ts packages/session/session-title-llm/tests/llm.spec.ts`: 4 files and 96 tests passed. The producer test reopens its committed V4 log and checks the instruction content and snapshot hashes; codec tests cover unknown-source preservation and refusal before recovery, and title tests preserve the existing request shape. Independent structural review finds only the shared source kind addition. The core Session reader, V4 codec/source traversal and title writer are byte-identical between the C03 parent and the reviewed checkout.

<a id="dev-note"></a>
## Dev Note

None.
