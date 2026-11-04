/** Loopback real authentication, native Peer/Gateway and private persistence; does not certify production Root readiness. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import pg from 'pg'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ModelKeyPeerConsumer } from '@deepseek-ai/dsh-pe-cloud-api'
import { BetterAuthAccess } from '../../../src/auth.ts'
import { LoginPeerRegistry } from '../../../src/peers.ts'
import { accessConfig } from '../../ingress-fixture.ts'
import { managementAccount, descriptors } from './account.ts'
import { remoteManagedFixture } from '../../../../pe-opensandbox/tests/remote-managed-fixture.ts'

/** Start an isolated acceptance graph against a caller-owned fresh PostgreSQL database.
 * @param database Test-only database allocation. @param assets Optional owned browser files, served without account data.
 * @returns Loopback address, original owners and joined cleanup. No existing service/config is read.
 */
export async function remoteAcceptanceServer(database: pg.PoolConfig,
  assets?: (path: string) => { type: string; body: string | Buffer } | undefined) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'remote-auth-acceptance-'))), root = await remoteManagedFixture()
  const pool = new pg.Pool({ ...database, max: 4, connectionTimeoutMillis: 2000, query_timeout: 5000 })
  const accounts = new Map<string,
    { binding: AccountBinding; lifetime: AbortController; account: Awaited<ReturnType<typeof managementAccount>> }>()
  const building = new Map<string, Promise<void>>(), sockets = new Set<Socket>(), requests = new Set<Promise<void>>()
  const cleanups: unknown[] = [], failures: unknown[] = []
  const lifecycle: { auth?: BetterAuthAccess; registry?: LoginPeerRegistry } = {}
  let count = 0
  const requestId = () => brandString<Branded<'pe-request-id'>>(randomUUID())
  const server = createServer((request, response) => {
    const task = (async () => {
      if (++count > 512 || lifecycle.auth === undefined || lifecycle.registry === undefined) throw new Error('Fixture admission closed')
      if (request.url?.startsWith('/cloud/auth/')) { await lifecycle.auth.handleNodeRequest(request, response, requestId(),
        { maxBodyBytes: 16384, signal: AbortSignal.timeout(10000) }); return }
      if (request.url === '/api/cloudRemoteServers/action') {
        const principal = await lifecycle.auth.authenticate(request, requestId())
        if (!accounts.has(principal.accountId)) {
          let starting = building.get(principal.accountId)
          if (starting === undefined) {
            starting = (async () => {
              const lifetime = new AbortController(), binding: AccountBinding = Object.freeze({ accountId: principal.accountId,
                epoch: brandString<AccountBinding['epoch']>(randomUUID()), recipeVersion: 'remote-auth-acceptance',
                lifetime: lifetime.signal })
              const directory = join(home, principal.accountId); mkdirSync(directory)
              const peers: ModelKeyPeerConsumer = { withModelKeyPeerUse(peer, consume) {
                if (lifecycle.registry === undefined) throw new Error('Registry closed')
                return lifecycle.registry.withOriginalUse(peer, (handle) => {
                  lifecycle.auth!.assertLoginCurrent(handle.principal, requestId())
                }, consume)
              } }
              const account = await managementAccount(directory, binding, root, peers)
              accounts.set(principal.accountId, { binding, lifetime, account })
            })()
            building.set(principal.accountId, starting)
          }
          await starting
        }
        const installed = accounts.get(principal.accountId)
        if (installed === undefined) throw new Error('No installed account')
        const peer = await lifecycle.registry.acquire(principal, installed.binding, Date.now() + 5000, undefined, requestId())
        await lifecycle.registry.handleNodeRequest(peer, request, response, 32768, requestId()); return
      }
      const asset = assets?.(request.url ?? '/')
      if (asset !== undefined) { response.writeHead(200, { 'content-type': asset.type,
        'cache-control': 'no-store' }); response.end(asset.body); return }
      response.writeHead(404); response.end()
    })().catch((error: unknown) => {
      failures.push(error)
      if (response.destroyed || response.writableEnded) return
      const code: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
      response.writeHead(code === 'cloud/unauthenticated' ? 401 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ code: typeof code === 'string' ? code : 'fixture/unavailable' }))
    })
    requests.add(task); void task.finally(() => { requests.delete(task) })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback listener absent')
  const url = `http://127.0.0.1:${address.port}`
  const settings = { ...accessConfig(), publicOrigin: url, sessionRecheckMs: 60000, authCheckTimeoutMs: 5000,
    maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerCarriers: 8, maxPeerCarriersPerAccount: 4, peerCloseTimeoutMs: 2000 }
  lifecycle.auth = await BetterAuthAccess.create(settings, pool, randomUUID() + randomUUID(),
    async (id) => { await lifecycle.registry?.invalidateLogin(id) })
  await (await lifecycle.auth.planMigrations(requestId())).runMigrations(); descriptors(home)
  const actualAuth = lifecycle.auth
  lifecycle.registry = new LoginPeerRegistry({ ...settings, sessionRecheckLeadMs: 0 }, actualAuth, {
    // The native login registry owns this test Use until its actual tasks finish. Production uses AccountFactory.borrow.
    async borrow(binding): Promise<AccountUse> {
      const installed = accounts.get(binding.accountId)
      if (installed?.binding !== binding) throw new Error('Foreign account generation')
      let released = false
      return { binding, context: installed.account.ctx,
        assertCurrent() { if (released || binding.lifetime.aborted) throw new Error('Fixture Use ended'); installed.account.api.assertInstalled() },
        release() { released = true } }
    },
    beforeHttp(request, peer) {
      if (request.url !== '/api/cloudRemoteServers/action') throw new Error('Unreviewed endpoint')
      accounts.get(peer.binding.accountId)!.account.api.requireRpc('cloudRemoteServers/action')
    }, beforeStream() { throw new Error('Management has no streams') }, cleanupFailed(error) { cleanups.push(error) },
  })
  const retainedRegistry = lifecycle.registry
  return { url, home, auth: actualAuth, registry: retainedRegistry, pool, accounts, cleanups, failures,
    async close() {
      await retainedRegistry.close(Date.now() + 5000)
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections() })
      for (const socket of sockets) socket.destroy()
      await Promise.all(requests); await actualAuth.close()
      for (const installed of accounts.values()) await installed.account.close()
      await root.close(); await pool.end(); rmSync(home, { recursive: true, force: true })
    },
  }
}
