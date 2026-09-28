const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i

export interface Artifact {
  readonly artifactId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly sourcePath: string
  readonly filename: string
  readonly mime: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly createdAt: string
}
export interface ArtifactPage { readonly items: readonly Artifact[]; readonly nextCursor: string | null }
export interface ArtifactPreview { readonly artifactId: string; readonly mime: string; readonly sizeBytes: number;
  readonly text?: string; readonly data?: string; readonly truncated: boolean }

export class ArtifactHttpError extends Error {
  constructor(readonly status: number) { super(`Artifact request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

export function relativeArtifactSource(absolutePath: string): string {
  if (!absolutePath.startsWith('/workspace/')) throw new Error('File is outside this Workspace')
  const path = absolutePath.slice('/workspace/'.length)
  if (!path || path.length > 1024 || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Workspace file path')
  return path
}

export function artifactDownloadUrl(artifactId: string): string {
  if (!isUuid(artifactId)) throw new Error('Invalid artifact ID')
  return `/api/powerEvolve/artifacts/${artifactId}/content`
}

function parseArtifact(value: unknown): Artifact {
  if (!record(value) || !isUuid(value.artifactId) || !isUuid(value.workspaceId) || !isUuid(value.sessionId)
    || typeof value.sourcePath !== 'string' || typeof value.filename !== 'string'
    || typeof value.mime !== 'string' || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0 || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
    || typeof value.createdAt !== 'string') throw new Error('Invalid artifact response')
  return value as unknown as Artifact
}

function parsePage(value: unknown): ArtifactPage {
  if (!record(value) || !Array.isArray(value.items)
    || !(value.nextCursor === null || value.nextCursor === undefined || typeof value.nextCursor === 'string')) {
    throw new Error('Invalid artifact list response')
  }
  return { items: value.items.map(parseArtifact), nextCursor: value.nextCursor ?? null }
}

function parsePreview(value: unknown, artifactId: string): ArtifactPreview {
  if (!record(value) || value.artifactId !== artifactId || typeof value.mime !== 'string'
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || typeof value.truncated !== 'boolean' || (value.text !== undefined && typeof value.text !== 'string')
    || (value.data !== undefined && typeof value.data !== 'string')) throw new Error('Invalid artifact preview response')
  return value as unknown as ArtifactPreview
}

export class ArtifactHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(route: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new ArtifactHttpError(response.status)
    return response.json() as Promise<unknown>
  }

  async publish(sessionId: string, absolutePath: string, requestId: string, signal?: AbortSignal): Promise<Artifact> {
    if (!isUuid(sessionId) || !isUuid(requestId)) throw new Error('Invalid publish request')
    const path = relativeArtifactSource(absolutePath)
    const result = parseArtifact(await this.post('artifactsPublish', { requestId, sessionId, path }, signal))
    if (result.sessionId !== sessionId || result.sourcePath !== path) throw new Error('Artifact publish response mismatch')
    return result
  }

  async list(filter: { workspaceId?: string; sessionId?: string; cursor?: string }, signal?: AbortSignal): Promise<ArtifactPage> {
    if (filter.workspaceId !== undefined && !isUuid(filter.workspaceId)) throw new Error('Invalid Workspace ID')
    if (filter.sessionId !== undefined && !isUuid(filter.sessionId)) throw new Error('Invalid Session ID')
    return parsePage(await this.post('artifactsList', { ...filter, limit: 30 }, signal))
  }

  async preview(artifactId: string, signal?: AbortSignal): Promise<ArtifactPreview> {
    if (!isUuid(artifactId)) throw new Error('Invalid artifact ID')
    return parsePreview(await this.post('artifactsPreview', { artifactId }, signal), artifactId)
  }
}
