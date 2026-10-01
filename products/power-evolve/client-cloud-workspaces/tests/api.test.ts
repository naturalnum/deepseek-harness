/** Native Host wire parsing rejects unrelated directory pages and recovery receipts. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceBindingRestoreRequest, storageDirectoriesRequest, storageDirectoryCreateRequest } from '@power-evolve/contracts/workspace-binding'
import { createWorkspaceBindingActions, WorkspaceBindingHttpError } from '../src/client/api.ts'

const SPACE = 'a0197a8a-105d-42c6-b815-6e5155f10b5e'
const WORKSPACE = 'b2cda611-5cf4-49f4-8606-7b8a66701e11'
const REQUEST = '598f346b-178c-4ef3-80ef-3a68f4cb4888'
const restore = workspaceBindingRestoreRequest.parse({ requestId: REQUEST, workspaceId: WORKSPACE, expectedGeneration: 4,
  spaceId: SPACE, rootRelativePath: 'Existing' })
const completed = { requestId: REQUEST, workspaceId: WORKSPACE, expectedGeneration: 4, state: 'completed', bindingGeneration: 5, errorCode: null }

async function withFetch(run: (api: ReturnType<typeof createWorkspaceBindingActions>, signal: AbortSignal) => Promise<void>,
  response: (key: string, request: unknown, init: RequestInit) => Response | Promise<Response>) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'same-origin')
    assert.equal(init?.redirect, 'error')
    return response(String(url), JSON.parse(String(init?.body)).request, init!)
  }
  try { await run(createWorkspaceBindingActions(), new AbortController().signal) }
  finally { globalThis.fetch = previous }
}

test('creation and recovery use six exact Host RPC keys and shared response validation', async () => {
  const routes: string[] = []
  await withFetch(async (api, signal) => {
    await api.listStorageSpaces(signal)
    await api.listMissingBindings(signal)
    await api.listStorageDirectories(storageDirectoriesRequest.parse({ spaceId: SPACE, parentPath: '', limit: 100 }), signal)
    await api.createStorageDirectory(storageDirectoryCreateRequest.parse({ requestId: REQUEST, spaceId: SPACE, parentPath: '', name: 'New' }), signal)
    assert.deepEqual(await api.restoreBinding(restore, signal), completed)
    assert.deepEqual(await api.checkBindingStatus(restore, signal), completed)
  }, (key, request) => {
    routes.push(key)
    switch (key) {
      case '/api/powerEvolve/storageSpaces': assert.deepEqual(request, {}); return Response.json({ items: [] })
      case '/api/powerEvolve/workspaceBindingsMissing': assert.deepEqual(request, {}); return Response.json({ items: [] })
      case '/api/powerEvolve/storageDirectories': return Response.json({ spaceId: SPACE, parentPath: '', entries: [{ name: 'Existing', path: 'Existing' }] })
      case '/api/powerEvolve/storageDirectoryCreate': return Response.json({ name: 'New', path: 'New' })
      case '/api/powerEvolve/workspaceBindingStatus': assert.deepEqual(request, { requestId: REQUEST }); return Response.json(completed)
      default: assert.deepEqual(request, restore); return Response.json(completed)
    }
  })
  assert.equal(routes.length, 6)
})

test('directory response identity, immediate children, uniqueness and cursors match their request', async () => {
  const request = storageDirectoriesRequest.parse({ spaceId: SPACE, parentPath: 'Existing', limit: 100, cursor: 'page' })
  const valid = { spaceId: SPACE, parentPath: 'Existing', entries: [{ name: 'Child', path: 'Existing/Child' }] }
  for (const response of [{ ...valid, spaceId: WORKSPACE }, { ...valid, parentPath: '' },
    { ...valid, entries: [{ name: 'Child', path: 'Other/Child' }] }, { ...valid, entries: [valid.entries[0], valid.entries[0]] },
    { ...valid, nextCursor: 'page' }, { ...valid, physicalRoot: '/private/server/root' }]) {
    await withFetch(async (api, signal) => { await assert.rejects(api.listStorageDirectories(request, signal)) }, () => Response.json(response))
  }
})

test('completed recovery requires the exact request, Workspace and expected generation', async () => {
  for (const response of [{ ...completed, requestId: SPACE }, { ...completed, workspaceId: SPACE },
    { ...completed, expectedGeneration: 3, bindingGeneration: 4 }, { ...completed, bindingGeneration: 8 },
    { ...completed, errorCode: 'old_writer_alive' }]) {
    await withFetch(async (api, signal) => { await assert.rejects(api.checkBindingStatus(restore, signal)) }, () => Response.json(response))
  }
})

test('Host failures retain bounded business codes and oversized replies are rejected', async () => {
  await withFetch(async (api, signal) => {
    await assert.rejects(api.restoreBinding(restore, signal), (error: unknown) => error instanceof WorkspaceBindingHttpError
      && error.status === 409 && error.code === 'workspace_storage_overlap')
  }, () => Response.json({ error: 'workspace_storage_overlap' }, { status: 409 }))
  await withFetch(async (api, signal) => { await assert.rejects(api.listStorageSpaces(signal), /byte limit/) },
    () => new Response(' '.repeat(512 * 1024 + 1)))
})

test('an aborted bounded response stops reading and cannot publish a receipt', async () => {
  const controller = new AbortController()
  await withFetch(async api => {
    const pending = api.restoreBinding(restore, controller.signal)
    controller.abort()
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
  }, () => new Response(new ReadableStream({ start() {} })))
})

test('a late creation acknowledgement completes only its own retry intent', async () => {
  const { createCloudWorkspaceStore } = await import('../src/client/store.ts')
  const { workspaceCreateSelection } = await import('@power-evolve/contracts/workspace-binding')
  const store = createCloudWorkspaceStore().create()
  const first = workspaceCreateSelection.parse({ requestId: REQUEST, title: 'First' })
  const second = workspaceCreateSelection.parse({ requestId: SPACE, title: 'Second' })
  store.actions.rememberCreate(first)
  store.actions.rememberCreate(second)
  store.actions.completeCreate(first.requestId)
  assert.deepEqual(store.getSnapshot().create, second)
  store.actions.completeCreate(second.requestId)
  assert.equal(store.getSnapshot().create, null)
})
