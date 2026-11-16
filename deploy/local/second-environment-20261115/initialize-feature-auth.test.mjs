/** Trusted initializer origins retain loopback and HTTPS policy while supporting isolated localhost sites. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { protectedAuthInitializationOrigin } from './initialize-feature-auth.mjs'
for (const value of ['http://localhost:32803', 'http://127.0.0.1:32803', 'http://[::1]:32803',
  'http://console.auth.pe010.localhost:32803', 'http://text.auth.pe010.localhost:32803',
  'https://console.example.test']) {
  test('accepts the canonical protected origin ' + value, () => {
    assert.equal(protectedAuthInitializationOrigin(value).origin, value)
  })
}
for (const value of ['http://example.test', 'http://localhost.example.test', 'http://localhost.evil', 'http://evil-localhost',
  'http://127.evil', 'http://127.0.0.1.evil', 'http://evil-localhost.test',
  'http://console.auth.pe010.localhost.evil.test', 'ftp://localhost:32803',
  'http://console.auth.pe010.localhost:32803/path', 'http://user:password@localhost:32803',
  'http://LOCALHOST:32803', 'http://localhost:32803/']) {
  test('rejects a noncanonical or nonlocal HTTP origin ' + value, () => {
    assert.throws(() => protectedAuthInitializationOrigin(value))
  })
}
