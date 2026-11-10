import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { PROBE_SCRIPT } from '@deepseek-ai/dsh-remote-server-cloud'
import type { RemoteServer } from '@deepseek-ai/dsh-remote-server-cloud'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { guardianWorkingCopiesBudget } from '../src/agent-data/encoded-budget.ts'
import { remoteSshSpec, type RemoteSshConfig } from '../src/remote-ssh.ts'

const project = '/srv/dsh-features-281fb24f-afdd-4266-8f89-bbda8f8a6a4d/accounts/'
  + 'v1-0b3a173da0d6d761b3976f4f776e623a9054503c25df9196208ec4d3fb7f8715/projects/default-workspace'
const target = { host: '192.168.215.8', user: 'fixture', port: 2222 } as RemoteServer
const credential = { privateKey: 'fixture-private-key-only', knownHosts: 'fixture-known-host-only' }
const config: RemoteSshConfig = { pythonPath: '/usr/local/bin/python3', sshPath: '/usr/bin/ssh',
  timeoutMs: 10000, probeTimeoutMs: 10000, connectTimeoutSeconds: 3, outputMaxBytes: 4096, stopWaitMs: 2000 }
const build = (probe: boolean, value = credential) => remoteSshSpec(target, value, probe ? PROBE_SCRIPT : 'printf ordinary',
  project, new AbortController().signal, config, probe)
function payload(spec: SubprocessSpawnSpec): string {
  const stdin = spec.stdio.stdin
  if (typeof stdin !== 'object') throw new Error('Expected the original private batch input')
  return Buffer.from(stdin.data).toString()
}
const budget = (spec: SubprocessSpawnSpec) => guardianWorkingCopiesBudget(project,
  { argv: spec.argv, cwd: spec.cwd, stdin: { mode: 'batch', base64: Buffer.from(payload(spec)).toString('base64') } },
  8, { mode: 'danger-full-access' })

it('admits the fixed facts probe with the deployed long project, eight skill copies and original 4KiB guardian budget', () => {
  const spec = build(true)
  expect(budget(spec)).toBeLessThanOrEqual(4096)
  expect(spec.argv).toHaveLength(6)
  const input = JSON.parse(payload(spec)) as Record<string, unknown>
  if (typeof input.probe !== 'string') throw new Error('Expected fixed compressed probe')
  expect(inflateSync(Buffer.from(input.probe, 'base64')).toString()).toBe(PROBE_SCRIPT)
  expect(input.command).toBeUndefined()
  expect(Buffer.byteLength(payload(spec))).toBeLessThanOrEqual(4096)
})

it('keeps ordinary exec arguments and private input fields while fitting the same original guardian budget', () => {
  const spec = build(false)
  expect(spec.argv.slice(0, 4)).toEqual([config.pythonPath, '-I', '-S', '-c'])
  expect(spec.argv.slice(5)).toEqual([config.sshPath])
  expect(payload(spec)).toBe(JSON.stringify({ ...credential, host: target.host, user: target.user,
    port: target.port, command: 'printf ordinary', connect: 3 }))
  expect(budget(spec)).toBeLessThanOrEqual(4096)
  expect(spec.argv.join(' ')).not.toContain(credential.privateKey)
  expect(spec.argv.join(' ')).not.toContain(credential.knownHosts)
})

it('refuses a substituted probe before constructing private input', () => {
  expect(() => remoteSshSpec(target, credential, 'printf substituted', project,
    new AbortController().signal, config, true)).toThrow('Account SSH execution is unavailable.')
})

it.each([false, true])('retains the complete private stdin 4096-byte ceiling (probe=%s)', (probe) => {
  const padding = 4096 - Buffer.byteLength(payload(build(probe, { ...credential, privateKey: '' })))
  expect(Buffer.byteLength(payload(build(probe, { ...credential, privateKey: 'a'.repeat(padding) })))).toBe(4096)
  expect(() => build(probe, { ...credential, privateKey: 'a'.repeat(padding + 1) })).toThrow('cloud/remote-request-too-large')
})

// Only the OS private-FD and SSH launch are replaced; Python parses and consumes the original helper input.
const pythonFixture = String.raw`import os,sys,fcntl,json
import itertools
fixture_fds=itertools.count(10)
os.MFD_ALLOW_SEALING=2
os.memfd_create=lambda name,flags: next(fixture_fds)
os.fchmod=lambda *args: None
os.write=lambda fd,data: len(data)
os.lseek=lambda *args: 0
os.close=lambda *args: None
fcntl.F_ADD_SEALS=1033
fcntl.F_SEAL_WRITE=fcntl.F_SEAL_GROW=fcntl.F_SEAL_SHRINK=fcntl.F_SEAL_SEAL=1
fcntl.fcntl=lambda *args: 0
import subprocess
class Child:
 def __init__(self,argv,**kwargs): print(json.dumps(argv))
 def wait(self): return 0
subprocess.Popen=Child
sys.argv=['fixture','/usr/bin/ssh']
`
function runHelper(spec: SubprocessSpawnSpec, input = payload(spec)) {
  const helper = spec.argv[4]
  if (helper === undefined) throw new Error('Expected the original private helper')
  return spawnSync('python3', ['-I', '-S', '-c', pythonFixture + '\n' + helper],
    { input, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 })
}

it.each([false, true])('consumes the closed private input with strict host-key SSH flags and no key material in argv (probe=%s)', (probe) => {
  const result = runHelper(build(probe))
  expect(result.status, result.stderr).toBe(0)
  const argv = JSON.parse(result.stdout) as string[]
  expect(argv.at(-1)).toBe(probe ? PROBE_SCRIPT : 'printf ordinary')
  expect(argv).toContain('-oStrictHostKeyChecking=yes')
  expect(argv).toContain('-oIdentityAgent=none')
  expect(argv).toContain('-oPreferredAuthentications=publickey')
  expect(argv.some(value => value.startsWith('-oUserKnownHostsFile=/proc/'))).toBe(true)
  expect(result.stdout).not.toContain(credential.privateKey)
  expect(result.stdout).not.toContain(credential.knownHosts)
})

it.each(['oversized', 'truncated', 'unknown', 'both', 'bad-probe', 'bad-key', 'boolean-port', 'zero-connect'] as const)(
  'rejects %s private input before any SSH launch', (kind) => {
    const spec = build(true), input = JSON.parse(payload(spec)) as Record<string, unknown>
    const raw = kind === 'oversized' ? ' '.repeat(4097) : kind === 'truncated' ? payload(spec).slice(0, -1)
      : JSON.stringify(kind === 'unknown' ? { ...input, extra: 'no' } : kind === 'both' ? { ...input, command: 'no' }
        : kind === 'bad-probe' ? { ...input, probe: 'not-valid-base64!' } : kind === 'bad-key' ? { ...input, privateKey: [] }
          : kind === 'boolean-port' ? { ...input, port: true } : { ...input, connect: 0 })
    const result = runHelper(spec, raw)
    expect(result.status).toBe(255)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^SSH private execution setup failed at 1 \(/)
    expect(result.stderr).not.toContain(credential.privateKey)
    expect(result.stderr).not.toContain(credential.knownHosts)
  })
