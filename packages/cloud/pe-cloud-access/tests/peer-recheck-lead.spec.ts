/** Loader/HTTP/canonical Peer scheduling; external DB answers and files are controlled, with actual timers and guards. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Socket } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { WorkspaceAnalyzer, FaceModelEmitter, findWorkspaceRoot } from '@deepseek-ai/dsh-typert-generator'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { apply as connectionApply, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { CloudAccountFiles, type AccountFilesPreparation, type SkillBundlePort, type SkillBundleVersion, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Auth } from 'better-auth'
import pg from 'pg'
import { BetterAuthAccess } from '../src/auth.ts'
import { LoginPeerRegistry, type LoginPeer } from '../src/peers.ts'
import type { AccessConfig } from '../src/types.ts'
import { CloudAccountApi } from '@deepseek-ai/dsh-pe-cloud-api/src/account-service.ts'
import type { CloudSkillService } from '@deepseek-ai/dsh-pe-cloud-api/src/cloud-skills.ts'
import { ConfigSaveCoordinator } from '@deepseek-ai/dsh-pe-cloud-api/src/config-saves.ts'
import { ExposurePolicy } from '@deepseek-ai/dsh-pe-cloud-api/src/exposure.ts'
import { describeBundle, encodeBundleZip, validateBundleTree } from '@deepseek-ai/dsh-pe-cloud-files/src/bundle-codec.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
import { PeAuthService } from '../src/auth-root.ts'
import { parseAuthRootConfig, type AuthRootConfig } from '../src/root-config.ts'
import { rootConfig, ingressConfig } from './ingress-fixture.ts'

const S = 5000
const ORIGIN = 'http://127.0.0.1:4100'
const INSTALLATION = '11111111-2222-3333-4444-555555555555'
const CONTENT = '66666666-7777-8888-9999-aaaaaaaaaaaa'
const methods = ['current', 'publish', 'installed', 'details', 'install', 'update', 'uninstall', 'download']
const bundleLimits = { maxInstallations: 4, maxFiles: 8, maxDirectories: 6, maxDepth: 5, maxPathBytes: 256,
  maxFileBytes: 4096, maxContentBytes: 16384, maxArchiveBytes: 32768, maxArchiveEntries: 16,
  maxExpandedArchiveBytes: 16384, maxInputBytes: 65536, maxManifestBytes: 8192, maxCatalogBytes: 8192,
  maxDownloadBytes: 32768, maxRequestBytes: 65536, maxReplyBytes: 131072, maxStagingBytes: 65536, reservationBytes: 65536 }
const policy: AccessConfig = { publicOrigin: ORIGIN, deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'f06-component',
  sessionRecheckMs: S, authCheckTimeoutMs: 10000, maxPeers: 4, maxPeersPerAccount: 2, maxPeerWaiters: 8, maxPeerWaitersPerAccount: 4,
  maxPeerCarriers: 16, maxPeerCarriersPerAccount: 8, maxPeerCarriersPerLogin: 8, peerCloseTimeoutMs: 30000,
  maxAuthOperations: 16, maxTrackedLogins: 16, maxTrackedLoginsPerAccount: 8, maxAuthInvalidations: 16,
  bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' } }

class UnusedWorkspaceRegistry extends WorkspaceRegistry {
  createProject(): Promise<never> { return Promise.reject(new Error('No project activation in F06')) }
  createAdmittedProject(): Promise<never> { return Promise.reject(new Error('No project activation in F06')) }
  createS2Project(): Promise<never> { return Promise.reject(new Error('No project activation in F06')) }
}

/** Copied from the existing peers-postgres carrier fixture; Node parses actual HTTP bytes without listen(). */
class MemorySocket extends Socket {
  other: MemorySocket | undefined
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.other === undefined || this.other.destroyed) { callback(new Error('Memory peer closed')); return }
    this.other.push(Buffer.from(chunk)); callback()
  }
  override _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], callback: (error?: Error | null) => void): void {
    this._write(Buffer.concat(chunks.map(item => Buffer.from(item.chunk))), 'utf8', callback)
  }
  override _final(callback: (error?: Error | null) => void): void { this.other?.push(null); callback() }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.other?.push(null); callback(error); process.nextTick(() => { this.emit('close', error !== null) })
  }
}

type Answer = {
  status: number
  result: {
    ok: boolean
    value?: { files?: unknown[]; bytes?: number; dataBase64?: string }
    error?: { code: string; message: string }
  }
}
type Barrier = ReturnType<typeof Promise.withResolvers<undefined>>
type Cut = { stage: 'observe' | 'export'; entered: Barrier; resume: Barrier }

async function fixture(sessionRecheckLeadMs: number) {
  const home = mkdtempSync(join(HERE, 'scratch-')), profileDir = join(home, 'profiles', 'test')
  const sockets: Socket[] = [], servers: ReturnType<typeof createServer>[] = [], handles: LoginPeer[] = []
  const clock = { now: 100000 }
  // Clock is the only guard input replaced. AuthAccess.assertLoginCurrent itself is always the shipping method.
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  vi.stubEnv('DSH_HOME', join(home, 'dsh-home'))
  const coordinator = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 8, maxQueuedPerAccount: 8,
    maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 16, maxNestedPerOperation: 8, maxWaitersPerAccount: 4 })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>('f06-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'f06-component', lifetime: lifetime.signal })
  const saves = coordinator.createAccount(binding)
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'unused-f06', database: 'unused-f06', max: 1, connectionTimeoutMillis: 50 })
  let nextLoginRead: { entered: Barrier; resume: Barrier } | undefined
  const loginReads: Array<NonNullable<typeof nextLoginRead>> = []
  let blockedConnects = 0
  const dbConnect = vi.spyOn(pool, 'connect').mockImplementation(() => { blockedConnects++; throw new Error('F06 component must not open SQL transport') })
  const dbQuery = vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('F06 component must not query SQL') })
  const owned: { ctx?: Context; registry?: LoginPeerRegistry; auth?: BetterAuthAccess } = {}
  let api: CloudAccountApi | undefined, service: CloudSkillService | undefined, cut: Cut | undefined
  const cuts: Cut[] = []
  let borrowed = 0, released = 0, nativeDispatches = 0, residents = 0, exports = 0, exportReleases = 0
  const failures: unknown[] = []
  onTestFinished(async () => {
    for (const held of loginReads) held.resume.resolve(undefined)
    for (const held of cuts) held.resume.resolve(undefined)
    try {
      await owned.registry?.closeActual()
      await owned.auth?.close()
      if (api !== undefined) { await api.stopConfigSaves(Date.now() + 2000); await api.withdraw() }
      await owned.ctx?.fiber.dispose()
      coordinator.releaseAccount(saves); coordinator.close()
      await pool.end()
      expect(released).toBe(borrowed)
      expect(residents).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      for (const server of servers) server.close()
      vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true })
    }
  })
  const requestId = () => brandString<Parameters<BetterAuthAccess['authenticate']>[1]>(randomUUID())
  const auth = await BetterAuthAccess.create(policy, pool, 'f06-component-secret-012345678901234567890', async (login) => {
    await owned.registry?.invalidateLogin(login)
  })
  owned.auth = auth
  const actualAuth = auth, library = Reflect.get(actualAuth, 'auth') as Auth
  const now = new Date(), expiresAt = new Date(Date.now() + 120000)
  // Same explicit DB-answer boundary as s5-model-key-host.spec.ts. Neither current guard nor Peer registry is mocked.
  const sessions = vi.spyOn(library.api, 'getSession').mockImplementation(async () => {
    const held = nextLoginRead; nextLoginRead = undefined
    if (held !== undefined) { held.entered.resolve(undefined); await held.resume.promise }
    return ({
      user: { id: 'f06-account', name: 'F06 component', email: 'f06@example.test', emailVerified: false, createdAt: now, updatedAt: now },
      session: { id: 'f06-login', userId: 'f06-account', token: 'f06-synthetic-session', expiresAt, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
    })
  })
  const authentications = vi.spyOn(actualAuth, 'authenticate')
  const guard = vi.spyOn(actualAuth, 'assertLoginCurrent')
  const rechecks = vi.spyOn(actualAuth, 'recheckLogin')
  const current = (actual: AccountBinding): void => { if (actual !== binding) throw new Error('Foreign F06 binding'); lifetime.signal.throwIfAborted() }
  const registry = new LoginPeerRegistry({ ...policy, sessionRecheckLeadMs }, actualAuth, {
    borrow: async (actual) => {
      current(actual); if (owned.ctx === undefined) throw new Error('F06 Loader graph absent'); borrowed++
      const context = owned.ctx; let live = true
      const use: AccountUse = { binding, context, assertCurrent() { current(binding); if (!live) throw new Error('F06 original Use ended') },
        release() { if (live) { live = false; released++ } } }
      return use
    },
    beforeHttp() {}, beforeStream() {},
    beforeDispatch(_request, dispatch) { if (api === undefined || dispatch.kind !== 'rpc') throw new Error('F06 native RPC absent'); api.requireRpc(dispatch.endpoint); nativeDispatches++ },
    cleanupFailed(value) { failures.push(value) },
  })
  owned.registry = registry
  const peers = registry
  const tree = validateBundleTree({ directories: ['empty', 'scripts'], files: [
    { relativePath: 'SKILL.md', data: new TextEncoder().encode('---\nname: f06-alpha\ndescription: F06 boundary fixture\n---\nUse fixture resources.\n') },
    { relativePath: 'README.txt', data: new TextEncoder().encode('component fixture\n') },
    { relativePath: 'data.txt', data: new TextEncoder().encode('F06\n') },
    { relativePath: 'scripts/read.py', data: new TextEncoder().encode('print("F06")\n') },
  ] }, bundleLimits)
  const manifest = describeBundle(tree), zip = encodeBundleZip(tree, bundleLimits.maxDownloadBytes)
  const version: SkillBundleVersion = Object.freeze({ binding, id: brandString<SkillBundleVersion['id']>(CONTENT), format: 'bundle-tree-v1',
    ...manifest, directoryCount: tree.directories.length, chargedBytes: manifest.contentBytes + 1024, chargedInodes: 9 })
  const catalog = Object.freeze({ entries: Object.freeze([{ skillId: brandString<import('@deepseek-ai/dsh-pe-cloud-files').SkillInstallationId>(INSTALLATION), kind: 'managed' as const, version }]), revision: FsVersion('f06-directory-1') })
  const own = <T>(value: T) => { residents++; let held = true; return { value, release() { if (!held) throw new Error('F06 resident released twice'); held = false; residents-- } } }
  const atCut = async (stage: Cut['stage']) => { if (cut?.stage !== stage) return; const selected = cut; cut = undefined; selected.entered.resolve(undefined); await selected.resume.promise }
  const deny = (): never => { throw new Error('No F06 skill mutation/projection') }
  const bundles: SkillBundlePort = {
    prepareBundle: deny, commitCatalog: deny, materializeBundleVersion: deny,
    async observeCatalog(signal) { signal.throwIfAborted(); await atCut('observe'); return own(catalog) },
    async withBundleSource(actual, consume, signal) {
      if (actual !== version) throw new Error('Foreign F06 source'); signal.throwIfAborted()
      const lease = Object.freeze({ ...version })
      return own(await consume({ version: lease, files: version.files, directories: version.directories,
        async readText(path, child) { child?.throwIfAborted(); const member = tree.files.find(file => file.relativePath === path); if (member === undefined) throw new Error('Missing F06 text'); return new TextDecoder().decode(member.data) },
        async readBytes(path, child) { child?.throwIfAborted(); const member = tree.files.find(file => file.relativePath === path); if (member === undefined) throw new Error('Missing F06 bytes'); return Uint8Array.from(member.data) },
      }, signal))
    },
    async exportBundle(actual, signal) {
      if (actual !== version) throw new Error('Foreign F06 export'); signal.throwIfAborted(); exports++
      await atCut('export'); const result = own(Uint8Array.from(zip))
      return { value: result.value, release() { exportReleases++; result.release() } }
    },
  }
  const legacy: SkillVersionPort & { bundles: SkillBundlePort } = { bundles, prepare: deny, commit: deny, withSource: deny,
    async current(signal) { signal.throwIfAborted(); return own(undefined) } }
  mkdirSync(profileDir, { recursive: true }); initProfile(profileDir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"f06-skills-component"}\n')
  mkdirSync(join(home, 'node_modules', '@deepseek-ai'), { recursive: true })
  // Native import() uses the generated descriptor with only its two module addresses relocated into this fixture.
  const artifactPackage = join(home, 'node_modules', '@deepseek-ai', 'dsh-pe-cloud-api')
  mkdirSync(artifactPackage)
  writeFileSync(join(artifactPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pe-cloud-api', version: '0.2.1-rc.2', type: 'module',
    exports: { './package.json': './package.json', './typert': './typert.host.mjs' } }))
  const remoteSource = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-typert-protocol/src/remote-info.ts'), 'utf8')
  const { outputText } = ts.transpileModule(remoteSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  })
  const remoteModule = ts.createSourceFile('remote-info.js', outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  expect(remoteModule.statements.filter(ts.isImportDeclaration)).toEqual([])
  const remotePath = join(home, 'remote-info.mjs'); writeFileSync(remotePath, outputText)
  const workspace = findWorkspaceRoot(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-pe-cloud-api/package.json')))
  const model = new WorkspaceAnalyzer({ root: workspace, packages: ['@deepseek-ai/dsh-pe-cloud-api'],
    faces: ['host'], mode: 'check', checkDiagnostics: true, rejectBuildOutputs: true }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('Original Cloud API Host model absent')
  const descriptor = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-pe-cloud-api').js
    .replace("from 'zod'", 'from ' + JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod')).href))
    .replace("from '@deepseek-ai/dsh-typert-protocol/remote-info'", 'from ' + JSON.stringify(pathToFileURL(remotePath).href))
  writeFileSync(join(artifactPackage, 'typert.host.mjs'), descriptor)
  const credentialPath = join(home, 'credentials.yaml'); writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const config = join(profileDir, 'cordis.yml'); writeFileSync(config, JSON.stringify([
    { id: 'dependencies', name: 'cordis:f06-dependencies' },
    { id: 'typert-artifacts', name: 'cordis:f06-typert-artifacts', config: { packages: ['@deepseek-ai/dsh-pe-cloud-api'] } },
    { id: 'credentials', name: 'cordis:f06-credentials', config: { path: credentialPath, watch: false } },
    { id: 'connection', name: 'cordis:f06-connection' },
    { id: 'skills', name: 'cordis:f06-skills' },
    { id: 'capability', name: 'cordis:f06-capability' },
  ]))
  const exposure = new ExposurePolicy({ recipeVersion: binding.recipeVersion,
    rpcEndpoints: methods.map(method => ({ endpoint: `cloudSkills/${method}`, handlerId: 'native:cloudSkills', guard: 'authenticated-account' })),
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] })
  const ctx = await boot('f06-skills-component', config, [], (owner) => {
    owner.provide('profileContext', { name: 'test', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
    owner.provide('peAccount', binding)
    api = new CloudAccountApi(owner, { binding, saves, rootExposure: exposure, selected: exposure.manifest,
      assertMountCurrent: current, assertBusinessCurrent: current })
    const preparedApi = api, info = statSync(home, { bigint: true })
    const grant: AccountFilesPreparation['defaultGrant'] = { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
      parent: { rootPath: home, rootDevice: String(info.dev), rootInode: String(info.ino) }, assertExclusive() { current(binding) } }
    const files = new CloudAccountFiles(owner, { binding, defaultGrant: grant, skillVersions: () => legacy,
      assertMountCurrent: current, assertUnpublished() { current(binding) },
      port: { createWorkspaceRegistry: () => UnusedWorkspaceRegistry } })
    Object.assign(owner.loader.builtins, {
      'f06-dependencies': { async apply(scope: Context) { await scope.plugin(TypertRegistry); await scope.plugin(RemoteAccess); await scope.plugin(Gateway) } },
      'f06-typert-artifacts': TypertLoader,
      'f06-credentials': preparedApi.providers.credentials,
      'f06-connection': { apply: connectionApply, inject: [...connectionInject] },
      'f06-skills': SkillRegistry,
      'f06-capability': { inject: ['typert', 'skills'], apply(scope: Context) {
        service = preparedApi.prepareCloudSkills(scope, { files,
          limits: { maxFileBytes: 4096, maxRequestBytes: 16384, maxReplyBytes: 8192, maxRetainedVersions: 8 },
          managed: { limits: { maxRequestBytes: 65536, maxReplyBytes: 131072, maxMetadataBytes: 4096, maxRetainedProviders: 8 },
            bundleLimits, assertWorkspace: deny },
          withModelKeyPeerUse: (peer, consume) => peers.withOriginalUse(peer, () => { current(binding) }, consume) })
      } },
    })
  })
  owned.ctx = ctx
  if (service === undefined || api === undefined) throw new Error('F06 native skill assembly absent')
  await service.restore(); api.audit(service.inspect())

  async function http(method: 'installed' | 'details' | 'download'): Promise<Answer> {
    const endpoint = `cloudSkills/${method}`, id = requestId()
    const server = createServer((req, res) => {
      void (async () => {
        const principal = await actualAuth.authenticate(req, id)
        const handle = await peers.acquire(principal, binding, Date.now() + 30000, undefined, id)
        handles.push(handle)
        await peers.handleNodeRequest(handle, req, res, 65536, id)
      })().catch(() => { res.destroy() })
    }); servers.push(server)
    const a = new MemorySocket(), b = new MemorySocket(); a.other = b; b.other = a
    a.on('error', () => {}); b.on('error', () => {}); sockets.push(a, b); server.emit('connection', b)
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${ORIGIN}/api/${endpoint}`, { method: 'POST',
        headers: { cookie: 'f06=component', 'content-type': 'application/json' }, createConnection: () => a }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => { chunks.push(chunk) }); response.on('error', reject)
        response.on('end', () => {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: Answer['result'] }
          resolve({ status: response.statusCode!, result: value.result })
        })
      })
      request.on('error', reject)
      request.end(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint,
        payload: { args: { request: method === 'installed' ? {} : method === 'details' ? { skillId: INSTALLATION } : { skillId: INSTALLATION, contentVersion: CONTENT } } } }))
    })
  }
  expect(await http('installed')).toMatchObject({ status: 200, result: { ok: true } })
  const original = handles[0]; if (original === undefined) throw new Error('F06 original Peer absent')
  // Initial Peer preparation always performs a real-adapter recheck; the matrix counts only later boundary-triggered rechecks.
  rechecks.mockClear()
  return { http, clock, original, handles, guard, rechecks, sessions, authentications, auth: actualAuth, saves,
    nativeDispatchCount: () => nativeDispatches,
    ownership: () => ({ borrowed, released, failures }),
    holdNextLoginRead() {
      if (nextLoginRead !== undefined) throw new Error('One external DB-answer cut at a time')
      const held = { entered: Promise.withResolvers<undefined>(), resume: Promise.withResolvers<undefined>() }
      nextLoginRead = held; loginReads.push(held); return held
    },
    arm(stage: Cut['stage']) { const next: Cut = { stage, entered: Promise.withResolvers<undefined>(), resume: Promise.withResolvers<undefined>() }; cut = next; cuts.push(next); return next },
    async settled() { await vi.waitFor(() => { expect(actualAuth.pendingOperations).toBe(0); expect(residents).toBe(0) }) },
    assertOwned() {
      expect(handles.every(handle => handle === original)).toBe(true); expect(borrowed).toBe(1); expect(released).toBe(0)
      expect(nativeDispatches).toBe(handles.length); expect(failures).toEqual([])
      expect(saves.snapshot().pending).toEqual([]); expect(saves.snapshot().failures).toEqual([])
      expect(exports).toBe(exportReleases); expect(dbConnect.mock.calls).toHaveLength(blockedConnects)
      expect(dbQuery).not.toHaveBeenCalled()
    },
  }
}

it.each(['healthy', 'late'] as const)('keeps the maximum login age with an explicit early recheck: %s', async (order) => {
  const f = await fixture(2500)
  f.clock.now = 102499
  const cut = f.arm('export'), answer = f.http('download')
  void answer.catch(() => {})
  await cut.entered.promise
  expect(f.rechecks).not.toHaveBeenCalled()
  const background = f.holdNextLoginRead()
  f.clock.now = 102500
  // The original scheduled timer must enter readLogin; no manual recheck or fake timer is used.
  await background.entered.promise
  expect(f.rechecks).toHaveBeenCalledOnce()
  expect(f.rechecks.mock.calls[0]?.[0]).toBe(f.original.principal)
  const beforeNative = f.nativeDispatchCount(), beforeAuth = f.authentications.mock.calls.length
  let freshSettled = false
  const freshRequest = f.http('installed').then((value) => { freshSettled = true; return value })
  void freshRequest.catch(() => {})
  await vi.waitFor(() => { expect(f.authentications.mock.calls.length).toBe(beforeAuth + 2) })
  const latest = f.authentications.mock.results.at(-1)
  if (latest?.type !== 'return') throw new Error('Expected the original HTTP authentication result')
  const freshPrincipal = await latest.value
  expect(freshPrincipal).not.toBe(f.original.principal)
  expect(freshSettled).toBe(false)
  expect(f.nativeDispatchCount()).toBe(beforeNative)
  // Pending early checks retain the original carrier join even while its canonical principal is still fresh.
  expect(() => { f.auth.assertLoginCurrent(f.original.principal, brandString<Parameters<BetterAuthAccess['assertLoginCurrent']>[1]>('early-principal')) }).not.toThrow()
  if (order === 'healthy') {
    f.clock.now = 102600
    background.resume.resolve(undefined)
    await vi.waitFor(() => { expect(f.auth.pendingOperations).toBe(0) })
    f.clock.now = 105000
    cut.resume.resolve(undefined)
    expect(await answer).toMatchObject({ status: 200, result: { ok: true } })
  } else {
    f.clock.now = 105000
    expect(() => { f.auth.assertLoginCurrent(f.original.principal, brandString<Parameters<BetterAuthAccess['assertLoginCurrent']>[1]>('original-age-limit')) }).toThrow()
    cut.resume.resolve(undefined)
    expect(await answer).toMatchObject({ status: 200, result: { ok: false, error: { code: 'gateway/internal',
      message: 'Authentication could not be confirmed. Check status before sending a new operation.' } } })
    expect(f.rechecks).toHaveBeenCalledOnce()
    f.clock.now = 105100
    background.resume.resolve(undefined)
  }
  expect(await freshRequest).toMatchObject({ status: 200, result: { ok: true } })
  await f.settled(); f.assertOwned()
  expect(f.rechecks).toHaveBeenCalledOnce()
}, 30000)

it('keeps actual authentication work owned after the unchanged 10000ms observer timeout', async () => {
  const f = await fixture(2500), background = f.holdNextLoginRead()
  f.clock.now = 105000
  await background.entered.promise
  expect(f.rechecks).toHaveBeenCalledOnce()
  const refused = expect(f.http('installed')).rejects.toThrow()
  // Recheck failure closes the original Peer/carrier; the held database answer remains actual auth work.
  await refused
  expect(f.auth.pendingOperations).toBe(1)
  expect(() => { f.auth.assertLoginCurrent(f.original.principal, brandString<Parameters<BetterAuthAccess['assertLoginCurrent']>[1]>('timed-out-canonical')) }).toThrow()
  expect(f.nativeDispatchCount()).toBe(1)
  background.resume.resolve(undefined)
  await f.settled()
  expect(f.ownership()).toEqual({ borrowed: 1, released: 1, failures: [] })
}, 30000)

function deployment(): AuthRootConfig {
  return { ...rootConfig(), sessionRecheckMs: S, authCheckTimeoutMs: 10000,
    ingress: { ...ingressConfig(), sessionRecheckLeadMs: 2500 } }
}

it('keeps the lead Root-only and independent of authentication observer timeout', () => {
  expect(parseAuthRootConfig(deployment())).toMatchObject({ sessionRecheckMs: 5000, authCheckTimeoutMs: 10000,
    ingress: { sessionRecheckLeadMs: 2500 } })
  const { ingress: _ingress, ...resources } = deployment()
  expect(parseAuthRootConfig(resources).ingress).toBeUndefined()
})

it.each([undefined, 0, -1, S, S + 1, 0.5, NaN, Infinity])(
  'refuses an invalid production lead before credentials or resource admission: %s', async (lead) => {
    const ctx = new Context(), reads = vi.spyOn(ctx, 'get')
    const config = deployment()
    const invalid = { ...config, ingress: { ...config.ingress, sessionRecheckLeadMs: lead } } as AuthRootConfig
    try {
      await expect(PeAuthService.mountRoot(ctx, invalid)).rejects.toThrow(TypeError)
      expect(reads).not.toHaveBeenCalled()
    } finally { reads.mockRestore(); await ctx.fiber.dispose() }
  },
)
