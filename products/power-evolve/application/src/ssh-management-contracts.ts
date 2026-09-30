/** Personal SSH management records. Secret values are accepted only by direct Platform upload. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { RequestId } from './contracts.ts'

/** Stable SSH connection identity, retained after deletion for calls and audit records. */
export type SshConnectionId = Branded<'PowerEvolveSshConnectionId'>
/** Validate a connection UUID at a wire or database boundary. */
export const sshConnectionId = z.uuid().transform(value => brandString<SshConnectionId>(value))
/** Validate the common request identity without a runtime dependency on legacy contracts. */
export const sshManagementRequestId = z.uuid().transform(value => brandString<RequestId>(value))

/** Maximum serialized credential envelope, including JSON escaping of bounded secret fields. */
export const SSH_CREDENTIAL_UPLOAD_MAX_BYTES = 65_536
const revision = z.number().int().positive().max(2_147_483_647)
const label = z.string().trim().min(1).max(100)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const secret = (bytes: number) => z.string().min(1).max(bytes)
  .refine(value => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= bytes
    && Buffer.from(value, 'utf8').toString('utf8') === value)

/** Metadata-only secret instructions; retention is explicit and checked against the owned source. */
export const sshAuthenticationPlan = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), password: z.enum(['retain', 'replace']) }).strict(),
  z.object({ kind: z.literal('private_key'), privateKey: z.enum(['retain', 'replace']),
    passphrase: z.enum(['retain', 'replace', 'clear']) }).strict(),
])

/** Complete replacement configuration. Working directories are remote paths, never local mounts. */
export const sshConfigurationInput = z.object({
  displayName: label,
  host: z.string().trim().min(1).max(253).refine(value => !/[\s\u0000-\u001f\u007f/@?#]/u.test(value)),
  port: z.number().int().min(1).max(65_535),
  username: label.refine(value => !/\s/u.test(value) && Buffer.byteLength(value, 'utf8') <= 256
    && Buffer.from(value, 'utf8').toString('utf8') === value),
  hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
  workingDirectory: z.string().min(1).max(1024)
    .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
      && Buffer.from(value, 'utf8').toString('utf8') === value).nullable(),
  authentication: sshAuthenticationPlan,
  enabled: z.boolean(),
}).strict()
/** Full owner-scoped configuration input, with no secret values. */
export type SshConfigurationInput = z.infer<typeof sshConfigurationInput>

const createBase = z.object({ requestId: sshManagementRequestId, configuration: sshConfigurationInput }).strict()
const newCredentials = (input: { configuration: SshConfigurationInput }): boolean => {
  const auth = input.configuration.authentication
  return auth.kind === 'password' ? auth.password === 'replace'
    : auth.privateKey === 'replace' && auth.passphrase !== 'retain'
}
/** Creation cannot retain a credential from an unspecified connection. */
export const sshConnectionCreateRequest = createBase.refine(newCredentials)
/** Compare-and-swap a complete configuration, retaining only explicitly selected credential fields. */
export const sshConnectionUpdateRequest = createBase.extend({
  connectionId: sshConnectionId, baseRevision: revision,
}).strict()
/** Enablement invalidates old authority without changing target or credential bytes. */
export const sshConnectionToggleRequest = z.object({ requestId: sshManagementRequestId,
  connectionId: sshConnectionId, baseRevision: revision, enabled: z.boolean() }).strict()
/** Deletion creates a tombstone; immutable versions and execution records remain addressable. */
export const sshConnectionDeleteRequest = sshConnectionToggleRequest.omit({ enabled: true }).strict()

const sizeBytes = z.number().int().min(1).max(SSH_CREDENTIAL_UPLOAD_MAX_BYTES)
/** A direct upload capability is bound to its purpose, owner, request, configuration and byte length. */
export const sshCredentialTicketRequest = z.discriminatedUnion('purpose', [
  createBase.extend({ purpose: z.literal('create'), sizeBytes }).strict().refine(newCredentials),
  sshConnectionUpdateRequest.extend({ purpose: z.literal('update'), sizeBytes }).strict(),
])
/** Metadata passed through Host RPC to reserve a direct Platform upload. */
export type SshCredentialTicketRequest = z.infer<typeof sshCredentialTicketRequest>

/** Format two is explicit; historical raw-password ciphertext is never interpreted as JSON. */
export const sshCredentialUpload = z.object({ formatVersion: z.literal(2),
  password: secret(4096).optional(), privateKey: secret(7168).optional(), passphrase: secret(1024).optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= SSH_CREDENTIAL_UPLOAD_MAX_BYTES)
/** Direct Platform body. Supplied fields must additionally match the ticket's replacement plan exactly. */
export type SshCredentialUpload = z.infer<typeof sshCredentialUpload>

/** Public metadata returned to the owning user; credential values and private key bytes are absent. */
export const sshConnectionValue = z.object({
  connectionId: sshConnectionId, revision, credentialRevision: revision,
  displayName: label, host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535),
  username: label, hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
  workingDirectory: z.string().min(1).max(1024).nullable(),
  authentication: z.enum(['password', 'private_key']), secretConfigured: z.boolean(),
  passphraseConfigured: z.boolean(), enabled: z.boolean(), deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
/** Owner-visible SSH record, including a tombstone returned by an idempotent deletion. */
export type SshConnection = z.infer<typeof sshConnectionValue>

/** Completed ticket retries still upload bytes so the Platform can reject a changed secret. */
export const sshCredentialTicketValue = z.object({ state: z.literal('pending'),
  requestId: sshManagementRequestId, ticket: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  uploadUrl: z.url(), expiresAt: z.iso.datetime(),
}).strict()
/** Query an owner's durable result after a lost mutation response; null means no completed receipt. */
export const sshMutationReceiptValue = z.object({ item: sshConnectionValue.nullable() }).strict()

/** New management methods coexist with the explicit legacy raw-password intake during migration. */
export const sshManagementRequests = {
  sshConnectionsList: z.object({}).strict(),
  sshConnectionsUpdate: sshConnectionUpdateRequest,
  sshConnectionsToggle: sshConnectionToggleRequest,
  sshConnectionsDelete: sshConnectionDeleteRequest,
  sshConnectionsTicket: sshCredentialTicketRequest,
  sshConnectionsReceipt: z.object({ requestId: sshManagementRequestId }).strict(),
}
/** Native Typert methods map to trusted Platform endpoints without carrying credentials. */
export const sshManagementEndpoints = {
  sshConnectionsList: '/ssh/connections/list', sshConnectionsUpdate: '/ssh/connections/update',
  sshConnectionsToggle: '/ssh/connections/toggle', sshConnectionsDelete: '/ssh/connections/delete',
  sshConnectionsTicket: '/ssh/connections/ticket', sshConnectionsReceipt: '/ssh/connections/receipt',
} as const
