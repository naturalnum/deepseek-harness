import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadBootstrapPayload, TrustedSdkBootstrap } from '../src/bootstrap/bootstrap.ts'
import { parseRootDeploymentInput, OFFICE_SERVER_IMAGE_DIGEST, REMOTE_CLIENT_SERVER_IMAGE_DIGEST,
  SESSION_DIRECTORY_SERVER_IMAGE_DIGEST } from '../src/bootstrap/deployment-input.ts'
import { NATIVE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST,
  OFFICE_WORKLOAD_IMAGE_DIGEST } from '../src/bootstrap/workload-images.ts'
import { sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

it('selects the exact Office pair while retaining original shared-path protections and limits', () => {
  const input = sharedPathDeploymentFixture()
  input.selection.serverImageDigest = SESSION_DIRECTORY_SERVER_IMAGE_DIGEST
  const before = parseRootDeploymentInput(input)
  input.lifecycle.imageDigest = OFFICE_WORKLOAD_IMAGE_DIGEST
  input.selection.serverImageDigest = OFFICE_SERVER_IMAGE_DIGEST
  const after = parseRootDeploymentInput(input)
  expect({ ...after.lifecycle, imageDigest: before.lifecycle.imageDigest }).toEqual(before.lifecycle)
  expect({ ...after.selection, serverImageDigest: before.selection.serverImageDigest }).toEqual(before.selection)
  expect({ ...after, lifecycle: before.lifecycle, selection: before.selection }).toEqual(before)
})

it('binds original immutable bootstrap assets to the Office image without creating a transport', async () => {
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
  const input = sharedPathDeploymentFixture()
  input.lifecycle.imageDigest = OFFICE_WORKLOAD_IMAGE_DIGEST
  input.selection.serverImageDigest = OFFICE_SERVER_IMAGE_DIGEST
  const parsed = parseRootDeploymentInput(input)
  expect(() => new TrustedSdkBootstrap({ ...parsed.bootstrap, lifecycle: parsed.lifecycle,
    assertDeploymentCurrent() {} }, payload, () => { throw Error('Construction must not create a transport') })).not.toThrow()
})

it.each([
  [OFFICE_WORKLOAD_IMAGE_DIGEST, SESSION_DIRECTORY_SERVER_IMAGE_DIGEST],
  [OFFICE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_SERVER_IMAGE_DIGEST],
  [OFFICE_WORKLOAD_IMAGE_DIGEST, 'sha256:fec2756169ff3e9baf123c0f2e9664baf3f2214898372c180847d991559ce0fd'],
  [NATIVE_WORKLOAD_IMAGE_DIGEST, OFFICE_SERVER_IMAGE_DIGEST],
  [REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST, OFFICE_SERVER_IMAGE_DIGEST],
])('refuses cross-pair %s / %s before allocation', (imageDigest, serverImageDigest) => {
  const input = sharedPathDeploymentFixture()
  input.lifecycle.imageDigest = imageDigest
  input.selection.serverImageDigest = serverImageDigest
  expect(() => parseRootDeploymentInput(input)).toThrow('selection.workloadImagePair')
})

it.each(['office:latest', OFFICE_WORKLOAD_IMAGE_DIGEST.slice(0, -1) + '1', 'sha256:' + 'e'.repeat(64)])(
  'refuses an unpinned Office workload selector %s', (imageDigest) => {
    const input = sharedPathDeploymentFixture()
    input.lifecycle.imageDigest = imageDigest
    input.selection.serverImageDigest = OFFICE_SERVER_IMAGE_DIGEST
    expect(() => parseRootDeploymentInput(input)).toThrow('lifecycle.fixedSelection')
  },
)

it.each(['office-server:latest', OFFICE_SERVER_IMAGE_DIGEST.slice(0, -1) + '5', 'sha256:' + 'e'.repeat(64)])(
  'refuses an unpinned Office server selector %s', (serverImageDigest) => {
    const input = sharedPathDeploymentFixture()
    input.lifecycle.imageDigest = OFFICE_WORKLOAD_IMAGE_DIGEST
    input.selection.serverImageDigest = serverImageDigest
    expect(() => parseRootDeploymentInput(input)).toThrow('selection.originalPolicy')
  },
)
