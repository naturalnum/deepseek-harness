/** Native creation transport keeps the explicit mutation identity and canonical relative target. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceCreateSelection } from '@power-evolve/contracts/workspace-binding'
import { cloudWorkspaceSelectionPath } from '../src/client/path.ts'

const requestId = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
test('native Workspace creation encodes new and existing private directory selections', () => {
  for (const target of [undefined, { spaceId: requestId, rootRelativePath: '项目/data' }]) {
    const selection = workspaceCreateSelection.parse({ requestId, title: ' 项目 A ', ...(target ? { target } : {}) })
    const path = cloudWorkspaceSelectionPath(selection)
    assert.ok(path.startsWith('power-evolve-cloud-selection:'))
    assert.deepEqual(JSON.parse(decodeURIComponent(path.slice('power-evolve-cloud-selection:'.length))), selection)
    assert.equal(cloudWorkspaceSelectionPath(selection), path)
  }
  for (const title of ['', ' '.repeat(10), 'x'.repeat(81), 'bad\nname']) {
    assert.throws(() => workspaceCreateSelection.parse({ requestId, title }))
  }
})
