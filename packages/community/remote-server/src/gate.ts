/**
 * The two-tier gate every remote command passes through.
 *
 * Fixed order, and the order is the design: unknown alias, then the
 * deterministic high-risk ruleset, then the read-only allowlist, then the model
 * classifier, then the human. Every branch that cannot reach a confident
 * "clear" ends at a human, and a human that cannot be reached ends at a denial.
 *
 * The ruleset is a noise filter, not a security boundary — `r''m -rf`, a
 * base64-decoded payload, or an indirect script call all walk past it. What
 * actually bounds damage is that the default leans to a human and that the SSH
 * user's own permissions on the target still apply.
 * @module dsh-remote-server/gate
 */

import type { RemoteApprovalPolicy } from './policy.ts'
import type { GateDecision } from './types.ts'

/** One deterministic high-risk category. */
export interface RiskRule {
  /** Stable identifier, recorded in the session event. */
  readonly id: string
  /** Human-readable category, shown in the approval prompt. */
  readonly label: string
  /** Matched against the whitespace-normalized command. */
  readonly pattern: RegExp
}

/**
 * The high-risk ruleset. Matching any of these forces a human decision and
 * cannot be overridden by the classifier or by the read-only allowlist.
 */
export const RISK_RULES: readonly RiskRule[] = [
  {
    id: 'recursive-delete',
    label: 'recursive deletion',
    pattern: /\brm\s+(-\w*\s+)*-\w*[rR]|\brm\s+-\w*[rR]|\bfind\b[^|;]*-delete\b|\bshred\b/,
  },
  {
    id: 'disk-write',
    label: 'disk or filesystem write',
    pattern: /\b(mkfs(\.\w+)?|fdisk|parted|sgdisk|mkswap|wipefs|blkdiscard|badblocks)\b|\bdd\b[^|;]*\bof=/,
  },
  {
    id: 'power-state',
    label: 'shutdown or reboot',
    pattern: /\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b|\bsystemctl\s+(reboot|poweroff|halt)\b/,
  },
  {
    id: 'service-state',
    label: 'service stop or restart',
    pattern: /\bsystemctl\s+(stop|restart|disable|mask|kill)\b|\bservice\s+\S+\s+(stop|restart)\b|\bsupervisorctl\s+(stop|restart)\b/,
  },
  {
    id: 'account-change',
    label: 'user or permission change',
    pattern: /\b(useradd|userdel|usermod|groupadd|groupdel|groupmod|passwd|chpasswd|visudo|setfacl)\b|\bch(own|mod|grp)\b/,
  },
  {
    id: 'package-change',
    label: 'package install or removal',
    // oxlint-disable-next-line @stylistic/max-len -- Preserve the pinned upstream regular expression.
    pattern: /\b(apt|apt-get|aptitude|yum|dnf|zypper|apk|pacman|snap|brew)\s+(install|remove|purge|upgrade|erase|add|del)\b|\bpip3?\s+(install|uninstall)\b|\bnpm\s+(install|uninstall)\b[^|;]*\s-g\b|\bgem\s+(install|uninstall)\b/,
  },
  {
    id: 'system-path-write',
    label: 'write into a system path',
    // oxlint-disable-next-line @stylistic/max-len -- Preserve the pinned upstream regular expression.
    pattern: />>?\s*\/(etc|usr|bin|sbin|boot|lib|sys|proc|var\/lib|opt)\b|\btee\s+(-\w+\s+)*\/(etc|usr|bin|sbin|boot|lib|var\/lib|opt)\b|\b(mv|cp|ln|install|truncate)\b[^|;]*\s\/(etc|usr|bin|sbin|boot|lib|var\/lib)\//,
  },
  {
    id: 'privilege-escalation',
    label: 'privilege escalation',
    pattern: /(^|[\s;&|(])(sudo|doas|pkexec|runuser)\b|(^|[\s;&|(])su\b(\s|$)/,
  },
  {
    id: 'credential-read',
    label: 'read of a credential or key path',
    // oxlint-disable-next-line @stylistic/max-len -- Preserve the pinned upstream regular expression.
    pattern: /\/etc\/(shadow|gshadow|sudoers)\b|(^|[\s"'/])\.ssh\/id_\w+|(^|[\s"'/])\.aws\/credentials\b|(^|[\s"'/])\.kube\/config\b|(^|[\s"'/])\.netrc\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|\S+\.pem\b/,
  },
]

/** Shell syntax that chains, substitutes, or redirects — never a plain read, whatever the leading token says. */
const COMPOUND = /[;&|`$><\n]|\$\(/

/**
 * The first high-risk rule this command matches.
 * @param command - the command line as the model wrote it.
 * @returns the matching rule, or undefined when none fires.
 */
export function matchRiskRule(command: string): RiskRule | undefined {
  const normalized = command.replace(/\s+/g, ' ').trim()
  return RISK_RULES.find(rule => rule.pattern.test(normalized))
}

/**
 * Whether the command is a plain invocation of an allowlisted read-only prefix.
 *
 * A command carrying any chaining, substitution, or redirection syntax is never
 * allowlisted: `df -h; rm -rf /` leads with an allowlisted token and is not a read.
 * @param command - the command line.
 * @param allowlist - configured command prefixes.
 * @returns true when the leading tokens match an allowlist entry exactly.
 */
export function isAllowlisted(command: string, allowlist: readonly string[]): boolean {
  if (COMPOUND.test(command)) return false
  const tokens = command.trim().split(/\s+/)
  return allowlist.some((entry) => {
    const prefix = entry.trim().split(/\s+/)
    return prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token)
  })
}

/** What the classifier answered for one command. */
export type Classification = 'auto' | 'human'

/**
 * Classifies a command the deterministic rules did not resolve.
 * Absent — unconfigured, failing, or timing out — means every such command
 * goes to a human.
 */
export interface CommandClassifier {
  /**
   * @param command - the command line.
   * @param alias - the target server, since the same command differs in risk per host.
   * @param signal - cancellation for the classification call itself.
   * @returns the verdict, or undefined when no confident verdict was produced.
   */
  classify(command: string, alias: string, signal?: AbortSignal): Promise<Classification | undefined>
}

/** Asks a human for a one-shot decision. Absent means no approval channel is composed. */
export interface ApprovalAsker {
  /** Explain a native-policy refusal without changing that policy. */
  denialReason?(): string | undefined
  /**
   * @param reason - why this command needs a human.
   * @returns true when a human allowed this one call.
   */
  ask(reason: string): Promise<boolean>
}

/** Everything the gate consults for one decision. */
export interface GateInput {
  readonly command: string
  readonly alias: string
  readonly isRegistered: boolean
  readonly config: RemoteApprovalPolicy
  readonly classifier?: CommandClassifier
  readonly approval?: ApprovalAsker
  readonly signal?: AbortSignal
}

/**
 * Decide one command.
 *
 * @param input - the command, its target, and the collaborators to consult.
 * @returns the decision and the path that produced it.
 */
export async function decide(input: GateInput): Promise<GateDecision> {
  input.signal?.throwIfAborted()
  if (!input.isRegistered) {
    return {
      kind: 'denied',
      path: 'unregistered',
      reason: `${JSON.stringify(input.alias)} is not a registered server`,
    }
  }

  // The ruleset runs before the allowlist and before the classifier: neither
  // can clear a command that matches a high-risk category.
  const rule = matchRiskRule(input.command)
  if (rule !== undefined) {
    return escalate(input, 'ruleset', `matches the high-risk category "${rule.label}" (${rule.id})`)
  }

  if (input.config.alwaysAsk) {
    return escalate(input, 'always-ask', 'this deployment routes every remote command to a human')
  }

  if (isAllowlisted(input.command, input.config.readOnlyAllowlist)) {
    return { kind: 'auto', path: 'allowlist', reason: 'a configured read-only command' }
  }

  const classification = input.classifier === undefined
    ? undefined
    : await input.classifier.classify(input.command, input.alias, input.signal)

  input.signal?.throwIfAborted()
  if (classification === 'auto') {
    return { kind: 'auto', path: 'classified-auto', reason: 'classified as safe to run unattended' }
  }
  return escalate(
    input,
    'classified-human',
    classification === 'human'
      ? 'classified as needing a human decision'
      : 'no confident classification was produced, so this defaults to a human decision',
  )
}

/** Route one command to a human, failing closed when no approval channel answers. */
async function escalate(input: GateInput, path: GateDecision['path'], reason: string): Promise<GateDecision> {
  if (input.approval === undefined) {
    return {
      kind: 'denied',
      path,
      reason: `${reason}, and no approval channel is available to ask — refusing to run it`,
    }
  }
  input.signal?.throwIfAborted()
  const allowed = await input.approval.ask(reason)
  input.signal?.throwIfAborted()
  return allowed
    ? { kind: 'approved', path, reason }
    : { kind: 'denied', path, reason: `${reason}; ${input.approval.denialReason?.() ?? 'a human declined'}` }
}
