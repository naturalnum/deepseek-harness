/** Actual Loader and current generated descriptor assembly, without production business-ready authority. */
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { managementAccount, descriptors } from './fixtures/remote-servers/account.ts'
import { remoteManagedFixture } from '../../pe-opensandbox/tests/remote-managed-fixture.ts'

it('mounts original strict management codecs, native tools and managed providers through cordis.yml', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remote-loader-'))), lifetime = new AbortController()
  const root = await remoteManagedFixture()
  let account: Awaited<ReturnType<typeof managementAccount>> | undefined
  try {
    descriptors(home); const path = join(home, 'A'); mkdirSync(path)
    account = await managementAccount(path, { accountId: brandString<AccountBinding['accountId']>('loader-account'),
      epoch: brandString<AccountBinding['epoch']>('1'),
      recipeVersion: 'remote-loader-fixture', lifetime: lifetime.signal }, root,
    { async withModelKeyPeerUse() { throw new Error('No login in descriptor assembly') } })
    expect(account.ctx.cloudRemoteServers.inspect().rpcEndpoints).toHaveLength(1)
    const descriptor = account.ctx.typert.local.get('cloudRemoteServers/action')
    expect(descriptor).toMatchObject({ parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict' } }],
      result: { mode: 'strict' }, cancellation: { parameter: 'signal' } })
    expect(descriptor?.result.mode).toBe('strict')
    if (descriptor?.result.mode !== 'strict') throw new Error('Original result codec absent')
    expect(descriptor.result.create().parse({ servers: [], limits: { maxPrivateKeyBytes: 2048,
      maxKnownHostsBytes: 1024, maxImportBytes: 4096 } }))
      .toEqual({ servers: [], limits: { maxPrivateKeyBytes: 2048, maxKnownHostsBytes: 1024, maxImportBytes: 4096 } })
    const parameter = descriptor.parameters[0]
    if (parameter?.codec.mode !== 'strict') throw new Error('Original request codec absent')
    const codec = parameter.codec
    expect(() => codec.create().parse({ action: 'execute', command: 'forged' })).toThrow()
    expect(account.barrier.snapshot().failures).toEqual([])
  } finally { await account?.close(); await root.close(); rmSync(home, { recursive: true, force: true }) }
}, 60000)
