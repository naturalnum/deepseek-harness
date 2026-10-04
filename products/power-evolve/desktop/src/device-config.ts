/** Development-only local Device runtime selection; installation owns its fixed runtime separately. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { DeviceProcessOptions } from './device-process.ts'

const path = z.string().min(1).refine(isAbsolute, 'device_runtime_requires_absolute_path')
const milliseconds = z.number().int().min(100).max(180000)
const bytes = z.number().int().min(1024).max(1024 * 1024)
const schema = z.object({
  nodeExecutable: path, cliEntrypoint: path, homeDir: path, workingDir: path,
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  loopbackOrigin: z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
      && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  }, 'device_requires_loopback_origin'),
  startupTimeoutMs: milliseconds, requestTimeoutMs: milliseconds,
  quiesceTimeoutMs: milliseconds, exitTimeoutMs: milliseconds,
  maxOutputBytes: bytes, maxMessageBytes: bytes, maxHealthBytes: bytes,
}).strict()

/**
 * Validate explicitly selected on-disk runtime configuration; renderer supplies no runtime fields.
 * @param value - Parsed development configuration, with no child environment or credentials.
 * @returns Validated process options except the independently selected child environment.
 */
export function parseDesktopDeviceConfig(value: unknown): Omit<DeviceProcessOptions, 'env'> {
  const config = schema.parse(value)
  return { ...config, loopbackOrigin: new URL(config.loopbackOrigin).origin }
}
