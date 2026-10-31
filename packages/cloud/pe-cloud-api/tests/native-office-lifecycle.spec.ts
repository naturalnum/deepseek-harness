/** Real native Office provider, account adapter, Cordis fibers and logger; only the external kit is substituted. */
import { chmod, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import OfficeToPdf, { Config, OfficeSourceKey, type OfficeToPdfRequest } from '@deepseek-ai/dsh-office-to-pdf'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { onTestFinished, expect, it, vi } from 'vitest'
import { createNativeOffice, type NativeOffice } from '../src/native-office.ts'

type Render = (request: { inputPath: string; outputPath: string }, signal?: AbortSignal) => Promise<{ backend: 'wasm'; missingFonts: string[] }>
type ConverterFixture = {
  backend: 'wasm'
  render: Render
  dispose: () => Promise<void>
  renderImages: () => Promise<never>
  convert: () => Promise<never>
  recalculate: () => Promise<never>
}
const kit = vi.hoisted(() => ({ create: vi.fn<(options?: unknown) => Promise<ConverterFixture>>() }))
vi.mock('../../../document/office-to-pdf/node_modules/@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))
const pdf = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')
const bytes = new Uint8Array([80, 75, 3, 4])
const request: OfficeToPdfRequest = { extension: 'docx', priority: 'foreground', source: {
  key: OfficeSourceKey('original'), version: '1', bytes: bytes.length,
  read: async () => ({ bytes, version: '1' }),
} }

async function fixture(render: Render, dispose: () => Promise<void> = async () => {}, files: object = {}): Promise<{
  ctx: Context
  native: NativeOffice
  close: () => Promise<void>
  abortBinding: () => void
  officeOwner: Context
}> {
  kit.create.mockReset().mockResolvedValue({ backend: 'wasm', render, dispose,
    renderImages: vi.fn<() => Promise<never>>(), convert: vi.fn<() => Promise<never>>(), recalculate: vi.fn<() => Promise<never>>() })
  const ctx = new Context(), lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>('office-lifecycle-fixture'),
    epoch: brandString<OwnerEpoch>('1'), recipeVersion: 'office-lifecycle', lifetime: lifetime.signal })
  await ctx.plugin(TypertRegistry)
  ctx.provide('peAccount', binding)
  await ctx.plugin({ apply(owner: Context) {
    owner.provide('fs', {} as never)
    owner.provide('workspaceFiles', files as never)
  } })
  let native: NativeOffice | undefined
  let officeOwner: Context | undefined
  await ctx.plugin({ inject: ['fs', 'workspaceFiles', 'typert', 'peAccount'], apply(owner: Context) {
    officeOwner = owner
    native = createNativeOffice(owner, binding, () => { if (lifetime.signal.aborted) throw new Error('closed binding') },
      512, Config({ maxConcurrentConversions: 1, maxReaders: 1 }), () => {})
  } })
  if (native === undefined || officeOwner === undefined) throw new Error('Native Office fixture did not mount')
  const close = async (): Promise<void> => { lifetime.abort(); await ctx.fiber.dispose() }
  onTestFinished(close)
  return { ctx, native, close, abortBinding: () => { lifetime.abort() }, officeOwner }
}

it('keeps the native reader and scratch until conversion settles after observer cancellation', async () => {
  const started = Promise.withResolvers<string>(), gate = Promise.withResolvers<undefined>()
  const dispose = vi.fn(async () => {})
  const f = await fixture(async ({ inputPath, outputPath }) => {
    started.resolve(dirname(inputPath))
    await gate.promise
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  }, dispose)
  const abort = new AbortController(), original = f.native.value.convert(request, abort.signal)
  const cancelled = original.then(() => { throw new Error('conversion unexpectedly completed') }, (error: unknown) => error)
  try {
    const scratch = await Promise.race([started.promise, cancelled.then((error) => { throw error })])
    abort.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect((await stat(scratch)).isDirectory()).toBe(true)
    expect(f.native.isIdle()).toBe(false)
    let stopped = false
    const stop = f.native.stop(Date.now() + 2_000).then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    expect(dispose).not.toHaveBeenCalled()
    gate.resolve(undefined)
    await stop
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(dispose).not.toHaveBeenCalled()
    await f.ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  } finally { gate.resolve(undefined) }
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'retains an actual native scratch removal failure after the observer cancelled', async () => {
    const started = Promise.withResolvers<string>(), gate = Promise.withResolvers<undefined>()
    const f = await fixture(async ({ inputPath, outputPath }) => {
      const scratch = dirname(inputPath)
      started.resolve(scratch)
      await gate.promise
      await writeFile(outputPath, pdf)
      await chmod(scratch, 0o500)
      return { backend: 'wasm', missingFonts: [] }
    })
    const abort = new AbortController(), original = f.native.value.convert(request, abort.signal)
    const cancelled = original.then(() => { throw new Error('conversion unexpectedly completed') }, (error: unknown) => error)
    let scratch: string | undefined
    try {
      scratch = await Promise.race([started.promise, cancelled.then((error) => { throw error })])
      abort.abort()
      expect(await cancelled).toMatchObject({ name: 'AbortError' })
      const stop = f.native.stop(Date.now() + 2_000)
      const rejected = expect(stop).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
      gate.resolve(undefined)
      await rejected
      expect((await stat(scratch)).isDirectory()).toBe(true)
      await expect(f.native.value.convert(request)).rejects.toBeDefined()
      expect(f.native.isIdle()).toBe(false)
    } finally {
      gate.resolve(undefined)
      if (scratch !== undefined) { await chmod(scratch, 0o700).catch(() => {}); await rm(scratch, { recursive: true, force: true }) }
    }
  },
)

it('records a converter disposer failure through the real Cordis fiber logger', async () => {
  const dispose = vi.fn(async () => { throw new Error('kit disposer failed') })
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  }, dispose)
  const observer = new Context()
  observer.logger = f.ctx.logger
  let errors = 0
  observer.logger.exporter({ levels: { default: 1 }, export(message) { if (message.type === 'error') errors++ } })
  try {
    await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
    await expect(f.native.stop(Date.now() + 2_000)).resolves.toBeUndefined()
    expect(dispose).not.toHaveBeenCalled()
    await f.ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    // The real native-boot owner maps any observed error event to unknown.
    expect(errors).toBeGreaterThan(0)
  } finally { await observer.fiber.dispose() }
})

it('retains original Office Remote implementations and exact account guards', async () => {
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  expect(Reflect.get(f.native.value, 'render')).toBe(Reflect.get(OfficeToPdf.prototype, 'render'))
  expect(Reflect.get(f.native.value, 'getGeneration')).toBe(Reflect.get(OfficeToPdf.prototype, 'getGeneration'))
  expect(f.native.inspect().rpcEndpoints).toEqual(expect.arrayContaining([
    { endpoint: 'officeToPdf/render', handlerId: 'native:officeToPdf', guard: 'account-session' },
    { endpoint: 'officeToPdf/generation', handlerId: 'native:officeToPdf', guard: 'authenticated-account' },
  ]))
  await expect(f.native.stop(Date.now() + 2_000)).resolves.toBeUndefined()
})

it('observes Office ordered stop when the parent account root is already disposing', async () => {
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
  const stop = Promise.withResolvers<{ status: 'confirmed' | 'unknown'; rootState: FiberState }>()
  f.ctx.effect(() => async () => {
    const rootState = f.ctx.fiber.state
    try { await f.native.stop(Date.now() + 2_000); stop.resolve({ status: 'confirmed', rootState }) }
    catch { stop.resolve({ status: 'unknown', rootState }) }
  }, 'fixture: account ordered stop during parent disposal')
  await f.ctx.fiber.dispose()
  const result = await stop.promise
  expect(result).toEqual({ status: 'unknown', rootState: FiberState.UNLOADING })
})

it('stops Office before disposing its separate account root when the application root shuts down', async () => {
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
  const application = new Context()
  const stop = Promise.withResolvers<{ status: 'confirmed' | 'unknown'; accountState: FiberState }>()
  await application.plugin({ apply(owner: Context) {
    owner.effect(() => async () => {
      const accountState = f.ctx.fiber.state
      try { await f.native.stop(Date.now() + 2_000); stop.resolve({ status: 'confirmed', accountState }) }
      catch { stop.resolve({ status: 'unknown', accountState }) }
    })
  } })
  await application.fiber.dispose()
  expect(await stop.promise).toEqual({ status: 'confirmed', accountState: FiberState.ACTIVE })
})

it('stops cleanly when the account binding is aborted before its still-active provider fiber', async () => {
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
  f.abortBinding()
  expect(f.ctx.fiber.state).toBe(FiberState.ACTIVE)
  await expect(f.native.stop(Date.now() + 2_000)).resolves.toBeUndefined()
})

it('does not create account error logs while successful Office cleanup runs in the unloading fiber', async () => {
  let observedOfficeState: FiberState | undefined
  const officeOwner = Promise.withResolvers<Context>()
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  }, async () => { observedOfficeState = (await officeOwner.promise).fiber.state })
  officeOwner.resolve(f.officeOwner)
  const observer = new Context()
  observer.logger = f.ctx.logger
  let errors = 0
  observer.logger.exporter({ levels: { default: 1 }, export(message) { if (message.type === 'error') errors++ } })
  try {
    await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
    await expect(f.native.stop(Date.now() + 2_000)).resolves.toBeUndefined()
    expect(observedOfficeState).toBeUndefined()
    expect(errors).toBe(0)
    await f.ctx.fiber.dispose()
    expect(observedOfficeState).toBe(FiberState.UNLOADING)
    expect(errors).toBe(0)
  } finally { await observer.fiber.dispose() }
})


it('retains an external Office fiber withdrawal as unknown', async () => {
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  })
  await expect(f.native.value.convert(request)).resolves.toMatchObject({ pdf: Uint8Array.from(pdf) })
  await f.officeOwner.fiber.dispose()
  await expect(f.native.stop(Date.now() + 2_000)).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
  await expect(f.native.value.convert(request)).rejects.toBeDefined()
})

it('retains a pre-conversion native render read in account disposal after Office conversion stop', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const files = { async readBytes() {
    entered.resolve(undefined)
    await release.promise
    throw new Error('fixture original file read settled')
  } }
  const f = await fixture(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'wasm', missingFonts: [] }
  }, async () => {}, files)
  const render = f.native.value.render({ sessionId: 'fixture-session', workspaceRoot: '/fixture' } as never,
    'report.docx', 'foreground', new AbortController().signal)
  const result = render.then(() => 'unexpected success', () => 'rejected')
  let accountDispose: Promise<void> | undefined
  try {
    await entered.promise
    expect(kit.create).not.toHaveBeenCalled()
    expect(f.native.isIdle()).toBe(true)
    await expect(f.native.stop(Date.now() + 2_000)).resolves.toBeUndefined()
    let disposed = false
    accountDispose = f.ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    release.resolve(undefined)
    expect(await result).toBe('rejected')
    await accountDispose
    expect(disposed).toBe(true)
    expect(kit.create).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await accountDispose?.catch(() => {}) }
})
