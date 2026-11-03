/** Real OpenSSH transport qualification only; this does not mount the cloud execution recipe. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it } from 'vitest'
import { sshArgv } from '../src/transport.ts'
import { PROBE_SCRIPT, parseProbe } from '../src/probe.ts'
import type { RemoteServer, ServerId } from '../src/account.ts'

it('authenticates with a temporary key, reads real facts, rejects a changed host key and bad identity, and joins cancelled SSH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-'))
  const name = 'remote-fixture-' + directory.split('/').at(-1)!.toLowerCase()
  const ctx = new Context()
  let started = false
  const command = (file: string, args: string[]): string => execFileSync(file, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    const server = join(directory, 'server'); await mkdir(server)
    const identity = join(directory, 'client_key'), hostKey = join(server, 'host_key'), wrongKey = join(directory, 'wrong_key')
    for (const key of [identity, hostKey, wrongKey]) command('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    await writeFile(join(server, 'authorized_keys'), await readFile(identity + '.pub'), { mode: 0o644 })
    command('docker', ['run', '--rm', '-d', '--name', name, '--cpus=.5', '--memory=64m', '--pids-limit=32',
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '-p', '127.0.0.1::2222',
      '--mount', `type=bind,src=${server},dst=/fixture,readonly`, 'dsh-remote-fixture:20261103'])
    started = true
    const address = command('docker', ['port', name, '2222/tcp']), port = Number(address.split(':').at(-1))
    const knownHosts = join(directory, 'known_hosts')
    const publicKey = (await readFile(hostKey + '.pub', 'utf8')).split(' ').slice(0, 2).join(' ')
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${publicKey}\n`, { mode: 0o600 })
    const target: RemoteServer = { id: brandString<ServerId>('fixture'), alias: 'fixture', host: '127.0.0.1', user: 'fixture', port,
      description: '', tags: [], alwaysAsk: true }
    await ctx.plugin(SubprocessLocal)
    const run = async (remote: string, key = identity, known = knownHosts, signal = new AbortController().signal) => {
      const handle = ctx.subprocess.spawn({ argv: sshArgv(target, remote, { identityPath: key, knownHostsPath: known }, 3),
        cwd: directory, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } }, graceMs: 100, signal })
      const outcome = await handle.done
      expect(await handle.waitForExit(AbortSignal.timeout(3000))).toBe(true)
      return { ...outcome, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
    }
    // Inspect the isolated service's own startup without trusting a TCP socket as authentication success.
    command('docker', ['exec', name, '/usr/sbin/sshd', '-t'])
    const completed = await run('printf remote-fixture-ok')
    expect(completed.exitCode).toBe(0); expect(completed.stdout).toBe('remote-fixture-ok')
    const probe = await run(PROBE_SCRIPT)
    expect(probe.exitCode).toBe(0)
    const facts = parseProbe(probe.stdout, new Date().toISOString())
    expect(facts.hostname).toBeTruthy(); expect(facts.kernel).toBeTruthy()
    const invalidIdentity = await run('echo must-not-run', wrongKey)
    expect(invalidIdentity.exitCode).toBe(255); expect(invalidIdentity.stdout).toBe('')
    const wrongKnown = join(directory, 'wrong_known_hosts')
    const wrongPublicKey = (await readFile(wrongKey + '.pub', 'utf8')).split(' ').slice(0, 2).join(' ')
    await writeFile(wrongKnown, `[127.0.0.1]:${port} ${wrongPublicKey}\n`)
    const mismatch = await run('echo must-not-run', identity, wrongKnown)
    expect(mismatch.exitCode).toBe(255); expect(mismatch.stdout).toBe('')
    expect(mismatch.stderr).toMatch(/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/)
    const timeout = AbortSignal.timeout(200)
    const timedOut = await run('sleep 30', identity, knownHosts, timeout)
    expect(timeout.aborted).toBe(true); expect(timedOut.exitCode).not.toBe(0)
    const cancellation = new AbortController(), timer = setTimeout(() => { cancellation.abort() }, 200)
    let cancelled
    try { cancelled = await run('sleep 30', identity, knownHosts, cancellation.signal) }
    finally { clearTimeout(timer) }
    expect(cancellation.signal.aborted).toBe(true); expect(cancelled.exitCode).not.toBe(0)
    console.info(JSON.stringify({ evidence: 'isolated-openssh-transport',
      command: completed.stdout, exitCode: completed.exitCode,
      facts, invalidIdentityExit: invalidIdentity.exitCode, hostKeyMismatchExit: mismatch.exitCode,
      timedOut: { requested: timeout.aborted, exitCode: timedOut.exitCode },
      cancelled: { requested: cancellation.signal.aborted, exitCode: cancelled.exitCode, signal: cancelled.signal },
      localRangesJoined: true, cloudRecipeQualified: false }))
    // The native provider joined its local SSH range. Remote-process termination is not inferred from that fact.
  } finally {
    await ctx.fiber.dispose()
    if (started) command('docker', ['stop', '-t', '1', name])
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
