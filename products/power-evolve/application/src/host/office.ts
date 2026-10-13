/** Guarded OfficeCLI command proposal for the operation's authorized execution target. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Grant } from '../contracts.ts'
import type RuntimeScope from './scope.ts'
import { executionToolOutput } from './executions.ts'

/** Native tool name for guarded OfficeCLI proposals. */
export const OFFICE_TOOL_NAME = 'office'

const OFFICECLI = '/usr/local/bin/officecli'
const ENV_EXECUTABLE = '/usr/bin/env'
const WORKSPACE = '/workspace'
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_ARGUMENTS = 256
const MAX_PROPOSAL_LENGTH = 8192
const OFFICECLI_ENVIRONMENT = Object.freeze([
  'OFFICECLI_NO_AUTO_RESIDENT=1',
  'OFFICECLI_RESIDENT_FLUSH=each',
  'OFFICECLI_SKIP_UPDATE=1',
] as const)
const STATELESS_RUNTIME_GUIDANCE = [
  '[PowerEvolve Office runtime constraint]',
  'Resident mode is disabled for Office tool calls. Each command reads or writes the saved file directly.',
  'The following upstream guide also describes resident mode; skip its open/edit/save lifecycle.',
  'Name the target file in every command. Replace guide variables such as $FILE with the actual path.',
  'Use direct create, add, set, remove, or batch commands, which persist before returning; use batch for grouped edits.',
  'Read and verify the saved file with direct get, query, view, and validate commands.',
].join('\n')
const receipt = z.object({
  executionId: z.uuid(), state: z.string(), command: z.string(), cwd: z.string(),
}).loose()

const COMMANDS = new Set([
  'add', 'add-part', 'batch', 'close', 'create', 'dump', 'get', 'help', 'import',
  'load_skill', 'merge', 'move', 'open', 'query', 'raw', 'raw-set', 'refresh',
  'remove', 'save', 'set', 'swap', 'validate', 'view',
])
const SKILLS = new Set(['word', 'excel', 'pptx'])
const FILE_OPTIONS = new Set(['--file', '--input', '-o', '--out', '--output'])
const SIDE_EFFECT_OPTIONS = new Set(['--browser', '--stdin'])
const RENDER_MODES = new Set(['html', 'pdf', 'screenshot', 'svg'])

/** Register the Office command adapter only for an enabled cloud execution provider.
 * @param agent Native Agent whose effect scope owns the tool registration.
 * @param grant Original operation grant admitting cloud execution.
 * @param runtime Platform transport observing the tool execution lifetime.
 */
export function installOfficeTool(agent: Agent, grant: Grant, runtime: RuntimeScope): void {
  if (!grant.executionEnabled) return
  agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
    name: OFFICE_TOOL_NAME,
    description: [
      'Create, read, modify, and validate .docx, .xlsx, and .pptx files in /workspace with OfficeCLI.',
      'Each call is an independent Sandbox execution: resident state does not survive calls and `open` is unavailable.',
      'Name the target file in each file command. Use direct create, add, set, remove, or batch commands that persist before returning.',
      'Use direct get, query, view, and validate commands to read or verify saved files.',
      'Use `load_skill` for the guide catalog, `load_skill word`, `load_skill excel`, or `load_skill pptx` for a guide,',
      'and `help <format> ...` when syntax or properties are uncertain.',
      'A queued or running receipt means the command was accepted, not completed. End the turn with a brief status',
      'and wait for the trusted platform to deliver the result and resume the Session. Do not poll or retry the command.',
    ].join(' '),
    parameters: {
      command: {
        type: 'string', required: true,
        description: 'One OfficeCLI command with no shell pipeline; name the target file for file operations.',
      },
    },
    output: executionToolOutput,
    async execute(args, exec) {
      const command = encodeOfficeCommand(args.command)
      const result = receipt.parse(await runtime.call('/runtime/executions/propose', grant.token, {
        callId: String(exec.callId), command, cwd: '',
      }, exec.signal))
      return { executionId: result.executionId, state: result.state, command: result.command, cwd: result.cwd }
    },
  })))
}

/** Quote parsed arguments; guide calls print fixed runtime instructions before the upstream guide.
 * @param input Model-supplied OfficeCLI command text.
 * @returns The bounded Bash command preserving each parsed argument.
 */
export function encodeOfficeCommand(input: string): string {
  const argv = parseOfficeCommand(input)
  const execute = [ENV_EXECUTABLE, '--', ...OFFICECLI_ENVIRONMENT, OFFICECLI, ...argv].map(shellQuote).join(' ')
  const command = argv[0] === 'load_skill'
    ? `printf '%s\\n\\n' ${shellQuote(STATELESS_RUNTIME_GUIDANCE)} && ${execute}` : execute
  if (command.length > MAX_PROPOSAL_LENGTH) {
    throw new OfficeCommandError(`Encoded OfficeCLI command exceeds ${String(MAX_PROPOSAL_LENGTH)} characters`)
  }
  return command
}

/** Parse one bounded OfficeCLI command and enforce its supported verbs and workspace paths.
 * @param command Original lexical command, including quoted JSON arguments.
 * @returns Parsed arguments without the optional OfficeCLI executable prefix.
 */
export function parseOfficeCommand(command: string): readonly string[] {
  if (Buffer.byteLength(command, 'utf8') < 1 || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new OfficeCommandError(`OfficeCLI command must contain 1 to ${String(MAX_COMMAND_BYTES)} UTF-8 bytes`)
  }
  const argv = shellWords(command)
  if (argv[0] === 'officecli' || argv[0] === OFFICECLI) argv.shift()
  const verb = argv[0]
  if (verb === undefined || argv.length > MAX_ARGUMENTS) {
    throw new OfficeCommandError(`OfficeCLI command must contain 1 to ${String(MAX_ARGUMENTS)} arguments`)
  }
  if (!COMMANDS.has(verb)) {
    throw new OfficeCommandError(`OfficeCLI command ${JSON.stringify(verb)} is unavailable through the Office tool`)
  }
  if (verb === 'open') {
    throw new OfficeCommandError([
      'OfficeCLI open is unavailable because each Office tool call is an independent Sandbox execution.',
      'Use get, query, or view with the file path to read it; use create, add, set, remove, or batch with the',
      'file path to persist changes in that call, then run validate or view directly against the saved file.',
    ].join(' '))
  }
  if (verb === 'load_skill') assertSkillRequest(argv)
  for (const argument of argv.slice(1)) {
    const option = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (SIDE_EFFECT_OPTIONS.has(option)) {
      throw new OfficeCommandError(`OfficeCLI option ${JSON.stringify(argument)} is unavailable through the Office tool`)
    }
  }
  if (verb === 'view' && RENDER_MODES.has(argv[2] ?? '')
    && !argv.some(argument => argument === '-o' || argument === '--out'
      || argument.startsWith('-o=') || argument.startsWith('--out='))) {
    throw new OfficeCommandError('Rendered Office views require --out with a path below /workspace')
  }
  assertWorkspacePaths(argv)
  return argv
}

function assertSkillRequest(argv: readonly string[]): void {
  if (argv.length === 1) return
  const skill = argv[1]
  if (skill === undefined || !SKILLS.has(skill)) {
    throw new OfficeCommandError('OfficeCLI load_skill is limited to word, excel, or pptx')
  }
  if (argv.length === 2) return
  const reference = argv[3]
  if (argv.length !== 4 || argv[2] !== '--path' || reference === undefined) {
    throw new OfficeCommandError('OfficeCLI load_skill accepts only an optional --path reference')
  }
  const path = reference.replaceAll('\\', '/')
  if (path.startsWith('/') || path.startsWith('~') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new OfficeCommandError('OfficeCLI Skill reference paths must be relative and cannot traverse directories')
  }
}

function shellWords(input: string): string[] {
  const words: string[] = []
  let word = ''
  let quoted = false
  let quote: "'" | '"' | undefined
  let escaped = false
  const finish = () => {
    if (word.length > 0 || quoted) words.push(word)
    word = ''
    quoted = false
  }
  for (const character of input) {
    if (/[\u0000-\u0008\u000a-\u001f]/u.test(character)) {
      throw new OfficeCommandError('OfficeCLI command contains a control character')
    }
    if (escaped) {
      word += character
      escaped = false
      quoted = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      quoted = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else word += character
      quoted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      quoted = true
      continue
    }
    if (/\s/u.test(character)) finish()
    else word += character
  }
  if (escaped || quote !== undefined) throw new OfficeCommandError('OfficeCLI command has an unfinished quote or escape')
  finish()
  return words
}

function assertWorkspacePaths(argv: readonly string[]): void {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) throw new OfficeCommandError('OfficeCLI command is missing an argument')
    if (FILE_OPTIONS.has(argument)) {
      const value = argv[index + 1]
      if (value === undefined) throw new OfficeCommandError(`${argument} requires a path below /workspace`)
      assertWorkspacePath(value)
      index += 1
      continue
    }
    if (argument === '--commands') {
      const value = argv[index + 1]
      if (value === undefined) throw new OfficeCommandError('--commands requires a JSON array')
      assertInlineBatchPaths(value)
      index += 1
      continue
    }
    if (argument === '--data') {
      const value = argv[index + 1]
      if (value === undefined) throw new OfficeCommandError('--data requires JSON or a path below /workspace')
      try { JSON.parse(value) } catch { assertWorkspacePath(value) }
      index += 1
      continue
    }
    const equals = argument.indexOf('=')
    const value = equals < 0 ? argument : argument.slice(equals + 1)
    if (equals >= 0 && argument.slice(0, equals) === '--commands') {
      assertInlineBatchPaths(value)
      continue
    }
    if (equals >= 0 && argument.slice(0, equals) === '--data') {
      try { JSON.parse(value) } catch { assertWorkspacePath(value) }
      continue
    }
    if (equals >= 0 && FILE_OPTIONS.has(argument.slice(0, equals))) {
      assertWorkspacePath(value)
      continue
    }
    if (pathLike(value)) assertWorkspacePath(value.slice(value.lastIndexOf('=') + 1))
  }
}

function assertInlineBatchPaths(value: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new OfficeCommandError('--commands must contain valid JSON')
  }
  if (!isJsonArray(parsed)) throw new OfficeCommandError('--commands must contain a JSON array')
  const pending: unknown[] = [...parsed]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    visited += 1
    if (visited > 4096) throw new OfficeCommandError('--commands JSON is too complex')
    if (typeof current === 'string') {
      if (pathLike(current)) assertWorkspacePath(current)
    } else if (isJsonArray(current)) pending.push(...current)
    else if (isJsonObject(current)) pending.push(...Object.values(current))
  }
}

function isJsonArray(value: unknown): value is unknown[] { return Array.isArray(value) }
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pathLike(value: string): boolean {
  return /(?:^|\/|\\)[^/\\]+\.(?:csv|docx|gif|jpeg|jpg|json|pdf|png|pptx|svg|tsv|webp|xlsx|xml)$/iu.test(value)
}

function assertWorkspacePath(value: string): void {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '' || normalized.startsWith('~') || normalized.split('/').includes('..')
    || normalized.startsWith('/') && !normalized.startsWith(`${WORKSPACE}/`)) {
    throw new OfficeCommandError('OfficeCLI file paths must stay below /workspace')
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", '\'"\'"\'')}'`
}

/** Refusal of an unsupported, oversized or unsafe OfficeCLI command proposal. */
export class OfficeCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficeCommandError'
  }
}
