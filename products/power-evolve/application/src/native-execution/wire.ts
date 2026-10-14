/** Bounded native execution JSON requests; raw process bytes travel as canonical base64. */
import { z } from 'zod'
import { nativeExecutionWorld } from './types.ts'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

/** Wire filesystem target brands are issued by the server and checked against its world. */
export const nativeFsTarget = z.object({ targetKey: z.string().min(1).max(4352).transform(FsTargetKey), displayPath: z.string().max(4096) }).strict()
/** Native metadata preserves opaque file-version tokens. */
export const nativeFsInfo = z.object({ type: z.enum(['file', 'directory', 'other']), version: z.string().transform(FsVersion), size: z.number().nonnegative().optional() }).strict()
/** Native path metadata also distinguishes symbolic links. */
export const nativeFsPathInfo = nativeFsInfo.extend({ type: z.enum(['file', 'directory', 'other', 'symlink']) }).strict()
/** Native atomic-write outcome. */
export const nativeFsWrite = z.object({ operation: z.enum(['create', 'update']), version: z.string().transform(FsVersion), before: z.string().nullable(), after: z.string() }).strict()
/** Native literal-edit outcome. */
export const nativeFsEdit = nativeFsWrite.omit({ operation: true }).extend({ before: z.string() }).strict()

const path = z.string().min(1).max(4096)
const version = z.string().transform(FsVersion)
const expected = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(), z.object({ kind: z.literal('replaceIfVersion'), version }).strict()])
/** Closed filesystem dispatch vocabulary used by both Runtime and Platform. */
export const nativeFsRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('resolve'), path, cwd: path }).strict(),
  z.object({ op: z.literal('lstat'), path, cwd: path }).strict(),
  z.object({ op: z.literal('stat'), target: nativeFsTarget }).strict(),
  z.object({ op: z.literal('readText'), target: nativeFsTarget }).strict(),
  z.object({ op: z.literal('readBytes'), target: nativeFsTarget, maxBytes: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('readRange'), target: nativeFsTarget, offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('listDir'), target: nativeFsTarget }).strict(),
  z.object({ op: z.literal('writeText'), target: nativeFsTarget, content: z.string(), expected: expected.optional() }).strict(),
  z.object({ op: z.literal('editText'), target: nativeFsTarget, edit: z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean() }).strict(), expected: z.object({ version }).strict().optional() }).strict(),
])
const output = z.union([z.enum(['pipe', 'inherit']), z.object({ maxBytes: z.number().int().positive(), spill: z.object({ maxBytes: z.number().int().positive() }).strict().optional() }).strict()])
/** Native argv process request; cancellation stays in the separate exact-handle stop route. */
export const nativeProcessSpec = z.object({ argv: z.array(z.string().max(1_048_576)).min(1).max(4096), cwd: path,
  env: z.record(z.string().min(1), z.string()).optional(), graceMs: z.number().positive().max(2_147_483_647),
  stdio: z.object({ stdin: z.union([z.enum(['pipe', 'ignore']), z.object({ data: z.string() }).strict()]),
    stdout: output, stderr: output, control: z.literal('pipe').optional() }).strict() }).strict()
/** Durable identity accompanies every native RPC. */
export const nativeWorldRequest = z.object({ world: nativeExecutionWorld }).strict()
/** Offset-based process observation, preserving independently retained output streams. */
export const nativeProcessObservation = z.object({ state: z.enum(['running', 'completed', 'failed']),
  outcome: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(),
  error: z.string().nullable(), control: z.object({ data: z.base64(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean(), ended: z.boolean() }).strict(), stdout: z.object({ data: z.base64(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean() }).strict(),
  stderr: z.object({ data: z.base64(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean() }).strict() }).strict()

/** Real guest terminal allocation request. */
export const nativeTerminalSpec = nativeProcessSpec.omit({ stdio: true }).extend({
  rows: z.number().int().positive().max(65535), cols: z.number().int().positive().max(65535),
  terminalType: z.string().min(1).max(256), shellActivity: z.boolean().optional(),
}).strict()
/** Byte-offset terminal observation and independent outcome. */
export const nativeTerminalObservation = z.object({ state: z.enum(['running', 'completed', 'failed']),
  outcome: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(), error: z.string().nullable(),
  output: z.object({ data: z.base64(), nextOffset: z.number().int().nonnegative(), lossy: z.boolean() }).strict(),
}).strict()
