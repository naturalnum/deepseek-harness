/** Real Remote metadata mutations shared by the native inventory compatibility regressions. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Remote, remoteMethods, type RemoteMethodMarker } from '@deepseek-ai/dsh-typert-protocol'
import type { ExposurePolicy } from '../src/exposure.ts'
import type { ExposureInventory } from '../src/types.ts'

const markerKey = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface InventoryFixture {
  readonly native: { readonly value: object; inspect(): ExposureInventory }
  readonly upstreamPrototype: object
  readonly policy: ExposurePolicy
  readonly maximum: number
  invokeOriginal(): Promise<unknown>
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}

function markerFixture(value: object, upstream: object) {
  const prototype = Object.getPrototypeOf(value) as object
  const original = Object.getOwnPropertyDescriptor(prototype, markerKey)
  const restorations = [() => { restore(prototype, markerKey, original) }]
  const restoreAll = (): void => {
    for (const undo of restorations.reverse()) undo()
    restorations.length = 0
  }
  onTestFinished(restoreAll)
  const replace = (methods: readonly RemoteMethodMarker[]): void => {
    Object.defineProperty(prototype, markerKey, { configurable: true, value: Object.freeze({
      version: 1, methods: Object.freeze(methods.map(marker => Object.freeze({ ...marker }))),
    }) })
  }
  const add = (method: string, exportName = method) => {
    expect(method in upstream).toBe(false)
    const originalMethod = Object.getOwnPropertyDescriptor(upstream, method)
    restorations.push(() => { restore(upstream, method, originalMethod) })
    const call = vi.fn(() => 'unexposed native result')
    Object.defineProperty(upstream, method, { configurable: true, writable: true, value: call })
    const initializers: Array<(this: object) => void> = []
    Remote(exportName)(call, {
      kind: 'method', name: method, static: false, private: false, metadata: {},
      access: { has: object => method in object, get: object => Reflect.get(object, method) as () => string },
      addInitializer: (initializer) => { initializers.push(initializer) },
    })
    for (const initialize of initializers) initialize.call(value)
    expect(remoteMethods(value)).toContainEqual(expect.objectContaining({ method }))
    expect(Reflect.get(value, method)).toBe(call)
    return call
  }
  const replaceImplementation = (method: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    restorations.push(() => { restore(value, method, descriptor) })
    Object.defineProperty(value, method, { configurable: true, value: vi.fn() })
  }
  return { replace, add, replaceImplementation, restore: restoreAll, read: () => remoteMethods(value) }
}

/** Define compatibility and denial cases over an actual mounted native service.
 * @param namespace Original wire namespace.
 * @param methods Fixed original internal/exported method pairs.
 * @param create Actual native composition and audited exposure, with owned teardown.
 */
export function nativeMethodInventoryTests(
  namespace: string, methods: readonly (readonly [string, string])[], create: () => Promise<InventoryFixture>,
): void {
  const withFixture = async (
    run: (fixture: InventoryFixture, markers: ReturnType<typeof markerFixture>) => void | Promise<void>,
  ): Promise<void> => {
    const f = await create(), markers = markerFixture(f.native.value, f.upstreamPrototype)
    try { await run(f, markers) }
    finally { markers.restore() }
  }
  describe(namespace + ' native method compatibility', () => {
    it('keeps original dispatch and forbids a newly marked native method', () => withFixture(async (f, markers) => {
      const expected = f.native.inspect()
      const call = markers.add('futureInventoryMethod')
      expect(f.native.inspect()).toEqual(expected)
      await f.invokeOriginal()
      expect(() => f.policy.requireRpc(namespace + '/futureInventoryMethod'))
        .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
      expect(call).not.toHaveBeenCalled()
    }))

    it.each(methods)('rejects a missing original marker %s', method => withFixture((f, markers) => {
      markers.replace(markers.read().filter(marker => marker.method !== method))
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    it.each(methods)('rejects a renamed original internal method %s', method => withFixture((f, markers) => {
      markers.replace(markers.read().map(marker => marker.method === method
        ? { ...marker, method: 'renamedNativeMethod' } : marker))
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    it.each(methods)('rejects a changed original export name for %s', method => withFixture((f, markers) => {
      markers.replace(markers.read().map(marker => marker.method === method
        ? { ...marker, exportName: 'renamedNativeExport' } : marker))
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    it.each(methods)('rejects a changed original invocation mode for %s', method => withFixture((f, markers) => {
      markers.replace(markers.read().map(marker => marker.method === method
        ? { ...marker, mode: 'stream' as const } : marker))
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    it.each(methods)('rejects a duplicate original internal marker %s', method => withFixture((f, markers) => {
      const original = markers.read().find(marker => marker.method === method)
      if (original === undefined) throw new Error('The original native marker is missing from the fixture.')
      markers.replace([...markers.read(), { ...original, exportName: 'duplicateNativeExport' }])
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    it.each(methods)('rejects a replaced original implementation for %s', method => withFixture((f, markers) => {
      markers.replaceImplementation(method)
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))

    for (const position of ['before', 'after'] as const) {
      it.each(methods)(
        'rejects an added Remote alias ' + position + ' the original export of %s',
        (_method, exportName) => withFixture((f, markers) => {
          const call = markers.add('futureInventoryAlias', exportName)
          const original = markers.read().filter(marker => marker.method !== 'futureInventoryAlias')
          const alias = markers.read().find(marker => marker.method === 'futureInventoryAlias')
          if (alias === undefined) throw new Error('The added native alias was not marked.')
          markers.replace(position === 'before' ? [alias, ...original] : [...original, alias])
          expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
          expect(call).not.toHaveBeenCalled()
        }),
      )
    }

    it('retains the existing finite method inventory bound', () => withFixture((f, markers) => {
      const added = f.maximum - markers.read().length
      for (let index = 0; index < added; index++) markers.add('futureInventory' + index)
      expect(f.native.inspect()).toEqual(expect.objectContaining({ recipeVersion: f.policy.manifest.recipeVersion }))
      markers.add('futureInventoryOverflow')
      expect(() => f.native.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    }))
  })
}
