/** Product arguments stay separate from Electron-owned debugging switches. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudDesktopArguments } from '../src/arguments.ts'
test('parses product flags after an Electron application directory', () => {
  const args = ['/electron', '--remote-debugging-port=0', '/app/', '--config', '/private/deployment.json', '--data-dir', '/private/alice']
  assert.deepEqual({ ...cloudDesktopArguments(args, '/app', false) }, { config: '/private/deployment.json', 'data-dir': '/private/alice' })
  assert.deepEqual({ ...cloudDesktopArguments(['/PowerEvolve', '--config=/private/deployment.json'], '/app', true) }, { config: '/private/deployment.json' })
  assert.deepEqual({ ...cloudDesktopArguments(['/electron', '/app', '--device-config', '/private/device.json'], '/app', false) },
    { 'device-config': '/private/device.json' })
  assert.throws(() => cloudDesktopArguments(['/electron', '/other-app', '--config', '/private/deployment.json'], '/app', false))
  assert.throws(() => cloudDesktopArguments(['/electron', '/app', '--unknown'], '/app', false))
})
