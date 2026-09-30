/** Deployment projections and real account configuration parsers; no Kubernetes mutation. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { accountBootstrapPath, accountManagementPath, validateAccountStartup } from './accounts.mjs'
import { buildManifests, validateValues } from './render.mjs'
import { validateAccountMaterials } from './preflight.mjs'

const values = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))
const management = { maxUsers: 10000, models: [{ id: 'fixture-model', label: 'Fixture', maxTokens: 128 }],
  initialSettings: { model: 'fixture-model', maxTokens: 64 } }
const bootstrap = { mode: 'create', userId: randomUUID(), username: 'first-admin', displayName: 'Administrator',
  password: 'private-fixture-password' }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')

test('only the Platform projects account files and bootstrap requires explicit configuration', () => {
  for (const enabled of [false, true]) {
    const items = buildManifests({ ...values, accounts: { bootstrap: enabled } })
    const host = items.find(item => item.kind === 'Deployment' && item.metadata.name === 'power-evolve-host')
    const platform = items.find(item => item.kind === 'Deployment' && item.metadata.name === 'power-evolve-platform')
    assert(!JSON.stringify(host).includes('account-'))
    const keys = platform.spec.template.spec.volumes.find(volume => volume.name === 'private').projected.sources
      .flatMap(source => source.secret?.items.map(item => item.key) ?? [])
    assert(keys.includes('account-management.json'))
    assert.equal(keys.includes('account-bootstrap.json'), enabled)
    const config = items.find(item => item.kind === 'ConfigMap' && item.metadata.name === 'power-evolve-platform-config')
    assert.equal(config.data.PE_ACCOUNT_BOOTSTRAP_FILE, enabled ? accountBootstrapPath : undefined)
    assert(!JSON.stringify(items).includes(bootstrap.password))
  }
  for (const accounts of [null, { bootstrap: 'true' }, { bootstrap: true, role: 'ADMIN' }]) {
    assert.throws(() => validateValues({ ...values, accounts }), /Invalid account deployment settings/u)
  }
})

test('startup reads only selected files and rejects invalid private inputs without exposing values', async () => {
  const files = new Map([[accountManagementPath, JSON.stringify(management)], [accountBootstrapPath, JSON.stringify(bootstrap)]])
  const seen = []
  const read = async path => { seen.push(path); if (!files.has(path)) throw new Error('Missing projection'); return files.get(path) }
  await validateAccountStartup('', read)
  assert.deepEqual(seen, [accountManagementPath])
  seen.length = 0
  await validateAccountStartup(accountBootstrapPath, read)
  assert.deepEqual(seen, [accountManagementPath, accountBootstrapPath])
  for (const [path, text] of [[accountBootstrapPath, '{private-fixture-password'],
    [accountManagementPath, JSON.stringify({ ...management, maxUsers: 0 })]]) {
    const previous = files.get(path)
    files.set(path, text)
    await assert.rejects(validateAccountStartup(accountBootstrapPath, read),
      { message: 'Invalid account deployment configuration' })
    files.set(path, previous)
  }
  await assert.rejects(validateAccountStartup('/unprojected/private-fixture-password', read),
    { message: 'Invalid account deployment configuration' })
})

test('preflight checks the same parser and requires bootstrap material only when selected', async () => {
  const secret = { data: { 'account-management.json': encode(management) } }
  assert.deepEqual(await validateAccountMaterials(values, secret),
    { accountConfigurationReady: true, accountBootstrapConfigured: false })
  const enabled = { ...values, accounts: { bootstrap: true } }
  await assert.rejects(validateAccountMaterials(enabled, secret), { message: 'Invalid account deployment materials' })
  secret.data['account-bootstrap.json'] = encode(bootstrap)
  assert.deepEqual(await validateAccountMaterials(enabled, secret),
    { accountConfigurationReady: true, accountBootstrapConfigured: true })
  secret.data['account-bootstrap.json'] = encode({ ...bootstrap, username: '../private-fixture-password' })
  await assert.rejects(validateAccountMaterials(enabled, secret), { message: 'Invalid account deployment materials' })
})
