/** Real account Loader, Gateway, Settings, C06 save owner and local credentials; no network search. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { localeFixture } from './locale-field-fixture.ts'

const fields = [
  { namespace: 'web', field: 'searchProvider', values: ['deepseek-official', 'deepseek-search-api'] },
  { namespace: 'web', field: 'fetchProvider', values: ['http', 'deepseek-fetch-api'] },
  { namespace: 'web-search-deepseek', field: 'baseURL', values: ['https://api.deepseek.com/anthropic/v1'] },
  { namespace: 'web-search-deepseek', field: 'maxUses' },
  { namespace: 'web-deepseek-api', field: 'baseURL', values: ['https://api.deepseek.com/v1/tools'] },
  { namespace: 'web-deepseek-api', field: 'count' },
]

it('writes actual approved web settings and the original account credential without crossing accounts', async () => {
  const a = await localeFixture('web-account-a', true, fields), b = await localeFixture('web-account-b', true, fields)
  const otherBefore = readFileSync(b.profile.patchPath), otherKey = readFileSync(b.credentialPath)
  expect(a.initialKey.configured).toBe(false)
  expect(JSON.stringify(a.initialKey)).not.toContain('synthetic-root-must-not-escape')
  expect(JSON.stringify(a.ctx.settingsController.describe())).not.toContain('synthetic-root-must-not-escape')
  expect(a.ctx.settingsController.describe().namespaces.map(row => row.ns).sort()).toEqual([
    'web', 'web-deepseek-api', 'web-search-deepseek',
  ])
  const changed = await a.call([{ op: 'set', path: ['maxUses'], value: 3 }], a.revision('web-search-deepseek'),
    { ns: 'web-search-deepseek' })
  expect(changed).toMatchObject({ ns: 'web-search-deepseek', value: { maxUses: 3 } })
  const key = await a.keyState()
  expect(JSON.stringify(key)).not.toContain('synthetic-fixture-key')
  await a.writeKey(key.version, 'synthetic-account-only')
  expect((await a.ctx.credentials.resolve(a.ref))?.value).toBe('synthetic-account-only')
  expect(readFileSync(b.profile.patchPath)).toEqual(otherBefore)
  expect(readFileSync(b.credentialPath)).toEqual(otherKey)
  await expect(b.writeKey(key.version, 'cross-account')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(a.writeKey(key.version, 'stale-must-not-write')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect((await a.ctx.credentials.resolve(a.ref))?.value).toBe('synthetic-account-only')
  const latest = await a.keyState()
  a.revoke()
  await expect(a.writeKey(latest.version, 'stale-generation')).rejects.toBeDefined()
  expect((await a.ctx.credentials.resolve(a.ref))?.value).toBe('synthetic-account-only')
  expect(a.barrier.snapshot().failures).toEqual([])
  a.restore()
}, 15_000)

it('rejects unapproved destinations and credential references without changing the account profile', async () => {
  const f = await localeFixture('web-account-denied', true, fields)
  const before = readFileSync(f.profile.patchPath)
  for (const [field, value] of [['baseURL', 'https://unapproved.example'], ['apiKeyEnv', 'ROOT_SECRET']]) {
    await expect(f.call([{ op: 'set', path: [field], value }], f.revision('web-search-deepseek'),
      { ns: 'web-search-deepseek' })).rejects.toBeDefined()
    expect(readFileSync(f.profile.patchPath)).toEqual(before)
  }
  expect(f.barrier.snapshot().failures).toEqual([])
})


it('saves and resets both real provider choices together and rejects an inconsistent pair', async () => {
  const f = await localeFixture('web-provider-switch', true, fields)
  const select = (search: string, fetch: string) => [
    { op: 'set', path: ['searchProvider'], value: search }, { op: 'set', path: ['fetchProvider'], value: fetch },
  ]
  await f.call(select('deepseek-search-api', 'deepseek-fetch-api'), f.revision('web'), { ns: 'web' })
  expect(f.ctx.settingsController.describe().namespaces.find(row => row.ns === 'web')?.value)
    .toMatchObject({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
  await expect(f.keyState()).resolves.toBeDefined()
  const before = readFileSync(f.profile.patchPath)
  await expect(f.call([{ op: 'set', path: ['searchProvider'], value: 'deepseek-official' }], f.revision('web'),
    { ns: 'web' })).rejects.toBeDefined()
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  await f.call([{ op: 'unset', path: ['searchProvider'] }, { op: 'unset', path: ['fetchProvider'] }], f.revision('web'), { ns: 'web' })
  expect(f.ctx.settingsController.describe().namespaces.find(row => row.ns === 'web')?.value)
    .toMatchObject({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
  await expect(f.keyState()).resolves.toBeDefined()
})
