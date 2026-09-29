/** SSH protocol transport; no database, filesystem mount, or shell entry point. */
import { createHash, timingSafeEqual } from 'node:crypto'
import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2'
import type { CallResult, SshCallInput } from './protocol.ts'

export class SshFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

export interface SshTransport {
  /** Execute one already-authorized SSH request. */
  call(input: SshCallInput, signal: AbortSignal): Promise<CallResult>
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

function sameFingerprint(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function classified(error: unknown, mismatch: boolean, timedOut: boolean, aborted: boolean): SshFailure {
  if (mismatch) return new SshFailure('ssh_host_key_mismatch')
  if (timedOut) return new SshFailure('ssh_timeout')
  if (aborted) return new SshFailure('ssh_cancelled')
  if (error instanceof SshFailure) return error
  const value = error as { code?: unknown; level?: unknown }
  if (value.level === 'client-authentication') return new SshFailure('ssh_authentication_failed')
  if (value.code === 'ECONNREFUSED') return new SshFailure('ssh_connection_refused')
  if (value.code === 'ETIMEDOUT' || value.level === 'client-timeout') return new SshFailure('ssh_timeout')
  return new SshFailure('ssh_network_error')
}

/** ssh2 with credential-free discovery and pinned-key authentication. */
export class Ssh2Transport implements SshTransport {
  async call(input: SshCallInput, signal: AbortSignal): Promise<CallResult> {
    if (signal.aborted) throw new SshFailure('ssh_cancelled')
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client()
      let settled = false
      let mismatch = false
      let timedOut = false
      let banner: string | null = null
      const finish = (error?: unknown, result?: CallResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        client.destroy()
        if (error !== undefined) reject(classified(error, mismatch, timedOut, signal.aborted))
        else if (result !== undefined) resolve(result)
        else reject(new SshFailure('ssh_network_error'))
      }
      const abort = (): void => finish(new Error('cancelled'))
      const timer = setTimeout(() => { timedOut = true; finish(new Error('timeout')) }, input.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      client.on('banner', value => {
        if (Buffer.byteLength(value, 'utf8') <= 512 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) banner = value
      })
      client.on('error', error => finish(error))
      client.on('close', () => { if (!settled) finish(new Error('closed')) })
      const config: ConnectConfig = {
        host: input.destination.host.replace(/^\[([^\]]+)\]$/u, '$1'), port: input.destination.port,
        username: input.destination.username, readyTimeout: input.timeoutMs,
        tryKeyboard: false,
        hostVerifier(key: Buffer) {
          const actual = fingerprint(key)
          if (input.kind === 'ssh.inspect') {
            queueMicrotask(() => finish(undefined, {
              kind: 'ssh.inspect', hostKeySha256: actual, serverBanner: banner,
            }))
            return true
          }
          const accepted = sameFingerprint(actual, input.destination.hostKeySha256 ?? '')
          mismatch = !accepted
          return accepted
        },
        ...(input.kind === 'ssh.inspect' ? { authHandler: [] as const }
          : input.credential.kind === 'password'
            ? { password: input.credential.password, authHandler: ['password'] as const }
            : { privateKey: input.credential.privateKey,
              ...(input.credential.passphrase === undefined ? {} : { passphrase: input.credential.passphrase }),
              authHandler: ['publickey'] as const }),
      }
      client.once('ready', () => {
        if (settled) return
        if (input.kind === 'ssh.authenticate') {
          finish(undefined, { kind: 'ssh.authenticate', serverBanner: banner })
          return
        }
        if (input.kind === 'ssh.execute') {
          execute(client, input.command, input.maxOutputBytes, finish)
        }
      })
      try { client.connect(config) } catch (error) { finish(error) }
    })
  }
}

function execute(client: ssh2.Client, command: string, maximum: number,
  finish: (error?: unknown, result?: CallResult) => void): void {
  client.exec(command, (error, channel: ClientChannel) => {
    if (error) { finish(error); return }
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0, exitCode: number | null = null, exitSignal: string | null = null
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.length
      if (bytes > maximum) {
        channel.close()
        finish(new SshFailure('ssh_output_limit'))
        return
      }
      target.push(data)
    }
    channel.on('data', (chunk: Buffer | string) => collect(stdout, chunk))
    channel.stderr.on('data', (chunk: Buffer | string) => collect(stderr, chunk))
    channel.once('error', (remoteError: Error) => finish(remoteError))
    channel.on('exit', (code: number | null, remoteSignal?: string) => {
      exitCode = code
      exitSignal = remoteSignal ?? null
    })
    channel.once('close', () => finish(undefined, { kind: 'ssh.execute', exitCode, signal: exitSignal,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
}
