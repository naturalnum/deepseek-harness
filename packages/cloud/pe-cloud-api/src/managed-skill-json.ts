/** Strict management JSON; files retains all archive, path, tree and storage validation. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import type { OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillEditToken, SkillEditVersion } from './save-hooks.ts'
import type { ManagedSkillApiLimits, ManagedSkillBundleUpload, ManagedSkillContentVersion,
  ManagedSkillDetails, ManagedSkillDetailsRequest, ManagedSkillDownload, ManagedSkillDownloadRequest,
  ManagedSkillEntry, ManagedSkillFileMetadata, ManagedSkillId, ManagedSkillInstallRequest,
  ManagedSkillMutationResult, ManagedSkillOrigin, ManagedSkillPublicLimits, ManagedSkillSelection,
  ManagedSkillsInstalled, ManagedSkillsInstalledRequest, ManagedSkillUninstallRequest,
  ManagedSkillUpdateRequest } from './managed-skill-types.ts'
import { CloudApiError } from './errors.ts'

type Strict<T> = Extract<TypertCodec<T>, { mode: 'strict' }>
function invalid(): never { throw new CloudApiError('cloud/forbidden', 'The managed skill JSON or finite byte limit is invalid.') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value }

/**
 * Validate the explicitly configured API residence/transport/provider limits.
 * @param input Root-owned finite values; no deployment default is supplied.
 * @returns Detached immutable values, or a configuration refusal.
 */
export function managedSkillApiLimits(input: ManagedSkillApiLimits): Readonly<ManagedSkillApiLimits> {
  const keys = ['maxRequestBytes', 'maxReplyBytes', 'maxMetadataBytes', 'maxRetainedProviders'] as const
  const row = record(input, keys)
  if (Object.keys(row).length !== keys.length) invalid()
  for (const key of keys) integer(row[key], 1)
  if (input.maxRetainedProviders > 65536 || keys.slice(0, 3).some(key => input[key] > 2147483647)) invalid()
  return Object.freeze({ ...input })
}

/** Strict codecs shared by the concrete management methods and their generated descriptors. */
export interface ManagedSkillCodecs {
  readonly installed: Strict<ManagedSkillsInstalledRequest>
  readonly details: Strict<ManagedSkillDetailsRequest>
  readonly install: Strict<ManagedSkillInstallRequest>
  readonly update: Strict<ManagedSkillUpdateRequest>
  readonly uninstall: Strict<ManagedSkillUninstallRequest>
  readonly download: Strict<ManagedSkillDownloadRequest>
  readonly installedResult: Strict<ManagedSkillsInstalled>
  readonly detailsResult: Strict<ManagedSkillDetails>
  readonly mutationResult: Strict<ManagedSkillMutationResult>
  readonly downloadResult: Strict<ManagedSkillDownload>
}

/**
 * Construct JSON codecs without I/O, registration, archive decoding or output-side Remote decoding.
 * @param configured Root's exact API limits; the files owner separately enforces its physical policy.
 * @returns Complete request/result codecs for the six concrete methods.
 */
export function managedSkillCodecs(configured: ManagedSkillApiLimits): ManagedSkillCodecs {
  const limits = managedSkillApiLimits(configured)
  const bounded = <T>(value: T, maximum: number): T => {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum) invalid()
    return value
  }
  const text = (value: unknown, maximum = limits.maxMetadataBytes): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum
      || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value || value.includes('\0')) invalid()
    return value
  }
  const digest = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
    return value
  }
  const base64 = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || value.length > maximum
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid()
    if (Buffer.from(value, 'base64').toString('base64') !== value) invalid()
    return value
  }
  const id = (value: unknown): ManagedSkillId => {
    const result = text(value)
    if (result !== 'sample' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result)) invalid()
    return brandString<ManagedSkillId>(result)
  }
  const contentVersion = (value: unknown): ManagedSkillContentVersion =>
    brandString<ManagedSkillContentVersion>(text(value))
  const version = (value: unknown): SkillEditVersion => {
    const row = record(value, ['epoch', 'editToken'])
    const epoch = text(row.epoch), editToken = text(row.editToken)
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(editToken)) invalid()
    return { epoch: brandString<OwnerEpoch>(epoch), editToken: brandString<SkillEditToken>(editToken) }
  }
  const bundle = (value: unknown): ManagedSkillBundleUpload => {
    const row = record(value, ['kind', 'files', 'dataBase64'])
    if (row.kind === 'zip') {
      if (Object.hasOwn(row, 'files')) invalid()
      return { kind: 'zip', dataBase64: base64(row.dataBase64, limits.maxRequestBytes) }
    }
    if (row.kind !== 'files' || Object.hasOwn(row, 'dataBase64') || !Array.isArray(row.files)
      || row.files.length === 0 || row.files.length > limits.maxRequestBytes) invalid()
    return { kind: 'files', files: row.files.map((value) => {
      const file = record(value, ['relativePath', 'dataBase64'])
      return { relativePath: text(file.relativePath), dataBase64: base64(file.dataBase64, limits.maxRequestBytes) }
    }) }
  }
  const origin = (value: unknown): ManagedSkillOrigin => {
    const row = record(value, ['name', 'source', 'provider'])
    return { name: text(row.name), source: text(row.source), provider: text(row.provider) }
  }
  const selection = (value: unknown): ManagedSkillSelection => {
    const row = record(value, ['kind', 'by'])
    if (row.kind === 'shadowed') return { kind: 'shadowed', by: origin(row.by) }
    if (Object.hasOwn(row, 'by')) invalid()
    if (row.kind === 'effective' || row.kind === 'incomplete') return { kind: row.kind }
    return invalid()
  }
  const entry = (value: unknown): ManagedSkillEntry => {
    const row = record(value, ['skillId', 'name', 'description', 'invocation', 'source', 'provider', 'contentVersion',
      'fileCount', 'contentBytes', 'legacySample', 'selection', 'mutable', 'actions'])
    const invocation = record(row.invocation, ['modelInvocable', 'userInvocable'])
    const actions = record(row.actions, ['update', 'uninstall', 'download'])
    const mutable = bool(row.mutable)
    if (!mutable && (actions.update === true || actions.uninstall === true)) invalid()
    return bounded({ skillId: id(row.skillId), name: text(row.name), description: text(row.description),
      invocation: { modelInvocable: bool(invocation.modelInvocable), userInvocable: bool(invocation.userInvocable) },
      source: text(row.source), provider: text(row.provider), contentVersion: contentVersion(row.contentVersion),
      fileCount: integer(row.fileCount, 1), contentBytes: integer(row.contentBytes), legacySample: bool(row.legacySample),
      selection: selection(row.selection), mutable, actions: { update: bool(actions.update),
        uninstall: bool(actions.uninstall), download: bool(actions.download) } }, limits.maxMetadataBytes)
  }
  const fileMetadata = (value: unknown): ManagedSkillFileMetadata => {
    const row = record(value, ['relativePath', 'bytes', 'sha256'])
    return { relativePath: text(row.relativePath), bytes: integer(row.bytes), sha256: digest(row.sha256) }
  }
  const publicLimits = (value: unknown): ManagedSkillPublicLimits => {
    const keys = ['maxSkills', 'maxFilesPerBundle', 'maxDirectoriesPerBundle', 'maxFileBytes', 'maxBundleBytes',
      'maxZipBytes', 'maxPathBytes', 'maxPathDepth', 'maxRequestBytes', 'maxReplyBytes'] as const
    const row = record(value, keys)
    return { maxSkills: integer(row.maxSkills, 1), maxFilesPerBundle: integer(row.maxFilesPerBundle, 1),
      maxDirectoriesPerBundle: integer(row.maxDirectoriesPerBundle), maxFileBytes: integer(row.maxFileBytes, 1),
      maxBundleBytes: integer(row.maxBundleBytes, 1), maxZipBytes: integer(row.maxZipBytes, 1),
      maxPathBytes: integer(row.maxPathBytes, 1), maxPathDepth: integer(row.maxPathDepth, 1),
      maxRequestBytes: integer(row.maxRequestBytes, 1), maxReplyBytes: integer(row.maxReplyBytes, 1) }
  }
  const codec = <T>(name: string, parse: (value: unknown) => T): Strict<T> => ({
    mode: 'strict', typeSymbol: '@deepseek-ai/dsh-pe-cloud-api/' + name,
    create: () => ({ parse }), decode: parse, encode: value => parse(value),
  })
  return {
    installed: codec('ManagedSkillsInstalledRequest', (value) => {
      const row = record(value, ['workspaceId'])
      return bounded(row.workspaceId === undefined ? {} : { workspaceId: brandString<Workspace['id']>(text(row.workspaceId)) }, limits.maxRequestBytes)
    }),
    details: codec('ManagedSkillDetailsRequest', (value) => {
      const row = record(value, ['skillId'])
      return bounded({ skillId: id(row.skillId) }, limits.maxRequestBytes)
    }),
    install: codec('ManagedSkillInstallRequest', (value) => {
      const row = record(value, ['version', 'bundle'])
      return bounded({ version: version(row.version), bundle: bundle(row.bundle) }, limits.maxRequestBytes)
    }),
    update: codec('ManagedSkillUpdateRequest', (value) => {
      const row = record(value, ['skillId', 'version', 'bundle'])
      return bounded({ skillId: id(row.skillId), version: version(row.version), bundle: bundle(row.bundle) }, limits.maxRequestBytes)
    }),
    uninstall: codec('ManagedSkillUninstallRequest', (value) => {
      const row = record(value, ['skillId', 'version'])
      return bounded({ skillId: id(row.skillId), version: version(row.version) }, limits.maxRequestBytes)
    }),
    download: codec('ManagedSkillDownloadRequest', (value) => {
      const row = record(value, ['skillId', 'contentVersion'])
      return bounded({ skillId: id(row.skillId), contentVersion: contentVersion(row.contentVersion) }, limits.maxRequestBytes)
    }),
    installedResult: codec('ManagedSkillsInstalled', (value) => {
      const row = record(value, ['entries', 'version', 'complete', 'actions', 'limits'])
      const actions = record(row.actions, ['install'])
      if (!Array.isArray(row.entries) || row.entries.length > limits.maxReplyBytes) invalid()
      return bounded({ entries: row.entries.map(entry), version: version(row.version), complete: bool(row.complete),
        actions: { install: bool(actions.install) }, limits: publicLimits(row.limits) }, limits.maxReplyBytes)
    }),
    detailsResult: codec('ManagedSkillDetails', (value) => {
      const row = record(value, ['entry', 'files', 'version'])
      if (!Array.isArray(row.files) || row.files.length > limits.maxReplyBytes) invalid()
      const parsed = entry(row.entry), files = row.files.map(fileMetadata)
      if (parsed.fileCount !== files.length || parsed.contentBytes !== files.reduce((sum, file) => sum + file.bytes, 0)) invalid()
      return bounded({ entry: parsed, files, version: version(row.version) }, limits.maxReplyBytes)
    }),
    mutationResult: codec('ManagedSkillMutationResult', (value) => {
      const row = record(value, ['persisted', 'applied', 'version', 'entry'])
      if (row.persisted === 'unknown') {
        if (row.applied !== false || Object.hasOwn(row, 'version') || Object.hasOwn(row, 'entry')) invalid()
        return bounded({ persisted: 'unknown', applied: false }, limits.maxReplyBytes)
      }
      if (row.persisted !== true) invalid()
      return bounded({ persisted: true, applied: bool(row.applied), version: version(row.version),
        entry: row.entry === null ? null : entry(row.entry) }, limits.maxReplyBytes)
    }),
    downloadResult: codec('ManagedSkillDownload', (value) => {
      const row = record(value, ['skillId', 'contentVersion', 'fileName', 'mediaType', 'bytes', 'sha256', 'dataBase64'])
      if (row.mediaType !== 'application/zip') invalid()
      const dataBase64 = base64(row.dataBase64, limits.maxReplyBytes), bytes = integer(row.bytes)
      if (Buffer.from(dataBase64, 'base64').byteLength !== bytes) invalid()
      return bounded({ skillId: id(row.skillId), contentVersion: contentVersion(row.contentVersion),
        fileName: text(row.fileName), mediaType: 'application/zip', bytes, sha256: digest(row.sha256), dataBase64 }, limits.maxReplyBytes)
    }),
  }
}
