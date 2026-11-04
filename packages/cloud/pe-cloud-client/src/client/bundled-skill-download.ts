/** Explicit readonly release binary download; no mutable ZIP/RPC limit or account upload quota is changed. */
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { ClientFailure } from './errors.ts'

/** Installed account/generation-bound fetch capability and its explicitly reviewed binary allowance. */
export interface BundledSkillDownloadInput {
  readonly fetch: FileUploadFetch
  /** Original account/generation-bound same-origin attachment URL; carries no authentication secret. */
  readonly navigationUrl: (path: string) => string
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly maxArchiveBytes: number
  readonly timeoutMs: number
}
/** Exact displayed immutable release selectors, never a Host path or uploaded attachment identity. */
export interface BundledSkillDownloadSelector { readonly skillId: string; readonly contentVersion: string }
/** Explicit original response route; trusted bootstrap/exposure installation must precede use. */
export const BUNDLED_SKILL_DOWNLOAD_PATH = 'api/skills/release-archive'

/**
 * Preflight the exact immutable version before exposing its download callback.
 * @param input Original account-bound fetch/navigation and finite binary policy; never global unbound fetch.
 * @param selector Exact displayed release/version.
 * @param observer Original detail-open observer.
 * @returns Browser-handoff callback after an authorized metadata preflight; absence retains the unavailable UI.
 * The server verifies complete archive bytes. Browser progress, cancellation and persistence own the handed-off GET.
 */
export async function prepareBundledSkillDownload(input: BundledSkillDownloadInput, selector: BundledSkillDownloadSelector,
  observer: AbortSignal): Promise<((signal: AbortSignal) => Promise<void>) | undefined> {
  if (!Number.isSafeInteger(input.maxArchiveBytes) || input.maxArchiveBytes < 1
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647) throw new RangeError('Invalid release download policy.')
  const path = `${BUNDLED_SKILL_DOWNLOAD_PATH}?${new URLSearchParams({ skillId: selector.skillId, contentVersion: selector.contentVersion })}`
  const current = (signal: AbortSignal): void => { signal.throwIfAborted(); input.signal.throwIfAborted(); input.assertCurrent() }
  const metadata = (response: Response): { bytes: number; hash: string } | undefined => {
    const length = response.headers.get('content-length'), hash = response.headers.get('x-content-sha256')
    if (!response.ok || response.headers.get('content-type') !== 'application/zip'
      || length === null || !/^[1-9][0-9]*$/.test(length) || hash === null || !/^[a-f0-9]{64}$/.test(hash)) return undefined
    const bytes = Number(length)
    return Number.isSafeInteger(bytes) && bytes <= input.maxArchiveBytes ? { bytes, hash } : undefined
  }
  const headSignal = AbortSignal.any([observer, input.signal, AbortSignal.timeout(input.timeoutMs)])
  current(headSignal)
  let expected: ReturnType<typeof metadata>
  try {
    const preflight = await input.fetch(path, { method: 'HEAD', signal: headSignal })
    await preflight.body?.cancel()
    current(headSignal)
    expected = metadata(preflight)
  } catch (_error) {
    // Download preflight loss leaves the already-read details usable; original scope withdrawal still rejects.
    current(observer)
    return undefined
  }
  if (expected === undefined) return undefined
  return async (observer) => {
    const signal = AbortSignal.any([observer, input.signal, AbortSignal.timeout(input.timeoutMs)])
    current(signal)
    const response = await input.fetch(path, { method: 'HEAD', signal })
    await response.body?.cancel()
    current(signal)
    const actual = metadata(response)
    if (actual?.bytes !== expected.bytes || actual.hash !== expected.hash) throw new ClientFailure('closed')
    const url = input.navigationUrl(path)
    current(signal)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = ''; anchor.rel = 'noopener noreferrer'; anchor.hidden = true
    document.body.append(anchor)
    try { anchor.click() } finally { anchor.remove() }
  }
}
