/** Complete current supplier matrix; these parsers and constructors create no transport or deployment. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadBootstrapPayload, TrustedSdkBootstrap } from '../src/bootstrap/bootstrap.ts'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'
import { NATIVE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST, OFFICE_WORKLOAD_IMAGE_DIGEST,
  SESSION_DIRECTORY_SERVER_IMAGE_DIGEST, REMOTE_CLIENT_SERVER_IMAGE_DIGEST, OFFICE_SERVER_IMAGE_DIGEST,
  qualifiedSupplierTuples, isPinnedWorkloadImageDigest, isSessionDirectoryServerImageDigest } from '../src/bootstrap/qualified-suppliers.ts'
import { rootDeploymentFixture, sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

// Pin the existing creation inventory independently of the policy's lookup helpers.
const existing = [
  { schema: 'pe-opensandbox-root-deployment-v1', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    serverImageDigest: rootDeploymentFixture().selection.serverImageDigest, sessionDirectories: false },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    serverImageDigest: sharedPathDeploymentFixture().selection.serverImageDigest, sessionDirectories: false },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    serverImageDigest: SESSION_DIRECTORY_SERVER_IMAGE_DIGEST, sessionDirectories: true },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST,
    serverImageDigest: REMOTE_CLIENT_SERVER_IMAGE_DIGEST, sessionDirectories: true },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_WORKLOAD_IMAGE_DIGEST,
    serverImageDigest: OFFICE_SERVER_IMAGE_DIGEST, sessionDirectories: true },
] as const

it('retains the existing five immutable suppliers without admitting another image', () => {
  expect(qualifiedSupplierTuples).toEqual(existing)
  expect(Object.isFrozen(qualifiedSupplierTuples)).toBe(true)
  expect(qualifiedSupplierTuples.every(Object.isFrozen)).toBe(true)
  for (const row of existing) {
    expect(isPinnedWorkloadImageDigest(row.workloadImageDigest)).toBe(true)
    expect(isSessionDirectoryServerImageDigest(row.serverImageDigest)).toBe(row.sessionDirectories)
  }
  expect(isPinnedWorkloadImageDigest('sha256:' + '0'.repeat(64))).toBe(false)
  expect(isPinnedWorkloadImageDigest('office:latest')).toBe(false)
  expect(isSessionDirectoryServerImageDigest('sha256:' + '0'.repeat(64))).toBe(false)
  expect(isSessionDirectoryServerImageDigest(undefined)).toBe(false)
})

for (const schema of ['pe-opensandbox-root-deployment-v1', 'pe-opensandbox-root-deployment-v2'] as const) {
  for (const workload of new Set(existing.map(row => row.workloadImageDigest))) {
    it.each(existing.map(row => row.serverImageDigest))(`checks the complete ${schema} / ${workload} / %s selection`, (server) => {
      const base = schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
      const input = { ...base, lifecycle: { ...base.lifecycle, imageDigest: workload },
        selection: { ...base.selection, serverImageDigest: server } }
      const allowed = existing.some(row => row.schema === schema && row.workloadImageDigest === workload
        && row.serverImageDigest === server)
      if (allowed) expect(parseRootDeploymentInput(input)).toMatchObject({ schema,
        lifecycle: { imageDigest: workload }, selection: { serverImageDigest: server } })
      else expect(() => parseRootDeploymentInput(input)).toThrow(/selection\.(originalPolicy|workloadImagePair)/u)
    })
  }
}

it('uses the same supplier inventory with the unchanged original bootstrap payload', async () => {
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
  for (const row of existing) {
    const base = row.schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
    const input = parseRootDeploymentInput({ ...base, lifecycle: { ...base.lifecycle, imageDigest: row.workloadImageDigest },
      selection: { ...base.selection, serverImageDigest: row.serverImageDigest } })
    expect(() => new TrustedSdkBootstrap({ ...input.bootstrap, lifecycle: input.lifecycle, assertDeploymentCurrent() {} },
      payload, () => { throw Error('Construction must not create a transport') })).not.toThrow()
  }
})
