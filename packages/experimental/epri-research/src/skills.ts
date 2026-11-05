/** Research skill contribution owned by the existing account Preset. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './service.ts'
export const name = 'epri-research/skills'
export const inject = ['epriResearch', 'skills']
/** No configuration beyond the account's approved service. */
export interface Config {}
export const Config: z<Config> = z.object({})
/** @param ctx Original Preset fiber. */
export function apply(ctx: Context): void { ctx.epriResearch.install('skills', ctx) }
