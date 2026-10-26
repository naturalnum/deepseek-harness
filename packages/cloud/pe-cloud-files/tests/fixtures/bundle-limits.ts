/** Explicit test capacities; these are not product defaults or production hard-domain evidence. */
import type { SkillBundleLimits } from '../../src/skill-bundles.ts'
import type { SkillProjectionLimits } from '../../src/skill-projection.ts'
export const limits: SkillBundleLimits = { maxInstallations: 8, maxFiles: 16, maxDirectories: 16, maxDepth: 8, maxPathBytes: 128,
  maxFileBytes: 4096, maxContentBytes: 8192, maxArchiveBytes: 16384, maxArchiveEntries: 32, maxExpandedArchiveBytes: 8192,
  maxInputBytes: 32768, maxManifestBytes: 8192, maxCatalogBytes: 16384, maxDownloadBytes: 16384,
  maxRequestBytes: 65536, maxReplyBytes: 16384, maxStagingBytes: 32768, reservationBytes: 16777216 }
export const projectionLimits: SkillProjectionLimits = { maxProjects: 4, maxCopiesPerProject: 8, maxCopiesPerOperation: 8,
  maxParentBorrows: 4, maxOperationBorrows: 4, maxRecordBytes: 32768, maxMetadataBytes: 262144,
  maxMetadataInodes: 12, reservationBytes: 16777216 }
