/** Validate imported Skill metadata through the pinned native filesystem provider. */
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillCandidate, SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import { PlatformError } from '../contracts.ts'

const MAXIMUM_NAME_CHARACTERS = 80
const MAXIMUM_DESCRIPTION_CHARACTERS = 500
const IMPORTED_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Read the one validated staging directory through the pinned native DSH provider.
 * @param directory - extracted skill directory containing SKILL.md.
 * @param signal - optional cancellation signal.
 * @returns the native skill name and bounded description.
 */
export async function readNativeSkillMetadata(
  directory: string,
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly description: string }> {
  signal?.throwIfAborted()
  const lifetime = new AbortController()
  const onAbort = () => { lifetime.abort(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const provider = new FileSystemSkillProvider(new Context(), {
    signal: lifetime.signal,
    invalidate() {},
  }, {
    providerName: 'power-evolve-import-validation',
    includeDefaultRoots: false,
    customSkillDirs: [directory],
    watch: false,
  })
  try {
    try {
      const options = { signal: signal ?? lifetime.signal } satisfies SkillLookupOptions
      const listed = await provider.list(options)
      const candidates: readonly SkillCandidate[] = Array.isArray(listed) ? listed : listed.candidates
      if ((!Array.isArray(listed) && !listed.complete) || candidates.length !== 1) invalid()
      const candidate = candidates[0]
      if (candidate === undefined) invalid()
      const loaded = await provider.get(candidate, options)
      if (loaded === undefined || loaded.name !== candidate.name || loaded.description !== candidate.description
        || !bounded(candidate.name, MAXIMUM_NAME_CHARACTERS, false)
        || !IMPORTED_SKILL_NAME.test(candidate.name)
        || !bounded(candidate.description, MAXIMUM_DESCRIPTION_CHARACTERS, true)) invalid()
      return { name: loaded.name, description: loaded.description }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof PlatformError) throw error
      throw new PlatformError(400, 'invalid_skill_metadata')
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    lifetime.abort(new Error('Imported Skill metadata was read'))
    await provider.dispose()
  }
}

function bounded(value: string, maximum: number, allowTextWhitespace: boolean): boolean {
  return value.length <= maximum * 2 && Array.from(value).length <= maximum
    && !Array.from(value).some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code < 32 || code === 127)
        && !(allowTextWhitespace && (code === 9 || code === 10 || code === 13))
    })
}

function invalid(): never {
  throw new PlatformError(400, 'invalid_skill_metadata')
}
