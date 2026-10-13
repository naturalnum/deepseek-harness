/** Bounded cloud Shell requests and observed outcomes shared by native providers and the trusted Platform. */
import { z } from 'zod'
import { resolutionExecutionId } from '@power-evolve/contracts/execution-resolution'

/** Foreground admission uses a stable native tool call identity and an explicit deadline. */
export const cloudShellProposeRequest = z.object({
  callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
  cwd: z.string().max(256).regex(/^[^\u0000-\u001f\u007f\\]*$/u)
    .refine(value => !value.startsWith('/') && !value.split('/').includes('..')),
  timeoutMs: z.number().int().min(1000).max(300_000),
  cancelRequested: z.boolean().optional(),
  cancelCause: z.enum(['timeout', 'abort']).optional(),
}).strict()

/** A read or stop request never authorizes a fresh command. */
export const cloudShellExecutionRequest = z.object({ executionId: resolutionExecutionId }).strict()

/** First stopping cause is durable; retrying a cancellation cannot replace it. */
export const cloudShellCancelRequest = z.object({ executionId: resolutionExecutionId,
  cause: z.enum(['timeout', 'abort']) }).strict()

/** Result fields contain execution facts; stdout and stderr remain untrusted command data. */
export const cloudShellResult = z.object({
  exitCode: z.number().int().nullable(), stdout: z.string().max(65_536), stderr: z.string().max(65_536),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(),
}).strict()

/** A terminal observation is delivered to the original native tool instead of a new user message. */
export const cloudShellObservation = z.object({
  executionId: resolutionExecutionId, state: z.enum(['queued', 'starting', 'running', 'cancelling', 'succeeded', 'failed',
    'cancelled', 'uncertain', 'closed_unknown']), command: z.string().max(8192), cwd: z.string().max(256),
  timeoutMs: z.number().int().positive(), result: cloudShellResult.nullable(), errorCode: z.string().nullable(),
  cancelCause: z.enum(['timeout', 'abort']).nullable(),
}).strict()

/** Validated cloud Shell observation. */
export type CloudShellObservation = z.infer<typeof cloudShellObservation>
