/** Capture native file deliveries in this account's research store. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './service.ts'
export const name = 'epri-research/workbench'
export const inject = ['epriResearch', 'tools', 'sessionProjections']
/** No configuration beyond the account's approved service. */
export interface Config {}
export const Config: z<Config> = z.object({})
/** @param ctx Original account fiber. */
export function apply(ctx: Context): void { ctx.epriResearch.install('workbench', ctx) }
