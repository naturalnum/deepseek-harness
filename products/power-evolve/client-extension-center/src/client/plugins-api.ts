const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** The one built-in plugin exposed by the first S6 cloud path. */
export interface NotesPlugin {
  readonly id: 'notes'
  readonly title: string
  readonly category: 'tools'
  readonly kind: 'builtin'
  readonly enabled: boolean
  readonly revision: number
  readonly requiresApproval: true
}

export interface NotesSetEnabled {
  readonly requestId: string
  readonly expectedRevision: number
  readonly enabled: boolean
}

export interface PluginPort {
  list(signal?: AbortSignal): Promise<readonly NotesPlugin[]>
  setEnabled(input: NotesSetEnabled): Promise<NotesPlugin>
}

export class PluginHttpError extends Error {
  constructor(readonly status: number) { super(`Plugin request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parsePlugin(value: unknown): NotesPlugin {
  if (!record(value) || value.id !== 'notes' || value.category !== 'tools' || value.kind !== 'builtin'
    || typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 80
    || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1 || value.requiresApproval !== true) {
    throw new Error('Invalid plugin response')
  }
  return { id: 'notes', title: value.title, category: 'tools', kind: 'builtin',
    enabled: value.enabled, revision: Number(value.revision), requiresApproval: true }
}

/** Product RPC carries only plugin state, never credentials or an asserted user ID. */
export class PluginHttpClient implements PluginPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new PluginHttpError(response.status)
    return response.json() as Promise<unknown>
  }

  async list(signal?: AbortSignal): Promise<readonly NotesPlugin[]> {
    const result = await this.post('pluginsList', {}, signal)
    if (!record(result) || !Array.isArray(result.items) || result.items.length > 1) {
      throw new Error('Invalid plugin list response')
    }
    return result.items.map(parsePlugin)
  }

  async setEnabled(input: NotesSetEnabled): Promise<NotesPlugin> {
    if (!UUID.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1 || typeof input.enabled !== 'boolean') {
      throw new Error('Invalid plugin toggle request')
    }
    const result = parsePlugin(await this.post('pluginsNotesSetEnabled', input))
    if (result.enabled !== input.enabled || result.revision < input.expectedRevision) {
      throw new Error('Plugin toggle response mismatch')
    }
    return result
  }
}

/** Read only the Host-declared trusted approval destination. */
export async function approvalUrl(request: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<string> {
  const response = await request('/config', { credentials: 'same-origin' })
  if (!response.ok) throw new PluginHttpError(response.status)
  const result: unknown = await response.json()
  if (!record(result) || typeof result.approvalUrl !== 'string') throw new Error('Invalid approval URL')
  const url = new URL(result.approvalUrl)
  if (url.username || url.password || url.pathname !== '/approval' || url.search || url.hash
    || url.origin !== result.approvalUrl.slice(0, -'/approval'.length)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid approval URL')
  }
  return url.href
}
