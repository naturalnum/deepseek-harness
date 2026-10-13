/** Native message reconstruction from an operation's original admitted grant metadata. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PlatformError, type Grant } from '../contracts.ts'

function required<T>(value: T | null): T {
  if (value === null) throw new PlatformError(503, 'native_turn_source_missing')
  return value
}

/** Reconstruct only the accepted input; this function never binds files or freezes new settings.
 * @param value Frozen grant metadata, including its original trusted source.
 * @param messageId Stable product message identity pinned by the frame ledger.
 * @returns Original native user-message fields used for exact pending/claimed verification.
 */
export function nativeInputForTurn(value: Omit<Grant, 'token'>, messageId: MessageId): UserMessage {
  const source: UserMessage['source'] = value.source === 'platform_action'
    ? { kind: 'power-evolve-action', actionId: required(value.sourceActionId) }
    : value.source === 'sandbox_result' ? { kind: 'power-evolve-execution', executionId: required(value.sourceExecutionId) }
      : value.source === 'stdio_mcp_result' ? { kind: 'power-evolve-stdio-mcp', callId: required(value.sourceStdioMcpCallId) }
        : value.source === 'ssh_execute_result' ? { kind: 'power-evolve-ssh-execute', actionId: required(value.sourceSshExecuteActionId) }
          : value.source === 'remote_mcp_result' ? { kind: 'power-evolve-remote-mcp', actionId: required(value.sourceMcpActionId) }
            : value.source === 'stdio_v2_result' ? { kind: 'power-evolve-stdio-v2-result',
              actionId: required(value.sourceStdioV2ActionId), phase: required(value.sourceStdioV2Phase) }
              : value.source === 'stdio_v2_no_start' ? { kind: 'power-evolve-stdio-v2-no-start',
                actionId: required(value.sourceStdioV2NoStartActionId), phase: required(value.sourceStdioV2Phase) }
                : { kind: 'user', rpcId: brandString<SessionRequestId>(value.requestId) }
  return { id: messageId, role: 'user', source, content: value.nativeContent ?? [{ type: 'text', text: value.text }] }
}
