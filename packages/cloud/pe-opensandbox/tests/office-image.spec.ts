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

it.each(['office:latest', OFFICE_WORKLOAD_IMAGE_DIGEST.slice(0, -1) + (OFFICE_WORKLOAD_IMAGE_DIGEST.endsWith('0') ? '1' : '0'), 'sha256:' + 'e'.repeat(64)])(
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


it.each([
  ['sha256:3690da1fbb1faaabaf7265927b8b21a0fef0c4c988d83a8b1e321a2e82d43140',
    'sha256:d2b79b4297bb2e8d0f11349000269aa0e7b600b02aed59d35c6d168b875b1034'],
  ['sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97',
    'sha256:6455dfede6c2aa12ef7c2b7e6d69d4254d53918600dab55acd09c62e4ab7a27d'],
])('keeps prior Office pair %s / %s closed to creation', (priorWorkload, priorServer) => {
  const input = sharedPathDeploymentFixture()
  input.lifecycle.imageDigest = priorWorkload
  input.selection.serverImageDigest = OFFICE_SERVER_IMAGE_DIGEST
  expect(() => parseRootDeploymentInput(input)).toThrow('lifecycle.fixedSelection')
  input.lifecycle.imageDigest = OFFICE_WORKLOAD_IMAGE_DIGEST
  input.selection.serverImageDigest = priorServer
  expect(() => parseRootDeploymentInput(input)).toThrow('selection.originalPolicy')
})

it('pins the heading-compatible workload and its one immutable server without changing Native or SSH suppliers', () => {
  expect(OFFICE_WORKLOAD_IMAGE_DIGEST).toBe('sha256:ff336ad49a52795fa82960da50a46cc7cbb654326ad5160313f94355d1cce461')
  expect(OFFICE_SERVER_IMAGE_DIGEST).toBe('sha256:1b7ec16bb1031eab0fd7024905fc03dc5f814fbfe46bbb2d5aa2f88e3813b628')
  expect(NATIVE_WORKLOAD_IMAGE_DIGEST).toBe('sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a')
  expect(REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST).toBe('sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d')
})
