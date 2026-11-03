/**
 * Reader for the user's own `~/.ssh/config`, so a server already configured
 * for `ssh` can be registered without retyping it.
 *
 * The parser is deliberately narrow: it recognizes the four keywords an entry
 * needs (`HostName`, `User`, `Port`, `IdentityFile`) plus `Include`, and it
 * reads nothing else. It never opens a key file — `IdentityFile` is carried
 * as the path it is written as, exactly like a hand-entered one.
 * @module dsh-remote-server/ssh-config
 */

/** One importable host, as the config describes it. */
export interface SshConfigHost {
  /** The first literal pattern of its `Host` line; also the proposed alias. */
  readonly alias: string
  /** `HostName` when present, otherwise the alias — which is what `ssh` itself does. */
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly identityFile?: string
  /** Absolute path of the file this block was read from, for display. */
  readonly source: string
}

/** How deep `Include` chains are followed before the parser stops descending. */
export const MAX_INCLUDE_DEPTH = 8

/** Reads one config file; returns undefined when it does not exist or cannot be read. */
export type ConfigReader = (path: string) => string | undefined

/** Everything the pure parser needs from the outside world. */
export interface ParseContext {
  /** Reads a config file by absolute path. */
  readonly read: ConfigReader
  /** Absolute path of the user's home directory, for `~` and relative `Include` resolution. */
  readonly home: string
  /**
   * Expands one already-resolved `Include` path that may contain glob
   * characters. Omit to treat every path literally — the parser then simply
   * finds nothing for a glob, rather than guessing.
   */
  readonly expandGlob?: (pattern: string) => readonly string[]
}

/** A `Host` pattern that matches more than one name cannot become one registered alias. */
function isLiteralPattern(pattern: string): boolean {
  return !/[*?!]/.test(pattern)
}

/**
 * Split one config line into its keyword and value.
 *
 * OpenSSH accepts both `Keyword Value` and `Keyword=Value`, and keywords are
 * case-insensitive; the returned keyword is lowercased for comparison.
 * @param line - one raw line.
 * @returns the keyword and its value, or undefined for a blank or comment line.
 */
export function splitDirective(line: string): { keyword: string; value: string } | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined
  const match = /^([A-Za-z][\w-]*)\s*(?:=|\s)\s*(.*)$/.exec(trimmed)
  if (match === null) return undefined
  const keyword = match[1]?.toLowerCase() ?? ''
  const value = (match[2] ?? '').trim()
  if (value.length === 0) return undefined
  // A quoted value is one token; OpenSSH strips the quotes.
  const unquoted = /^"(.*)"$/.exec(value)
  return { keyword, value: unquoted?.[1] ?? value }
}

/** Expand a leading `~` against the given home directory. */
export function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  return path
}

/**
 * Resolve one `Include` argument to candidate absolute paths.
 *
 * OpenSSH resolves a relative include against `~/.ssh` for a user config, so
 * that is what a bare `config.d/*` means here.
 * @param spec - the `Include` argument, possibly containing globs.
 * @param context - home directory and optional glob expansion.
 * @returns absolute candidate paths, empty when a glob cannot be expanded.
 */
export function resolveInclude(spec: string, context: ParseContext): readonly string[] {
  const expanded = expandTilde(spec, context.home)
  const absolute = expanded.startsWith('/') ? expanded : `${context.home}/.ssh/${expanded}`
  if (!/[*?[]/.test(absolute)) return [absolute]
  return context.expandGlob?.(absolute) ?? []
}

/** Parser state for one file in the include chain. */
interface Block {
  patterns: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  source: string
}

/** Turn one finished block into a candidate, or nothing when it names no literal host. */
function toHost(block: Block | undefined): SshConfigHost | undefined {
  if (block === undefined) return undefined
  const alias = block.patterns.find(isLiteralPattern)
  if (alias === undefined) return undefined
  return {
    alias,
    host: block.hostName ?? alias,
    ...(block.user === undefined ? {} : { user: block.user }),
    ...(block.port === undefined ? {} : { port: block.port }),
    ...(block.identityFile === undefined ? {} : { identityFile: block.identityFile }),
    source: block.source,
  }
}

/**
 * Parse one config file and everything it includes.
 *
 * A `Host` line whose patterns are all wildcards (`Host *`) contributes
 * defaults to `ssh` but names no importable server, so it is skipped. A
 * `Match` block ends the current host block: its directives are conditional,
 * and carrying them into a fixed entry would misrepresent them.
 * @param entryPath - absolute path of the file to start from.
 * @param context - file reader, home directory, optional glob expansion.
 * @returns candidates in file order, first occurrence of an alias winning.
 */
export function parseSshConfig(entryPath: string, context: ParseContext): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  const seenAliases = new Set<string>()
  const visitedFiles = new Set<string>()

  const walk = (path: string, depth: number): void => {
    // Cycle protection and depth bound together: a config that includes itself
    // directly or through a chain stops here instead of recursing forever.
    if (depth > MAX_INCLUDE_DEPTH || visitedFiles.has(path)) return
    visitedFiles.add(path)
    const text = context.read(path)
    if (text === undefined) return

    let block: Block | undefined
    const flush = (): void => {
      const host = toHost(block)
      if (host !== undefined && !seenAliases.has(host.alias)) {
        seenAliases.add(host.alias)
        hosts.push(host)
      }
      block = undefined
    }

    for (const line of text.split('\n')) {
      const directive = splitDirective(line)
      if (directive === undefined) continue
      switch (directive.keyword) {
        case 'host':
          flush()
          block = { patterns: directive.value.split(/\s+/).filter(p => p.length > 0), source: path }
          break
        case 'match':
          // Conditional directives follow; nothing after this belongs to a fixed entry.
          flush()
          break
        case 'include':
          // An include inside a block interrupts it, matching how OpenSSH
          // splices the included directives in at this point.
          flush()
          for (const included of resolveInclude(directive.value, context)) walk(included, depth + 1)
          break
        case 'hostname':
          if (block !== undefined) block.hostName = directive.value
          break
        case 'user':
          if (block !== undefined) block.user = directive.value
          break
        case 'port': {
          const port = Number(directive.value)
          if (block !== undefined && Number.isInteger(port) && port > 0 && port <= 65_535) block.port = port
          break
        }
        case 'identityfile':
          // Stored as written, then tilde-expanded so the SSH client receives a
          // path it can open regardless of the process's own cwd.
          if (block !== undefined) block.identityFile = expandTilde(directive.value, context.home)
          break
        default:
          // Every other keyword is deliberately ignored: this reader imports
          // connection identity, not the user's full ssh configuration.
          break
      }
    }
    flush()
  }

  walk(entryPath, 0)
  return hosts
}
