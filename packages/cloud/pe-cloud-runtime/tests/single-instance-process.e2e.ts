/** Actual dsh profile, native WebServer and isolated database prove failure exits and port withdrawal. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, connect, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Client } from 'pg'
import { expect, it } from 'vitest'
import { rootConfig } from './root-control-fixture.ts'
import { instanceTestConnection } from './instance-test-connection.ts'

const privateConfig = process.env.DSH_RUNTIME_ROOT_PG_PRIVATE_CONFIG
const root = fileURLToPath(new URL('../../../..', import.meta.url))
const lock = "hashtextextended('pe-cloud/single-instance', 0)"

it.skipIf(privateConfig === undefined).each(['competition', 'exhausted', 'second-instance', 'invalid-config'] as const)('settles actual dsh process and port after %s', async (scenario) => {
  if (privateConfig === undefined) throw new Error('Isolated database configuration required')
  const directory = await mkdtemp(join(tmpdir(), 'pe-lock-process-'))
  const database = new Client(await instanceTestConnection(privateConfig))
  await database.connect()
  let stopChild = async (): Promise<void> => {}
  let stopProxy = async (): Promise<void> => {}
  try {
    const profile = join(directory, 'profiles', 'lifecycle')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'lifecycle-profile', private: true,
      dependencies: {}, dsh: { profile: { bundles: [] } } }))
    const config = { ...rootConfig(directory), singleInstance: true, heartbeatIntervalMs: 60_000, recipeVersion: 'process-' + randomUUID() }
    const original = await instanceTestConnection(privateConfig)
    let connection = { ...original }
    let severConnections = (): void => {}
    if (scenario === 'exhausted') {
      const sockets = new Set<Socket>()
      let offline = false
      const proxy = createServer((socket) => {
        if (offline) { socket.destroy(); return }
        const upstream = connect(original.port, original.host)
        sockets.add(socket); sockets.add(upstream)
        for (const owned of [socket, upstream]) {
          owned.on('error', () => { socket.destroy(); upstream.destroy() })
          owned.once('close', () => { sockets.delete(owned) })
        }
        socket.pipe(upstream).pipe(socket)
      })
      stopProxy = async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
      }
      await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
      const address = proxy.address()
      if (address === null || typeof address === 'string') throw new Error('Proxy did not bind')
      connection = { ...original, host: '127.0.0.1', port: address.port }
      config.pg = { ...config.pg, connectionTimeoutMs: 100 }
      severConnections = () => { offline = true; for (const socket of sockets) socket.destroy() }
    }
    if (scenario === 'second-instance') await database.query(`SELECT pg_advisory_lock(${lock})`)
    const input = scenario === 'invalid-config' ? { ...config, singleInstnace: true } : config
    config.database = { ...config.database, host: connection.host, port: connection.port,
      user: connection.user, database: connection.database }
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'credentials', name: join(root, 'packages/cloud/pe-cloud-runtime/tests/fixtures/lifecycle/credentials.mjs') },
      { id: 'runtime', name: join(root, 'packages/cloud/pe-cloud-runtime/lib/root.js'), config: { ...input, database: config.database } },
      { id: 'webserver', name: join(root, 'packages/host/webserver/lib/index.js'), config: { host: '127.0.0.1', port: 0 } },
      { id: 'observe', name: join(root, 'packages/cloud/pe-cloud-runtime/tests/fixtures/lifecycle/observe.mjs') },
    ] }]))
    const child = execa(process.execPath, [join(root, 'apps/cli/lib/bin.js'), '--profile', 'lifecycle', '--shutdown-timeout-ms', '10000'], {
      cwd: root, env: { DSH_HOME: directory }, reject: false, timeout: 30_000,
    })
    stopChild = async () => { child.kill('SIGTERM'); await child }
    const running = child
    if (scenario === 'second-instance' || scenario === 'invalid-config') {
      const result = await running
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('LIFECYCLE_READY=')
      expect(result.stderr).toContain(scenario === 'invalid-config' ? '$.singleInstnace: unknown' : 'Another process holds the single-instance lock')
      return
    }
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''
      running.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = /LIFECYCLE_READY=(\d+)/.exec(output)
        if (match !== null) resolve(Number(match[1]))
      })
      void running.then((result) => { reject(new Error(`Child exited before readiness: ${result.stderr}`)) })
    })
    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200)
    if (scenario === 'exhausted') {
      severConnections()
    } else {
      const pid = await database.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND granted`)
      expect(pid.rows).toHaveLength(1)
      // Queue the competing lock first so reacquisition cannot win by scheduler timing.
      const winner = database.query(`SELECT pg_advisory_lock(${lock})`)
      const terminator = new Client(original)
      await terminator.connect()
      try { await terminator.query('SELECT pg_terminate_backend($1)', [pid.rows[0]!.pid]) }
      finally { await terminator.end() }
      await winner
    }
    const result = await running
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('LIFECYCLE_DISPOSED')
    expect(result.stderr).toContain('stopping the application with failure status')
    if (scenario === 'exhausted') {
      expect(result.stderr.match(/single-instance-lock-reconnect-failed/g)).toHaveLength(5)
      expect(result.stderr).toContain('shutdown is unconfirmed')
    }
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow()
    const instances = await database.query('SELECT phase FROM pe_instances WHERE recipe_version = $1', [config.recipeVersion])
    expect(instances.rows.some(row => row.phase === 'registered')).toBe(scenario === 'exhausted')
  } finally {
    await stopChild()
    await stopProxy()
    await database.query('SELECT pg_advisory_unlock_all()')
    await database.end()
    await rm(directory, { recursive: true, force: true })
  }
})
