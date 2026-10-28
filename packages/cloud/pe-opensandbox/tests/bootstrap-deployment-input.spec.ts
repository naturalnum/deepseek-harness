/** Protected deployment selection parsing; synthetic inputs create no files or remote resources. */
import { expect, it } from 'vitest'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'
import { rootDeploymentFixture, sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

it('keeps legacy v1 keeper input distinct from explicit shared-path v2', () => {
  const legacy = parseRootDeploymentInput(rootDeploymentFixture()), shared = parseRootDeploymentInput(sharedPathDeploymentFixture())
  expect(legacy.schema).toBe('pe-opensandbox-root-deployment-v1')
  expect(Object.hasOwn(legacy, 'storage')).toBe(false)
  expect(shared.schema).toBe('pe-opensandbox-root-deployment-v2')
  expect(Object.hasOwn(shared, 'exports')).toBe(false)
  if (shared.schema !== 'pe-opensandbox-root-deployment-v2') throw new Error('Expected explicit shared-path selection.')
  expect(shared.storage.mode).toBe('shared-path')
  expect(shared.storage.plan).toEqual({ path: '/root-private/storage-plan.json', sha256: '5'.repeat(64) })
})

it('retains frozen plan references and finite capacities with the same lifecycle and bootstrap bounds', () => {
  const input = sharedPathDeploymentFixture(), parsed = parseRootDeploymentInput(input)
  if (parsed.schema !== 'pe-opensandbox-root-deployment-v2') throw new Error('Expected explicit shared-path selection.')
  expect(parsed.lifecycle).toEqual(parseRootDeploymentInput(rootDeploymentFixture()).lifecycle)
  expect(parsed.bootstrap).toEqual(parseRootDeploymentInput(rootDeploymentFixture()).bootstrap)
  expect(Object.isFrozen(parsed.storage)).toBe(true)
  expect(Object.isFrozen(parsed.storage.plan)).toBe(true)
  expect(Object.isFrozen(parsed.storage.limits)).toBe(true)
  input.storage.plan.path = '/changed'
  input.storage.limits.maxShares = 1
  expect(parsed.storage.plan.path).toBe('/root-private/storage-plan.json')
  expect(parsed.storage.limits.maxShares).toBe(4)
})

it('binds each storage schema to its exact Native guard image without accepting the other layout', () => {
  const legacy = rootDeploymentFixture(), shared = sharedPathDeploymentFixture()
  expect(parseRootDeploymentInput(shared).selection.serverImageDigest).toBe(shared.selection.serverImageDigest)
  expect(() => parseRootDeploymentInput({ ...shared, selection: legacy.selection })).toThrow('selection.originalPolicy')
  expect(() => parseRootDeploymentInput({ ...legacy, selection: shared.selection })).toThrow('selection.originalPolicy')
  expect(() => parseRootDeploymentInput({ ...shared, selection: { ...shared.selection,
    serverImageDigest: 'sha256:' + 'a'.repeat(64) } })).toThrow('selection.originalPolicy')
})

it.each([undefined, null, 'keeper', 'auto', ''])('rejects absent or unsupported shared-path mode %s', (mode) => {
  const value = sharedPathDeploymentFixture()
  expect(() => parseRootDeploymentInput({ ...value, storage: { ...value.storage, mode } })).toThrow()
})

it('does not infer shared paths from a missing legacy keeper/export declaration', () => {
  const { exports: previous, ...legacy } = rootDeploymentFixture()
  expect(previous.manifest.path).toBe('/root-private/manifest.json')
  expect(() => parseRootDeploymentInput(legacy)).toThrow()
  expect(() => parseRootDeploymentInput({ ...legacy, storage: sharedPathDeploymentFixture().storage })).toThrow()
  expect(() => parseRootDeploymentInput({ ...sharedPathDeploymentFixture(), exports: previous })).toThrow()
})

it.each(['relative/plan', '/a/../plan', '//plan', '/plan/', '/', '/a\\plan', '/a\0plan'])('rejects noncanonical plan path %s', (path) => {
  const value = sharedPathDeploymentFixture()
  expect(() => parseRootDeploymentInput({ ...value, storage: { ...value.storage, plan: { ...value.storage.plan, path } } })).toThrow()
})

it.each(['', 'x'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)])('requires an exact lowercase plan SHA256', (sha256) => {
  const value = sharedPathDeploymentFixture()
  expect(() => parseRootDeploymentInput({ ...value, storage: { ...value.storage, plan: { ...value.storage.plan, sha256 } } })).toThrow()
})

it.each(['maxPlanBytes', 'maxMountInfoBytes', 'maxPathBytes', 'maxShares', 'maxResidentBytes'] as const)(
  'rejects invalid explicit %s capacity', (key) => {
    for (const invalid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const value = sharedPathDeploymentFixture()
      expect(() => parseRootDeploymentInput({ ...value, storage: { ...value.storage,
        limits: { ...value.storage.limits, [key]: invalid } } })).toThrow()
    }
  },
)

it('accepts the existing files plan byte ceiling and rejects a larger record budget', () => {
  const value = sharedPathDeploymentFixture(); value.storage.limits.maxPlanBytes = 262144
  expect(parseRootDeploymentInput(value).schema).toBe('pe-opensandbox-root-deployment-v2')
  value.storage.limits.maxPlanBytes++
  expect(() => parseRootDeploymentInput(value)).toThrow()
})

it('rejects a second export/source table and readiness declarations in shared-path input', () => {
  const value = sharedPathDeploymentFixture()
  for (const added of [{ manifest: {} }, { accounts: [] }, { ready: true }]) {
    expect(() => parseRootDeploymentInput({ ...value, storage: { ...value.storage, ...added } })).toThrow()
  }
})
