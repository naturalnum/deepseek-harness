import { TEST_PLUGIN_ID, TEST_BUNDLE_ID, pluginFixture, bundleFixture } from './plugin-fixtures.client.ts'
/** Actual generated request types with scripted external replies; no real account or native save is invoked. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { prepareAccountPluginEdit, type CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'
import { pluginCardFromCurrent } from '../src/client/management/plugins/current-card.ts'

type Changed = Extract<Awaited<ReturnType<CloudPluginRemote['change']>>, { ok: true }>['value']
const state = pluginFixture
function fixture() {
  const original = state('original'), lifetime = new AbortController(), observer = new AbortController()
  const current = vi.fn<CloudPluginRemote['current']>(async () => ({ ok: true, value: original }))
  const change = vi.fn<CloudPluginRemote['change']>(async () => ({ ok: true, value: { kind: 'applied', value: state('next', true) } }))
  const remote: CloudPluginRemote = { current, change }
  return { original, lifetime, observer, current, change, remote, admission: { signal: lifetime.signal, assertCurrent: vi.fn() } }
}

it('captures the original read version across metadata refresh and waits for the owner-confirmed applied reply', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  expect(edit.state).not.toHaveProperty('version')
  f.current.mockResolvedValue({ ok: true, value: state('refresh-token') })
  await f.remote.current({ id: TEST_PLUGIN_ID }, f.observer.signal)
  const gate = Promise.withResolvers<Awaited<ReturnType<CloudPluginRemote['change']>>>()
  f.change.mockReturnValue(gate.promise)
  const pending = edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)
  expect(f.change).toHaveBeenCalledExactlyOnceWith({ id: TEST_PLUGIN_ID, version: f.original.version,
    mode: 'if-idle', operation: { kind: 'enabled', enabled: true } }, expect.any(AbortSignal))
  expect(edit.state.plugin?.enabled).toBe(false)
  gate.resolve({ ok: true, value: { kind: 'applied', value: state('owner-confirmed', true) } })
  expect(await pending).toMatchObject({ kind: 'applied', state: { plugin: { enabled: true } } })
  expect(edit.state.plugin?.enabled).toBe(false)
  await expect(edit.submit({ kind: 'enabled', enabled: false }, 'if-idle', f.observer.signal)).rejects.toThrow()
  expect(f.current).toHaveBeenCalledTimes(2); expect(f.change).toHaveBeenCalledOnce()
})

it('preserves accepted rebuild as acceptance without applying or refreshing the displayed native state', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  const operationId = brandString<Extract<Changed, { kind: 'accepted-rebuild' }>['operationId']>('test-rebuild')
  f.change.mockResolvedValue({ ok: true, value: { kind: 'accepted-rebuild', operationId } })
  expect(await edit.submit({ kind: 'configure', path: ['limits', 'steps'], value: [1, 2] }, 'stop-and-apply', f.observer.signal)).toEqual({ kind: 'accepted-rebuild', operationId })
  expect(edit.state.configuration.fields[0]?.value).toEqual([3, 5, 8])
  expect(f.current).toHaveBeenCalledOnce(); expect(f.change).toHaveBeenCalledOnce()
})

it('consumes a conflicted edit without rereading a replacement version or retrying the operation', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  f.change.mockResolvedValue({ ok: false, error: new RemoteError('cloud/config-conflict', 'test conflict', {}) })
  expect(await edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).toEqual({ kind: 'conflict' })
  await expect(edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).rejects.toThrow()
  expect(f.current).toHaveBeenCalledOnce(); expect(f.change).toHaveBeenCalledOnce()
})

it('reports unknown after observer loss and never converts a late backend result into optimistic state', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  const gate = Promise.withResolvers<Awaited<ReturnType<CloudPluginRemote['change']>>>()
  f.change.mockReturnValue(gate.promise)
  const pending = edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)
  f.observer.abort()
  gate.resolve({ ok: true, value: { kind: 'applied', value: state('late', true) } })
  expect(await pending).toEqual({ kind: 'unknown' })
  expect(edit.state.plugin?.enabled).toBe(false)
  await expect(edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', new AbortController().signal)).rejects.toThrow()
  expect(f.current).toHaveBeenCalledOnce(); expect(f.change).toHaveBeenCalledOnce()
})

it('projects only the qualified account current result and does not manufacture a published package version', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  const card = pluginCardFromCurrent(edit.state, { title: 'Test reminder', description: 'Test metadata' },
    { toggle: 'available', configuration: 'not-connected' }, { id: TEST_PLUGIN_ID, installable: true, toggleable: true })
  expect(card).toMatchObject({ id: TEST_PLUGIN_ID, installed: true, enabled: false, version: null,
    toggle: 'available', configuration: 'not-connected' })
  expect(card).not.toHaveProperty('editToken')
})

it('preserves a wire busy refusal without certifying a write outcome or retrying the consumed edit', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  f.change.mockResolvedValue({ ok: false, error: new RemoteError('cloud/config-busy', 'The original account still owns non-observation Peer work.', {}) })
  expect(await edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).toEqual({ kind: 'busy' })
  expect(edit.state.plugin?.enabled).toBe(false)
  await expect(edit.submit({ kind: 'enabled', enabled: true }, 'stop-and-apply', f.observer.signal)).rejects.toThrow()
  expect(f.current).toHaveBeenCalledOnce(); expect(f.change).toHaveBeenCalledOnce()
})

it.each(['cloud/account-unavailable', 'cloud/stale-generation', 'gateway/internal', 'gateway/cancelled'] as const)(
  'keeps an actual %s response unknown rather than guessing busy from its message', async (code) => {
    const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
    f.change.mockResolvedValue({ ok: false, error: new RemoteError(code, 'The original account still owns non-observation Peer work.', {}) })
    expect(await edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).toEqual({ kind: 'unknown' })
    expect(f.change).toHaveBeenCalledOnce()
  },
)

it('keeps a thrown busy-shaped transport exception unknown', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  f.change.mockRejectedValue(new RemoteError('cloud/config-busy', 'Scripted thrown carrier failure', {}))
  expect(await edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).toEqual({ kind: 'unknown' })
  expect(f.change).toHaveBeenCalledOnce()
})

it('rejects a current or applied response for another approved identity', async () => {
  const f = fixture()
  f.current.mockResolvedValueOnce({ ok: true, value: pluginFixture('other', false, 10, 'other-plugin') })
  await expect(prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)).rejects.toThrow()
  const edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  f.change.mockResolvedValueOnce({ ok: true, value: { kind: 'applied', value: pluginFixture('other', true, 10, 'other-plugin') } })
  expect(await edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).toEqual({ kind: 'unknown' })
  expect(f.change).toHaveBeenCalledOnce()
})
it('rejects undeclared operations and field paths before sending, consuming each original attempt', async () => {
  const f = fixture(), edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  await expect(edit.submit({ kind: 'configure', path: ['other'], value: 2 }, 'if-idle', f.observer.signal)).rejects.toThrow()
  await expect(edit.submit({ kind: 'enabled', enabled: true }, 'if-idle', f.observer.signal)).rejects.toThrow()
  expect(f.change).not.toHaveBeenCalled()
  const another = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  await expect(another.submit({ kind: 'selected', selected: true }, 'if-idle', f.observer.signal)).rejects.toThrow()
  expect(f.change).not.toHaveBeenCalled()
})
it('preserves actual preinstalled bundle facts and selects through the original version without an entry', async () => {
  const f = fixture(), original = bundleFixture('bundle', true)
  f.current.mockResolvedValueOnce({ ok: true, value: original })
  const edit = await prepareAccountPluginEdit(f.remote, TEST_BUNDLE_ID, f.admission, f.observer.signal)
  const card = pluginCardFromCurrent(edit.state, { title: 'Bundle', description: 'Native bundle metadata' },
    { toggle: 'available', configuration: 'available' }, { id: TEST_BUNDLE_ID, installable: true, toggleable: false })
  expect(card).toMatchObject({ installable: true, installed: false, enabled: null, selected: true, toggle: 'available',
    availability: 'installation', moduleName: null, version: '1.2.3',
    selectionTarget: { kind: 'bundle', name: '@example/preinstalled-tools' }, operations: ['selected'], maxImpact: 'graph' })
  expect(edit.state).not.toHaveProperty('plugin')
  f.change.mockResolvedValueOnce({ ok: true, value: { kind: 'accepted-rebuild',
    operationId: brandString<Extract<Changed, { kind: 'accepted-rebuild' }>['operationId']>('bundle-rebuild') } })
  expect(await edit.submit({ kind: 'selected', selected: false }, 'stop-and-apply', f.observer.signal)).toMatchObject({ kind: 'accepted-rebuild' })
  expect(f.change.mock.calls[0]?.[0]).toMatchObject({ id: TEST_BUNDLE_ID,
    operation: { kind: 'selected', selected: false }, version: original.version })
})
it('uses the native protected-field metadata and never stages redacted container values as secret input', async () => {
  const f = fixture(), original = state('secret')
  f.current.mockResolvedValueOnce({ ok: true, value: { ...original, configuration: { fields: [{ path: ['auth'],
    schema: { type: 'object', properties: { token: { type: 'string', 'x-cordis': { role: 'secret' } } } },
    writable: false, readOnlyReason: 'protected', secrets: [{ path: ['token'], set: true }],
    acceptsMissing: true, limitations: [], value: { visible: 1 } }] } } })
  const edit = await prepareAccountPluginEdit(f.remote, TEST_PLUGIN_ID, f.admission, f.observer.signal)
  expect(edit.state.configuration.fields[0]).not.toHaveProperty('value')
  expect(edit.state.configuration.fields[0]?.secrets).toEqual([{ path: ['token'], set: true }])
  await expect(edit.submit({ kind: 'configure', path: ['auth'], value: {} }, 'if-idle', f.observer.signal)).rejects.toThrow()
  expect(f.change).not.toHaveBeenCalled()
})

it.each(['missing', 'both', 'wrong-name'] as const)('refuses %s native bundle facts without constructing a disabled entry', async (invalid) => {
  const f = fixture(), original = bundleFixture('invalid')
  const { bundle: _bundle, ...withoutBundle } = original
  const value = invalid === 'missing' ? withoutBundle : invalid === 'both' ? { ...original, plugin: state('entry').plugin }
    : { ...original, bundle: { ...original.bundle, name: '@example/other-bundle' } }
  f.current.mockResolvedValueOnce({ ok: true, value })
  await expect(prepareAccountPluginEdit(f.remote, TEST_BUNDLE_ID, f.admission, f.observer.signal)).rejects.toThrow()
  expect(f.change).not.toHaveBeenCalled()
})
it.each(['installation', 'profile', 'missing'] as const)('preserves native %s availability, dependency and version independently', async (availability) => {
  const f = fixture(), original = bundleFixture('native-facts', false, TEST_BUNDLE_ID,
    { availability, installed: true, version: '9.8.7' })
  f.current.mockResolvedValueOnce({ ok: true, value: original })
  const edit = await prepareAccountPluginEdit(f.remote, TEST_BUNDLE_ID, f.admission, f.observer.signal)
  const card = pluginCardFromCurrent(edit.state, { title: 'Native bundle', description: 'Native metadata' },
    { toggle: 'available', configuration: 'available' }, { id: TEST_BUNDLE_ID, installable: true, toggleable: false })
  expect(card).toMatchObject({ installed: true, selected: false, enabled: null, moduleName: null,
    version: '9.8.7', availability, toggle: availability === 'missing' ? 'not-installed' : 'available' })
})
