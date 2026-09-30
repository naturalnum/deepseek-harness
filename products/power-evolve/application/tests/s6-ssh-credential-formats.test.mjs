/** Offline credential-format regressions; no process, socket, or database fixtures. */
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { SshCredentialCipher, mergeSshCredential, sshChangesCredential,
  sshNeedsUpload, sshUploadForPlan } from '../lib/platform/ssh-credentials.js'

const key = randomBytes(32)
const cipher = new SshCredentialCipher(key.toString('base64url'))
const identity = () => ({ userId: randomUUID(), connectionId: randomUUID(), credentialRevision: 1,
  credentialKind: 'password', formatVersion: 2, aadRequestId: null })

test('format one reads historical raw password with original install-request AAD, including JSON-shaped values', () => {
  const context = { ...identity(), formatVersion: 1, aadRequestId: randomUUID() }
  const password = '{"formatVersion":2,"password":"still a raw legacy password"}'
  const iv = randomBytes(12)
  const legacy = createCipheriv('aes-256-gcm', key, iv)
  legacy.setAAD(Buffer.from(['power-evolve-ssh-v1', context.userId, context.aadRequestId, '1'].join('\0')))
  const ciphertext = Buffer.concat([legacy.update(password, 'utf8'), legacy.final()])
  const sealed = Buffer.concat([iv, legacy.getAuthTag(), ciphertext])
  assert.deepEqual(cipher.open(context, sealed), { kind: 'password', password })
  assert.equal(cipher.legacyFingerprint(Buffer.from(password)),
    createHmac('sha256', key).update(password).digest('hex'))
  assert.throws(() => cipher.open({ ...context, aadRequestId: randomUUID() }, sealed),
    { code: 'ssh_credential_unavailable' })
  assert.throws(() => cipher.open({ ...context, formatVersion: 2, aadRequestId: null }, sealed),
    { code: 'ssh_credential_unavailable' })
})

test('format two binds both authentication kinds to owner, connection, credential revision and kind', () => {
  for (const credential of [{ kind: 'password', password: ' retained whitespace ' },
    { kind: 'private_key', privateKey: 'fixture-key', passphrase: 'fixture-passphrase' }]) {
    const context = { ...identity(), credentialKind: credential.kind }
    const sealed = cipher.seal(context, credential)
    assert.deepEqual(cipher.open(context, sealed), credential)
    for (const changed of [
      { ...context, userId: randomUUID() }, { ...context, connectionId: randomUUID() },
      { ...context, credentialRevision: 2 },
      { ...context, credentialKind: credential.kind === 'password' ? 'private_key' : 'password' },
    ]) assert.throws(() => cipher.open(changed, sealed), { code: 'ssh_credential_unavailable' })
    assert.throws(() => new SshCredentialCipher(randomBytes(32).toString('base64url')).open(context, sealed),
      { code: 'ssh_credential_unavailable' })
    const corrupted = Buffer.from(sealed); corrupted[corrupted.length - 1] ^= 1
    assert.throws(() => cipher.open(context, corrupted), { code: 'ssh_credential_unavailable' })
  }
})

test('replacement upload fields match the plan exactly and kind switches cannot retain another kind', () => {
  const password = { kind: 'password', password: 'replace' }
  assert.deepEqual(sshUploadForPlan(password, { formatVersion: 2, password: 'secret' }),
    { formatVersion: 2, password: 'secret' })
  for (const body of [{ formatVersion: 2 }, { formatVersion: 2, password: 'secret', privateKey: 'key' },
    { formatVersion: 2, password: 'secret', passphrase: 'extra' }, { formatVersion: 1, password: 'secret' }]) {
    assert.throws(() => sshUploadForPlan(password, body))
  }
  const retainPassword = { kind: 'password', password: 'retain' }
  assert.throws(() => mergeSshCredential(retainPassword, { formatVersion: 2 },
    { kind: 'private_key', privateKey: 'key' }), { code: 'ssh_credential_retention_invalid' })
  assert.deepEqual(mergeSshCredential(retainPassword, { formatVersion: 2 },
    { kind: 'password', password: 'unchanged' }), { kind: 'password', password: 'unchanged' })
  assert.equal(sshNeedsUpload(retainPassword), false)
  assert.equal(sshChangesCredential(retainPassword), false)
})

test('retaining or clearing a private-key passphrase never invents an implicit replacement', () => {
  const previous = { kind: 'private_key', privateKey: 'key', passphrase: 'old' }
  const clear = { kind: 'private_key', privateKey: 'retain', passphrase: 'clear' }
  assert.deepEqual(mergeSshCredential(clear, { formatVersion: 2 }, previous), { kind: 'private_key', privateKey: 'key' })
  assert.equal(sshNeedsUpload(clear), false)
  assert.equal(sshChangesCredential(clear), true)
  assert.throws(() => mergeSshCredential(clear, { formatVersion: 2, passphrase: 'hidden replacement' }, previous))
  const retain = { kind: 'private_key', privateKey: 'retain', passphrase: 'retain' }
  assert.deepEqual(mergeSshCredential(retain, { formatVersion: 2 }, previous), previous)
  assert.deepEqual(mergeSshCredential(retain, { formatVersion: 2 }, { kind: 'private_key', privateKey: 'key' }),
    { kind: 'private_key', privateKey: 'key' })
  assert.throws(() => mergeSshCredential({ ...retain, privateKey: 'replace' },
    { formatVersion: 2, privateKey: 'new' }, { kind: 'password', password: 'wrong source' }),
  { code: 'ssh_credential_retention_invalid' })
})

test('full field byte limits survive JSON escaping and secret replay identity is canonical and keyed', () => {
  const plan = { kind: 'private_key', privateKey: 'replace', passphrase: 'replace' }
  const supplied = { formatVersion: 2, privateKey: '\x01'.repeat(7168), passphrase: '\x01'.repeat(1024) }
  const context = { ...identity(), credentialKind: 'private_key' }
  const credential = mergeSshCredential(plan, supplied)
  assert.deepEqual(cipher.open(context, cipher.seal(context, credential)), credential)
  assert.throws(() => sshUploadForPlan(plan, { ...supplied, privateKey: 'x'.repeat(7169) }))
  assert.throws(() => sshUploadForPlan(plan, { ...supplied, passphrase: 'x'.repeat(1025) }))
  assert.throws(() => sshUploadForPlan({ kind: 'password', password: 'replace' },
    { formatVersion: 2, password: 'x'.repeat(4097) }))
  assert.throws(() => sshUploadForPlan({ kind: 'password', password: 'replace' },
    { formatVersion: 2, password: '\ud800' }))
  assert.equal(cipher.fingerprint('upload', supplied), cipher.fingerprint('upload', {
    passphrase: supplied.passphrase, privateKey: supplied.privateKey, formatVersion: 2,
  }))
  assert.notEqual(cipher.fingerprint('upload', supplied), cipher.fingerprint('other-purpose', supplied))
  assert.notEqual(cipher.fingerprint('upload', supplied),
    new SshCredentialCipher(randomBytes(32).toString('base64url')).fingerprint('upload', supplied))
})
