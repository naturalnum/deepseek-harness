/** Static operator-owned Host destinations and mandatory forwarding budgets. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const positive = z.number().int().positive()
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value
      && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  } catch (_invalidUrl) { return false }
})

/** Browser input cannot choose an origin, path, worker or forwarding budget. */
export const nativeInputOwnerRoutingConfig = z.object({
  workerOrigins: z.record(z.uuid().refine(value => value === value.toLowerCase()), origin),
  timeoutMs: positive.max(2_147_483_647),
  maxResponseBytes: positive,
}).strict()

/** Explicit UUID-to-origin deployment mapping; an empty mapping refuses every owner. */
export type NativeInputOwnerRoutingConfig = Readonly<{
  workerOrigins: Readonly<Record<string, string>>
  timeoutMs: number
  maxResponseBytes: number
}>

/** Load a private absolute JSON file; invalid configuration fails without printing its contents.
 * @param path Operator-supplied absolute filename; all settings are required.
 * @returns Validated static destinations and HTTP budgets, without defaults or registration effects.
 */
export async function loadNativeInputOwnerRoutingConfig(path: string): Promise<NativeInputOwnerRoutingConfig> {
  try {
    if (!isAbsolute(path) || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) throw new Error('Invalid path')
    return nativeInputOwnerRoutingConfig.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (_invalidConfiguration) { throw new Error('Invalid native input owner routing configuration') }
}
