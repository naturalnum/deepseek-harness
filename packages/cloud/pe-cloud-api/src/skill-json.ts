/** Closed request JSON and bounded metadata for the fixed sample skill. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillEditToken, SkillEditVersion } from './save-hooks.ts'
import type { SkillCurrentRequest, SkillCurrentState, SkillPublicationLimits, SkillPublishRequest, SkillPublishResult } from './skill-types.ts'
import { CloudApiError } from './errors.ts'

function invalid(): never { throw new CloudApiError('cloud/forbidden', 'The skill JSON fields or complete byte limit are invalid.') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
/** Validate only explicit deployment bounds; this enables no publication.
 * @param input Required Root limits.
 * @returns Detached finite limits.
 */
export function skillPublicationLimits(input: SkillPublicationLimits): Readonly<SkillPublicationLimits> {
  const names = ['maxFileBytes', 'maxRequestBytes', 'maxReplyBytes', 'maxRetainedVersions'] as const
  for (const name of names) if (!Number.isSafeInteger(input[name]) || input[name] < 1) invalid()
  if (Object.keys(input).length !== 4 || Object.keys(input).some(name => !(names as readonly string[]).includes(name))
    || input.maxReplyBytes < 2048
    || !Number.isSafeInteger(8 * input.maxFileBytes + 4096)) invalid()
  return Object.freeze({ ...input })
}
/** Materialize closed JSON codecs without registering a handler.
 * @param input Root bounds.
 * @returns Strict request/result codecs; Remote methods perform no output decode.
 */
export function skillCodecs(input: SkillPublicationLimits): Readonly<{
  current: Extract<TypertCodec<SkillCurrentRequest>, { mode: 'strict' }>
  publish: Extract<TypertCodec<SkillPublishRequest>, { mode: 'strict' }>
  state: Extract<TypertCodec<SkillCurrentState>, { mode: 'strict' }>
  result: Extract<TypertCodec<SkillPublishResult>, { mode: 'strict' }>
}> {
  const limits = skillPublicationLimits(input)
  const bounded = <T>(value: T, maximum: number): T => {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum) invalid()
    return value
  }
  const edit = (value: unknown): SkillEditVersion => {
    const row = record(value, ['epoch', 'editToken'])
    if (typeof row.epoch !== 'string' || row.epoch.length < 1 || Buffer.byteLength(row.epoch) > 128
      || typeof row.editToken !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.editToken)) invalid()
    return { epoch: brandString<OwnerEpoch>(row.epoch), editToken: brandString<SkillEditToken>(row.editToken) }
  }
  const reference = (row: Record<string, unknown>): SkillCurrentRequest => {
    if (row.slot !== 'sample') invalid()
    return { slot: 'sample' }
  }
  const codec = <T>(name: string, parse: (value: unknown) => T): Extract<TypertCodec<T>, { mode: 'strict' }> => ({
    mode: 'strict', typeSymbol: '@deepseek-ai/dsh-pe-cloud-api/' + name,
    create: () => ({ parse }), decode: parse, encode: value => parse(value),
  })
  const current = codec<SkillCurrentRequest>('SkillCurrentRequest', value =>
    bounded(reference(record(value, ['slot'])), limits.maxRequestBytes))
  const publish = codec<SkillPublishRequest>('SkillPublishRequest', (value) => {
    const row = record(value, ['slot', 'version', 'skillMarkdown', 'resourceBase64'])
    if (typeof row.skillMarkdown !== 'string' || row.skillMarkdown.length > limits.maxFileBytes
      || Buffer.byteLength(row.skillMarkdown) > limits.maxFileBytes
      || Buffer.from(row.skillMarkdown).toString('utf8') !== row.skillMarkdown
      || typeof row.resourceBase64 !== 'string' || row.resourceBase64.length > 4 * Math.ceil(limits.maxFileBytes / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.resourceBase64)) invalid()
    const bytes = Buffer.from(row.resourceBase64, 'base64')
    if (bytes.byteLength > limits.maxFileBytes || bytes.toString('base64') !== row.resourceBase64) invalid()
    return bounded({ ...reference(row), version: edit(row.version), skillMarkdown: row.skillMarkdown,
      resourceBase64: row.resourceBase64 }, limits.maxRequestBytes)
  })
  const state = codec<SkillCurrentState>('SkillCurrentState', (value) => {
    const row = record(value, ['slot', 'version', 'current', 'applied', 'resources'])
    if ((row.resources !== 'unavailable' && row.resources !== 'project-on-load') || typeof row.applied !== 'boolean') invalid()
    const current = versionMetadata(row.current)
    if (row.resources === 'project-on-load' && (!row.applied || current === null)) invalid()
    return bounded({ ...reference(row), version: edit(row.version), current,
      applied: row.applied, resources: row.resources }, limits.maxReplyBytes)
  })
  const result = codec<SkillPublishResult>('SkillPublishResult', (value) => {
    const row = record(value, ['persisted', 'applied', 'version', 'current', 'resources'])
    if ((row.resources !== 'unavailable' && row.resources !== 'project-on-load') || typeof row.applied !== 'boolean') invalid()
    if (row.persisted === 'unknown') {
      if (row.applied || row.resources !== 'unavailable' || row.version !== undefined || row.current !== undefined) invalid()
      return bounded({ persisted: 'unknown', applied: false, resources: 'unavailable' }, limits.maxReplyBytes)
    }
    if (row.persisted !== true) invalid()
    if (!row.applied && row.resources !== 'unavailable') invalid()
    const current = versionMetadata(row.current)
    if (current === null) invalid()
    return bounded({ persisted: true, applied: row.applied, version: edit(row.version), current,
      resources: row.resources }, limits.maxReplyBytes)
  })
  return { current, publish, state, result }
}

function versionMetadata(value: unknown): SkillCurrentState['current'] {
  if (value === null) return null
  const row = record(value, ['id', 'skillSha256', 'resourceSha256', 'skillBytes', 'resourceBytes'])
  if (typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)
    || typeof row.skillSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.skillSha256)
    || typeof row.resourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.resourceSha256)
    || typeof row.skillBytes !== 'number' || !Number.isSafeInteger(row.skillBytes) || row.skillBytes < 0
    || typeof row.resourceBytes !== 'number' || !Number.isSafeInteger(row.resourceBytes) || row.resourceBytes < 0) invalid()
  return { id: row.id, skillSha256: row.skillSha256, resourceSha256: row.resourceSha256,
    skillBytes: row.skillBytes, resourceBytes: row.resourceBytes }
}
