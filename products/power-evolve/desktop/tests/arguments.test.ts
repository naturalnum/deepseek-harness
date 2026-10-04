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

test('packaged startup ignores only numeric Electron debug transport ports', () => {
  for (const port of ['0', '1', '65535']) {
    assert.deepEqual({ ...cloudDesktopArguments(['/PowerEvolve', '--inspect=' + port, '--remote-debugging-port=' + port], '/app', true) }, {})
  }
  assert.deepEqual({ ...cloudDesktopArguments(['/PowerEvolve', '--inspect=0', '--config=/private/deployment.json',
    '--data-dir', '/private/alice', '--remote-debugging-port=65535', '--device-config=/private/device.json'], '/app', true) },
  { config: '/private/deployment.json', 'data-dir': '/private/alice', 'device-config': '/private/device.json' })
})

test('packaged startup rejects missing, invalid and unrelated debug switches', () => {
  for (const name of ['inspect', 'remote-debugging-port']) {
    for (const suffix of ['', '=', '=-1', '=65536', '=1.5', '=0x10', '=localhost:0', '=word']) {
      assert.throws(() => cloudDesktopArguments(['/PowerEvolve', '--' + name + suffix], '/app', true))
    }
    assert.throws(() => cloudDesktopArguments(['/PowerEvolve', '--' + name, '0'], '/app', true))
  }
  for (const value of ['--inspect-brk=0', '--inspect-publish-uid=http', '--unknown=0']) {
    assert.throws(() => cloudDesktopArguments(['/PowerEvolve', value], '/app', true))
  }
})

test('debug transport filtering never accepts positional arguments or changes development parsing', () => {
  assert.throws(() => cloudDesktopArguments(['/PowerEvolve', '--', '--inspect=0'], '/app', true))
  assert.throws(() => cloudDesktopArguments(['/PowerEvolve', '--inspect=0', '/other-app'], '/app', true))
  assert.throws(() => cloudDesktopArguments(['/PowerEvolve', '--config', '--inspect=0'], '/app', true))
  assert.throws(() => cloudDesktopArguments(['/electron', '/app', '--inspect=0'], '/app', false))
})
