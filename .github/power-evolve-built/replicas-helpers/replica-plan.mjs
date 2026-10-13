/** Pure preparation of four isolated named Profile configurations; no filesystem writes or launches. */
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'

/** Prepare explicit file references and local destinations for two Hosts and two Platforms.
 * @param input Owned absolute home, two actual worker UUIDs, six reserved ports and provider destinations.
 * @returns RenderProfile-compatible configurations, shared routing and per-process private file inventory.
 */
export function replicaPlan(input) {
  const { home, workerIds, ports, modelUrl, connectorUrl } = input
  assert(isAbsolute(home) && !/[\u0000-\u001f\u007f]/u.test(home))
  assert(Array.isArray(workerIds) && workerIds.length === 2 && new Set(workerIds).size === 2)
  assert(workerIds.every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)))
  const ids = ['h1', 'h2', 'p1', 'p2', 'proxy1', 'proxy2']
  assert(ids.every(id => Number.isInteger(ports[id]) && ports[id] > 0 && ports[id] <= 65535))
  assert.equal(new Set(ids.map(id => ports[id])).size, ids.length)
  for (const value of [modelUrl, connectorUrl]) {
    const url = new URL(value)
    assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
  }
  const origins = Object.fromEntries(ids.map(id => [id, 'http://127.0.0.1:' + ports[id]]))
  const sharedRoots = Object.fromEntries(['workspaces', 'attachments', 'skills'].map(id => [id, join(home, 'storage', id)]))
  const routingFile = join(home, 'operator', 'native-input-owner-routing.json')
  const routing = { workerOrigins: Object.fromEntries(workerIds.map((worker, index) => [worker, origins['h' + (index + 1)]])),
    timeoutMs: 15000, maxResponseBytes: 1048576 }
  const configs = {}, privateFiles = {}
  for (const [index, workerId] of workerIds.entries()) {
    const number = index + 1, host = 'h' + number, platform = 'p' + number
    for (const [id, role] of [[host, 'host'], [platform, 'platform']]) {
      const privateDir = join(home, 'private', id)
      const base = { mode: 'local-http', privateDir, dshHome: join(home, 'dsh-home', id),
        hostOrigin: origins[host], platformOrigin: origins[platform],
        platformInternalUrl: origins['proxy' + number], rows: {} }
      if (role === 'host') {
        base.rows.host = { 'web-server': { port: ports[id] }, 'power-evolve-runtime': { workerId,
          workerTokenFile: join(privateDir, 'worker-token'), timeoutMs: 15000 },
        'power-evolve-host': { concurrency: 1, pollMs: 100, renewMs: 8000, nativeInputPollMs: 100,
          operationTimeoutMs: 150000 } }
        privateFiles[id] = { workerTokenFile: join(privateDir, 'worker-token') }
      } else {
        base.rows.platform = { 'web-server': { port: ports[id] }, 'power-evolve-platform': {
          databaseUrlFile: join(privateDir, 'database-url'), workerTokenFile: join(privateDir, 'worker-token'),
          nativeIntentKeyFile: join(privateDir, 'native-intent-key'),
          modelKeyFile: join(privateDir, 'model-key'), connectorKeyFile: join(privateDir, 'connector-key'),
          workspaceRoot: sharedRoots.workspaces, attachmentRoot: sharedRoots.attachments,
          skillLibraryRoot: sharedRoots.skills, nativeInputOwnerRoutingFile: routingFile,
          modelUrl, connectorUrl, modelTimeoutMs: 120000, leaseMs: 30000, nativeWriterLeaseMs: 30000,
          seedUsersFile: '', accountManagementFile: '', preinstalledSkills: [],
        } }
        privateFiles[id] = Object.fromEntries(['database-url', 'worker-token', 'model-key', 'connector-key', 'native-intent-key']
          .map(name => [name, join(privateDir, name)]))
      }
      configs[id] = { role, config: base }
    }
  }
  return { expectedSchema: { family: 'cloud-native', version: 6, tables: 82 },
    nativeMutationFamilies: ['publication', 'admission', 'claim', 'queue', 'step',
      'prepared-cancel', 'archive-cancel', 'turn-transition'],
    configs, origins, sharedRoots, routingFile, routing, privateFiles,
    proxies: [1, 2].map(number => ({ targetOrigin: origins['p' + number], port: ports['proxy' + number],
      watchedPaths: ['/runtime/native-intents/prepare', '/runtime/native-intents/execute',
        '/runtime/native-intents/reconcile', '/runtime/native-intents/resolve', '/runtime/native-turn/prepare'],
      maxRequestBytes: 50331648, maxFaultResponseBytes: 67108864, requestTimeoutMs: 15000 })) }
}
