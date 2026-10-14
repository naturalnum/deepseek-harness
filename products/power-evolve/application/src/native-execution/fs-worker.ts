/** One-shot native filesystem worker executed inside a credential-free payload Pod. */
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { posix } from 'node:path'
import { z } from 'zod'

const pathSchema = z.string().min(1).max(4096)
const targetSchema = z.object({ targetKey: pathSchema, displayPath: pathSchema }).strict()
const version = z.string().min(1)
const expected = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(),
  z.object({ kind: z.literal('replaceIfVersion'), version }).strict()])
const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('resolve'), path: pathSchema, cwd: pathSchema }).strict(),
  z.object({ op: z.literal('lstat'), path: pathSchema, cwd: pathSchema }).strict(),
  z.object({ op: z.literal('stat'), target: targetSchema }).strict(),
  z.object({ op: z.literal('readText'), target: targetSchema }).strict(),
  z.object({ op: z.literal('readBytes'), target: targetSchema, maxBytes: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('readRange'), target: targetSchema,
    offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('listDir'), target: targetSchema }).strict(),
  z.object({ op: z.literal('writeText'), target: targetSchema, content: z.string(), expected: expected.optional() }).strict(),
  z.object({ op: z.literal('editText'), target: targetSchema,
    edit: z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean() }).strict(),
    expected: z.object({ version }).strict().optional() }).strict(),
])

function allowed(path: string): string {
  const resolved = posix.resolve(path)
  if (!['/workspace', '/home/agent', '/tmp'].some(root => resolved === root || resolved.startsWith(root + '/'))) {
    throw new FsError('Path is outside the Agent execution world.', 'FS_PERMISSION_DENIED')
  }
  return resolved
}

/** Run an externally validated JSON request through the unchanged native filesystem implementation.
 * @param request Untrusted wire request, bounded by the trusted caller before launch.
 * @returns JSON-safe result, including native atomic versions and diff bases.
 */
export async function executeNativeFsRequest(request: unknown): Promise<unknown> {
  const parsed = requestSchema.parse(request)
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: '/workspace', diffBasisMaxBytes: 10 * 1024 * 1024 })
  const fs = ctx.fs
  const checked = async (target: { targetKey: string; displayPath: string }): Promise<FsTarget> => {
    const path = allowed(target.targetKey)
    const fresh = await fs.resolve(path)
    allowed(fs.processPath(fresh))
    if (fresh.targetKey !== path) throw new FsError('File target changed.', 'FS_STALE_VERSION')
    return { targetKey: FsTargetKey(path), displayPath: target.displayPath }
  }
  try {
    if (parsed.op === 'resolve') {
      const target = await fs.resolve(allowed(posix.resolve(allowed(parsed.cwd), parsed.path)))
      allowed(fs.processPath(target))
      return target
    }
    if (parsed.op === 'lstat') return await fs.lstat(allowed(posix.resolve(allowed(parsed.cwd), parsed.path))) ?? null
    const target = await checked(parsed.target)
    switch (parsed.op) {
      case 'stat': return await fs.stat(target) ?? null
      case 'readText': return await fs.readText(target)
      case 'readBytes': return Buffer.from(await fs.readBytes(target, undefined, parsed.maxBytes)).toString('base64')
      case 'readRange': return Buffer.from(await fs.readByteRange(target, parsed)).toString('base64')
      case 'listDir': {
        const entries = await fs.listDir(target)
        for (const entry of entries) allowed(fs.processPath(entry.target))
        return entries
      }
      case 'writeText': return await fs.writeText(target, parsed.content, parsed.expected === undefined ? undefined
        : parsed.expected.kind === 'createIfAbsent' ? parsed.expected : { ...parsed.expected, version: fsVersion(parsed.expected.version) })
      case 'editText': return await fs.editText(target, parsed.edit,
        parsed.expected === undefined ? undefined : { version: fsVersion(parsed.expected.version) })
    }
  } finally { await ctx.fiber.dispose() }
}

import { FsVersion as fsVersion } from '@deepseek-ai/dsh-fs'

/** Stream text through the unchanged native provider while retaining its Context until iteration settles.
 * @param request Original native target within the mounted user world.
 * @returns Native text chunks; Context disposal joins the opened reader.
 */
export async function* streamNativeFsRequest(request: unknown): AsyncIterable<string> {
  const parsed = z.object({ op: z.literal('streamText'), target: targetSchema }).strict().parse(request)
  const ctx = new Context()
  try {
    await ctx.plugin(LocalFileSystem, { cwd: '/workspace', diffBasisMaxBytes: 10 * 1024 * 1024 })
    const path = allowed(parsed.target.targetKey), fresh = await ctx.fs.resolve(path)
    allowed(ctx.fs.processPath(fresh))
    if (fresh.targetKey !== path) throw new FsError('File target changed.', 'FS_STALE_VERSION')
    for await (const chunk of await ctx.fs.streamText(fresh)) yield chunk
  } finally { await ctx.fiber.dispose() }
}
