import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { validateRecoveryInputs } from './recovery-validation.mjs'

const schemas = ['runtime-root', 'api-root', 'files-root', 'execution-root', 'access-root', 'connection']
function fixture() {
  const home = '/run/dsh-feature-root', hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const plan = Buffer.from(JSON.stringify({ version: 3, slots: [{}, {}, {}], maxAccounts: 3,
    installAnchor: '/synthetic/product/package.json', baseConfigPath: '/opt/dsh-features/account-base.yml' }))
  const deployment = Buffer.from(JSON.stringify({ schema: 'pe-opensandbox-root-deployment-v2',
    storage: { plan: { path: home + '/storage-plan.json', sha256: hash(plan) } }, lifecycle: { environmentVersion: 'fixture-v1', provider: 'fixture' } }))
  const root = [{ insert: [...schemas.map(id => ({ id, name: '@fixture/' + id, config: id === 'runtime-root'
    ? { paths: { maxPathBytes: 1024 }, native: { configPath: '/opt/dsh-features/account-base.yml' } }
    : id === 'files-root' ? { staticStorage: { planPath: home + '/storage-plan.json', planSha256: hash(plan) } }
    : id === 'execution-root' ? { rootDeployment: { path: home + '/rootDeployment.json', sha256: hash(deployment) },
      managed: { allocations: { environmentVersion: 'fixture-v1', provider: 'fixture' } } } : {} })),
    { id: 'credentials', config: { path: home + '/credentials.json' } }] }]
  const credentials = Buffer.from('{"version":1,"refs":{"fixture":"synthetic-only"}}\r\n'), calls = []
  const prepared = { files: [
    { relativePath: 'profiles/cloud/cordis.patch.yml', bytes: Buffer.from('\uFEFF' + JSON.stringify(root) + '\r\n') },
    { relativePath: 'rootDeployment.json', bytes: deployment }, { relativePath: 'storage-plan.json', bytes: plan },
    { relativePath: 'credentials.json', bytes: credentials },
    { relativePath: 'profiles/cloud/package.json', bytes: Buffer.from('{"private":true,"type":"module"}\n') },
    { relativePath: 'profiles/cloud/cordis.yml', bytes: Buffer.alloc(0) },
  ] }
  const load = async name => {
    calls.push(name)
    if (name === '@deepseek-ai/dsh-pe-opensandbox') return { parseRootDeploymentInput: value => value }
    if (name === '@deepseek-ai/dsh-pe-cloud-files/root') return { parseStorageDeploymentPlan: (bytes, maximum) => {
      assert.equal(maximum, 1024); return JSON.parse(bytes)
    } }
    if (name === '@deepseek-ai/dsh-credentials-local') return { parseCredentialsDocument: (text, filename) => {
      assert.equal(text, credentials.toString('utf8')); assert.equal(filename, home + '/credentials.json')
    } }
    return { Config: config => config }
  }
  return { prepared, load, calls, settings: { installAnchor: '/synthetic/product/package.json', load } }
}

test('candidate validation uses all original installed parser interfaces without changing BOM, CRLF or credential bytes', async () => {
  const f = fixture(), before = f.prepared.files.map(row => Buffer.from(row.bytes))
  const result = await validateRecoveryInputs(f.prepared, f.settings)
  assert.deepEqual(result.validatedLoaderSchemas, schemas)
  assert.deepEqual(f.calls, [...schemas.map(id => '@fixture/' + id), '@deepseek-ai/dsh-pe-opensandbox',
    '@deepseek-ai/dsh-pe-cloud-files/root', '@deepseek-ai/dsh-credentials-local'])
  assert.equal(result.protectedDeploymentParsed && result.planParsed && result.credentialsParsed, true)
  assert.deepEqual(f.prepared.files.map(row => row.bytes), before)
})

test('each original parser or Loader refusal rejects without echoing its private diagnostic', async () => {
  for (const selected of [...schemas.map(id => '@fixture/' + id), '@deepseek-ai/dsh-pe-opensandbox',
    '@deepseek-ai/dsh-pe-cloud-files/root', '@deepseek-ai/dsh-credentials-local']) {
    const f = fixture(), load = async name => {
      if (name === selected) return new Proxy({}, { get: () => () => { throw new Error('synthetic-private-diagnostic') } })
      return f.load(name)
    }
    await assert.rejects(validateRecoveryInputs(f.prepared, { ...f.settings, load }), error => error.name === 'CandidateError'
      && !error.message.includes('synthetic-private-diagnostic') && /不发布ready/.test(error.message))
  }
})

test('a schema-valid candidate with a mismatched protected plan hash cannot reach ready publication', async () => {
  const f = fixture(), target = f.prepared.files.find(row => row.relativePath === 'rootDeployment.json')
  f.prepared.inputsValidated = true
  const value = JSON.parse(target.bytes); value.storage.plan.sha256 = 'f'.repeat(64)
  target.bytes = Buffer.from(JSON.stringify(value))
  await assert.rejects(validateRecoveryInputs(f.prepared, f.settings), /不发布ready/)
})
