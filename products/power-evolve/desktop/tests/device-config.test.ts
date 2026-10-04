/** Development runtime JSON refuses remote endpoints and renderer-selected credentials. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDesktopDeviceConfig } from '../src/device-config.ts'

const config = {
  nodeExecutable: '/private/runtime/node', cliEntrypoint: '/private/runtime/dsh/lib/bin.js',
  homeDir: '/private/device/home', workingDir: '/private/device/project', profile: 'power-evolve-device',
  loopbackOrigin: 'http://127.0.0.1:20891/', startupTimeoutMs: 30000, requestTimeoutMs: 3000,
  quiesceTimeoutMs: 30000, exitTimeoutMs: 10000, maxOutputBytes: 65536, maxMessageBytes: 262144, maxHealthBytes: 4096,
}
test('requires an explicit local runtime without environment fields', () => {
  assert.deepEqual(parseDesktopDeviceConfig(config), { ...config, loopbackOrigin: 'http://127.0.0.1:20891' })
  for (const value of [null, {}, { ...config, env: { TOKEN: 'not-a-real-token' } },
    { ...config, nodeExecutable: 'node' }, { ...config, cliEntrypoint: './bin.js' },
    { ...config, homeDir: '../home' }, { ...config, profile: '../../other' }]) {
    assert.throws(() => parseDesktopDeviceConfig(value))
  }
})
test('refuses ambiguous endpoints and unbounded lifecycle budgets', () => {
  for (const loopbackOrigin of ['http://localhost:20891', 'https://device.example', 'http://127.0.0.1',
    'http://user:pass@127.0.0.1:20891', 'http://127.0.0.1:20891/api',
    'http://127.0.0.1:20891/?token=x', 'http://127.0.0.1:20891/#x']) {
    assert.throws(() => parseDesktopDeviceConfig({ ...config, loopbackOrigin }))
  }
  for (const field of ['startupTimeoutMs', 'requestTimeoutMs', 'quiesceTimeoutMs', 'exitTimeoutMs']) {
    for (const value of [0, 1.5, 180001]) assert.throws(() => parseDesktopDeviceConfig({ ...config, [field]: value }))
  }
  for (const field of ['maxOutputBytes', 'maxMessageBytes', 'maxHealthBytes']) {
    for (const value of [0, 1023, 1048577]) assert.throws(() => parseDesktopDeviceConfig({ ...config, [field]: value }))
  }
})
