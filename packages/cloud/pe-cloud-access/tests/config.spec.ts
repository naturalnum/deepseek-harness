import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { parseAccessConfig } from '../src/config.ts'
import { apply, type Config } from '../src/root.ts'
import type { AccessConfig } from '../src/types.ts'

function config(): AccessConfig {
  return {
    publicOrigin: 'https://cloud.example.test',
    deploymentMode: 'production',
    trustedProxyAddresses: [],
    authSecretRef: 'test-auth-secret-reference',
    sessionRecheckMs: 20,
    authCheckTimeoutMs: 10,
    maxPeers: 4,
    maxPeersPerAccount: 2,
    maxPeerWaiters: 32, maxPeerWaitersPerAccount: 24, maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8,
    maxPeerCarriersPerLogin: 4, peerCloseTimeoutMs: 500,
    maxAuthOperations: 8,
    maxTrackedLogins: 16,
    maxTrackedLoginsPerAccount: 4,
    maxAuthInvalidations: 8,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
  }
}

describe('access deployment inputs', () => {
  it('requires explicit production limits without filling defaults', () => {
    expect(parseAccessConfig(config())).toEqual(config())
    const { sessionRecheckMs: _omitted, ...missing } = config()
    expect(() => parseAccessConfig(missing)).toThrow()
  })

  it.each([
    'https://cloud.example.test/', 'https://cloud.example.test/path', 'https://cloud.example.test?x=1',
    'https://user:password@cloud.example.test', 'http://cloud.example.test', 'file:///tmp/cloud',
  ])('rejects a noncanonical or insecure origin %s', (publicOrigin) => {
    expect(() => parseAccessConfig({ ...config(), publicOrigin })).toThrow()
  })

  it.each(['http://localhost:4100', 'http://127.0.0.1:4100', 'http://[::1]:4100'])('allows development loopback %s only in development', (publicOrigin) => {
    expect(parseAccessConfig({ ...config(), publicOrigin, deploymentMode: 'development' }).publicOrigin).toBe(publicOrigin)
    expect(() => parseAccessConfig({ ...config(), publicOrigin })).toThrow()
  })

  it.each([0, -1, 0.5, Infinity, NaN, 2_147_483_648])('rejects unusable authentication timer %s', (value) => {
    expect(() => parseAccessConfig({ ...config(), sessionRecheckMs: value })).toThrow()
    expect(() => parseAccessConfig({ ...config(), authCheckTimeoutMs: value })).toThrow()
  })

  it('requires distinct dedicated fields and exact trusted proxy addresses', () => {
    const valid = config()
    expect(() => parseAccessConfig({ ...valid, trustedProxyAddresses: ['forwarded.example'] })).toThrow()
    expect(() => parseAccessConfig({ ...valid, bindingFields: { ...valid.bindingFields, accountHeader: 'cookie' } })).toThrow()
    const duplicateHeader = { ...valid.bindingFields, generationHeader: valid.bindingFields.accountHeader }
    const duplicateQuery = { ...valid.bindingFields, generationQuery: valid.bindingFields.accountQuery }
    expect(() => parseAccessConfig({ ...valid, bindingFields: duplicateHeader })).toThrow()
    expect(() => parseAccessConfig({ ...valid, bindingFields: duplicateQuery })).toThrow()
    expect(parseAccessConfig({ ...valid, trustedProxyAddresses: ['127.0.0.1', '::1'] }).trustedProxyAddresses).toEqual(['127.0.0.1', '::1'])
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1%eth0.2', 'fe80::1%eth-0', 'fe80::1%foo:bar'])(
    'retains Node exact-IP acceptance for %s', (address) => {
      expect(parseAccessConfig({ ...config(), trustedProxyAddresses: [address] }).trustedProxyAddresses).toEqual([address])
    },
  )

  it.each(['127.1', '0177.0.0.1', '127.0.0.01', '::ffff:192.168.001.1', '::ffff:0x7f.0.0.1'])(
    'retains Node exact-IP rejection for %s', (address) => {
      expect(() => parseAccessConfig({ ...config(), trustedProxyAddresses: [address] })).toThrow()
    },
  )

  it('rejects a per-account peer capacity larger than global capacity', () => {
    expect(() => parseAccessConfig({ ...config(), maxPeersPerAccount: 5 })).toThrow()
  })

  it.each(['maxAuthOperations', 'maxTrackedLogins', 'maxTrackedLoginsPerAccount', 'maxAuthInvalidations',
    'maxPeerWaiters', 'maxPeerWaitersPerAccount', 'maxPeerCarriers', 'maxPeerCarriersPerAccount', 'maxPeerCarriersPerLogin', 'peerCloseTimeoutMs'])(
    'requires an explicit positive finite %s', (field) => {
      for (const value of [0, -1, 0.5, Infinity, NaN]) expect(() => parseAccessConfig({ ...config(), [field]: value })).toThrow()
      const missing = Object.fromEntries(Object.entries(config()).filter(([name]) => name !== field))
      expect(() => parseAccessConfig(missing)).toThrow()
    },
  )

  it('rejects per-scope budgets greater than their parent', () => {
    expect(() => parseAccessConfig({ ...config(), maxPeerWaitersPerAccount: 33 })).toThrow()
    expect(() => parseAccessConfig({ ...config(), maxPeerCarriersPerAccount: 17 })).toThrow()
    expect(() => parseAccessConfig({ ...config(), maxPeerCarriersPerLogin: 9 })).toThrow()
    expect(() => parseAccessConfig({ ...config(), peerCloseTimeoutMs: 2_147_483_648 })).toThrow()
  })

  it('rejects tracked-login per-account capacity larger than global capacity', () => {
    expect(() => parseAccessConfig({ ...config(), maxTrackedLoginsPerAccount: 17 })).toThrow()
  })

  it('rejects component-only configuration without allocating root resources', async () => {
    const ctx = new Context()
    await expect(apply(ctx, config() as Config)).rejects.toThrow('explicit valid database')
    expect(ctx.get('peAuth')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
