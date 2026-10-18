/** Real Loader/Gateway/JSONL composition with explicit deployment guard review; no owner/ready or cloud-files authority. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import NativeLoop from '@deepseek-ai/dsh-agent-loop'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { remoteMethods, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished } from 'vitest'
import { createAccountExposure } from '../src/account-exposure.ts'
import { createNativeController, type NativeSessionGuards } from '../src/native.ts'
import { CloudApiError } from '../src/errors.ts'
import ExposureService from '../src/root.ts'
import type { ExposurePolicy } from '../src/exposure.ts'
import type { EndpointExposure, ExposureInventory, ExposureManifest } from '../src/types.ts'

const recipeVersion = 'm8-native-loader-exposure-component'
// Deployment review, not facts inferred from Remote names/resources. The actual
// thin Controller below installs the shared assertSessionProject implementation.
const reviewedHistory = new Map<string, EndpointExposure>([
  ['session/page', { endpoint: 'session/page', handlerId: 'native:sessionController', guard: 'account-session' }],
  ['session/follow', { endpoint: 'session/follow', handlerId: 'native:sessionController', guard: 'account-session' }],
])
const manifest: ExposureManifest = {
  recipeVersion, rpcEndpoints: [reviewedHistory.get('session/page')!],
  streamEndpoints: [reviewedHistory.get('session/follow')!], exactFetchRoutes: [], allowedSettings: [],
}

class ExactQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is outside this history fixture.')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is outside this history fixture.')) }
}

/** Inspect the public binding on the captured registration and its actual installed Service. */
function nativeFacts(ctx: Context, controller: SessionController) {
  const binding = controller.typertRemote
  const installed = ctx.get('sessionController')
  if (installed === undefined) return []
  expect(installed.typertRemote).toBe(binding)
  expect(binding.service).toBe(controller)
  expect(binding.serviceKey).toBe('sessionController')
  return remoteMethods(controller).map((marker) => {
    expect(typeof Reflect.get(binding.service, marker.method)).toBe('function')
    return {
      endpoint: `${binding.namespace}/${marker.exportName ?? marker.method}`,
      handlerId: `native:${binding.serviceKey}`, mode: marker.mode ?? 'rpc',
      implementation: marker.method, invocation: marker.invocation,
    }
  })
}

/** Join real mounted endpoint/handler/mode facts with the separately reviewed installed adapter guards. */
function mountedInventory(ctx: Context, controller: SessionController): ExposureInventory {
  const rpcEndpoints: EndpointExposure[] = []
  const streamEndpoints: EndpointExposure[] = []
  for (const fact of nativeFacts(ctx, controller)) {
    const reviewed = reviewedHistory.get(fact.endpoint)
    if (reviewed === undefined) continue
    const entry = { endpoint: fact.endpoint, handlerId: fact.handlerId, guard: reviewed.guard }
    if (fact.mode === 'stream') streamEndpoints.push(entry)
    else rpcEndpoints.push(entry)
  }
  return { recipeVersion, rpcEndpoints, streamEndpoints, exactFetchRoutes: [] }
}

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'm8-exposure-loader-')))
  const roots: Context[] = []
  onTestFinished(async () => {
    try { for (const root of roots.toReversed()) await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const deploymentConfig = join(home, 'deployment.yml')
  writeFileSync(deploymentConfig, JSON.stringify([{ id: 'exposure', name: 'cordis:m8-exposure', config: manifest }]))
  const deployment = await boot('m8-exposure-deployment', deploymentConfig, [], (root) => {
    roots.push(root)
    root.loader.builtins['m8-exposure'] = ExposureService
  })
  const rootPolicy = deployment.peExposure.policy

  const account = async (name: string) => {
    const accountHome = join(home, name)
    const project = join(accountHome, 'same-project-name')
    mkdirSync(project, { recursive: true })
    const lifetime = new AbortController()
    // Explicit component inputs only; no production owner, AccountUse, receipt or ready is issued.
    const binding: AccountBinding = Object.freeze({
      accountId: brandString<AccountId>(name), epoch: brandString<OwnerEpoch>('1'),
      recipeVersion, lifetime: lifetime.signal,
    })
    let ctx: Context | undefined
    let view: ExposurePolicy | undefined
    let controller: SessionController | undefined
    const observedProjects: string[] = []
    const enabledHandlers: string[] = []
    const assertCurrent = (actual: AccountBinding): void => {
      if (actual !== binding || lifetime.signal.aborted || ctx?.get('peAccount') !== binding) {
        throw new CloudApiError('cloud/stale-generation', 'The test graph binding has ended.')
      }
    }
    const requireView = (): ExposurePolicy => {
      if (view === undefined) throw new Error('The account view was not installed.')
      return view
    }
    const requireController = (): SessionController => {
      if (controller === undefined) throw new Error('The native Controller was not installed.')
      return controller
    }
    const dependencies = {
      name: 'm8-native-dependencies', Config: z.object({}),
      async apply(scope: Context): Promise<void> { await mountAgentLoopTestDependencies(scope, { workingDirectory: true }) },
    }
    const unrelatedServices = {
      name: 'm8-unrelated-services', Config: z.object({}),
      apply(scope: Context): void {
        // Constructor-only fixtures from native-history; no upload/attachment operation is exposed or exercised.
        scope.provide('fileUploads', { registerAgentResolver: () => () => {} })
        scope.provide('attachments', { imageLimits: {
          maxImageBytes: 1_024, maxImagesPerMessage: 1, maxMessageImageBytes: 1_024,
          maxImagePixels: 1_024, maxImageDimension: 32, mediaTypes: ['image/png'],
        } })
      },
    }
    const loop = {
      name: 'm8-native-loop', inject: [...NativeLoop.inject, 'sessionPersistence'], Config: NativeLoop.Config,
      apply(scope: Context, config: ConstructorParameters<typeof NativeLoop>[1]): void { new NativeLoop(scope, config) },
    }
    const controllerPlugin = {
      name: 'm8-native-controller', inject: [...SessionController.inject, 'peAccount', 'sessionPersistence'],
      Config: SessionController.Config,
      apply(scope: Context, config: ConstructorParameters<typeof SessionController>[1]): void {
        const guards: NativeSessionGuards = {
          assertHandlerEnabled(handlerId) {
            if (!nativeFacts(scope, requireController()).some(row => row.handlerId === handlerId)) {
              throw new CloudApiError('cloud/account-unavailable', 'The registered native handler is absent.')
            }
            enabledHandlers.push(handlerId)
          },
          async assertSessionProject(id) {
            using observation = await scope.sessionQuery.observeSession(id, { projectionMode: 'none' })
            if (observation.header.cwd !== project) throw new CloudApiError('cloud/forbidden', 'Outside the Node test project.')
            observedProjects.push(observation.header.cwd)
          },
          async resolveCreate() { throw new Error('Create is not in this reviewed history subset.') },
          assertActiveScope() { throw new Error('Active control is not in this reviewed history subset.') },
        }
        controller = createNativeController(scope, binding, assertCurrent, requireView(), guards, config)
      },
    }
    const configuration = join(accountHome, 'cordis.yml')
    writeFileSync(configuration, JSON.stringify([
      { id: 'dependencies', name: 'cordis:m8-dependencies' },
      { id: 'typert', name: 'cordis:m8-typert' },
      { id: 'access', name: 'cordis:m8-access' },
      { id: 'gateway', name: 'cordis:m8-gateway' },
      { id: 'storage', name: 'cordis:m8-storage' },
      { id: 'json', name: 'cordis:m8-json', config: { root: join(accountHome, 'storage') } },
      { id: 'domain', name: 'cordis:m8-domain', config: { backend: 'json' } },
      { id: 'jsonl', name: 'cordis:m8-jsonl', config: { root: join(accountHome, 'sessions'), compression: 'none' } },
      { id: 'workspace', name: 'cordis:m8-workspace' },
      { id: 'loop', name: 'cordis:m8-loop', config: { agents: [] } },
      { id: 'default-model', name: 'cordis:m8-default-model', config: { provider: 'unused', model: 'unused' } },
      { id: 'query', name: 'cordis:m8-query' },
      { id: 'unrelated', name: 'cordis:m8-unrelated' },
      { id: 'controller', name: 'cordis:m8-controller', config: { nativeOpen: false } },
    ]))
    const graph = await boot('m8-exposure-account-' + name, configuration, [], (root) => {
      roots.push(root)
      ctx = root
      root.provide('peAccount', binding)
      view = createAccountExposure(root, binding, assertCurrent, rootPolicy, manifest)
      Object.assign(root.loader.builtins, {
        'm8-dependencies': dependencies, 'm8-typert': TypertRegistry, 'm8-access': RemoteAccess,
        'm8-gateway': Gateway, 'm8-storage': Storage, 'm8-json': JsonStorage, 'm8-domain': DomainStorage,
        'm8-jsonl': Jsonl, 'm8-workspace': WorkspaceRegistry, 'm8-loop': loop,
        'm8-default-model': DefaultModel, 'm8-query': ExactQuery, 'm8-unrelated': unrelatedServices,
        'm8-controller': controllerPlugin,
      })
    })
    const installed = requireController()
    const peer: PeerScope = {
      id: brandString<PeerId>('m8-exposure-' + name), ctx: graph, principal: { kind: 'owner' },
      interactions: 'answer', signal: new AbortController().signal, dispose: async () => {},
    }
    const sessionId = SessionId('same-native-session-id')
    const prepared = graph.sessions.prepare(sessionId, { meta: { cwd: project } })
    const handle = await graph.sessionPersistence.create(prepared.header)
    try { await handle.flush() } finally { await handle.close() }
    await graph.sessionPersistence.flush()
    const address = { kind: 'session' as const, sessionId }
    const page = () => graph.typertGateway.invoke({ namespace: 'session', method: 'page', args: { request: { address, throughSeq: -1 } }, peer })
    const cancel = () => graph.typertGateway.invoke({ namespace: 'session', method: 'cancel', args: { request: { sessionId } }, peer })
    const snapshot = async () => {
      const source = await graph.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address } }, peer })
      const iterator = source[Symbol.asyncIterator]()
      try { return await iterator.next() } finally { await iterator.return?.() }
    }
    return {
      ctx: graph, binding, project, view: requireView(), controller: installed, observedProjects, enabledHandlers,
      inventory: () => mountedInventory(graph, installed), facts: () => nativeFacts(graph, installed), page, cancel, snapshot,
      async removeController() {
        const entry = [...graph.loader.entries()].find(row => row.options.id === 'controller')
        const fiber = entry?.fiber
        if (fiber === undefined) throw new Error('The actual Controller Loader fiber is absent.')
        await fiber.dispose()
      },
    }
  }
  return { deployment, rootPolicy, account }
}

it('audits actual native registrations per Loader graph and isolates audit, withdrawal and disposal across identical Session ids', async () => {
  const f = await fixture()
  const a = await f.account('A')
  const b = await f.account('B')
  expect(a.ctx.root).not.toBe(b.ctx.root)
  expect(a.ctx.sessionPersistence).not.toBe(b.ctx.sessionPersistence)
  expect(a.ctx.workspaceRegistry).toBeInstanceOf(WorkspaceRegistry)
  expect(b.ctx.workspaceRegistry).toBeInstanceOf(WorkspaceRegistry)
  expect(a.controller).toBeInstanceOf(SessionController)
  expect(a.facts()).toEqual(expect.arrayContaining([
    expect.objectContaining({ endpoint: 'session/page', implementation: 'page', mode: 'rpc', handlerId: 'native:sessionController' }),
    expect.objectContaining({ endpoint: 'session/follow', implementation: 'follow', mode: 'stream', handlerId: 'native:sessionController' }),
    expect.objectContaining({ endpoint: 'session/cancel' }),
  ]))
  await expect(a.page()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  a.view.audit(a.inventory())
  await expect(a.page()).resolves.toEqual({ records: [], hasMore: false })
  await expect(b.page()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(() => { f.rootPolicy.requireRpc('session/page') }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  b.view.audit(b.inventory())
  f.rootPolicy.audit(a.inventory())
  for (const graph of [a, b]) {
    await expect(graph.snapshot()).resolves.toMatchObject({ value: { type: 'snapshot', header: { id: SessionId('same-native-session-id'), cwd: graph.project }, cursor: -1, records: [] } })
    expect(graph.observedProjects.length).toBeGreaterThan(0)
    expect(graph.observedProjects.every(path => path === graph.project)).toBe(true)
    expect(new Set(graph.enabledHandlers)).toEqual(new Set(['native:sessionController']))
    expect(graph.ctx.agents.get(SessionId('same-native-session-id'))).toBeUndefined()
    // A real mounted native endpoint outside the reviewed subset remains closed.
    expect(() => { graph.view.requireRpc('session/cancel') }).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
    await expect(graph.cancel()).rejects.toMatchObject({ code: 'cloud/forbidden' })
  }
  a.view.invalidate()
  await expect(a.page()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await expect(b.page()).resolves.toEqual({ records: [], hasMore: false })
  expect(f.rootPolicy.requireRpc('session/page').endpoint).toBe('session/page')
  a.view.audit(a.inventory())
  await a.removeController()
  expect(a.facts()).toEqual([])
  expect(() => { a.view.audit(a.inventory()) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(() => { a.view.requireStream('session/follow') }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await expect(a.page()).rejects.toMatchObject({ code: 'gateway/invocation-unavailable' })
  await a.ctx.fiber.dispose()
  await expect(b.snapshot()).resolves.toMatchObject({ value: { header: { cwd: b.project } } })
  expect(f.rootPolicy.requireStream('session/follow').endpoint).toBe('session/follow')
  f.rootPolicy.invalidate()
  await expect(b.page()).resolves.toEqual({ records: [], hasMore: false })
  await b.ctx.fiber.dispose()
  expect(() => { b.view.requireRpc('session/page') }).toThrow()
})
