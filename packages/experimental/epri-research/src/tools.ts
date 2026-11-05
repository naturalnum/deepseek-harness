/** Research tools contributed to the existing approved account Preset. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './service.ts'
export const name = 'epri-research/tools'
export const inject = ['epriResearch', 'tools']
/** No configuration beyond the account's approved service. */
export interface Config {}
export const Config: z<Config> = z.object({})
/** @param ctx Original Preset fiber. */
export function apply(ctx: Context): void { ctx.epriResearch.install('tools', ctx) }
