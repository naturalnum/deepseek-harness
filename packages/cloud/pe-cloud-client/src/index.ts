/** Host declaration half; cloud-client has no Host service or listener. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable declaration-half plugin name; this is not an account or root service. */
export const name = 'pe-cloud-client'
/** Browser declaration requires no Host services. */
export const inject: string[] = []
/** The Host declaration accepts no configuration fields. */
export interface Config {}
/** Empty Host declaration configuration. */
export const Config: z<Config> = z.object({})

/**
 * Declare the browser package without activating an account Host service.
 * @param _ctx - declaration Context; no service, route, or effect is registered.
 * @param _config - empty Loader configuration.
 */
export function apply(_ctx: Context, _config: Config): void {}
