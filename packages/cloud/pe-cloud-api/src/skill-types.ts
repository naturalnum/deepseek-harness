/** Fixed two-file publication JSON. Client types are generated from the concrete Remote methods. */
import type { SkillEditVersion } from './save-hooks.ts'

/** Explicit account request/result and native-provider retention bounds. */
export interface SkillPublicationLimits {
  readonly maxFileBytes: number
  readonly maxRequestBytes: number
  readonly maxReplyBytes: number
  readonly maxRetainedVersions: number
}
/** The only managed pointer is the account's fixed sample bundle. */
export interface SkillCurrentRequest { readonly slot: 'sample' }
/** Two complete files; no path, account identity, archive or native revision is accepted. */
export interface SkillPublishRequest extends SkillCurrentRequest {
  readonly version: SkillEditVersion
  readonly skillMarkdown: string
  readonly resourceBase64: string
}
/** Detached facts from the exact files-issued version, without a private path. */
export interface SkillVersionMetadata {
  readonly id: string
  readonly skillSha256: string
  readonly resourceSha256: string
  readonly skillBytes: number
  readonly resourceBytes: number
}
/** Project guidance is prepared per authorized live load, never by reading publication metadata. */
export type SkillResourceMode = 'unavailable' | 'project-on-load'
/** Current durable pointer and separate native catalog selection/projection capability. */
export interface SkillCurrentState extends SkillCurrentRequest {
  readonly version: SkillEditVersion
  readonly current: SkillVersionMetadata | null
  readonly applied: boolean
  readonly resources: SkillResourceMode
}
/** Persistence and synchronous catalog application are separate facts, never a model-load success claim. */
export type SkillPublishResult = Readonly<{
  persisted: true
  applied: boolean
  version: SkillEditVersion
  current: SkillVersionMetadata
  resources: SkillResourceMode
}> | Readonly<{
  persisted: 'unknown'
  applied: false
  resources: 'unavailable'
}>
