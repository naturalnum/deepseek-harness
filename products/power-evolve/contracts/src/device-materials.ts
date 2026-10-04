/** Browser-safe records for immutable skill bytes delivered to an original Device dispatch. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Selected private skill identity; it is not a caller-selected storage path. */
export type DeviceMaterialSkillId = Branded<'power-evolve/DeviceMaterialSkillId'>
/** Digest of an immutable skill archive, manifest, or instruction body. */
export type DeviceMaterialDigest = Branded<'power-evolve/DeviceMaterialDigest'>
const digest = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<DeviceMaterialDigest>(value))
/** The existing upload protocol's maximum expanded bytes in one skill package. */
export const DEVICE_MATERIAL_MAX_BYTES = 8 * 1024 * 1024
/** The existing upload protocol's maximum regular files in one skill package. */
export const DEVICE_MATERIAL_MAX_FILES = 256
const path = z.string().min(7).max(4096).refine(value => value.startsWith('skill/')
  && !/[\\:\0]/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))

/** Package references frozen from the accepted Operation, not the user's later installed version. */
export const deviceMaterialBinding = z.object({
  skillId: z.uuid().transform(value => brandString<DeviceMaterialSkillId>(value)),
  version: z.string().min(1).max(128), packageDigest: digest, manifestDigest: digest, instructionDigest: digest,
}).strict()
/** An absent selection preserves the original dispatch representation; an empty supplied selection is refused. */
export const deviceMaterialSelection = z.array(deviceMaterialBinding).min(1).max(256).superRefine((items, ctx) => {
  if (new Set(items.map(item => item.skillId)).size !== items.length
    || new Set(items.map(item => item.packageDigest)).size !== items.length) {
    ctx.addIssue({ code: 'custom', message: 'device_material_selection_duplicate' })
  }
})
/** The original published manifest; it describes normalized regular files rather than a new ZIP. */
export const deviceSkillManifest = z.object({ schemaVersion: z.literal(1), artifactSha256: digest,
  files: z.array(z.object({ path, size: z.number().int().min(0).max(DEVICE_MATERIAL_MAX_BYTES), sha256: digest }).strict())
    .min(1).max(DEVICE_MATERIAL_MAX_FILES),
}).strict().superRefine((manifest, ctx) => {
  if (!manifest.files.some(file => file.path === 'skill/SKILL.md')
    || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
    || manifest.files.reduce((sum, file) => sum + file.size, 0) > DEVICE_MATERIAL_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'device_material_manifest_invalid' })
  }
})
const data = z.string().max(4 * Math.ceil(DEVICE_MATERIAL_MAX_BYTES / 3))
  .refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value))
/** One bounded package response; consumers verify its manifest digest and every decoded file before use. */
export const deviceSkillMaterial = z.object({ binding: deviceMaterialBinding,
  manifest: z.string().min(1).max(128 * 1024),
  files: z.array(z.object({ path, data }).strict()).min(1).max(DEVICE_MATERIAL_MAX_FILES),
}).strict().superRefine((material, ctx) => {
  const bytes = material.files.reduce((sum, file) => sum + file.data.length / 4 * 3
    - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0), 0)
  if (new Set(material.files.map(file => file.path)).size !== material.files.length || bytes > DEVICE_MATERIAL_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'device_material_bytes_invalid' })
  }
})
/** Validated immutable package reference, bound by the command request digest. */
export type DeviceMaterialBinding = z.infer<typeof deviceMaterialBinding>
/** Validated original per-file manifest; byte digests remain the consumer's obligation. */
export type DeviceSkillManifest = z.infer<typeof deviceSkillManifest>
/** Validated bounded transfer response; parsing supplies no execution authority. */
export type DeviceSkillMaterial = z.infer<typeof deviceSkillMaterial>
