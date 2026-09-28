/** Browser selection is untrusted; the platform rechecks device and directory ownership at admission. */
export type ExecutionTarget = { readonly kind: 'cloud' }
  | { readonly kind: 'desktop'; readonly deviceId: string; readonly directoryId: string }

export interface TargetOption {
  readonly key: string
  readonly target: ExecutionTarget
  readonly device: string
  readonly directory: string
}

export interface Pairing { readonly code: string; readonly expiresAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cloud: ExecutionTarget = Object.freeze({ kind: 'cloud' })

export function targetKey(target: ExecutionTarget): string {
  return target.kind === 'cloud' ? 'cloud' : `${target.deviceId}:${target.directoryId}`
}

export function deviceOptions(value: unknown): TargetOption[] {
  if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)) {
    throw new Error('Invalid device list')
  }
  return value.items.flatMap((row: unknown): TargetOption[] => {
    if (typeof row !== 'object' || row === null || !('deviceId' in row) || !('directoryId' in row)
      || !('name' in row) || !('label' in row) || !('directoryRevokedAt' in row)
      || typeof row.deviceId !== 'string' || typeof row.directoryId !== 'string'
      || !UUID.test(row.deviceId) || !UUID.test(row.directoryId)
      || typeof row.name !== 'string' || typeof row.label !== 'string'
      || row.directoryRevokedAt !== null) return []
    const target: ExecutionTarget = { kind: 'desktop', deviceId: row.deviceId, directoryId: row.directoryId }
    return [{ key: targetKey(target), target, device: row.name, directory: row.label }]
  })
}

export class ExecutionTargetClient {
  private readonly selections = new Map<string, ExecutionTarget>()
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  current(sessionId: string): ExecutionTarget { return this.selections.get(sessionId) ?? cloud }

  select(sessionId: string, target: ExecutionTarget, options: readonly TargetOption[]): void {
    if (target.kind === 'desktop' && !options.some(option => option.key === targetKey(target))) {
      throw new Error('Local directory is unavailable')
    }
    this.selections.set(sessionId, target)
  }

  reconcile(sessionId: string, options: readonly TargetOption[]): ExecutionTarget {
    const current = this.current(sessionId)
    if (current.kind === 'desktop' && !options.some(option => option.key === targetKey(current))) {
      this.selections.set(sessionId, cloud)
      return cloud
    }
    return current
  }

  hint(sessionId: string): string { return JSON.stringify(this.current(sessionId)) }

  async list(signal?: AbortSignal): Promise<TargetOption[]> {
    const response = await this.request('/api/powerEvolve/devicesList', { method: 'POST',
      credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({ request: {} }),
    })
    if (!response.ok) throw new Error(`Device list failed: ${response.status}`)
    return deviceOptions(await response.json())
  }

  async pair(signal?: AbortSignal): Promise<Pairing> {
    const response = await this.request('/api/powerEvolve/devicesPair', { method: 'POST',
      credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      ...(signal === undefined ? {} : { signal }), body: JSON.stringify({ request: {} }),
    })
    if (!response.ok) throw new Error(`Device pairing failed: ${response.status}`)
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('code' in value) || !('expiresAt' in value)
      || typeof value.code !== 'string' || value.code.length < 24
      || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new Error('Invalid device pairing response')
    }
    return { code: value.code, expiresAt: value.expiresAt }
  }
}
