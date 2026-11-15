/** Preserve the existing Cloud skill-install ABI through the original Native name guard. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemoteMethodCompatibility } from '@deepseek-ai/dsh-api-gateway/client'

/**
 * Opt in only the original Cloud skills namespace before its generated contribution mounts.
 * @param ctx - Original Cloud entry scope; its disposal withdraws the compatibility value.
 */
export function installCloudRemoteMethodCompatibility(ctx: Context): void {
  const compatibility: ClientRemoteMethodCompatibility = Object.freeze({
    allowInstallMethod: (namespace: string) => namespace === 'cloudSkills',
  })
  ctx.provide('remoteMethodCompatibility', compatibility)
}
