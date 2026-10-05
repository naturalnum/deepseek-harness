/** Real disposable PostgreSQL/POSIX Artifact reads through the production native adapter; no browser or parser runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmod, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeFileRead } from '../lib/platform/native-files.js'
import { IdentityService } from '../lib/platform/identity.js'
import { artifactDocumentPathFor } from '../../contracts/lib/artifact-document.js'
import { previewFixture } from './office-preview-fixture.mjs'
import { clearTaskCredential, disableFixtureAccount, taskCredential } from './task-credential-fixture.mjs'

const options = { timeout: 30000 }
async function published(f, name, bytes) {
  await writeFile(join(f.root, f.workspaceId, name), bytes)
  return f.artifacts.publish(f.user, randomUUID(), f.sessionId, name)
}

test('native PDF/XLSX byte ranges and text observations retain immutable bytes after source and storage changes', options, async t => {
  const f = await previewFixture(t, {}, 1), native = new NativeFileRead(f.pool, f.files, f.artifacts)
  for (const [name, bytes] of [['view.pdf', Buffer.from('%PDF-1.4\nimmutable\n%%EOF\n')],
    ['book.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 127])], ['read.txt', Buffer.from('first\n第二行\n')]]) {
    const record = await published(f, name, bytes), path = artifactDocumentPathFor(record.artifactId, record.filename)
    const request = { sessionId: f.sessionId, path }
    await writeFile(join(f.root, f.workspaceId, name), 'changed'); await unlink(join(f.root, f.workspaceId, name))
    await f.pool.query('UPDATE pe_workspaces SET binding_generation=binding_generation+1 WHERE id=$1', [f.workspaceId])
    assert.deepEqual(await native.stat(f.user, request, f.token), { absolutePath: path, version: record.sha256, bytes: bytes.length })
    assert.deepEqual(await native.observe(f.user, request, f.token), { absolutePath: path, version: record.sha256 })
    const range = await native.readBytes(f.user, { ...request, options: { range: { offset: 2, length: 3 } } }, f.token)
    assert.deepEqual(Buffer.from(range.data, 'base64'), bytes.subarray(2, 5)); assert.equal(range.eof, false)
    const whole = await native.readBytes(f.user, { ...request, options: {} }, f.token)
    assert.deepEqual(Buffer.from(whole.data, 'base64'), bytes); assert.equal(whole.eof, true)
    if (name === 'read.txt') assert.equal((await native.read(f.user, { ...request, range: { offset: 2, limit: 1 } }, f.token)).text, '第二行')
  }
})

test('native Artifact scope and literal addresses reject aliases without mutable Workspace fallback', options, async t => {
  const f = await previewFixture(t), record = await published(f, 'literal name.pdf', Buffer.from('%PDF-snapshot'))
  const native = new NativeFileRead(f.pool, f.files, f.artifacts), path = artifactDocumentPathFor(record.artifactId, record.filename)
  for (const method of ['kind', 'list', 'read', 'readInWorkspace', 'bindingForId']) {
    f.files[method] = async () => assert.fail('Artifact address reached mutable Workspace access')
  }
  const request = { sessionId: f.sessionId, path }, other = await f.createSession(f.userId)
  const bobId = await f.createUser(), bob = { userId: bobId }, bobSession = await f.createSession(bobId)
  const bobToken = await taskCredential(f.pool, bob)
  await assert.rejects(native.stat(f.user, { ...request, path: path.replace(record.filename, 'wrong.pdf') }, f.token), { status: 404, code: 'artifact_not_found' })
  await assert.rejects(native.stat(f.user, { ...request, sessionId: other.sessionId }, f.token), { status: 404, code: 'artifact_not_found' })
  await assert.rejects(native.stat(bob, { ...request, sessionId: bobSession.sessionId }, bobToken), { status: 404, code: 'artifact_not_found' })
  await assert.rejects(native.stat(bob, request, bobToken), { status: 404, code: 'session_not_found' })
  await assert.rejects(native.stat(bob, request, f.token), { status: 401, code: 'account_unauthorized' })
  for (const invalid of [path.replace(record.artifactId, record.artifactId.toUpperCase()), path.slice(1),
    `/artifacts/${record.artifactId}/./${record.filename}`, `${path}/extra`, `/workspace/..${path}`, '../artifacts/a']) {
    await assert.rejects(native.stat(f.user, { ...request, path: invalid }, f.token), { status: 400, code: 'invalid_path' })
  }
  await assert.rejects(native.stat(f.user, { ...request, path: path.replace(' ', '%20') }, f.token), { status: 404, code: 'artifact_not_found' })
  await assert.rejects(native.list(f.user, request), { status: 400, code: 'invalid_path' })
  await assert.rejects(native.readBytes(f.user, { ...request, options: { baseFile: '/workspace/base.md' } }), { code: 'invalid_path' })
  await assert.rejects(native.readBytes(f.user, { ...request, path: 'other.png', options: { baseFile: path } }), { code: 'invalid_path' })
  await assert.rejects(f.pool.query('UPDATE pe_sessions SET workspace_id=$2 WHERE id=$1', [f.sessionId, other.workspaceId]), /Session Workspace is immutable/u)
})

test('native Artifact corruption and missing immutable bytes reject rather than reporting file absence; disabled owners lose access', options, async t => {
  const f = await previewFixture(t), record = await published(f, 'frozen.txt', Buffer.from('original'))
  const native = new NativeFileRead(f.pool, f.files, f.artifacts), request = {
    sessionId: f.sessionId, path: artifactDocumentPathFor(record.artifactId, record.filename) }
  const immutable = join(f.localRoot, 'artifacts', f.userId, `${record.artifactId}.bin`)
  await chmod(immutable, 0o600); await writeFile(immutable, 'tampered')
  await assert.rejects(native.observe(f.user, request, f.token), { code: 'artifact_unavailable' })
  await unlink(immutable)
  await assert.rejects(native.stat(f.user, request, f.token), { code: 'artifact_unavailable' })
  await writeFile(immutable, 'original', { mode: 0o400 })
  await disableFixtureAccount(f.pool, f.user)
  await assert.rejects(native.readBytes(f.user, { ...request, options: {} }, f.token), { code: 'account_unauthorized' })
})

test('a credential revoked after outer authentication cannot deliver native Artifact bytes, including logout and rotation', options, async t => {
  const f = await previewFixture(t, {}, 1), record = await published(f, 'private.pdf', Buffer.from('%PDF-owned'))
  const native = new NativeFileRead(f.pool, f.files, f.artifacts), identity = new IdentityService(f.pool, 3600000)
  const request = { sessionId: f.sessionId, path: artifactDocumentPathFor(record.artifactId, record.filename), options: {} }
  await f.pool.query('UPDATE pe_users SET settings=$2 WHERE id=$1', [f.userId, { model: 'fixture', maxTokens: 100, revision: 1 }])
  await assert.rejects(native.readBytes(f.user, request), { status: 401, code: 'account_unauthorized' })
  const authenticated = await identity.authenticate(f.token)
  await identity.logout(f.token)
  await assert.rejects(native.readBytes(authenticated, request, f.token), { status: 401, code: 'account_unauthorized' })
  clearTaskCredential(f.pool, f.user)
  const rotated = await taskCredential(f.pool, f.user), beforeRotation = await identity.authenticate(rotated)
  await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.userId])
  await assert.rejects(native.readBytes(beforeRotation, request, rotated), { status: 401, code: 'account_unauthorized' })
})
