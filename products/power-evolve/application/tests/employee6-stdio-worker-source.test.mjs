/** Three bounded current source Worker service flows; this entry never claims deployed Pod qualification. */
import { test } from 'node:test'
import { runWorkerLinuxCase } from './employee6-stdio-worker-linux-fixture.ts'

const all = ['unallocated-cancel-drain', 'discover-call-once-and-reconcile', 'lease-lost-cancel-original']
for (const job of all) {
  test('actual current source Cloud STDIO ' + job, { timeout: 120_000 }, async (t) => {
    const result = await runWorkerLinuxCase(job, t.signal)
    t.diagnostic(JSON.stringify({ job, context: result.context, naturalExit: result.naturalExit,
      physicalPodQualified: false, currentSourceServiceFixture: true }))
  })
}
