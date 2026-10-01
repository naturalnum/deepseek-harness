/** Wire rejection tests for observations, persisted file facts and conditional publication. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { artifactPublishRequest, executionFilesRequest, executionFilesView,
  runnerFileChanges, verifiedExecutionFiles } from '../../contracts/lib/execution-files.js'

const file = { path: 'reports/结果.txt', sizeBytes: 4, sha256: 'a'.repeat(64) }
const observation = { status: 'complete', files: [file], reasons: [] }

test('Runner candidates reject escaping paths, duplicate versions and oversized content', () => {
  assert.deepEqual(runnerFileChanges.parse(observation), observation)
  for (const path of ['../private', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', 'a\0b']) {
    assert.equal(runnerFileChanges.safeParse({ ...observation, files: [{ ...file, path }] }).success, false)
  }
  for (const files of [[file, file], [{ ...file, sizeBytes: 2097153 }], [{ ...file, sha256: 'not-a-digest' }]]) {
    assert.equal(runnerFileChanges.safeParse({ ...observation, files }).success, false)
  }
  assert.equal(runnerFileChanges.safeParse({ ...observation, files: Array.from({ length: 101 },
    (_, index) => ({ ...file, path: `result-${index}` })) }).success, false)
})

test('unavailable and partial scans cannot present themselves as complete verified facts', () => {
  assert.equal(runnerFileChanges.safeParse({ ...observation, reasons: ['excluded_paths'] }).success, false)
  assert.equal(runnerFileChanges.safeParse({ ...observation, status: 'partial' }).success, false)
  assert.equal(runnerFileChanges.safeParse({ ...observation, status: 'unavailable', reasons: ['scan_unavailable'] }).success, false)
  const partial = { ...observation, status: 'partial', reasons: ['verification_failed'] }
  assert.equal(runnerFileChanges.safeParse(partial).success, false)
  assert.deepEqual(verifiedExecutionFiles.parse(partial), partial)
  assert.equal(verifiedExecutionFiles.safeParse({ ...partial, reasons: ['verification_failed', 'verification_failed'] }).success, false)
})

test('Session-scoped queries and response items require unique bounded execution identities', () => {
  const executionId = randomUUID(), sessionId = randomUUID()
  assert.equal(executionFilesRequest.safeParse({ sessionId, executionIds: [executionId, executionId] }).success, false)
  assert.equal(executionFilesRequest.safeParse({ sessionId, executionIds: [] }).success, false)
  assert.equal(executionFilesRequest.safeParse({ sessionId, executionIds: Array.from({ length: 21 }, () => randomUUID()) }).success, false)
  const item = { ...observation, executionId, callId: 'call-1', state: 'succeeded' }
  const view = { sessionId, workspaceId: randomUUID(), items: [item] }
  assert.deepEqual(executionFilesView.parse(view), view)
  assert.equal(executionFilesView.safeParse({ ...view, items: [item, item] }).success, false)
  assert.equal(executionFilesView.safeParse({ ...view, items: [{ ...item, state: 'running' }] }).success, false)
  assert.equal(executionFilesView.safeParse({ ...view, items: [{ ...item, status: 'pending', files: [], reasons: [] }] }).success, false)
  assert.equal(executionFilesView.safeParse({ ...view, items: [{ ...item, state: 'running', status: 'pending', files: [], reasons: [] }] }).success, true)
})

test('conditional publication retains the source version and permits existing unconditioned callers', () => {
  const request = { requestId: randomUUID(), sessionId: randomUUID(), path: file.path }
  assert.deepEqual(artifactPublishRequest.parse(request), request)
  assert.deepEqual(artifactPublishRequest.parse({ ...request, expectedRevision: file.sha256 }),
    { ...request, expectedRevision: file.sha256 })
  assert.equal(artifactPublishRequest.safeParse({ ...request, expectedRevision: '' }).success, false)
})
