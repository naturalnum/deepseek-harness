/** Storage wire requests exclude physical paths and carry exact recovery generations. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { workspaceCreateSelection, workspaceStorageTarget, storageDirectoriesRequest,
  storageDirectoryCreateRequest, workspaceBindingRestoreRequest, workspaceBindingReceipt,
  workspaceBindingView } from '../../contracts/lib/workspace-binding.js'

const target = { spaceId: randomUUID(), rootRelativePath: 'projects/项目' }
const request = { ...target, requestId: randomUUID(), workspaceId: randomUUID(), expectedGeneration: 3 }

test('storage selection preserves existing relative directories but rejects physical roots and traversal', () => {
  for (const rootRelativePath of ['', 'projects/已有仓库']) {
    assert.equal(workspaceStorageTarget.parse({ ...target, rootRelativePath }).rootRelativePath, rootRelativePath)
  }
  for (const rootRelativePath of ['/private', '../other', 'a/../b', 'a//b', 'a\\b', 'a\0b', 'C:/private']) {
    assert.equal(workspaceStorageTarget.safeParse({ ...target, rootRelativePath }).success, false)
  }
  assert.equal(workspaceStorageTarget.safeParse({ ...target, rootKey: randomUUID() }).success, false)
  assert.equal(workspaceStorageTarget.safeParse({ ...target, userId: randomUUID() }).success, false)
})

test('creation and recovery preserve retry identity, ownership references and exact expected generation', () => {
  const creation = { requestId: randomUUID(), title: 'Existing Git', target }
  assert.deepEqual(workspaceCreateSelection.parse(creation), creation)
  assert.deepEqual(workspaceBindingRestoreRequest.parse(request), request)
  for (const expectedGeneration of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(workspaceBindingRestoreRequest.safeParse({ ...request, expectedGeneration }).success, false)
  }
  const { requestId: omitted, ...withoutId } = request
  assert.equal(workspaceBindingRestoreRequest.safeParse(withoutId).success, false)
  assert.equal(workspaceBindingRestoreRequest.safeParse({ ...request, podStopped: true }).success, false)
})

test('directory creation stays within one selected parent and listing has a bounded page', () => {
  const creation = { requestId: randomUUID(), spaceId: target.spaceId, parentPath: '', name: '仓库' }
  assert.deepEqual(storageDirectoryCreateRequest.parse(creation), creation)
  assert.equal(storageDirectoryCreateRequest.safeParse({ ...creation, name: 'a/b' }).success, false)
  assert.equal(storageDirectoriesRequest.safeParse({ spaceId: target.spaceId, parentPath: '', limit: 201 }).success, false)
})

test('recovery progress cannot claim completion without advancing exactly one generation', () => {
  const receipt = { requestId: request.requestId, workspaceId: request.workspaceId, state: 'completed',
    expectedGeneration: 3, bindingGeneration: 4, errorCode: null }
  assert.deepEqual(workspaceBindingReceipt.parse(receipt), receipt)
  for (const bindingGeneration of [null, 3, 5]) {
    assert.equal(workspaceBindingReceipt.safeParse({ ...receipt, bindingGeneration }).success, false)
  }
  assert.equal(workspaceBindingReceipt.safeParse({ ...receipt, state: 'stopping' }).success, false)
  assert.equal(workspaceBindingReceipt.safeParse({ ...receipt, state: 'blocked', bindingGeneration: null }).success, false)
  assert.equal(workspaceBindingReceipt.safeParse({ ...receipt, state: 'blocked', bindingGeneration: null,
    errorCode: 'mount_stop_proof_missing' }).success, true)
  assert.equal(workspaceBindingView.safeParse({ workspaceId: request.workspaceId, title: 'Project',
    generation: 1, state: 'ready', target: null }).success, false)
})
