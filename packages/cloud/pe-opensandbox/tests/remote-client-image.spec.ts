import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadBootstrapPayload, TrustedSdkBootstrap } from '../src/bootstrap/bootstrap.ts'
import { parseRootDeploymentInput, SESSION_DIRECTORY_SERVER_IMAGE_DIGEST } from '../src/bootstrap/deployment-input.ts'
import { NATIVE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST } from '../src/bootstrap/workload-images.ts'
import { sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

it('selects the exact reviewed SSH layer without changing the original lifecycle or Native guard policy', () => {
  const input = sharedPathDeploymentFixture()
  input.selection.serverImageDigest = SESSION_DIRECTORY_SERVER_IMAGE_DIGEST
  const previous = parseRootDeploymentInput(input)
  input.lifecycle.imageDigest = REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST
  const selected = parseRootDeploymentInput(input)
  expect({ ...selected.lifecycle, imageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST }).toEqual(previous.lifecycle)
  expect(selected.selection).toEqual(previous.selection)
  expect(selected.bootstrap).toEqual(previous.bootstrap)
  expect(selected.schema).toBe('pe-opensandbox-root-deployment-v2')
})

it.each([NATIVE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST])(
  'binds actual packaged bootstrap bytes to reviewed image %s without starting a transport', async (imageDigest) => {
    const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
    const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
    const input = sharedPathDeploymentFixture()
    input.lifecycle.imageDigest = imageDigest
    const parsed = parseRootDeploymentInput(input)
    expect(() => new TrustedSdkBootstrap({ ...parsed.bootstrap, lifecycle: parsed.lifecycle,
      assertDeploymentCurrent() {} }, payload, () => { throw new Error('Construction must not start a transport') }))
      .not.toThrow()
  },
)

it.each(['dsh-remote-client:20261104-01', REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST.slice(0, -1) + 'e',
  'sha256:' + 'a'.repeat(64)])('rejects unreviewed workload image %s', (imageDigest) => {
  const input = sharedPathDeploymentFixture()
  input.lifecycle.imageDigest = imageDigest
  expect(() => parseRootDeploymentInput(input)).toThrow('lifecycle.fixedSelection')
})
