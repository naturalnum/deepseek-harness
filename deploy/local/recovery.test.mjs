import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRecoveryCommand } from './recovery.mjs'

test('cold recovery help imports the whole entry without reading inputs or creating resources', async () => {
  const output = []
  assert.equal(await runRecoveryCommand([], { report: value => output.push(value) }), 0)
  assert.equal(await runRecoveryCommand(['--help'], { report: value => output.push(value) }), 0)
  assert.equal(output.length, 2)
  assert.match(output[0], /snapshot\|check\|prepare\|publish/)
  assert.match(output[0], /原冒烟未过不报告恢复成功/)
})

test('unknown phases, missing arguments and invalid digests refuse before operational file access', async () => {
  for (const argv of [['restore'], ['clear', '--input', '/must-not-read', '--sha256', 'a'.repeat(64)],
    ['restore', '--input', '/must-not-read', '--sha256', 'invalid'], ['--help', '--input', '/must-not-read']]) {
    await assert.rejects(runRecoveryCommand(argv), error => error.name === 'CandidateError' && !error.message.includes('must-not-read'))
  }
})
