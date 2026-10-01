/** Browser-safe execution file observations, verified records and conditional publication. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { fileDownloadPath, FILE_DOWNLOAD_MAX_FILE_BYTES } from './file-download.ts'

/** Maximum candidates in one execution observation. */
export const EXECUTION_FILES_MAX_FILES = 100
/** Maximum execution identities in one Session-scoped read. */
export const EXECUTION_FILES_MAX_EXECUTIONS = 20
/** Platform route for persisted file facts; reading never creates an execution environment. */
export const EXECUTION_FILES_PLATFORM_PATH = '/executions/files'
/** Execution identity returned by the trusted Platform. */
export type FileExecutionId = Branded<'PowerEvolveFileExecutionId'>
/** Session identity owning an execution file query. */
export type FileExecutionSessionId = Branded<'PowerEvolveFileExecutionSessionId'>
/** Workspace identity owning the observed bytes. */
export type FileExecutionWorkspaceId = Branded<'PowerEvolveFileExecutionWorkspaceId'>
/** Native tool call identity used to associate files with the invoking turn. */
export type FileExecutionCallId = Branded<'PowerEvolveFileExecutionCallId'>
const executionId = z.uuid().transform(value => brandString<FileExecutionId>(value))
const sessionId = z.uuid().transform(value => brandString<FileExecutionSessionId>(value))
const workspaceId = z.uuid().transform(value => brandString<FileExecutionWorkspaceId>(value))
const callId = z.string().min(1).max(512).transform(value => brandString<FileExecutionCallId>(value))
const revision = z.string().regex(/^[a-f0-9]{64}$/u)
const scanReasons = z.enum(['budget_exceeded', 'excluded_paths', 'read_failed', 'changed_during_scan', 'scan_unavailable'])
const verificationReasons = z.enum([...scanReasons.options, 'verification_failed', 'legacy_runner', 'execution_unavailable'])

/** An observed file version; parsing alone establishes neither ownership nor existence. */
export const executionProducedFile = z.object({
  path: fileDownloadPath,
  sizeBytes: z.number().int().min(0).max(FILE_DOWNLOAD_MAX_FILE_BYTES),
  sha256: revision,
}).strict()
const files = z.array(executionProducedFile).max(EXECUTION_FILES_MAX_FILES)
  .refine(value => new Set(value.map(file => file.path)).size === value.length)
const status = z.enum(['complete', 'partial', 'unavailable'])

function observationConsistent(value: { status: string; files: readonly unknown[]; reasons: readonly string[] }): boolean {
  if (new Set(value.reasons).size !== value.reasons.length) return false
  if (value.status === 'complete') return value.reasons.length === 0
  if (value.status === 'partial') return value.reasons.length > 0
  return value.files.length === 0 && value.reasons.length > 0
}

/** Untrusted Runner candidates. The Platform must reread each version before persisting facts. */
export const runnerFileChanges = z.object({
  status, files, reasons: z.array(scanReasons).max(scanReasons.options.length),
}).strict().refine(observationConsistent)

/** Persisted Platform-verified versions. Completeness applies to the declared scan scope only. */
export const verifiedExecutionFiles = z.object({
  status, files, reasons: z.array(verificationReasons).max(verificationReasons.options.length),
}).strict().refine(observationConsistent)

/** Read exact execution identities under one authenticated Session. */
export const executionFilesRequest = z.object({
  sessionId,
  executionIds: z.array(executionId).min(1).max(EXECUTION_FILES_MAX_EXECUTIONS)
    .refine(value => new Set(value).size === value.length),
}).strict()

/** Persisted file facts for one execution, including an explicit nonterminal state. */
export const executionFilesItem = z.object({
  executionId, callId,
  state: z.enum(['queued', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'uncertain']),
  status: z.enum(['pending', ...status.options]),
  files, reasons: z.array(verificationReasons).max(verificationReasons.options.length),
}).strict().refine(value => value.status === 'pending'
  ? ['queued', 'starting', 'running', 'cancelling'].includes(value.state)
    && value.files.length === 0 && value.reasons.length === 0
  : !['queued', 'starting', 'running', 'cancelling'].includes(value.state) && observationConsistent(value))

/** Session-scoped facts returned through the Host; physical paths and credentials are absent. */
export const executionFilesView = z.object({
  sessionId, workspaceId, items: z.array(executionFilesItem).max(EXECUTION_FILES_MAX_EXECUTIONS),
}).strict().refine(value => new Set(value.items.map(item => item.executionId)).size === value.items.length)

/** Explicit immutable publication; expectedRevision prevents publishing a later source version. */
export const artifactPublishRequest = z.object({
  requestId: z.uuid(), sessionId: z.uuid(), path: fileDownloadPath, expectedRevision: revision.optional(),
}).strict()

/** Candidate versions supplied by a sandbox Runner. */
export type RunnerFileChanges = z.infer<typeof runnerFileChanges>
/** File versions reread and verified by the trusted Platform. */
export type VerifiedExecutionFiles = z.infer<typeof verifiedExecutionFiles>
/** One bounded file observation without file bytes. */
export type ExecutionProducedFile = z.infer<typeof executionProducedFile>
/** Validated Session-scoped query input. */
export type ExecutionFilesRequest = z.infer<typeof executionFilesRequest>
/** Validated persisted facts returned to the native client. */
export type ExecutionFilesView = z.infer<typeof executionFilesView>
/** One execution's state and verified file versions. */
export type ExecutionFilesItem = z.infer<typeof executionFilesItem>
