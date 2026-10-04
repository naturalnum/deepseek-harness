/** Persistent browser storage is scoped to one fixed Host/Platform deployment. */
import { createHash } from 'node:crypto'
import type { CloudDesktopConfig } from './config.ts'

/**
 * Isolate deployment cookies, including loopback cookies that do not distinguish ports.
 * @param config - Normalized Host and Platform origins.
 * @returns Stable Electron Session partition; both origins in this deployment share it.
 */
export function cloudDesktopPartition(config: CloudDesktopConfig): string {
  return `persist:power-evolve-${createHash('sha256').update(JSON.stringify([config.hostOrigin, config.platformOrigin])).digest('hex')}`
}
