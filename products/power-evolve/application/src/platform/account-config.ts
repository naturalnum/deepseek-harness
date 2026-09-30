/** Deployment-owned account catalog and explicit, private first-administrator configuration. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { accountNewPassword, accountNewUsername, accountUserId } from '../account-contracts.ts'

const model = z.object({ id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  label: z.string().trim().min(1).max(200), maxTokens: z.number().int().min(1).max(8192) }).strict()
/** All replicas use the same bounded model catalog; account requests cannot invent model IDs. */
export const accountManagementConfig = z.object({
  maxUsers: z.number().int().min(1).max(1_000_000), models: z.array(model).min(1).max(64),
  initialSettings: z.object({ model: model.shape.id, maxTokens: model.shape.maxTokens }).strict(),
}).strict().refine(value => new Set(value.models.map(item => item.id)).size === value.models.length
  && value.models.some(item => item.id === value.initialSettings.model && item.maxTokens >= value.initialSettings.maxTokens))
export type AccountManagementConfig = z.infer<typeof accountManagementConfig>

/** Existing databases require the exact existing ID and login name; create is allowed only in an empty database. */
export const accountBootstrapConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), userId: accountUserId, username: z.string().min(1).max(80) }).strict(),
  z.object({ mode: z.literal('create'), userId: accountUserId, username: accountNewUsername,
    displayName: z.string().trim().min(1).max(200).refine(value => !value.includes('\0')), password: accountNewPassword }).strict(),
])
export type AccountBootstrapConfig = z.infer<typeof accountBootstrapConfig>

/**
 * Read the catalog from an absolute operator-owned file; parser diagnostics never contain configuration values.
 * @param path Absolute private account-management JSON filename.
 * @param readText Trusted reader used by deployment preflight.
 * @returns Validated catalog and account limit.
 */
export async function loadAccountManagementConfig(path: string,
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<AccountManagementConfig> {
  try {
    if (!isAbsolute(path)) throw new Error('Absolute filename required')
    const text = await readText(path)
    if (Buffer.byteLength(text) > 65536) throw new Error('Configuration too large')
    return accountManagementConfig.parse(JSON.parse(text))
  } catch { throw new Error('Invalid account management configuration') }
}

/**
 * Read an explicitly enabled first-administrator file; an empty path never infers an administrator from seeds.
 * @param path Absolute private bootstrap JSON filename, or empty to disable initialization.
 * @param readText Trusted reader used by deployment preflight.
 * @returns Validated private bootstrap settings, or null when initialization is disabled.
 */
export async function loadAccountBootstrapConfig(path: string,
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<AccountBootstrapConfig | null> {
  if (!path) return null
  try {
    if (!isAbsolute(path)) throw new Error('Absolute filename required')
    const text = await readText(path)
    if (Buffer.byteLength(text) > 4096) throw new Error('Configuration too large')
    return accountBootstrapConfig.parse(JSON.parse(text))
  } catch { throw new Error('Invalid account bootstrap configuration') }
}
