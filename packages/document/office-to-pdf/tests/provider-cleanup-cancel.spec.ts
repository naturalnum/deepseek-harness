/** An abandoned caller does not release the provider's scratch ownership. */
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Converter } from '@deepseek-ai/libreoffice-kit'
import { expect, it, vi } from 'vitest'
import OfficeToPdf, { OfficeSourceKey } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, rm: vi.fn(original.rm) }
})
const kit = vi.hoisted(() => ({ create: vi.fn<() => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

it('closes the provider when cleanup fails after the caller has already cancelled', async () => {
  const ctx = new Context()
  const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const entered = Promise.withResolvers<string>(), release = Promise.withResolvers<void>()
  const render = vi.fn<Converter['render']>().mockImplementation(async ({ inputPath, outputPath }) => {
    entered.resolve(dirname(inputPath))
    await release.promise
    await fs.writeFile(outputPath, '%PDF-1.7\n%%EOF\n')
    return { backend: 'wasm', missingFonts: [] }
  })
  kit.create.mockResolvedValue({ backend: 'wasm', render, dispose: vi.fn().mockResolvedValue(undefined),
    renderImages: vi.fn(), convert: vi.fn(), recalculate: vi.fn() })
  await ctx.plugin(OfficeToPdf)
  const bytes = new Uint8Array([80, 75, 3, 4])
  const request = { extension: 'docx' as const, priority: 'foreground' as const,
    source: { key: OfficeSourceKey('cancelled'), version: 'v1', bytes: bytes.length,
      read: async () => ({ bytes, version: 'v1' }) } }
  const caller = new AbortController(), provider = ctx.officeToPdf
  const work = provider.convert(request, caller.signal)
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  const scratch = await entered.promise
  vi.mocked(fs.rm).mockRejectedValueOnce(Object.assign(new Error('scratch removal failed'), { code: 'EIO' }))
  caller.abort()
  await rejected
  let disposed = false
  const closing = ctx.fiber.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.resolve()
  await vi.waitFor(() => { expect(logged).toHaveBeenCalled() })
  await closing
  await expect(provider.convert(request)).rejects.toMatchObject({ code: 'unavailable' })
  expect(vi.mocked(fs.rm)).toHaveBeenCalledTimes(1)
  await fs.rm(scratch, { recursive: true, force: true })
})
