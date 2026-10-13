/** Actual PG and local SDK Runner stops; the controlled Kubernetes facade provides no remote isolation evidence. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { EgressGate } from '../../connector-runner/src/egress.ts'
import { createConnectorRunner } from '../../connector-runner/src/server.ts'
import { StdioMcpTransport } from '../../connector-runner/src/stdio.ts'
import { requestId } from '../src/contracts.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { KubernetesError, type KubernetesClient } from '../src/platform/kubernetes.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { StdioMcpService } from '../src/platform/stdio-mcp.ts'
import { StdioRunnerOrchestrator } from '../src/platform/stdio-runner.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const resource = z.object({ metadata: z.object({ name: z.string() }).loose() }).loose()
const nodeRequire = createRequire(new URL('../../connector-runner/package.json', import.meta.url))
const deferred = () => {
  let resolve = (): void => { throw new Error('Gate not initialized') }
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('STDIO fixture has no persisted row')
  return row
}

async function controlledRunner(f: Fixture) {
  const trace = join(f.root, 'peer-trace.jsonl'), release = join(f.root, 'release-peer'), script = join(f.root, 'peer.mjs')
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(nodeRequire.resolve(name)).href)
  await writeFile(script, `import { appendFileSync, existsSync } from 'node:fs';
    import { McpServer } from ${moduleUrl('@modelcontextprotocol/server')};
    import { serveStdio } from ${moduleUrl('@modelcontextprotocol/server/stdio')};
    import { z } from ${moduleUrl('zod')};
    const trace = ${JSON.stringify(trace)};
    appendFileSync(trace, JSON.stringify({event:'spawn',pid:process.pid})+'\\n',{mode:0o600});
    serveStdio(() => {
      const server = new McpServer({name:'controlled-whoami',version:'1.0.0'},{capabilities:{tools:{}}});
      server.registerTool('whoami',{inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>{
        appendFileSync(trace,JSON.stringify({event:'call',pid:process.pid})+'\\n',{mode:0o600});
        while(!existsSync(${JSON.stringify(release)})) await new Promise(done=>setTimeout(done,10));
        return {content:[{type:'text',text:'user:'+process.env.PE_MCP_ACCOUNT_ID}]};
      });
      return server;
    });`, { mode: 0o600 })
  const resources = new Map<string, z.infer<typeof resource>>()
  let runner: ReturnType<typeof createConnectorRunner> | undefined
  let origin = '', podUid = '', posts = 0, lookups = 0, deletes = 0
  let probeGate: ReturnType<typeof deferred> | undefined, replyGate: ReturnType<typeof deferred> | undefined
  const probeEntered = deferred(), postEntered = deferred()
  const kube: Pick<KubernetesClient, 'call' | 'resourcePath' | 'proxyPath'> = {
    resourcePath: (namespace, kind) => `/api/v1/namespaces/${namespace}/${kind}`,
    proxyPath: (_namespace, name, path) => `/controlled-proxy/${name}${path}`,
    async call<T>(method: string, path: string, body?: unknown, _timeout?: number, token?: string): Promise<T> {
      const proxy = /^\/controlled-proxy\/[^/]+(\/.*)$/u.exec(path)
      if (proxy) {
        const endpoint = first(proxy.slice(1))
        if (method === 'POST') posts++
        if (method === 'GET' && endpoint.startsWith('/calls/')) lookups++
        const response = await fetch(`${origin}${endpoint}`, { method,
          headers: { 'content-type': 'application/json', 'x-power-evolve-runner-token': token ?? '' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const value: unknown = await response.json()
        if (!response.ok) throw new KubernetesError(response.status, 'Controlled Runner response')
        if (method === 'POST' && replyGate) {
          postEntered.resolve(); await replyGate.promise
          throw new KubernetesError(503, 'Actual first POST reply was lost')
        }
        return value as T // Generic Kubernetes JSON response is validated by the actual orchestrator.
      }
      if (method === 'POST') {
        const value = resource.parse(body), target = `${path}/${value.metadata.name}`
        if (resources.has(target)) throw new KubernetesError(409, 'Resource already exists')
        if (path.endsWith('/secrets')) {
          const input = z.object({ stringData: z.object({ token: z.string() }) }).parse(value)
          value.data = { token: Buffer.from(input.stringData.token).toString('base64') }
        }
        if (path.endsWith('/pods')) {
          podUid = randomUUID(); value.metadata.uid = podUid
          value.status = { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] }
          const secret = resources.get(kube.resourcePath('owned-stdio', 'secrets') + `/${value.metadata.name}`)
          const token = z.object({ stringData: z.object({ token: z.string() }) }).parse(secret).stringData.token
          const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => 'denied', false, 60_000)
          await gate.check(); await gate.check(); await gate.check()
          runner = createConnectorRunner({ token, allowlist: new Set(), egress: gate, instanceId: randomUUID(),
            transport: { async call() { throw new Error('STDIO fixture does not authorize SSH') } },
            stdioTransport: new StdioMcpTransport(script) })
          const current = runner
          await new Promise<void>(done => current.server.listen(0, '127.0.0.1', done))
          const address = current.server.address()
          if (!address || typeof address === 'string') throw new Error('Runner did not acquire its owned port')
          origin = `http://127.0.0.1:${address.port}`
        }
        resources.set(target, value)
        return structuredClone(value) as T
      }
      const value = resources.get(path)
      if (!value) throw new KubernetesError(404, 'Owned resource not found')
      if (method === 'DELETE') {
        if (path.includes('/pods/')) { deletes++; await runner?.close() }
        resources.delete(path)
        return {} as T
      }
      if (method !== 'GET') throw new Error('Unexpected controlled Kubernetes mutation')
      return structuredClone(value) as T
    },
  }
  const orchestrator = new StdioRunnerOrchestrator(kube, {
    namespace: 'owned-stdio', image: 'fixture.invalid/controlled', runtimeClassName: 'controlled',
    controlKey: 'c'.repeat(48), readyTimeoutMs: 1000, platformIngressCidrs: ['127.0.0.1/32'],
    forbiddenProbe: { ip: '192.0.2.3', port: 2999 },
    async proveForbiddenListener() {
      if (probeGate) { probeEntered.resolve(); await probeGate.promise }
      return true // Controlled readiness only; no claim of physical Pod egress denial.
    },
  })
  const peerPid = async () => {
    const rows = (await readFile(trace, 'utf8')).trim().split('\n').map(line => z.object({ pid: z.number().int(), event: z.string() }).parse(JSON.parse(line)))
    return first(rows.filter(row => row.event === 'call')).pid
  }
  return { orchestrator, metrics: () => ({ podUid, posts, lookups, deletes }), resources,
    pausePrepare() { probeGate = deferred(); return { entered: probeEntered.promise, release: probeGate.resolve } },
    losePostReply() { replyGate = deferred(); return { entered: postEntered.promise, release: replyGate.resolve } },
    releasePeer: () => writeFile(release, '', { mode: 0o600 }), peerPid,
    async called() { return (await readFile(trace, 'utf8')).includes('"event":"call"') },
    async observe(id: string) {
      const response = await fetch(`${origin}/calls/${id}`, {
        headers: { 'x-power-evolve-runner-token': z.object({ stringData: z.object({ token: z.string() }) })
          .parse([...resources.values()].find(value => value.stringData !== undefined)).stringData.token },
      })
      return z.object({ state: z.string() }).loose().parse(await response.json())
    },
    async close() { probeGate?.resolve(); replyGate?.resolve(); await runner?.close() },
  }
}

async function setup(f: Fixture, runner: Awaited<ReturnType<typeof controlledRunner>>) {
  expect(first((await f.pool.query<{ version: number }>('SELECT version FROM pe_schema')).rows).version).toBe(CURRENT_SCHEMA_VERSION)
  const tasks = new TaskStore(f.pool, { maxEventBytes: 524_288, leaseMs: 60_000,
    maxPendingPerUser: 8, maxActivePerUser: 2, stdioMcpEnabled: true })
  const service = new StdioMcpService(tasks, runner.orchestrator, randomUUID(), 30_000, 100)
  const connection = await service.install(f.alice.user, randomUUID(), 'Original whoami')
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Original STDIO operation', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('STDIO fixture did not actually claim its original operation')
  const key = randomUUID(), call = await service.call(grant.token, connection.connectionId, connection.revision, key)
  const row = async () => first((await f.pool.query<{ state: string
    cleanup_complete: boolean
    error_code: string | null
    pod_uid: string | null
    runner_instance_id: string | null
    dispatch_digest: string | null
    continuation_request_id: string }>(
    `SELECT state,cleanup_complete,error_code,pod_uid,runner_instance_id,dispatch_digest,continuation_request_id
     FROM pe_stdio_mcp_calls WHERE id=$1`, [call.callId])).rows)
  const archive = () => transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
    await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [session.sessionId, f.alice.user.userId])
    const workspaces = (await client.query<LayoutWorkspace>(
      'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.alice.user.userId])).rows
    const layout = await readWorkspaceLayout(client, f.alice.user.userId, workspaces)
    layout.archivedSessionIds = [session.sessionId]
    await writeWorkspaceLayout(client, f.alice.user.userId, layout)
    await tasks.requestArchiveStopInTransaction(client, f.alice.user, session.sessionId)
  })
  return { tasks, service, connection, session, grant, key, call, row, archive,
    async followups() { return first((await f.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pe_operations WHERE source_stdio_mcp_call_id=$1', [call.callId])).rows).n },
  }
}

test('legacy whoami refuses fresh calls after archive and stops a preparing call before its sole first POST', () => cloudFixture(async (f) => {
  const runner = await controlledRunner(f), n = await setup(f, runner), gate = runner.pausePrepare()
  try {
    n.service.start(); await gate.entered
    await n.archive()
    await expect(n.service.call(n.grant.token, n.connection.connectionId, n.connection.revision, randomUUID()))
      .rejects.toMatchObject({ code: 'native_session_stopped' })
    expect(await n.service.call(n.grant.token, n.connection.connectionId, n.connection.revision, n.key))
      .toMatchObject({ callId: n.call.callId })
    gate.release()
    await expect.poll(n.row).toMatchObject({ state: 'failed', error_code: 'native_session_stopped', cleanup_complete: true })
    expect(runner.metrics()).toMatchObject({ posts: 0, deletes: 1 })
    expect(runner.resources.size).toBe(0)
    expect(await n.followups()).toBe(0)
  } finally { gate.release(); await n.service.close(); await runner.close() }
}))

test('a cold stopped root preserves the actual completed whoami result after first reply loss and native-purpose completion', () => cloudFixture(async (f) => {
  const runner = await controlledRunner(f), n = await setup(f, runner), gate = runner.losePostReply()
  let resumed: StdioMcpService | undefined
  try {
    n.service.start(); await gate.entered
    await runner.releasePeer()
    await expect.poll(() => runner.observe(n.call.callId)).toMatchObject({ state: 'succeeded' })
    const archiving = n.archive()
    await expect.poll(async () => first((await f.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
       AND cardinality(pg_blocking_pids(pid))>0) AS waiting`)).rows).waiting).toBe(true)
    const closing = n.service.close(); gate.release(); await closing; await archiving
    expect(await n.row()).toMatchObject({ state: 'uncertain', cleanup_complete: false })
    const original = await n.row()
    // Persisted purpose completion is only gate input; it supplies no provider-stop evidence.
    await transaction(f.pool, async (client) => {
      await requireBrowserAccount(client, f.alice.token, { lock: 'update' })
      await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [n.session.sessionId, f.alice.user.userId])
      const workspaces = (await client.query<LayoutWorkspace>(
        'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.alice.user.userId])).rows
      const layout = await readWorkspaceLayout(client, f.alice.user.userId, workspaces)
      layout.archivedSessionIds = []
      await writeWorkspaceLayout(client, f.alice.user.userId, layout)
      await client.query(`UPDATE pe_native_preferences SET value=jsonb_set(value,'{status}','"complete"'::jsonb)
        WHERE user_id=$1 AND namespace=$2`, [f.alice.user.userId, `session-archive-stop:${n.session.sessionId}`])
    })
    resumed = new StdioMcpService(n.tasks, runner.orchestrator, randomUUID(), 30_000, 100); resumed.start()
    await expect.poll(n.row).toMatchObject({ state: 'succeeded', cleanup_complete: true })
    expect(await resumed.status(f.alice.user, n.call.callId)).toEqual({ callId: n.call.callId,
      state: 'succeeded', result: `user:${f.alice.user.userId}` })
    expect(await n.row()).toMatchObject({ pod_uid: original.pod_uid, runner_instance_id: original.runner_instance_id,
      dispatch_digest: original.dispatch_digest, continuation_request_id: original.continuation_request_id })
    expect(runner.metrics()).toMatchObject({ posts: 1, deletes: 1 })
    expect(await n.followups()).toBe(0)
  } finally { gate.release(); await resumed?.close(); await n.service.close(); await runner.close() }
}))

test('a dispatched running whoami stops its actual SDK child and retains uncertain original identity without replay', () => cloudFixture(async (f) => {
  const runner = await controlledRunner(f), n = await setup(f, runner)
  let resumed: StdioMcpService | undefined
  try {
    n.service.start()
    await expect.poll(n.row).toMatchObject({ state: 'running' })
    await expect.poll(() => runner.called()).toBe(true)
    await n.service.close()
    const original = await n.row(), pid = await runner.peerPid()
    expect(() => process.kill(pid, 0)).not.toThrow()
    await n.archive()
    resumed = new StdioMcpService(n.tasks, runner.orchestrator, randomUUID(), 30_000, 100); resumed.start()
    await expect.poll(n.row, { timeout: 8000 })
      .toMatchObject({ state: 'uncertain', error_code: 'native_session_stopped', cleanup_complete: true })
    await expect.poll(() => {
      try { process.kill(pid, 0); return false }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error }
    }).toBe(true)
    expect(await n.row()).toMatchObject({ pod_uid: original.pod_uid, runner_instance_id: original.runner_instance_id,
      dispatch_digest: original.dispatch_digest, continuation_request_id: original.continuation_request_id })
    expect(runner.metrics()).toMatchObject({ posts: 1, deletes: 1 })
    expect(runner.metrics().lookups).toBeGreaterThan(1)
    expect(runner.resources.size).toBe(0)
    expect(await n.followups()).toBe(0)
  } finally { await resumed?.close(); await n.service.close(); await runner.close() }
}))
