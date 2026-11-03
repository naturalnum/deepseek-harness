/** Native Loader, generated RPC codecs and private storage; Root SQL/SDK and publication are explicit fixture capabilities. */
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { WorkspaceAnalyzer, FaceModelEmitter, findWorkspaceRoot } from '@deepseek-ai/dsh-typert-generator'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as TypertLoader from '@deepseek-ai/dsh-typert-loader'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { CloudAccountApi, ConfigSaveCoordinator, type ModelKeyPeerConsumer } from '@deepseek-ai/dsh-pe-cloud-api'
import { ExposurePolicy } from '../../../../pe-cloud-api/src/exposure.ts'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { remoteManagedFixture } from '../../../../pe-opensandbox/tests/remote-managed-fixture.ts'

/** Fixed finite Root opt-in; never exposed as browser-editable configuration. */
export const remotePolicy = {
  limits: { maxServers: 4, maxReplyBytes: 65536, maxRequestBytes: 16384, maxImportBytes: 4096,
    maxPrivateKeyBytes: 2048, maxKnownHostsBytes: 1024, maxCommandBytes: 4096, alwaysAsk: true, readOnlyAllowlist: [] },
  execution: { pythonPath: '/usr/bin/python3', sshPath: '/usr/bin/ssh', timeoutMs: 10000, probeTimeoutMs: 10000,
    connectTimeoutSeconds: 3, outputMaxBytes: 4096, stopWaitMs: 2000 },
}
class UnusedWorkspaceRegistry extends WorkspaceRegistry {
  createProject(): Promise<never> { return Promise.reject(new Error('No project activation in management fixture')) }
  createAdmittedProject(): Promise<never> { return this.createProject() }
  createS2Project(): Promise<never> { return this.createProject() }
}
/** Generate exact current native descriptors from source; no handwritten codec or lib dependency.
 * @param home Owned fixture module directory. @returns Host descriptor installation directory.
 */
export function descriptors(home: string): string {
  const require = createRequire(import.meta.url), manifest = require.resolve('@deepseek-ai/dsh-pe-cloud-api/package.json')
  const model = new WorkspaceAnalyzer({ root: findWorkspaceRoot(dirname(manifest)), packages: ['@deepseek-ai/dsh-pe-cloud-api'],
    faces: ['host'], mode: 'check', checkDiagnostics: true, rejectBuildOutputs: true }).analyze()
  const face = model.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('Original Host face absent')
  const protocol = ts.transpileModule(readFileSync(require.resolve('@deepseek-ai/dsh-typert-protocol/src/remote-info.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText
  const factory = join(home, 'remote-info.mjs'); writeFileSync(factory, protocol)
  const output = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-pe-cloud-api').js
    .replace(/from (['"])zod\1/g, 'from ' + JSON.stringify(pathToFileURL(require.resolve('zod')).href))
    .replace(/from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g, 'from ' + JSON.stringify(pathToFileURL(factory).href))
  const installed = join(home, 'node_modules/@deepseek-ai/dsh-pe-cloud-api')
  mkdirSync(join(installed, 'lib'), { recursive: true }); writeFileSync(join(installed, 'package.json'), readFileSync(manifest))
  writeFileSync(join(installed, 'lib/typert.host.js'), output)
  return installed
}

/** Boot a management account via real cordis.yml and retained native constructors.
 * @param home Owned account path. @param binding Original authenticated-account test generation.
 * @param managed Original managed coordinator. @param peers Original login registry consumer.
 * @returns Actual mounted services and joined shutdown; does not certify production Root readiness.
 */
export async function managementAccount(home: string, binding: AccountBinding,
  managed: Awaited<ReturnType<typeof remoteManagedFixture>>, peers: ModelKeyPeerConsumer) {
  const dir = join(home, 'profile'), anchor = join(home, 'package.json'), config = join(dir, 'cordis.yml')
  mkdirSync(dir, { recursive: true }); initProfile(dir, [])
  writeFileSync(anchor, '{"name":"remote-management-fixture","dependencies":{}}')
  const profile: ProfileContext = { name: 'remote-fixture', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: anchor, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 4, maxQueuedPerAccount: 4,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 8, maxWaitersPerAccount: 4 })
  const barrier = saves.createAccount(binding)
  const policy = new ExposurePolicy({ recipeVersion: binding.recipeVersion,
    rpcEndpoints: [{ endpoint: 'cloudRemoteServers/action', handlerId: 'cloud:remote-servers', guard: 'authenticated-account' }],
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] })
  const current = (): void => { binding.lifetime.throwIfAborted() }
  let api: CloudAccountApi | undefined
  writeFileSync(config, JSON.stringify([
    { id: 'artifacts', name: 'cordis:artifacts', config: { packages: ['@deepseek-ai/dsh-pe-cloud-api'] } },
    { id: 'dependencies', name: 'cordis:dependencies' }, { id: 'credentials', name: 'cordis:credentials',
      config: { path: join(home, 'credentials.yaml'), watch: false } },
    { id: 'storage-json', name: 'cordis:json', config: { root: join(home, 'storage') } },
    { id: 'connection', name: 'cordis:connection' }, { id: 'remote-access', name: 'cordis:remote-access' },
    { id: 'gateway', name: 'cordis:gateway', config: { websocketHeartbeatIntervalMs: 60000, streamInboxBytes: 65536 } },
    { id: 'domains', name: 'cordis:domains', config: { backend: 'json' } },
    { id: 'execution', name: 'cordis:execution' }, { id: 'remote-servers', name: 'cordis:remote-servers' },
  ]))
  const ctx = await boot('dsh', config, [], async (owner) => {
    owner.provide('profileContext', profile); owner.provide('peAccount', binding)
    await owner.plugin(Typert)
    api = new CloudAccountApi(owner, { binding, saves: barrier, rootExposure: policy, selected: policy.manifest,
      assertMountCurrent: current, assertBusinessCurrent: current })
    const info = statSync(home, { bigint: true })
    const files = new CloudAccountFiles(owner, { binding, port: { createWorkspaceRegistry: () => UnusedWorkspaceRegistry },
      defaultGrant: { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
        parent: { rootPath: home, rootDevice: String(info.dev), rootInode: String(info.ino) }, assertExclusive: current },
      assertMountCurrent: current, assertUnpublished: current })
    const actual = api
    const noExecution = (): never => { throw new Error('Management fixture has no Session execution') }
    const execution = managed.bind(owner, binding, { assertBusinessCurrent: current, getAgent: () => undefined,
      projectForAgent: noExecution, projectForSession: noExecution, assertRetainedExecutionOwner: noExecution, files: () => files })
    Object.assign(owner.loader.builtins, {
      artifacts: TypertLoader, json: Json, domains: Domains, credentials: actual.providers.credentials,
      connection: Connection, 'remote-access': RemoteAccess, gateway: Gateway,
      dependencies: { apply(scope: Context) {
        new Storage(scope); new SystemPrompt(scope, SystemPrompt.Config({})); new Tools(scope, { mode: 'native' })
      } },
      execution: { inject: ['tools'], apply(scope: Context) {
        managed.installProviders(scope, execution)
      } },
      'remote-servers': { inject: ['peCloudApi', 'storageDomain', 'credentials', 'tools', 'subprocess', 'shell', 'typert'],
        async apply(scope: Context) { await actual.prepareCloudRemoteServers(scope, { ...remotePolicy, files, ...peers,
          assertBusinessCurrent: current, assertToolCurrent() { throw new Error('Management cannot issue an execution') } }) } },
    })
  })
  if (api === undefined) throw new Error('API not prepared')
  const retained = api, inventory = ctx.cloudRemoteServers.inspect()
  retained.audit(inventory)
  return { ctx, api: retained, barrier,
    async close() {
      await barrier.stopConfigSaves(Date.now() + 2000); await retained.withdraw(); await ctx.fiber.dispose()
      saves.releaseAccount(barrier); saves.close()
    },
  }
}
