/** Deployment-private complete request encryption; no model or browser key participates. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'

import { orderNativeInputJson as ordered } from '../native-input-ledger-records.ts'
function canonical(value: unknown): string { return JSON.stringify(ordered(z.json().parse(value))) }

/** The dedicated deployment key protects both original requests and keyed request identities. */
export class NativeRetainedIntentCipher {
  private readonly key: Buffer

  /**
   * @param encodedKey Canonical base64url encoding of exactly 32 bytes, loaded from nativeIntentKeyFile.
   */
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== encodedKey) throw new Error('Invalid native intent key')
    this.key = key
  }

  /** Derive a deployment-keyed identity over all exact canonical fields.
   * @param domain Fixed purpose distinguishing whole requests from logical mutation keys.
   * @param value Complete JSON identity; arrays and secrets are never omitted.
   * @returns Canonical lowercase SHA-256 HMAC without raw bearer material.
   */
  identity(domain: 'request' | 'mutation', value: unknown): string {
    return createHmac('sha256', this.key).update(`power-evolve-native-intent-v1\0${domain}\0`)
      .update(canonical(value)).digest('hex')
  }

  /** Encrypt the complete original request with immutable actual owner and mutation identity as AAD.
   * @param identity Persisted family, owner, Session, operation, epoch, worker and complete intent ID.
   * @param value Whole private original request, including operation and nested credentials.
   * @returns Version-one nonce, authentication tag and ciphertext stored only in the private table.
   */
  seal(identity: unknown, value: unknown): Buffer {
    const plaintext = Buffer.from(canonical(value))
    try {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce)
      cipher.setAAD(Buffer.from(canonical({ domain: 'power-evolve-native-intent-v1', identity })))
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    } finally { plaintext.fill(0) }
  }

  /** Open an original request only under its exact persisted identity.
   * @param identity The same complete immutable AAD used when the request was prepared.
   * @param sealed Original authenticated ciphertext; corrupted data never yields a partial request.
   * @returns Parsed JSON for the strict retained request decoder.
   */
  open(identity: unknown, sealed: Buffer): unknown {
    let plaintext: Buffer | undefined
    try {
      if (sealed.length < 29) throw new Error('Invalid ciphertext')
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12))
      decipher.setAAD(Buffer.from(canonical({ domain: 'power-evolve-native-intent-v1', identity })))
      decipher.setAuthTag(sealed.subarray(-16))
      plaintext = Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()])
      const text = plaintext.toString('utf8')
      if (!Buffer.from(text).equals(plaintext)) throw new Error('Invalid UTF-8')
      return z.json().parse(JSON.parse(text))
    } catch { throw new PlatformError(503, 'native_intent_unavailable') }
    finally { plaintext?.fill(0) }
  }
}
