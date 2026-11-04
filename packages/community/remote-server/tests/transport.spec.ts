import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { sshArgv } from '../src/transport.ts'
import type { ServerId } from '../src/account.ts'

it('removes ambient config, agents, passwords, host-key acceptance and multiplexing from the SSH request', () => {
  const argv = sshArgv({ id: brandString<ServerId>('fixture'), alias: 'fixture', host: '127.0.0.1', user: 'fixture',
    port: 22, description: '', tags: [], alwaysAsk: true }, 'hostname', { identityPath: '/private/key', knownHostsPath: '/private/known_hosts' }, 3)
  expect(argv).toContain('-F/dev/null')
  expect(argv).toContain('-oStrictHostKeyChecking=yes')
  expect(argv).toContain('-oIdentityAgent=none')
  expect(argv).toHaveLength(16)
  expect(argv).toContain('-oPreferredAuthentications=publickey')
  expect(argv).toContain('-oControlPath=none')
  expect(argv.slice(-3)).toEqual(['--', 'fixture@127.0.0.1', 'hostname'])
})
