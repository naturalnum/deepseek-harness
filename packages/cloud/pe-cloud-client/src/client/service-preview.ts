/** Task selection only; the original prepared page owns all navigation and C02 expectations. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Selection taken from the framework Session seat and a recorded task handle. */
export interface CloudServicePreviewSelection {
  readonly sessionId: SessionId
  readonly serviceHandle: string
}

/**
 * Required immutable-page callback, never a URL factory or authentication source.
 * The actual page rechecks its lifetime, attaches its own C02 expectations and owns navigation/refusal feedback without throwing.
 * @param selection Task selectors only; original ingress/session/service owners supply and verify infrastructure identity.
 */
export type CloudServicePreviewNavigation = (selection: CloudServicePreviewSelection) => void

/** Bounded non-authoritative task metadata produced by the original tool output declaration. */
export interface CloudServicePreviewMeta {
  readonly kind: 'cloud-dev-service-v1'
  readonly action: 'start' | 'status'
  readonly serviceHandle: string
  readonly processSubmitted: true
}

/**
 * Narrow a recorded task projection; legacy or malformed metadata supplies no preview action.
 * @param value Opaque durable tool metadata.
 * @returns The validated task fields, or undefined. Submission does not establish HTTP readiness.
 */
export function cloudServicePreviewMeta(value: unknown): CloudServicePreviewMeta | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const meta = value as Record<string, unknown>
  if (Object.keys(meta).length !== 4 || meta.kind !== 'cloud-dev-service-v1'
    || (meta.action !== 'start' && meta.action !== 'status') || meta.processSubmitted !== true
    || typeof meta.serviceHandle !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(meta.serviceHandle)) return undefined
  return { kind: meta.kind, action: meta.action, serviceHandle: meta.serviceHandle, processSubmitted: true }
}
