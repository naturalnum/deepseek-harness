/** Optional first-screen deployment inputs remain explicit and bounded; parsing grants no native ready state. */
import { expect, it } from 'vitest'
import { RuntimeRootConfigSchema } from '../src/root-config.ts'
import { rootConfig } from './root-control-fixture.ts'

it('preserves old native configuration while requiring every selected first-screen budget without defaults', () => {
  const config = rootConfig('/first-screen-config-component')
  expect(RuntimeRootConfigSchema(config).native.firstScreen).toBeUndefined()
  const firstScreen = { maxHomeBytes: 4096, maxCollectionItems: 16, maxFrameBytes: 65536,
    maxQueuedEvents: 16, maxQueuedBytes: 131072 }
  const selected = { ...config, native: { ...config.native, firstScreen } }
  expect(RuntimeRootConfigSchema(selected).native.firstScreen).toEqual(firstScreen)
  for (const key of Object.keys(firstScreen)) {
    const absent = { ...firstScreen }
    Reflect.deleteProperty(absent, key)
    expect(() => RuntimeRootConfigSchema({ ...selected, native: { ...selected.native, firstScreen: absent } })).toThrow()
    for (const value of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => RuntimeRootConfigSchema({ ...selected, native: { ...selected.native,
        firstScreen: { ...firstScreen, [key]: value },
      } })).toThrow()
    }
  }
})
