/** Deployment parsing and exact document authorization without an Electron substitute. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowsCloudHost, allowsCloudNavigation, nativeCloudDestination, parseCloudDesktopConfig } from '../src/config.ts'
import { cloudDesktopPartition } from '../src/partition.ts'
const config = { hostOrigin: 'http://127.0.0.1:20880', platformOrigin: 'http://127.0.0.1:20881' }
test('requires explicit distinct safe deployment origins', () => {
  assert.deepEqual(parseCloudDesktopConfig(config), config)
  assert.deepEqual(parseCloudDesktopConfig({ hostOrigin: 'https://host.example', platformOrigin: 'https://platform.example/' }),
    { hostOrigin: 'https://host.example', platformOrigin: 'https://platform.example' })
  for (const value of [null, [], { ...config, token: 'invalid' }, { ...config, hostOrigin: config.platformOrigin }]) {
    assert.throws(() => parseCloudDesktopConfig(value))
  }
  for (const hostOrigin of ['http://host.example', 'http://localhost:20880', 'file:///native/', 'https://user:pass@host.example',
    `${config.hostOrigin}/native/`, `${config.hostOrigin}/?x=1`, `${config.hostOrigin}/#x`]) {
    assert.throws(() => parseCloudDesktopConfig({ ...config, hostOrigin }))
  }
})
test('shares storage only within the same deployment', () => {
  const partition = cloudDesktopPartition(config)
  assert.equal(cloudDesktopPartition({ ...config }), partition)
  assert.notEqual(cloudDesktopPartition({ ...config, hostOrigin: 'http://127.0.0.1:20882' }), partition)
  assert.notEqual(cloudDesktopPartition({ ...config, platformOrigin: 'http://127.0.0.1:20883' }), partition)
})
test('native sidebar browser requires explicit bounded timing and rejects incomplete or extra settings', () => {
  const sidebarBrowser = { scopeRequestTimeoutMs: 5000, scopeRecheckIntervalMs: 15000 }
  assert.deepEqual(parseCloudDesktopConfig({ ...config, sidebarBrowser }), { ...config, sidebarBrowser })
  for (const invalid of [null, {}, [], { ...sidebarBrowser, token: 'invalid' },
    ...[0, -1, 1.5, NaN, Infinity, 2_147_483_648, '5000'].map(scopeRequestTimeoutMs => ({ ...sidebarBrowser, scopeRequestTimeoutMs })),
    { scopeRequestTimeoutMs: 5000 }, { ...sidebarBrowser, scopeRecheckIntervalMs: 0 }]) {
    assert.throws(() => parseCloudDesktopConfig({ ...config, sidebarBrowser: invalid }))
  }
})
test('allows only fixed native and trusted login navigation', () => {
  for (const value of [`${config.hostOrigin}/native/`, `${config.platformOrigin}/login`, `${config.platformOrigin}/account#password`]) {
    assert(allowsCloudNavigation(config, value))
  }
  assert(allowsCloudHost(config, `${config.hostOrigin}/native/`))
  assert(!allowsCloudHost(config, `${config.platformOrigin}/login`))
  for (const value of ['https://host.example/native/', 'http://127.0.0.1:20882/native/', 'http://127.0.0.1.evil/native/',
    'data:text/html,hi', 'javascript:alert(1)', 'file:///tmp/a', 'dsh-app://app/', 'invalid',
    `${config.hostOrigin}/identity/login`, `${config.platformOrigin}/identity/login`,
    'http://user:pass@127.0.0.1:20880/native/']) {
    assert(!allowsCloudNavigation(config, value), value)
    assert(!allowsCloudHost(config, value), value)
  }
  assert.equal(nativeCloudDestination(config, `${config.hostOrigin}/`), `${config.hostOrigin}/native/`)
  assert.equal(nativeCloudDestination(config, `${config.platformOrigin}/login`), `${config.platformOrigin}/login`)
})
