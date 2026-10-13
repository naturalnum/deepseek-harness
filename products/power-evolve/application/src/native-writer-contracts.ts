/** Session writer occupancy records; no operation or execution authority is granted. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { sessionId } from './contracts.ts'

/** Host worker identity recorded by the current operation attempt. */
export type NativeWriterWorkerId = Branded<'PowerEvolveNativeWriterWorkerId'>
/** Normalize a UUID to the PostgreSQL worker representation. */
export const nativeWriterWorkerId = z.uuid().transform(value => brandString<NativeWriterWorkerId>(value.toLowerCase()))
/** Exactly 32 bytes in unpadded canonical base64url; the final sextet has two zero padding bits. */
export const nativeWriterToken = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
/** Positive, exactly representable monotone Session writer epoch, independent of the operation epoch. */
export const nativeWriterEpoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
/** Host-generated token is retained across an uncertain acquire response. */
export const nativeWriterAcquire = z.object({ sessionId, workerId: nativeWriterWorkerId, token: nativeWriterToken }).strict()
/** Exact writer identity required for maintenance after the originating operation has settled. */
export const nativeWriterIdentity = nativeWriterAcquire.extend({ epoch: nativeWriterEpoch }).strict()
/** Committed occupancy receipt; callers already own the token and must keep it private. */
export const nativeWriterLease = z.object({ sessionId, workerId: nativeWriterWorkerId,
  epoch: nativeWriterEpoch, expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
/** Exact release, including a repeat of the most recently released identity. */
export const nativeWriterReleased = nativeWriterLease.omit({ expiresAt: true }).extend({ released: z.literal(true) }).strict()
/** Validated first acquisition or retry request. */
export type NativeWriterAcquire = z.infer<typeof nativeWriterAcquire>
/** Validated independent writer maintenance request. */
export type NativeWriterIdentity = z.infer<typeof nativeWriterIdentity>
/** Receipt whose expiry is measured by the PostgreSQL clock, in Unix milliseconds. */
export type NativeWriterLease = z.infer<typeof nativeWriterLease>
/** Release receipt carries no execution authority or bearer. */
export type NativeWriterReleased = z.infer<typeof nativeWriterReleased>
