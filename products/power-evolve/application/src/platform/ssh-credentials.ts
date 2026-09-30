/** Platform-private SSH credential formats, explicit retention and authenticated encryption. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { sshCredentialUpload, type SshConfigurationInput, type SshCredentialUpload,
  SSH_CREDENTIAL_UPLOAD_MAX_BYTES } from '../ssh-management-contracts.ts'
import { PlatformError } from '../contracts.ts'

/** Only the trusted Platform and an authorized isolated Runner receive secret values. */
export type SshCredential =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'private_key'; readonly privateKey: string; readonly passphrase?: string }

/** Historical AAD request identity is explicit and never inferred from plaintext content. */
export interface SshCredentialIdentity {
  readonly userId: string
  readonly connectionId: string
  readonly credentialRevision: number
  readonly credentialKind: SshCredential['kind']
  readonly formatVersion: 1 | 2
  readonly aadRequestId: string | null
}

/**
 * Serialize JSON with stable object-key ordering while preserving array order.
 * @param value JSON-compatible value to serialize.
 * @returns Canonical JSON text used in credential envelopes and replay identities.
 */
export function sshCanonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (typeof item === 'object' && item !== null) return Object.fromEntries(Object.entries(item)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]))
    return item
  }
  const encoded = JSON.stringify(canonical(value))
  if (encoded === undefined) throw new PlatformError(400, 'ssh_credential_invalid')
  return encoded
}

/**
 * Determine whether an authentication plan requires replacement secret bytes.
 * @param plan Explicit instructions for retaining, replacing or clearing credential fields.
 * @returns Whether at least one credential field must arrive through direct upload.
 */
export function sshNeedsUpload(plan: SshConfigurationInput['authentication']): boolean {
  return plan.kind === 'password' ? plan.password === 'replace'
    : plan.privateKey === 'replace' || plan.passphrase === 'replace'
}

/**
 * Determine whether an authentication plan changes the immutable credential version.
 * @param plan Explicit instructions for retaining, replacing or clearing credential fields.
 * @returns Whether a replacement or passphrase clear creates a credential version.
 */
export function sshChangesCredential(plan: SshConfigurationInput['authentication']): boolean {
  return sshNeedsUpload(plan) || plan.kind === 'private_key' && plan.passphrase === 'clear'
}

/**
 * Validate replacement fields exactly; retained and cleared fields must be absent.
 * @param plan Ticket-bound authentication plan defining which secret fields may be supplied.
 * @param value Untrusted format-two upload body to validate.
 * @returns Validated envelope containing exactly the plan's replacement fields.
 */
export function sshUploadForPlan(plan: SshConfigurationInput['authentication'], value: unknown): SshCredentialUpload {
  const parsed = sshCredentialUpload.safeParse(value)
  if (!parsed.success) throw new PlatformError(400, 'ssh_credential_invalid')
  const expected = ['formatVersion']
  if (plan.kind === 'password') {
    if (plan.password === 'replace') expected.push('password')
  } else {
    if (plan.privateKey === 'replace') expected.push('privateKey')
    if (plan.passphrase === 'replace') expected.push('passphrase')
  }
  if (Object.keys(parsed.data).sort().join(',') !== expected.sort().join(',')) {
    throw new PlatformError(400, 'ssh_credential_plan_mismatch')
  }
  return parsed.data
}

/**
 * Merge replacements with explicitly retained fields from the ticket's fixed owned source.
 * @param plan Authentication plan; changing kind cannot retain another kind's secrets.
 * @param supplied Upload envelope containing exactly the replacement fields.
 * @param previous Decrypted owned source credential when the plan retains any field.
 * @returns Complete password or private-key credential with a cleared passphrase omitted.
 */
export function mergeSshCredential(plan: SshConfigurationInput['authentication'],
  supplied: SshCredentialUpload, previous?: SshCredential): SshCredential {
  const upload = sshUploadForPlan(plan, supplied)
  if (plan.kind === 'password') {
    const password = plan.password === 'replace' ? upload.password
      : previous?.kind === 'password' ? previous.password : undefined
    if (password === undefined) throw new PlatformError(409, 'ssh_credential_retention_invalid')
    return { kind: 'password', password }
  }
  const privateKey = plan.privateKey === 'replace' ? upload.privateKey
    : previous?.kind === 'private_key' ? previous.privateKey : undefined
  if (privateKey === undefined || plan.passphrase === 'retain' && previous?.kind !== 'private_key') {
    throw new PlatformError(409, 'ssh_credential_retention_invalid')
  }
  const passphrase = plan.passphrase === 'replace' ? upload.passphrase
    : plan.passphrase === 'retain' && previous?.kind === 'private_key' ? previous.passphrase : undefined
  return { kind: 'private_key', privateKey, ...(passphrase === undefined ? {} : { passphrase }) }
}

/** Complete format-two envelope for sealing, distinct from a partial replacement upload. */
function envelope(credential: SshCredential): SshCredentialUpload {
  return sshCredentialUpload.parse({ formatVersion: 2,
    ...(credential.kind === 'password' ? { password: credential.password }
      : { privateKey: credential.privateKey,
        ...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }) }) })
}

/** AES-GCM and keyed replay identity use the existing backend key with explicit format domains. */
export class SshCredentialCipher {
  private readonly key: Buffer
  /**
   * Configure the Platform's encryption and replay-verification key.
   * @param keyText Canonical base64url encoding of a 32-byte backend key.
   */
  constructor(keyText: string) {
    const encoded = keyText.trim(), key = Buffer.from(encoded, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw new Error('Invalid SSH credential key')
    this.key = key
  }

  /**
   * Compute the historical keyed replay identity from raw password bytes.
   * @param value Original format-one password bytes, including any JSON-shaped text.
   * @returns Hexadecimal HMAC-SHA256 matching historical credential receipts.
   */
  legacyFingerprint(value: Buffer): string {
    return createHmac('sha256', this.key).update(value).digest('hex')
  }

  /**
   * Compute a domain-separated keyed replay identity for replacement secrets.
   * @param domain Purpose separating this verifier from other format-two uses.
   * @param value JSON-compatible request and replacement fields to canonicalize.
   * @returns Hexadecimal HMAC-SHA256 without an unkeyed secret verifier.
   */
  fingerprint(domain: string, value: unknown): string {
    return createHmac('sha256', this.key).update(`power-evolve-ssh-v2\0${domain}\0`)
      .update(sshCanonicalJson(value)).digest('hex')
  }

  private aad(identity: SshCredentialIdentity): Buffer {
    if (!Number.isSafeInteger(identity.credentialRevision) || identity.credentialRevision < 1
      || !identity.userId || !identity.connectionId) throw new Error('Invalid SSH credential identity')
    if (identity.formatVersion === 1) {
      if (identity.credentialKind !== 'password' || !identity.aadRequestId) {
        throw new Error('Invalid legacy SSH credential identity')
      }
      return Buffer.from(['power-evolve-ssh-v1', identity.userId, identity.aadRequestId,
        String(identity.credentialRevision)].join('\0'))
    }
    if (identity.aadRequestId !== null) throw new Error('Invalid SSH credential identity')
    return Buffer.from(['power-evolve-ssh-v2', identity.userId, identity.connectionId,
      String(identity.credentialRevision), identity.credentialKind].join('\0'))
  }

  /**
   * Encrypt a credential with AES-GCM bound to its immutable format-specific identity.
   * @param identity Owner and credential-version identity persisted with the ciphertext.
   * @param credential Complete secret matching the identity's authentication kind.
   * @returns Ciphertext containing the nonce, authentication tag and encrypted secret bytes.
   */
  seal(identity: SshCredentialIdentity, credential: SshCredential): Buffer {
    if (credential.kind !== identity.credentialKind) throw new Error('SSH credential kind mismatch')
    const plaintext = identity.formatVersion === 1 && credential.kind === 'password'
      ? Buffer.from(credential.password, 'utf8') : Buffer.from(sshCanonicalJson(envelope(credential)), 'utf8')
    try {
      if (!plaintext.length || plaintext.length > (identity.formatVersion === 1 ? 4096 : SSH_CREDENTIAL_UPLOAD_MAX_BYTES)) {
        throw new PlatformError(400, 'ssh_credential_invalid')
      }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
      cipher.setAAD(this.aad(identity))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    } finally { plaintext.fill(0) }
  }

  /**
   * Decrypt only the declared format, rejecting identity, key and ciphertext errors uniformly.
   * @param identity Immutable owner, version and format identity loaded with the ciphertext.
   * @param sealed Stored nonce, authentication tag and encrypted credential bytes.
   * @returns Complete password or private-key secret for trusted Platform and Runner use.
   */
  open(identity: SshCredentialIdentity, sealed: Buffer): SshCredential {
    let plaintext: Buffer | undefined
    try {
      const maximum = identity.formatVersion === 1 ? 4096 : SSH_CREDENTIAL_UPLOAD_MAX_BYTES
      if (!Buffer.isBuffer(sealed) || sealed.length < 29 || sealed.length > maximum + 28) {
        throw new Error('Invalid SSH credential ciphertext')
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12))
      decipher.setAAD(this.aad(identity)); decipher.setAuthTag(sealed.subarray(12, 28))
      plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
      const text = plaintext.toString('utf8')
      if (!text || !Buffer.from(text, 'utf8').equals(plaintext)) throw new Error('Invalid UTF-8')
      if (identity.formatVersion === 1) return { kind: 'password', password: text }
      const parsed = sshCredentialUpload.parse(JSON.parse(text))
      if (identity.credentialKind === 'password' && parsed.password !== undefined
        && parsed.privateKey === undefined && parsed.passphrase === undefined) {
        return { kind: 'password', password: parsed.password }
      }
      if (identity.credentialKind === 'private_key' && parsed.privateKey !== undefined && parsed.password === undefined) {
        return { kind: 'private_key', privateKey: parsed.privateKey,
          ...(parsed.passphrase === undefined ? {} : { passphrase: parsed.passphrase }) }
      }
      throw new Error('Invalid SSH credential kind')
    } catch { throw new PlatformError(503, 'ssh_credential_unavailable') }
    finally { plaintext?.fill(0) }
  }
}
