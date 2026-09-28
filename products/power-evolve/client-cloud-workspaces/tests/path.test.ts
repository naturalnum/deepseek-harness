import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudWorkspaceTitlePath } from '../src/client/path.ts'

test('title is carried as a canonical opaque workspace/create path', () => {
  assert.equal(cloudWorkspaceTitlePath('  项目 A  '), 'power-evolve-cloud-title:%E9%A1%B9%E7%9B%AE%20A')
  for (const title of ['', ' '.repeat(10), 'x'.repeat(81), 'bad\nname']) {
    assert.throws(() => cloudWorkspaceTitlePath(title))
  }
})
