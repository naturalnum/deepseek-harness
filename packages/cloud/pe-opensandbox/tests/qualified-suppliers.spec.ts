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
  NATIVE_AMD64_WORKLOAD_IMAGE_DIGEST, NATIVE_AMD64_SERVER_IMAGE_DIGEST,
  OFFICE_RESEARCH_GIT_SSH_AMD64_WORKLOAD_IMAGE_DIGEST, OFFICE_RESEARCH_GIT_SSH_AMD64_SERVER_IMAGE_DIGEST,
  qualifiedSupplierTuples, isPinnedWorkloadImageDigest, isSessionDirectoryServerImageDigest } from '../src/bootstrap/qualified-suppliers.ts'
import { RUNTIME_PROFILES } from '../src/bootstrap/runtime-profiles.ts'
import { rootDeploymentFixture, sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

// Pin the existing creation inventory independently of the policy's lookup helpers.
const existing = [
  { schema: 'pe-opensandbox-root-deployment-v1', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: rootDeploymentFixture().selection.serverImageDigest, sessionDirectories: false },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: sharedPathDeploymentFixture().selection.serverImageDigest, sessionDirectories: false },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: SESSION_DIRECTORY_SERVER_IMAGE_DIGEST, sessionDirectories: true },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: REMOTE_CLIENT_SERVER_IMAGE_DIGEST, sessionDirectories: true },
  { schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: OFFICE_SERVER_IMAGE_DIGEST, sessionDirectories: true },
] as const

const previous = [...existing, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST,
  platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
  serverImageDigest: OFFICE_RESEARCH_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST,
  platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
  serverImageDigest: OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}] as const

const armSuppliers = [...previous, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST,
  platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
  serverImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST,
  sessionDirectories: true,
}] as const

const nativeSuppliers = [...armSuppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:84d3c8cd1520dfb2b088f9d3dbd296f4d18fabed3b18fb0aea01e6e378f9d5eb',
  serverImageDigest: 'sha256:7b9ef8e0c71d81c9d6909cae992015f8789e9e152d5a21aee03836fd08ac7224',
  platform: 'amd64', execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de',
  sessionDirectories: true,
}] as const

const priorAmd64Suppliers = [...nativeSuppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:4b7497e321629c90db04a8105865ca9f932beedeb67239cb22e68ed1a66dc360',
  serverImageDigest: 'sha256:28e4ebc841f3bc9b09f5cbfce8ce289522d259daa95f2b9ca152786ca8b5de0b',
  platform: 'amd64', execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de',
  sessionDirectories: true,
}] as const

const priorManifestSuppliers = [...priorAmd64Suppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:32c17c742af43a6d9c89c69441fbc543751af41b0f61bf8294ed00ac3a4df62f',
  serverImageDigest: 'sha256:e4fc713db05339d41b70215f2ffdbc1c37f8948b92c949eb4cd2c164ce90038a',
  platform: 'amd64', execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de',
  sessionDirectories: true,
}] as const

const priorContentSuppliers = [...priorManifestSuppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:214323fe18dce90360b499cf069412efb8adf889ad02c94cef43fb87b8f42b9e',
  serverImageDigest: 'sha256:a8b6fcac0077db9073389583162d85cb78c4aa6da1846a2cdca30f72985100f0',
  platform: 'arm64', execdImageDigest: 'sha256:b6dc1290091b2d4c5b51e0776e718d275069224110ae07a07dad14d249447b4e',
  sessionDirectories: true,
}] as const

const previousSuppliers = [...priorContentSuppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:3ec6ba073f482c4c39d2ad0e03fde8f841373a0bd30c53a2660e9cbd10b2f202',
  serverImageDigest: 'sha256:2c0389e8aaf9430c6a07d2ba796a2ae0b578a1d02839f7be9f02f6c164c1c74e',
  platform: 'arm64', execdImageDigest: 'sha256:b6dc1290091b2d4c5b51e0776e718d275069224110ae07a07dad14d249447b4e',
  sessionDirectories: true,
}] as const

const suppliers = [...previousSuppliers, {
  schema: 'pe-opensandbox-root-deployment-v2',
  workloadImageDigest: 'sha256:32c17c742af43a6d9c89c69441fbc543751af41b0f61bf8294ed00ac3a4df62f',
  serverImageDigest: 'sha256:67eb1b98ee174004ffe048b00df70025b2754efc8bbf1a5b667dfe7ee339df08',
  platform: 'amd64', execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de',
  sessionDirectories: true,
}] as const

it('retains the original suppliers and permits only the exact built v2 superset pairs', () => {
  expect(qualifiedSupplierTuples.slice(0, 5)).toEqual(existing)
  expect(qualifiedSupplierTuples.slice(0, 7)).toEqual(previous)
  expect(qualifiedSupplierTuples.slice(0, 8)).toEqual(armSuppliers)
  expect(qualifiedSupplierTuples.slice(0, 9)).toEqual(nativeSuppliers)
  expect(qualifiedSupplierTuples.slice(0, 10)).toEqual(priorAmd64Suppliers)
  expect(qualifiedSupplierTuples.slice(0, 11)).toEqual(priorManifestSuppliers)
  expect(qualifiedSupplierTuples.slice(0, 12)).toEqual(priorContentSuppliers)
  expect(qualifiedSupplierTuples.slice(0, 13)).toEqual(previousSuppliers)
  expect(qualifiedSupplierTuples).toEqual(suppliers)
  expect(NATIVE_AMD64_WORKLOAD_IMAGE_DIGEST).toBe(suppliers[8].workloadImageDigest)
  expect(NATIVE_AMD64_SERVER_IMAGE_DIGEST).toBe(suppliers[8].serverImageDigest)
  expect(OFFICE_RESEARCH_GIT_SSH_AMD64_WORKLOAD_IMAGE_DIGEST).toBe(suppliers[9].workloadImageDigest)
  expect(OFFICE_RESEARCH_GIT_SSH_AMD64_SERVER_IMAGE_DIGEST).toBe(suppliers[9].serverImageDigest)
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
    for (const platform of ['arm64', 'amd64'] as const) {
      for (const execd of new Set(suppliers.map(row => row.execdImageDigest))) {
        it.each(suppliers.map(row => row.serverImageDigest))(`checks ${schema} / ${platform} / ${execd} / ${workload} / %s`, (server) => {
          const base = schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
          const input = { ...base, lifecycle: { ...base.lifecycle, imageDigest: workload, platform },
            selection: { ...base.selection, serverImageDigest: server, execdImageDigest: execd } }
          const allowed = suppliers.some(row => row.schema === schema && row.workloadImageDigest === workload
            && row.serverImageDigest === server && row.platform === platform && row.execdImageDigest === execd)
          if (allowed) expect(parseRootDeploymentInput(input)).toMatchObject({ schema,
            lifecycle: { imageDigest: workload }, selection: { serverImageDigest: server } })
          else expect(() => parseRootDeploymentInput(input)).toThrow(/selection\.(originalPolicy|workloadImagePair)/u)
        })
      }
    }
  }
}

it('uses one fixed bootstrap payload for every exact reviewed supplier', async () => {
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
  for (const row of suppliers) {
    const base = row.schema === 'pe-opensandbox-root-deployment-v1' ? rootDeploymentFixture() : sharedPathDeploymentFixture()
    const input = parseRootDeploymentInput({ ...base,
      selection: { ...base.selection, serverImageDigest: row.serverImageDigest, execdImageDigest: row.execdImageDigest },
      lifecycle: { ...base.lifecycle, imageDigest: row.workloadImageDigest, platform: row.platform } })
    expect(() => new TrustedSdkBootstrap({ ...input.bootstrap, lifecycle: input.lifecycle, assertDeploymentCurrent() {} },
      payload, () => { throw Error('Construction must not create a transport') })).not.toThrow()
  }
})

it.each([
  [suppliers[10], 'sha256:0a06b620dfb9fa477e6e136e01786d39ab29be5d68c19a6c975c6a6205023374',
    'sha256:6ab048f3f4553f1e28d702900b41dd3f19fe0bce0a707bda8b5d7114474ea5c4'],
  [nativeSuppliers[8], 'sha256:9bd266bc2a847a977395c5ccfd5cfa73fecdf9fc7322b18aebf9b27be0c0b87b',
    'sha256:79b40881f084d1252e6f247409678668a50278685fc8200928495a30fbde0ced'],
  [suppliers[9], 'sha256:b555c2337af0b7997c465542044723d507fba142533f450f39b1ed5908e2c6b7',
    'sha256:f1a88665692d86807fc5c68480c91203ae37e1d2880340199625f4edb19e45da'],
] as const)('admits only the actual AMD64 manifest tuple and its fixed bootstrap payload: %j', async (supplier, workloadConfig, serverConfig) => {
  const base = sharedPathDeploymentFixture()
  const value = { ...base, lifecycle: { ...base.lifecycle, platform: 'amd64',
    imageDigest: supplier.workloadImageDigest },
  selection: { ...base.selection,
    serverImageDigest: supplier.serverImageDigest,
    execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de' } }
  const input = parseRootDeploymentInput(value)
  expect(input.lifecycle).toMatchObject({ platform: 'amd64', imageDigest: value.lifecycle.imageDigest })
  expect(input.selection).toEqual(value.selection)
  const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))
  const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
  const config = { ...input.bootstrap, lifecycle: input.lifecycle, assertDeploymentCurrent() {} }
  const noTransport = () => { throw Error('Construction must not create a transport') }
  expect(() => new TrustedSdkBootstrap(config, payload, noTransport)).not.toThrow()
  expect(() => new TrustedSdkBootstrap({ ...config, lifecycle: { ...input.lifecycle, platform: 'arm64' } },
    payload, noTransport)).toThrow('binding')
  for (const imageDigest of [workloadConfig, 'native:latest']) {
    expect(() => parseRootDeploymentInput({ ...value, lifecycle: { ...value.lifecycle, imageDigest } }))
      .toThrow('lifecycle.fixedSelection')
  }
  for (const serverImageDigest of [serverConfig,
    'sha256:b9e5cb3029d236dbfcb50823d59cc5ad77dab7efcd1fc4c5a256babcbcf78bde']) {
    expect(() => parseRootDeploymentInput({ ...value, selection: { ...value.selection, serverImageDigest } }))
      .toThrow('selection.originalPolicy')
  }
  expect(() => parseRootDeploymentInput({ ...value, selection: { ...value.selection,
    execdImageDigest: 'sha256:64104feaa1209e5754b316b64d1a191ac638233b34f215b2af3d0bce2f607541' } }))
    .toThrow('selection.workloadImagePair')
})
