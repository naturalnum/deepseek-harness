/** Management wire checks run without PostgreSQL, models or an execution environment. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sshConfigurationInput, sshConnectionCreateRequest, sshConnectionUpdateRequest,
  sshCredentialTicketRequest, sshCredentialUpload, sshConnectionValue,
  sshCredentialTicketValue, sshMutationReceiptValue, sshManagementRequests,
} from '../lib/ssh-management-contracts.js'

const configuration = {
  displayName: 'SSH 开发机', host: 'ssh.example.test', port: 22, username: 'developer',
  hostKeySha256: `SHA256:${'a'.repeat(43)}`, workingDirectory: '~/project', enabled: true,
  authentication: { kind: 'password', password: 'replace' },
}
const request = () => ({ requestId: randomUUID(), configuration })
const connection = () => ({
  connectionId: randomUUID(), revision: 3, credentialRevision: 2,
  ...configuration, authentication: 'password', secretConfigured: true,
  passphraseConfigured: false, deletedAt: null,
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T01:00:00.000Z',
})

test('Host management rejects credential bytes and untrusted identity on every new method', () => {
  const update = { ...request(), connectionId: randomUUID(), baseRevision: 3 }
  const inputs = {
    sshConnectionsList: {}, sshConnectionsUpdate: update,
    sshConnectionsToggle: { requestId: randomUUID(), connectionId: randomUUID(), baseRevision: 3, enabled: false },
    sshConnectionsDelete: { requestId: randomUUID(), connectionId: randomUUID(), baseRevision: 3 },
    sshConnectionsTicket: { ...request(), purpose: 'create', sizeBytes: 72 },
    sshConnectionsReceipt: { requestId: randomUUID() },
  }
  for (const [method, schema] of Object.entries(sshManagementRequests)) {
    assert.equal(schema.safeParse(inputs[method]).success, true, method)
    for (const extra of [{ password: 'private' }, { privateKey: 'private' }, { userId: randomUUID() }]) {
      assert.equal(schema.safeParse({ ...inputs[method], ...extra }).success, false, method)
    }
  }
  assert.equal(sshConfigurationInput.safeParse({ ...configuration,
    authentication: { kind: 'password', password: 'private bytes' } }).success, false)
  assert.equal(sshConfigurationInput.safeParse({ ...configuration, secrets: { privateKey: 'private' } }).success, false)
})

test('creation forbids retention while updates carry explicit per-field credential instructions', () => {
  for (const authentication of [
    { kind: 'password', password: 'retain' },
    { kind: 'private_key', privateKey: 'retain', passphrase: 'clear' },
    { kind: 'private_key', privateKey: 'replace', passphrase: 'retain' },
  ]) {
    const value = { ...request(), configuration: { ...configuration, authentication } }
    assert.equal(sshConnectionCreateRequest.safeParse(value).success, false)
    assert.equal(sshCredentialTicketRequest.safeParse({ ...value, purpose: 'create', sizeBytes: 80 }).success, false)
    assert.equal(sshConnectionUpdateRequest.safeParse({ ...value, connectionId: randomUUID(), baseRevision: 3 }).success, true)
  }
  for (const passphrase of ['replace', 'clear']) {
    assert.equal(sshCredentialTicketRequest.safeParse({ ...request(), purpose: 'create', sizeBytes: 100,
      configuration: { ...configuration, authentication: { kind: 'private_key', privateKey: 'replace', passphrase } },
    }).success, true)
  }
})

test('direct secret intake requires format two and bounds actual UTF-8 and serialized bytes', () => {
  assert.equal(sshCredentialUpload.safeParse('a historical raw password').success, false)
  assert.equal(sshCredentialUpload.safeParse({ formatVersion: 1, password: 'legacy' }).success, false)
  assert.equal(sshCredentialUpload.safeParse({ formatVersion: 2, password: '密码'.repeat(682) }).success, true)
  assert.equal(sshCredentialUpload.safeParse({ formatVersion: 2, password: '密码'.repeat(683) }).success, false)
  assert.equal(sshCredentialUpload.safeParse({ formatVersion: 2, privateKey: '\u0001'.repeat(7168),
    passphrase: '\u0001'.repeat(1024) }).success, true)
  for (const password of ['contains\0nul', '\ud800', 'x'.repeat(4097)]) {
    assert.equal(sshCredentialUpload.safeParse({ formatVersion: 2, password }).success, false)
  }
  assert.equal(sshCredentialUpload.safeParse({ formatVersion: 2, password: 'ok', arbitrary: 'not accepted' }).success, false)
})

test('public receipts preserve deletion metadata but cannot contain plaintext or bypass upload verification', () => {
  const item = { ...connection(), deletedAt: '2026-09-30T02:00:00.000Z', enabled: false }
  assert.deepEqual(sshMutationReceiptValue.parse({ item }).item, item)
  assert.equal(sshConnectionValue.safeParse({ ...item, password: 'secret' }).success, false)
  assert.deepEqual(sshMutationReceiptValue.parse({ item: null }), { item: null })
  assert.equal(sshCredentialTicketValue.safeParse({ state: 'ready', item }).success, false)
  assert.equal(sshCredentialTicketValue.safeParse({ state: 'pending', requestId: randomUUID(),
    ticket: 'a'.repeat(43), uploadUrl: 'https://platform.example.test/ssh/upload',
    expiresAt: '2026-09-30T02:00:00.000Z' }).success, true)
})

test('management input respects Runner UTF-8 budgets and preserves literal directory whitespace', () => {
  assert.equal(sshConfigurationInput.safeParse({ ...configuration, username: '人'.repeat(85) }).success, true)
  assert.equal(sshConfigurationInput.safeParse({ ...configuration, username: '人'.repeat(86) }).success, false)
  for (const value of ['\ud800', 'a\0b']) {
    assert.equal(sshConfigurationInput.safeParse({ ...configuration, username: value }).success, false)
    assert.equal(sshConfigurationInput.safeParse({ ...configuration, workingDirectory: value }).success, false)
  }
  assert.equal(sshConfigurationInput.parse({ ...configuration, workingDirectory: ' folder ' }).workingDirectory, ' folder ')
  assert.equal(sshConnectionUpdateRequest.safeParse({ ...request(), connectionId: randomUUID(),
    baseRevision: 2_147_483_648 }).success, false)
})
