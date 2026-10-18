/** Private bounded address derivation; no filesystem I/O, resource authority, or account admission. */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AccountRuntimeError } from './errors.ts'
import type { AccountId, AccountLayout, AccountStorageKey, InstanceId } from './types.ts'

/** Explicit address inputs, separate from the root Loader schema and real storage capabilities. */
export interface LayoutDeployment {
  readonly sharedAccountsRoot: string
  readonly localCacheRoot: string
  readonly maxPathBytes: number
}

interface ProjectLayout {
  readonly directoryKey: string
  readonly root: string
  readonly attachmentsRoot: string
  readonly spillRoot: string
}

function invalid(field: string): never {
  throw new AccountRuntimeError('cloud/invalid-config', `Account layout ${field} is invalid or exceeds its explicit path budget`)
}

function budget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid('maxPathBytes')
}

function bounded(value: string, field: string, maxPathBytes: number): void {
  // Length is constant-time; UTF-8 scanning only runs after the character bound holds.
  if (value.length === 0 || value.length > maxPathBytes || Buffer.byteLength(value, 'utf8') > maxPathBytes) invalid(field)
}

function root(value: string, field: string, maxPathBytes: number): void {
  bounded(value, field, maxPathBytes)
  if (!posix.isAbsolute(value) || value.includes('\0') || value.includes('\\') || posix.normalize(value) !== value
    || (value.length > 1 && value.endsWith('/'))) invalid(field)
}

function segment(value: string, field: string, maxPathBytes: number): void {
  bounded(value, field, maxPathBytes)
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) invalid(field)
}

function path(parent: string, maxPathBytes: number, ...segments: string[]): string {
  const result = posix.join(parent, ...segments)
  bounded(result, 'derived path', maxPathBytes)
  return result
}

/**
 * Derive stable addresses using v1 SHA-256 over a domain and the length-framed exact UTF-8 account id.
 * No epoch enters shared paths; only the rebuildable local index contains the startup identity.
 * @param accountId Authenticated identity, bounded before hashing and never concatenated into a path.
 * @param instanceId Current server-generated startup identity, used only as a local-cache segment.
 * @param deployment Explicit normalized POSIX roots and a positive finite UTF-8 path-byte limit.
 * @returns Frozen addresses only; no directories are created, verified, or granted to a caller.
 * @throws AccountRuntimeError for invalid deployment roots, segments, or exceeded bounds, without echoing their values.
 */
export function deriveAccountLayout(accountId: AccountId, instanceId: InstanceId, deployment: LayoutDeployment): AccountLayout {
  const { sharedAccountsRoot, localCacheRoot, maxPathBytes } = deployment
  budget(maxPathBytes)
  root(sharedAccountsRoot, 'sharedAccountsRoot', maxPathBytes)
  root(localCacheRoot, 'localCacheRoot', maxPathBytes)
  bounded(accountId, 'account identity', maxPathBytes)
  segment(instanceId, 'instance identity', maxPathBytes)
  const digest = createHash('sha256').update('dsh-pe/account-storage/v1\0', 'utf8')
    .update(`${Buffer.byteLength(accountId, 'utf8')}:`, 'ascii').update(accountId, 'utf8').digest('hex')
  const storageKey = brandString<AccountStorageKey>(`v1-${digest}`)
  bounded(storageKey, 'storage key', maxPathBytes)
  const accountRoot = path(sharedAccountsRoot, maxPathBytes, storageKey)
  const privateRoot = path(accountRoot, maxPathBytes, 'private')
  const profileRoot = path(privateRoot, maxPathBytes, 'profile')
  return Object.freeze({
    storageKey, accountRoot, privateRoot, profileRoot,
    patchPath: path(profileRoot, maxPathBytes, 'cordis.patch.yml'),
    credentialsRoot: path(privateRoot, maxPathBytes, 'credentials'),
    sessionsRoot: path(privateRoot, maxPathBytes, 'sessions'),
    storageRoot: path(privateRoot, maxPathBytes, 'storage'),
    attachmentsRoot: path(privateRoot, maxPathBytes, 'attachments'),
    skillsRoot: path(privateRoot, maxPathBytes, 'skills'),
    instructionsRoot: path(privateRoot, maxPathBytes, 'instructions'),
    projectsRoot: path(accountRoot, maxPathBytes, 'projects'),
    environmentsRoot: path(accountRoot, maxPathBytes, 'environments'),
    localIndexRoot: path(localCacheRoot, maxPathBytes, instanceId, storageKey, 'session-index'),
  })
}

function project(layout: AccountLayout, directoryKey: string, maxPathBytes: number): ProjectLayout {
  budget(maxPathBytes)
  root(layout.projectsRoot, 'projectsRoot', maxPathBytes)
  const projectRoot = path(layout.projectsRoot, maxPathBytes, directoryKey)
  return Object.freeze({
    directoryKey, root: projectRoot,
    attachmentsRoot: path(projectRoot, maxPathBytes, '.pe', 'attachments'),
    spillRoot: path(projectRoot, maxPathBytes, '.pe', 'spill'),
  })
}

/**
 * Locate the stable server-selected default candidate without initializing a Workspace.
 * Native eligibility, history checks, deletion markers, and basename-derived titles remain native-owned.
 * @param layout Runtime-derived account addresses, carrying no directory authorization.
 * @param maxPathBytes Explicit positive finite UTF-8 limit for every returned address.
 * @returns Frozen default-workspace candidate addresses; existence is not established.
 * @throws AccountRuntimeError for invalid roots or exceeded bounds.
 */
export function defaultProjectLayout(layout: AccountLayout, maxPathBytes: number): ProjectLayout {
  return project(layout, 'default-workspace', maxPathBytes)
}

/**
 * Select one new server UUID directory candidate; the caller retains it through actual preparation.
 * This neither creates nor retries a directory, registers a Workspace, or transfers cleanup responsibility.
 * @param layout Runtime-derived account addresses, carrying no directory authorization.
 * @param maxPathBytes Explicit positive finite UTF-8 limit for every returned address.
 * @returns Frozen candidate addresses with a freshly generated UUID, unrelated to any title.
 * @throws AccountRuntimeError for invalid roots or exceeded bounds.
 */
export function newProjectLayout(layout: AccountLayout, maxPathBytes: number): ProjectLayout {
  return project(layout, randomUUID(), maxPathBytes)
}
