/** Closed owner lifecycle through real Cordis and native service calls; no execution backend is supplied. */
import { expect, it } from 'vitest'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { installAccountExecutionPort } from '../src/closed-owner.ts'
import { assertClosedAccountExecution } from '../src/index.ts'
import { assessExecution } from '../src/capabilities.ts'
import type { AccountExecutionPort } from '../src/account-port.ts'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'
import { closedRoot, closedAccount, installedAccount, context } from './closed-fixture.ts'

const shellSpec: ShellExecSpec = {
  command: 'exit 0', workdir: '/project', timeoutMs: 1000, onExpiry: 'kill', stdoutMaxBytes: 1024, sandboxPolicy: undefined,
}
const spawnSpec: SubprocessSpawnSpec = {
  argv: ['/bin/true'], cwd: '/project', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'inherit' }, graceMs: 100,
}
const disabled = { code: 'cloud/execution-unavailable', reason: 'disabled' }

it('registers an actual root and one native provider pair in each independent account', async () => {
  const r = await closedRoot()
  const a = await closedAccount(r.owner), b = await closedAccount(r.owner, 'b')
  expect(r.owner.id).toBe('execution')
  expect(() => { r.owner.assertReady() }).not.toThrow()
  expect(a.port.binding).toBe(a.binding)
  expect(b.port.binding).toBe(b.binding)
  expect(a.ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(a.ctx.shell.sandboxMode).toBeUndefined()
  expect(a.ctx.get('subprocess')).toBeDefined()
  expect(() => a.ctx.shell.resolve({ command: 'exit 0' })).toThrow(expect.objectContaining(disabled))
  expect(() => b.ctx.subprocess.spawn(spawnSpec)).toThrow(expect.objectContaining(disabled))
  expect(assessExecution({ requiredCapabilities: [] }).availableCapabilities).toEqual([])
})

it('refuses every native asynchronous entry without publishing any process handle', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner)
  await expect(a.ctx.shell.execute(shellSpec)).rejects.toMatchObject(disabled)
  await expect(a.ctx.subprocess.resolveExecutable('python')).rejects.toMatchObject(disabled)
  await expect(a.ctx.subprocess.terminalEnvironment()).rejects.toMatchObject(disabled)
  await expect(a.ctx.subprocess.spawnTerminal({ argv: ['bash'], cwd: '/project', rows: 24, cols: 80,
    terminalType: 'xterm', graceMs: 100 })).rejects.toMatchObject(disabled)
})

it.each([
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', control: 'pipe' },
  { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
] as const)('synchronously rejects native subprocess stdio $stdout', async (stdio) => {
  const r = await closedRoot(), a = await closedAccount(r.owner)
  expect(() => a.ctx.subprocess.spawn({ ...spawnSpec, stdio })).toThrow(expect.objectContaining(disabled))
})

it('preserves the original pre-aborted reason for native preparation and spawn', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner)
  const reason = new Error('caller reason'), signal = AbortSignal.abort(reason)
  await expect(a.ctx.shell.execute({ ...shellSpec, signal })).rejects.toBe(reason)
  expect(() => a.ctx.subprocess.spawn({ ...spawnSpec, signal })).toThrow(reason)
  await expect(a.ctx.subprocess.resolveExecutable('python', {}, signal)).rejects.toBe(reason)
})

it('stops the exact registration despite closed business admission and retains its original terminal receipt', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner), b = await closedAccount(r.owner, 'b')
  a.current.mockImplementation(() => { throw new Error('business admission ended') })
  const receipt = await r.owner.stopEpoch(a.binding, Date.now() - 1)
  expect(receipt).toMatchObject({ participant: 'execution', accountId: a.binding.accountId, epoch: a.binding.epoch,
    status: 'confirmed', pendingOperationIds: [] })
  expect(receipt.evidenceRefs).toHaveLength(1)
  expect(Object.isFrozen(receipt)).toBe(true)
  expect(await r.owner.stopEpoch(a.binding, Date.now())).toBe(receipt)
  expect(() => a.ctx.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => b.ctx.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining(disabled))
})

it('rejects unknown, cloned and foreign-owner bindings rather than issuing clean evidence', async () => {
  const r = await closedRoot(), other = await closedRoot(), a = await closedAccount(r.owner)
  const unknown = installedAccount('unknown')
  for (const binding of [unknown.binding, { ...a.binding }, { ...a.binding, lifetime: new AbortController().signal }]) {
    await expect(r.owner.stopEpoch(binding, Date.now())).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  }
  await expect(other.owner.stopEpoch(a.binding, Date.now())).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(r.owner.stopEpoch(a.binding, Infinity)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(() => a.ctx.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining(disabled))
})

it('bounds live registrations, rejects same-account replacement, and never reopens a retired binding', async () => {
  const r = await closedRoot(1), a = await closedAccount(r.owner), b = installedAccount('b'), replacement = installedAccount('a', '2')
  expect(() => r.owner.bindAccount(b.ctx, b.binding, b.current)).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  expect(() => r.owner.bindAccount(replacement.ctx, replacement.binding, replacement.current)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  const receipt = await r.owner.stopEpoch(a.binding, Date.now())
  expect(() => r.owner.bindAccount(a.ctx, a.binding, a.current)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(r.owner.bindAccount(b.ctx, b.binding, b.current).binding).toBe(b.binding)
  expect(await r.owner.stopEpoch(a.binding, Date.now())).toBe(receipt)
})

it('rejects copied ports and isolated child shadow bindings at installation and actual native use', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner), other = installedAccount('b')
  expect(() => { installAccountExecutionPort(other.ctx, { ...a.port }) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => { installAccountExecutionPort(other.ctx, Object.create(a.port) as AccountExecutionPort) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  const shadow = a.ctx.isolate('peAccount')
  shadow.provide('peAccount', { ...a.binding })
  expect(() => shadow.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => shadow.subprocess.spawn(spawnSpec)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  await expect(shadow.plugin(account, { mode: 'closed', requiredCapabilities: [] })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  const shadowPort = a.ctx.isolate('peAccountExecution')
  shadowPort.provide('peAccountExecution', { ...a.port })
  expect(() => shadowPort.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  const foreignChild = other.ctx.isolate('peAccount')
  foreignChild.provide('peAccount', a.binding)
  expect(() => r.owner.bindAccount(foreignChild, a.binding, a.current)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
})

it('rejects provider duplication without stopping the original account and closes it on its actual unload', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner)
  await expect(a.ctx.plugin(account, { mode: 'closed', requiredCapabilities: [] })).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(() => a.ctx.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining(disabled))
  await a.fiber.dispose()
  expect(a.ctx.get('shell')).toBeUndefined()
  expect(a.ctx.get('subprocess')).toBeUndefined()
  expect(await r.owner.stopEpoch(a.binding, Date.now())).toMatchObject({ status: 'confirmed' })
  await expect(a.ctx.plugin(account, { mode: 'closed', requiredCapabilities: [] })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
})

it('lifetime abort closes only its own port and releases its bounded registration capacity', async () => {
  const r = await closedRoot(1), a = await closedAccount(r.owner)
  a.lifetime.abort()
  expect(() => a.ctx.subprocess.spawn(spawnSpec)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(await r.owner.stopEpoch(a.binding, Date.now())).toMatchObject({ status: 'confirmed' })
  const b = installedAccount('b')
  expect(r.owner.bindAccount(b.ctx, b.binding, b.current).binding).toBe(b.binding)
})

it('closes all known registrations before root withdrawal and never adopts unknown work', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner), b = await closedAccount(r.owner, 'b')
  await r.fiber.dispose()
  expect(r.ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(() => { r.owner.assertReady() }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  for (const entry of [a, b]) {
    expect(() => entry.ctx.subprocess.spawn(spawnSpec)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(await r.owner.stopEpoch(entry.binding, Date.now())).toMatchObject({ status: 'confirmed' })
  }
  const unknown = installedAccount('c')
  expect(() => r.owner.bindAccount(unknown.ctx, unknown.binding, unknown.current)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await expect(r.owner.stopEpoch(unknown.binding, Date.now())).rejects.toMatchObject({ code: 'cloud/stale-generation' })
})

it('withdraws the closed coordinator and closes its ports when its actual runtime dependency unloads', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner)
  await r.runtimeFiber.dispose()
  expect(r.ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(() => { r.owner.assertReady() }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => a.ctx.subprocess.spawn(spawnSpec)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(await r.owner.stopEpoch(a.binding, Date.now())).toMatchObject({ status: 'confirmed' })
})

it('fails missing runtime, missing capacity and duplicate root/participant registrations without leftover services', async () => {
  const absent = context()
  await expect(absent.plugin(root, { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 1 })).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(absent.get('peSandboxCoordinator')).toBeUndefined()
  await absent.plugin(PeAccountRuntime, { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  await expect(absent.plugin(root, { mode: 'closed', requiredCapabilities: [] })).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(absent.get('peSandboxCoordinator')).toBeUndefined()
  absent.peAccountRuntime.registerDrainParticipant({ id: 'execution', stopEpoch: async () => { throw new Error('must not be called') } })
  await expect(absent.plugin(root, { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 1 })).rejects.toThrow('Duplicate')
  expect(absent.get('peSandboxCoordinator')).toBeUndefined()
  const r = await closedRoot()
  await expect(r.ctx.plugin(root, { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 1 })).rejects.toThrow('registered')
  expect(() => { r.owner.assertReady() }).not.toThrow()
  const wrongScope = installedAccount('wrong-root')
  await wrongScope.ctx.plugin(PeAccountRuntime, { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  await expect(wrongScope.ctx.plugin(root, { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 1 })).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(wrongScope.ctx.get('peSandboxCoordinator')).toBeUndefined()
})

it('still refuses missing closed mode, nonempty requirements and an account without its actual port', async () => {
  const r = await closedRoot()
  for (const entry of [root, account]) {
    const ctx = context()
    await expect(ctx.plugin(entry, { mode: 'closed', requiredCapabilities: ['argv-collect'] })).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
    expect(ctx.get('shell')).toBeUndefined()
    expect(ctx.get('subprocess')).toBeUndefined()
  }
  const missing = installedAccount()
  await expect(missing.ctx.plugin(account, { mode: 'closed', requiredCapabilities: [] })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(() => { Reflect.apply(root.Config, undefined, [{ mode: 'enabled', requiredCapabilities: [] }]) }).toThrow()
  expect(() => { r.owner.assertReady() }).not.toThrow()
})

it('reports closed capabilities only for the original active native provider pair without consuming or stopping its port', async () => {
  const r = await closedRoot(), a = await closedAccount(r.owner), b = await closedAccount(r.owner, 'b')
  expect(() => { assertClosedAccountExecution(a.ctx) }).not.toThrow()
  expect(() => { assertClosedAccountExecution(b.ctx) }).not.toThrow()
  expect(() => a.ctx.shell.resolve({ command: 'x' })).toThrow(expect.objectContaining(disabled))
  const shadow = a.ctx.isolate('shell')
  shadow.provide('shell', b.ctx.shell)
  expect(() => { assertClosedAccountExecution(shadow) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => { assertClosedAccountExecution(a.ctx) }).not.toThrow()
  await a.fiber.dispose()
  expect(() => { assertClosedAccountExecution(a.ctx) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => { assertClosedAccountExecution(b.ctx) }).not.toThrow()
  b.lifetime.abort()
  expect(() => { assertClosedAccountExecution(b.ctx) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
})

it('refuses a live issued port whose native account provider pair was never installed', async () => {
  const r = await closedRoot(), a = installedAccount()
  const port = r.owner.bindAccount(a.ctx, a.binding, a.current)
  installAccountExecutionPort(a.ctx, port)
  expect(() => { port.assertCurrent(a.ctx) }).not.toThrow()
  expect(() => { assertClosedAccountExecution(a.ctx) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => { port.assertCurrent(a.ctx) }).not.toThrow()
})
