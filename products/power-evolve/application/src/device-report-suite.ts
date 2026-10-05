/** Stable report layout identities shared by the Platform and Device; this module grants no authority. */
import { createHash } from 'node:crypto'
import { deviceMaterialSelection, deviceReportSuite, type DeviceMaterialBinding,
  type DeviceReportSuite } from '@power-evolve/contracts/device-execution'

/**
 * Bind the fixed four roles to complete accepted package references. Additional selected packages
 * and their order do not change this layout; each referenced package must occur exactly once.
 * @param members Fixed role order and Platform-selected private skill identities.
 * @param materials Validated package references belonging to the accepted dispatch.
 * @returns Canonical description whose digest covers each role and its complete package binding.
 */
export function createDeviceReportSuite(members: DeviceReportSuite['members'],
  materials: readonly DeviceMaterialBinding[]): DeviceReportSuite {
  const parsedMembers = deviceReportSuite.shape.members.parse(members)
  const parsedMaterials = deviceMaterialSelection.parse(materials)
  const bindings = parsedMembers.map(member => {
    const binding = parsedMaterials.find(item => item.skillId === member.skillId)
    if (!binding) throw new Error('device_report_suite_materials_missing')
    return { role: member.role, binding }
  })
  const digest = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, members: bindings })).digest('hex')
  return deviceReportSuite.parse({ schemaVersion: 1, digest, members: parsedMembers })
}

/**
 * Verify a wire or journal description against its original immutable package selection.
 * A changed member, version, archive, manifest or instruction digest rejects the layout.
 * @param suite Description frozen in the original dispatch.
 * @param materials Original dispatch package bindings, not current user configuration.
 * @returns Canonical verified description; no filesystem read or execution is performed.
 */
export function validateDeviceReportSuite(suite: DeviceReportSuite,
  materials: readonly DeviceMaterialBinding[]): DeviceReportSuite {
  const parsed = deviceReportSuite.parse(suite)
  const canonical = createDeviceReportSuite(parsed.members, materials)
  if (canonical.digest !== parsed.digest) throw new Error('device_report_suite_digest_mismatch')
  return canonical
}
