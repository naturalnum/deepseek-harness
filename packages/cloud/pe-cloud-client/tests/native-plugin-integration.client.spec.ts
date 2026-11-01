/** Native manager data source over scripted Cloud RPCs; no account server or browser deployment. */
import { expect, it, vi } from 'vitest'
import { TEST_PLUGIN_ID, pluginFixture } from './plugin-fixtures.client.ts'
import { createNativePluginManagerIntegration } from '../src/client/management/plugins/native-integration.ts'
import type { CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'

function fixture() {
  const abort = new AbortController(), value = pluginFixture('private-edit')
  const bundle = { name: '@example/package', official: false, availability: 'profile' as const, enabled: true,
    installed: true, optional: false, removable: false, overrides: [],
    rows: [{ rowId: TEST_PLUGIN_ID, moduleName: value.plugin.moduleName, entryId: value.plugin.entryId }] }
  const list = vi.fn(async () => ({ ok: true as const, value: { bundles: [bundle], plugins: [value.plugin], controls: [{
    id: value.id, selectionTarget: value.selectionTarget, operations: value.operations,
  }] } }))
  const current = vi.fn(async () => ({ ok: true as const, value }))
  const change = vi.fn<CloudPluginRemote['change']>(async () => ({ ok: true as const, value: { kind: 'applied' as const, value } }))
  const owner = { remote: { cloudPlugins: { list, current, change } } }
  const page = { bootstrap: { capabilities: { configuration: {
    plugins: [{ id: TEST_PLUGIN_ID, toggleable: true, installable: false }],
  } } },
  lifetime: { transport: { signal: abort.signal } },
  assertAccountManagementCurrent: () => { abort.signal.throwIfAborted() } }
  return { source: createNativePluginManagerIntegration(owner as never, page as never), abort, list, current, change }
}

it('reads actual roster, allows only approved entry and submits once through the existing edit owner', async () => {
  const f = fixture(), snapshot = await f.source.read()
  expect(snapshot.plugins).toHaveLength(1)
  expect(f.source.install).toBe(false)
  expect(f.source.canSetEntry('include:' + TEST_PLUGIN_ID)).toBe(true)
  expect(f.source.canSetEntry('include:not-approved')).toBe(false)
  await f.source.setEntry('include:' + TEST_PLUGIN_ID, true)
  expect(f.current).toHaveBeenCalledTimes(1)
  expect(f.change).toHaveBeenCalledTimes(1)
  expect(f.change.mock.calls[0]?.[0]).toMatchObject({ id: TEST_PLUGIN_ID, mode: 'if-idle', operation: { kind: 'enabled', enabled: true } })
  await expect(f.source.setEntry('include:not-approved', true)).rejects.toBeDefined()
  expect(f.change).toHaveBeenCalledTimes(1)
})

it('revokes visible controls after the original page ends', async () => {
  const f = fixture()
  await f.source.read()
  f.abort.abort()
  expect(f.source.canSetEntry('include:' + TEST_PLUGIN_ID)).toBe(false)
  await expect(f.source.setEntry('include:' + TEST_PLUGIN_ID, true)).rejects.toBeDefined()
  expect(f.current).not.toHaveBeenCalled()
})

it('maps configuration only to the exact approved native bundle row', async () => {
  const f = fixture(), snapshot = await f.source.read(), bundle = snapshot.bundles[0]
  if (bundle === undefined) throw new Error('Missing actual bundle')
  const pkg = { name: bundle.name, installed: bundle.installed, availability: bundle.availability,
    official: bundle.official, enabled: bundle.enabled, rows: [] }
  expect(f.source.configurationId({ kind: 'row', pkg, row: { rowId: TEST_PLUGIN_ID,
    moduleName: '@example/' + TEST_PLUGIN_ID, enabled: false } })).toBe(TEST_PLUGIN_ID)
  expect(f.source.configurationId({ kind: 'row', pkg, row: { rowId: TEST_PLUGIN_ID,
    moduleName: '@example/other', enabled: false } })).toBeUndefined()
  expect(f.source.configurationId({ kind: 'bundle', pkg })).toBeUndefined()
})

it('accepts only finite managed Shell limits and clears them before a failed refresh', async () => {
  const abort = new AbortController(), changed = vi.fn()
  const list = vi.fn().mockResolvedValueOnce({ ok: true, value: { bundles: [], plugins: [], controls: [],
    terminal: { timeoutMs: 10, maxTimeoutMs: 20, maxOutputBytes: 30 } } })
    .mockResolvedValueOnce({ ok: true, value: { bundles: [], plugins: [], controls: [],
      terminal: { timeoutMs: 21, maxTimeoutMs: 20, maxOutputBytes: 30 } } })
  const owner = { remote: { cloudPlugins: { list } } }, page = {
    bootstrap: { capabilities: { configuration: { plugins: [] } } }, lifetime: { transport: { signal: abort.signal } },
    assertAccountManagementCurrent: () => { abort.signal.throwIfAborted() },
  }
  const source = createNativePluginManagerIntegration(owner as never, page as never, changed)
  await source.read()
  expect(changed).toHaveBeenLastCalledWith({ timeoutMs: 10, maxTimeoutMs: 20, maxOutputBytes: 30 })
  await expect(source.read()).rejects.toBeDefined()
  expect(changed).toHaveBeenLastCalledWith(undefined)
  abort.abort()
  await expect(source.read()).rejects.toBeDefined()
  expect(list).toHaveBeenCalledTimes(2)
})
