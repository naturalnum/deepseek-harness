/** Durable archival stop purpose; restoring visibility never withdraws an issued stop. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { sessionId } from './contracts.ts'

/** One immutable identity for an issued Session archival stop. */
export type NativeSessionStopId = Branded<'PowerEvolveNativeSessionStopId'>
/** Canonical UUID recorded independently of operation and Writer generations. */
export const nativeSessionStopId = z.uuid().transform(value => brandString<NativeSessionStopId>(value.toLowerCase()))
/** Fixed archival purpose in a private account-owned preference; no execution authority is stored. */
export const nativeSessionStopIntent = z.object({ version: z.literal(1), purpose: z.literal('archive'),
  sessionId, stopId: nativeSessionStopId, status: z.enum(['requested', 'complete']),
}).strict()
/** Validated archival stop retained across unarchive and Host replacement. */
export type NativeSessionStopIntent = z.infer<typeof nativeSessionStopIntent>
