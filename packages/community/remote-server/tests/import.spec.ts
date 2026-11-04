import { expect, it } from 'vitest'
import { uploadedSshConfig } from '../src/import.ts'

it('imports uploaded literal hosts and discards local identity paths without reading them', () => {
  expect(uploadedSshConfig('Host web\nHostName 192.0.2.1\nUser fixture\nPort 2222\nIdentityFile ~/.ssh/private', 4096))
    .toEqual([{ alias: 'web', host: '192.0.2.1', user: 'fixture', port: 2222, requiresAccountKey: true }])
})
it('refuses directives requiring local files, shell commands, wildcard or conditional execution', () => {
  for (const directive of ['Include /etc/passwd', 'ProxyCommand cat ~/.ssh/key', 'ProxyJump other', 'Match exec "true"', 'ForwardAgent yes']) {
    expect(() => uploadedSshConfig('Host a\n' + directive, 4096)).toThrow('unsupported-ssh-config')
  }
  expect(() => uploadedSshConfig('Host é', 6)).toThrow('invalid-ssh-config')
})
