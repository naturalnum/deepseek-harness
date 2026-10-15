/** Fixed SDK utility for one already approved native Pod; no control credential enters this process. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { stdioExecutorOwnerV2, stdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioEnvironmentValues } from '@power-evolve/contracts/stdio-environment'
import { stdioOutcomeV2 } from '@power-evolve/contracts/stdio-runtime'
import { runStdioDispatchV2, validateStdioStartV2 } from '@power-evolve/connector-runner/stdio-v2-dispatch'

const input = z.object({ packet: z.unknown(), limits: stdioLimitsV2, maxReplyBytes: z.number().int().positive(),
  environment: stdioEnvironmentValues.optional() }).strict()
const controller = new AbortController()
process.once('SIGTERM', () => { controller.abort() })
process.once('SIGINT', () => { controller.abort() })
const raw = readFileSync(0, 'utf8')
const request = input.parse(JSON.parse(raw))
if (Buffer.byteLength(raw) > request.limits.maxInputBytes) throw new Error('stdio_v2_native_input_limit')
const owner = z.object({ dispatch: z.object({ permit: z.object({ executorOwner: z.unknown() }).loose() }).loose() })
  .parse(request.packet).dispatch.permit.executorOwner
const packet = validateStdioStartV2(request.packet, request.limits, stdioExecutorOwnerV2.parse(owner), Date.now())
const outcome = await runStdioDispatchV2(packet.dispatch, { workspaceRoot: '/workspace',
  env: { HOME: '/home/agent', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  identity: { kind: 'current' } }, controller.signal, request.environment)
const result = stdioOutcomeV2(request.limits, request.maxReplyBytes).parse(outcome)
process.stdout.write(JSON.stringify(result))
