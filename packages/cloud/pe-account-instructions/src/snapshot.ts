/** Complete C-09 context construction using native message identity and freezing. */
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import { jsonBytes, jsonStringBytes } from './budget.ts'
import { validateLimits } from './config.ts'
import { loadInstructionContents } from './load.ts'
import type { Config } from './config.ts'
import type { InstructionMessage, InstructionMessageSource, InstructionSnapshot } from './types.ts'
import type { InstructionDirectory } from './internal-types.ts'

const INTRO = 'Complete instruction snapshot for the current turn. Earlier instruction snapshots are historical.\n'
const EMPTY = 'No optional instruction files are present.\n'

/**
 * Construct a complete immutable native context from already-authorized sources.
 * No path or identity argument grants authority. The supplied files port owns
 * per-operation scope/current checks, bounded stream credit and actual I/O drain.
 * The complete encoded message is sized before its rendered text is joined or
 * cloned; maxResidentBytes checks the source-buffer and handoff-copy text plan.
 * Acquiring actual shared reservations remains the files owner's responsibility.
 * Empty optional sources produce an explicit empty snapshot; failures produce none.
 * @param directories - approved source targets and their fixed read-only readers; project labels identify the full root-to-cwd chain.
 * @param identity - validated C-09 identity data, not an authorization token.
 * @param config - explicit source, envelope and conservative storage budgets.
 * @param signal - current turn/account cancellation.
 * @returns a detached, deeply frozen native instruction message, ready for pre-step.
 * @throws original provider/cancellation errors, FS_TOO_LARGE, or invalid configuration.
 */
export async function prepareInstructionSnapshot(
  directories: readonly InstructionDirectory[],
  identity: Pick<InstructionSnapshot, 'accountId' | 'workspaceId' | 'epoch'>,
  config: Config,
  signal: AbortSignal,
): Promise<InstructionMessage> {
  validateLimits(config)
  signal.throwIfAborted()
  const initial: InstructionSnapshot = {
    accountId: identity.accountId, workspaceId: identity.workspaceId, epoch: identity.epoch,
    sources: [], text: '', totalBytes: 0,
  }
  if (jsonBytes(initial) > config.maxSnapshotBytes) throw new FsError('Instruction snapshot metadata exceeds its byte budget.', 'FS_TOO_LARGE')
  const source: InstructionMessageSource = { kind: 'pe-account-instructions', form: 'instructions', snapshot: initial }
  const seed = createUserMessage({ content: [], source })
  if (jsonBytes(seed) > config.maxSnapshotBytes) throw new FsError('Instruction message metadata exceeds its byte budget.', 'FS_TOO_LARGE')
  const contents = await loadInstructionContents(directories, config, signal)
  const parts = [INTRO]
  if (contents.sources.length === 0) parts.push(EMPTY)
  for (const entry of contents.sources) {
    parts.push(`\n[${entry.kind} ${JSON.stringify(entry.relativeName)}]\n`, entry.text, '\n')
  }
  const totalBytes = parts.reduce((bytes, part) => bytes + Buffer.byteLength(part, 'utf8'), 0)
  const renderedJsonBytes = 2 + parts.reduce((bytes, part) => bytes + jsonStringBytes(part) - 2, 0)
  const emptyText: InstructionSnapshot = { ...initial, sources: contents.sources, totalBytes }
  const draft: InstructionMessage = {
    ...seed, content: [{ type: 'text', text: '' }],
    source: { ...source, snapshot: emptyText },
  }
  const messageBytes = jsonBytes(draft) + 2 * (renderedJsonBytes - 2)
  if (messageBytes > config.maxSnapshotBytes) throw new FsError('Complete instruction message exceeds its byte budget.', 'FS_TOO_LARGE')
  signal.throwIfAborted()
  const text = parts.join('')
  const snapshot: InstructionSnapshot = { ...emptyText, text }
  return freezeMessage({
    ...draft, content: [{ type: 'text', text }],
    source: { ...source, snapshot },
  })
}
