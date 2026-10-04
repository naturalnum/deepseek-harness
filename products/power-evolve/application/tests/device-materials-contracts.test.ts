/** Material wire limits and legacy dispatch bytes, independent from resource authorization. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceDispatchRequest, deviceJob, deviceMaterialSelection, deviceMaterialRequest,
  deviceSkillManifest, deviceSkillMaterial, DEVICE_MATERIAL_MAX_BYTES } from '@power-evolve/contracts/device-execution'

const binding = { skillId: '00000000-0000-4000-8000-000000000001', version: '1.0.0',
  packageDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), instructionDigest: 'c'.repeat(64) }
const legacy = { command: 'pwd', cwd: '', timeoutMs: 1000,
  deviceId: '00000000-0000-4000-8000-000000000002', directoryId: '00000000-0000-4000-8000-000000000003' }

test('legacy dispatch retains its exact representation while supplied material references remain frozen', () => {
  assert.equal(JSON.stringify(deviceDispatchRequest.parse(legacy)),
    '{"command":"pwd","cwd":"","timeoutMs":1000,"deviceId":"00000000-0000-4000-8000-000000000002","directoryId":"00000000-0000-4000-8000-000000000003"}')
  assert(!Object.hasOwn(deviceDispatchRequest.parse(legacy), 'materials'))
  const selected = deviceDispatchRequest.parse({ ...legacy, materials: [binding] })
  assert.deepEqual(selected.materials, [binding])
  assert.equal(deviceDispatchRequest.safeParse({ ...legacy, materials: [] }).success, false)
  assert.equal(deviceMaterialSelection.safeParse([binding, binding]).success, false)
  const job = deviceJob.parse({ executionId: '00000000-0000-4000-8000-000000000004',
    directoryId: legacy.directoryId, command: 'pwd', cwd: '', timeoutMs: 1000,
    digest: 'd'.repeat(64), state: 'queued', cancelRequested: false, materials: [binding] })
  assert.deepEqual(job.materials, selected.materials)
})

test('material access identifies the original dispatch and accepts no user, local path or remote download URL', () => {
  const request = { executionId: '00000000-0000-4000-8000-000000000004',
    instanceId: '00000000-0000-4000-8000-000000000005', processId: '00000000-0000-4000-8000-000000000006',
    dispatchId: '00000000-0000-4000-8000-000000000007', digest: 'd'.repeat(64), skillId: binding.skillId }
  assert.deepEqual(deviceMaterialRequest.parse(request), request)
  for (const extra of [{ userId: binding.skillId }, { localPath: '/private/other-user' }, { url: 'https://example.invalid/package' }]) {
    assert.equal(deviceMaterialRequest.safeParse({ ...request, ...extra }).success, false)
  }
  assert.equal(deviceMaterialRequest.safeParse({ ...request, dispatchId: undefined }).success, false)
})

test('package manifests reject traversal, duplicate names, missing instructions and excess expanded bytes', () => {
  const instruction = { path: 'skill/SKILL.md', size: 0, sha256: binding.instructionDigest }
  const manifest = { schemaVersion: 1, artifactSha256: binding.packageDigest, files: [instruction] }
  assert.equal(deviceSkillManifest.safeParse(manifest).success, true)
  for (const files of [[instruction, instruction], [{ ...instruction, path: 'skill/../secret' }],
    [{ ...instruction, path: 'skill/script.sh' }], [instruction, { path: 'skill/huge', size: DEVICE_MATERIAL_MAX_BYTES + 1,
      sha256: 'a'.repeat(64) }], Array.from({ length: 257 }, (_value, index) => ({ ...instruction, path: `skill/${index}` }))]) {
    assert.equal(deviceSkillManifest.safeParse({ ...manifest, files }).success, false)
  }
})

test('bounded binary responses refuse malformed base64 and aggregate expansion while accepting long canonical data', () => {
  const response = { binding, manifest: '{}', files: [{ path: 'skill/SKILL.md', data: '' }] }
  assert.equal(deviceSkillMaterial.safeParse(response).success, true)
  for (const data of ['AA=', 'AAAA===', 'A A=', '====', 'AA\n=']) {
    assert.equal(deviceSkillMaterial.safeParse({ ...response, files: [{ path: 'skill/SKILL.md', data }] }).success, false)
  }
  const long = Buffer.alloc(2 * 1024 * 1024).toString('base64')
  assert.equal(deviceSkillMaterial.safeParse({ ...response, files: [{ path: 'skill/SKILL.md', data: long }] }).success, true)
  const full = Buffer.alloc(DEVICE_MATERIAL_MAX_BYTES).toString('base64')
  assert.equal(deviceSkillMaterial.safeParse({ ...response, files: [
    { path: 'skill/SKILL.md', data: full }, { path: 'skill/extra', data: 'AA==' },
  ] }).success, false)
})
