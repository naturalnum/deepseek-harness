/** Root Loader adapter for a separately composed original Native service-content WebServer. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import './auth-root.ts'

/** Stable content-listener Loader entry. */
export const name = 'pe-cloud-access/applications'
/** The management Root authentication owner and this group's isolated original Native listener. */
export const inject = ['peAuth', 'webServer']
/** No request, identity or destination policy may be supplied by this adapter. */
export const Config = z.object({})

/**
 * Attach the isolated listener through the original Root owner; policy remains in pe-cloud-access/root.
 * @param ctx Original Loader scope with an isolated Native WebServer and the shared Root peAuth.
 */
export function apply(ctx: Context): void {
  ctx.peAuth.attachApplicationListener(ctx, ctx.webServer)
}
