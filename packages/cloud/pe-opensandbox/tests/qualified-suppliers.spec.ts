/** Complete current supplier matrix; these parsers and constructors create no transport or deployment. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadBootstrapPayload, TrustedSdkBootstrap } from '../src/bootstrap/bootstrap.ts'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'
import { NATIVE_WORKLOAD_IMAGE_DIGEST, REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST, OFFICE_WORKLOAD_IMAGE_DIGEST,
  OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST, OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST,
  OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST,
  SESSION_DIRECTORY_SERVER_IMAGE_DIGEST, REMOTE_CLIENT_SERVER_IMAGE_DIGEST, OFFICE_SERVER_IMAGE_DIGEST,
  OFFICE_RESEARCH_SERVER_IMAGE_DIGEST, OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST,
  OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST,
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

const previous = [...existing, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST,
  serverImageDigest: OFFICE_RESEARCH_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST,
  serverImageDigest: OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}] as const

const suppliers = [...previous, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST,
  serverImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}] as const

it('retains the original suppliers and permits only the exact built v2 superset pairs', () => {
  expect(qualifiedSupplierTuples.slice(0, 5)).toEqual(existing)
  expect(qualifiedSupplierTuples.slice(0, 7)).toEqual(previous)
  expect(qualifiedSupplierTuples).toEqual(suppliers)
  expect(OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST).toBe('sha256:71c7afa35f5d774ec6a198c7233b645bc16275c56595369efa368d6fac025bf8')
  expect(OFFICE_RESEARCH_SERVER_IMAGE_DIGEST).toBe('sha256:7d8a5f0bfe9d7db24ff396d57f930ef8a6be2d4651c05d229e6d2624cfc2e042')
  expect(OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST).toBe('sha256:44e26197f73faece822111f939e23a14816cf4fd5eb53362e0088087c42a8c1e')
  expect(OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST).toBe('sha256:c0e629914f5b62c74f63e6a0632fd75de47ef6c4abc2321f277525350848894f')
  expect(OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST).toBe('sha256:4a7ce478412f06d3369ff338aaa971acaa7bc6e6778995c1558eb9c997cb263a')
  expect(OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST).toBe('sha256:87bbc26029f68dab351a3abd958fda82877cb29b3d15a77fe5887c858ab1de57')
  expect(Object.isFrozen(qualifiedSupplierTuples)).toBe(true)
  expect(qualifiedSupplierTuples.every(Object.isFrozen)).toBe(true)
  for (const row of suppliers) {
    expect(isPinnedWorkloadImageDigest(row.workloadImageDigest)).toBe(true)
    expect(isSessionDirectoryServerImageDigest(row.serverImageDigest)).toBe(row.sessionDirectories)
  }
  expect(isPinnedWorkloadImageDigest('sha256:' + '0'.repeat(64))).toBe(false)
  expect(isPinnedWorkloadImageDigest('office:latest')).toBe(false)
  expect(isSessionDirectoryServerImageDigest('sha256:' + '0'.repeat(64))).toBe(false)
  expect(isSessionDirectoryServerImageDigest(undefined)).toBe(false)
})

for (const schema of ['pe-opensandbox-root-deployment-v1', 'pe-opensandbox-root-deployment-v2'] as const) {
  for (const workload of new Set(suppliers.map(row => row.workloadImageDigest))) {
    it.each(suppliers.map(row => row.serverImageDigest))(`checks the complete ${schema} / ${workload} / %s selection`, (server) => {
      const base = schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
      const input = { ...base, lifecycle: { ...base.lifecycle, imageDigest: workload },
        selection: { ...base.selection, serverImageDigest: server } }
      const allowed = suppliers.some(row => row.schema === schema && row.workloadImageDigest === workload
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
  for (const row of suppliers) {
    const base = row.schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
    const input = parseRootDeploymentInput({ ...base, lifecycle: { ...base.lifecycle, imageDigest: row.workloadImageDigest },
      selection: { ...base.selection, serverImageDigest: row.serverImageDigest } })
    expect(() => new TrustedSdkBootstrap({ ...input.bootstrap, lifecycle: input.lifecycle, assertDeploymentCurrent() {} },
      payload, () => { throw Error('Construction must not create a transport') })).not.toThrow()
  }
})
