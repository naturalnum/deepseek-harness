/** Resolve private Host derivative storage independently of Platform's durable image originals. */
import { dirname, isAbsolute, join } from 'node:path'
import type { LegacyMigrationHostImageOptions } from '../platform/legacy-migration-v2-host-images.ts'

/** Validated Host image settings, including an optional explicit derivative cache location. */
export interface NativeImageConfiguration {
  readonly readyFile: string
  readonly legacyImageCacheRoot: string
  readonly legacyImageMaxBytes: number
  readonly legacyImageMaxPixels: number
  readonly legacyImageMaxDimension: number
  readonly legacyImageMaxImagesPerMessage: number
  readonly legacyImageMaxMessageBytes: number
}

/** Resolve the default cache beside the Host readiness file before installing the attachment provider.
 * @param config Host settings validated by the named Profile's plugin configuration.
 * @returns Absolute derivative cache and explicit SDK image request limits.
 */
export function resolveNativeImageOptions(config: NativeImageConfiguration): LegacyMigrationHostImageOptions {
  const cacheRoot = config.legacyImageCacheRoot === ''
    ? join(dirname(config.readyFile), 'image-request-cache') : config.legacyImageCacheRoot
  if (!isAbsolute(cacheRoot)) throw new Error('Host image cache must be an absolute private path')
  return { cacheRoot, imageLimits: {
    maxImageBytes: config.legacyImageMaxBytes, maxImagePixels: config.legacyImageMaxPixels,
    maxImageDimension: config.legacyImageMaxDimension, maxImagesPerMessage: config.legacyImageMaxImagesPerMessage,
    maxMessageImageBytes: config.legacyImageMaxMessageBytes, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  } }
}
