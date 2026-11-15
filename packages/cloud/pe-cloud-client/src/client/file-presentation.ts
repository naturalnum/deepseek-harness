/** Cloud-owned file-link presentation over the original Native Markdown and scoped opener. */
import type { Context } from '@deepseek-ai/cordis'
import type { MarkdownFilePresentation, MarkdownFilePresentationChoice } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

// Display ambiguity only; ordinary explicit paths still use the original Native parser and Host checks.
const webSuffixes = new Set(('com net org edu gov mil int biz info name mobi travel io ai app dev cloud co '
  + 'uk de fr cn jp ru au es pt in ca us').split(' '))
const native = { kind: 'native' } as const, text = { kind: 'text' } as const

function artifactName(value: string): string | undefined {
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_-][\p{L}\p{N}_.-]*)*\.[A-Za-z0-9]{1,12}$/u.test(value)) return undefined
  const extension = value.slice(value.lastIndexOf('.') + 1).toLowerCase()
  if (/^\d+$/.test(extension) || !value.includes('/') && webSuffixes.has(extension)) return undefined
  return value
}

function scopedUri(value: string): MarkdownFilePresentationChoice | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (scheme !== 'file' && scheme !== 'sandbox') return undefined
  const rest = value.slice(value.indexOf(':') + 1)
  if (value.includes('?') || /%2f|%5c/i.test(value)) return text
  let raw: string
  if (scheme === 'file') {
    if (!rest.startsWith('///') || rest.startsWith('////')) return text
    raw = rest.slice(2)
  } else {
    if (!rest.startsWith('/') || rest.startsWith('//')) return text
    raw = rest
  }
  const hash = raw.indexOf('#'), destination = hash < 0 ? raw : raw.slice(0, hash)
  let path: string
  try { path = decodeURIComponent(destination) } catch { return text }
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').includes('..')) return text
  const fragment = hash < 0 ? undefined : /^L(\d+)(?:-L(\d+))?$/.exec(raw.slice(hash + 1))
  const line = fragment === null || fragment === undefined ? undefined : Number(fragment[1])
  const end = fragment?.[2] === undefined ? line : Number(fragment[2])
  const validLine = line !== undefined && Number.isSafeInteger(line) && line > 0
    && end !== undefined && Number.isSafeInteger(end) && end >= line
  return { kind: 'file', path, ...(validLine ? { line } : {}) }
}

/**
 * Select Cloud presentation using only authored text and the original caller's admission.
 * @param input Original display position/text and settlement; never a credential, account or service.
 * @returns Plain display choice, with actual file access left to the original scoped opener and Host.
 */
export const cloudFilePresentation: MarkdownFilePresentation = (input) => {
  if (input.kind !== 'link') {
    const path = input.active ? artifactName(input.text) : undefined
    return path === undefined ? native : { kind: 'file', path }
  }
  const scoped = scopedUri(input.text)
  return scoped === undefined ? native : input.active ? scoped : text
}

/**
 * Install one display-only selector on the original Native root, owned by this Cloud dependency scope.
 * @param ctx Original Cloud entry; its slots withdrawal retires the selector for this root only.
 */
export function installCloudFilePresentation(ctx: Context): void {
  ctx.inject(['slots'], (owner) => {
    owner.effect(() => owner.slots.provideRoot({ props: { assistantFilePresentation: cloudFilePresentation } }),
      'Cloud file presentation over original Native Markdown')
  })
}
