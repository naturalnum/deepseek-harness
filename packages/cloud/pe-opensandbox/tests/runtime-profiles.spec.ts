/** Closed binary profiles and original source guards; no transport, SDK or resource is constructed. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { RUNTIME_PROFILES, isRuntimePlatform } from '../src/bootstrap/runtime-profiles.ts'
import { checkOptions, expectedWorldHash } from '../src/agent-data/validate.ts'
import { AGENT_SOURCE_SHA256 } from '../src/agent-data/constants.ts'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'
import { qualifiedSupplierTuples, isQualifiedSupplierPair } from '../src/bootstrap/qualified-suppliers.ts'
import { sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

it('keeps original Python binary, recipe and historical owner guards', () => {
  const script = fileURLToPath(new URL('./test_runtime_architecture.py', import.meta.url))
  execFileSync('python3', ['-I', '-S', '-B', script],
    { timeout: 10000, stdio: 'pipe' })
  const observed: unknown = JSON.parse(execFileSync('python3', ['-I', '-S', '-B', script, '--profiles'],
    { timeout: 10000, encoding: 'utf8' }))
  const expected = Object.fromEntries(Object.entries(RUNTIME_PROFILES).map(([platform, profile]) =>
    [platform, [profile.bwrapSha256, profile.bwrapBytes, profile.elfMachine]]))
  expect(observed).toEqual({ 'agent/launcher.py': expected, 'bootstrap/publisher.py': expected })
})

it.each(['arm64', 'amd64'] as const)('binds %s to its own exact local binary pins', (platform) => {
  const expected = { platform, physicalSandboxId: 'sandbox-1', runtimeIdentity: '1'.repeat(64), projectRoot: '/project',
    declaredImageId: 'sha256:' + '2'.repeat(64), roots: {
      project: { device: '1', inode: '2', maximumBytes: '4096', maximumInodes: '8' },
      environment: { device: '3', inode: '4', maximumBytes: '4096', maximumInodes: '8' },
    }, pins: { bwrapSha256: RUNTIME_PROFILES[platform].bwrapSha256, agentSourceSha256: AGENT_SOURCE_SHA256,
      userWorldArgvSha256: expectedWorldHash('/project') } }
  const options = { host: '127.0.0.1', port: 8080, token: '3'.repeat(64), expected }
  expect(checkOptions(options).expected).toEqual(expected)
  const other = platform === 'arm64' ? 'amd64' : 'arm64'
  expect(() => checkOptions({ ...options, expected: { ...expected, platform: other } })).toThrow('unexpected_frozen_payload')
  expect(() => checkOptions({ ...options, expected: { ...expected,
    pins: { ...expected.pins, agentSourceSha256: '0'.repeat(64) } } })).toThrow('unexpected_frozen_payload')
})

it('preserves all ARM suppliers and refuses platform or execd mixing before remote work', () => {
  expect(qualifiedSupplierTuples).toHaveLength(9)
  for (const tuple of qualifiedSupplierTuples.slice(0, 8)) {
    expect(tuple.platform).toBe('arm64')
    expect(tuple.execdImageDigest).toBe(RUNTIME_PROFILES.arm64.execdImageDigest)
    expect(isQualifiedSupplierPair(tuple.schema, tuple.workloadImageDigest, tuple.serverImageDigest,
      'arm64', tuple.execdImageDigest)).toBe(true)
    expect(isQualifiedSupplierPair(tuple.schema, tuple.workloadImageDigest, tuple.serverImageDigest,
      'amd64', tuple.execdImageDigest)).toBe(false)
    expect(isQualifiedSupplierPair(tuple.schema, tuple.workloadImageDigest, tuple.serverImageDigest,
      'arm64', RUNTIME_PROFILES.amd64.execdImageDigest)).toBe(false)
  }
  const input = sharedPathDeploymentFixture()
  expect(() => parseRootDeploymentInput({ ...input,
    lifecycle: { ...input.lifecycle, platform: 'amd64' } })).toThrow('selection.workloadImagePair')
  expect(() => parseRootDeploymentInput({ ...input,
    selection: { ...input.selection, execdImageDigest: RUNTIME_PROFILES.amd64.execdImageDigest } })).toThrow('selection.workloadImagePair')
  expect(() => parseRootDeploymentInput({ ...input, lifecycle: { ...input.lifecycle, platform: 'amd64',
    imageDigest: 'sha256:84d3c8cd1520dfb2b088f9d3dbd296f4d18fabed3b18fb0aea01e6e378f9d5eb' } })).toThrow('selection.workloadImagePair')
  for (const value of ['x86_64', 'aarch64', 'auto', '', null]) expect(isRuntimePlatform(value)).toBe(false)
})
