/** Original Device dispatch compatibility and report layout identity checks. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { deviceClaim, deviceDispatchRequest, deviceJob, deviceMaterialBinding, deviceReportSuite,
  DEVICE_REPORT_SUITE_ROLES, type DeviceMaterialBinding, type DeviceReportSuite } from '@power-evolve/contracts/device-execution'
import { createDeviceReportSuite, validateDeviceReportSuite } from '../src/device-report-suite.ts'

const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444']
const bindings = ids.map((skillId, i) => deviceMaterialBinding.parse({ skillId, version:'1.0.0',
  packageDigest: String(i+1).repeat(64), manifestDigest:'a'.repeat(64), instructionDigest:'b'.repeat(64) }))
const members: DeviceReportSuite['members'] = [
  {role:DEVICE_REPORT_SUITE_ROLES[0],skillId:bindings[0]!.skillId},
  {role:DEVICE_REPORT_SUITE_ROLES[1],skillId:bindings[1]!.skillId},
  {role:DEVICE_REPORT_SUITE_ROLES[2],skillId:bindings[2]!.skillId},
  {role:DEVICE_REPORT_SUITE_ROLES[3],skillId:bindings[3]!.skillId},
]
const original = { command:'git status', cwd:'.', timeoutMs:1000, deviceId:ids[0],directoryId:ids[1] }

test('absent report metadata preserves original dispatch JSON and digest', () => {
  const parsed=deviceDispatchRequest.parse(original)
  assert.equal(JSON.stringify(parsed),JSON.stringify(original))
  assert.equal(createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
    '21aa91738d01bf226cc446c389f36c9eff1c9d6c723f6b1f1bf4d311659e79cb')
})

test('four siblings remain stable across selection order and unrelated packages', () => {
  const extra=deviceMaterialBinding.parse({...bindings[0],skillId:ids[0]!.replace('11111111','55555555'),packageDigest:'c'.repeat(64)})
  const suite=createDeviceReportSuite(members,bindings)
  assert.deepEqual(createDeviceReportSuite(members,[extra,...bindings.toReversed()]),suite)
  assert.deepEqual(validateDeviceReportSuite(suite,bindings),suite)
  assert(deviceDispatchRequest.safeParse({...original,materials:bindings,reportSuite:suite}).success)
})

test('every package identity component participates in the layout digest', () => {
  const suite=createDeviceReportSuite(members,bindings)
  const changes: Partial<DeviceMaterialBinding>[]=[{version:'1.0.1'},{packageDigest:deviceMaterialBinding.shape.packageDigest.parse('c'.repeat(64))},
    {manifestDigest:deviceMaterialBinding.shape.manifestDigest.parse('c'.repeat(64))},
    {instructionDigest:deviceMaterialBinding.shape.instructionDigest.parse('c'.repeat(64))}]
  for(const change of changes)assert.throws(()=>validateDeviceReportSuite(suite,[{...bindings[0]!,...change},...bindings.slice(1)]),/digest_mismatch/)
  const changedId=deviceMaterialBinding.shape.skillId.parse(ids[0]!.replace('11111111','55555555'))
  const changedMembers: DeviceReportSuite['members']=[{...members[0],skillId:changedId},members[1],members[2],members[3]]
  assert.notEqual(createDeviceReportSuite(changedMembers,[{...bindings[0]!,skillId:changedId},...bindings.slice(1)]).digest,suite.digest)
})

test('roles, duplicate members, missing packages and changed digest reject', () => {
  const suite=createDeviceReportSuite(members,bindings)
  assert(!deviceReportSuite.safeParse({...suite,members:[members[1],members[0],members[2],members[3]]}).success)
  assert(!deviceReportSuite.safeParse({...suite,members:[members[0],{...members[1],skillId:members[0].skillId},members[2],members[3]]}).success)
  assert.throws(()=>createDeviceReportSuite(members,bindings.slice(1)),/materials_missing/)
  assert.throws(()=>validateDeviceReportSuite({...suite,digest:deviceReportSuite.shape.digest.parse('c'.repeat(64))},bindings),/digest_mismatch/)
})

test('all wire records reject a report without its selected members', () => {
  const suite=createDeviceReportSuite(members,bindings)
  assert(!deviceDispatchRequest.safeParse({...original,reportSuite:suite}).success)
  const command={executionId:ids[2],directoryId:ids[1],command:'true',cwd:'.',timeoutMs:1000,digest:'a'.repeat(64),reportSuite:suite}
  assert(!deviceJob.safeParse({...command,state:'queued',cancelRequested:false}).success)
  assert(!deviceClaim.safeParse({...command,dispatchId:ids[0],processId:ids[3]}).success)
})
