/** Canonical native document addresses for immutable, Platform-owned artifact snapshots. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** An immutable publication identity; parsing supplies no owner authorization. */
export type ArtifactDocumentId = Branded<'PowerEvolveArtifactDocumentId'>
/** A canonical lowercase publication identity. */
export const artifactDocumentId = z.uuid().regex(/^[a-f0-9-]+$/u)
  .transform(value => brandString<ArtifactDocumentId>(value))
/** One literal POSIX filename, never an encoded or relative resource path. */
export const artifactDocumentFilename = z.string().min(1).max(255)
  .regex(/^[^/\\\x00-\x1f\x7f]+$/u).refine(value => value !== '.' && value !== '..')
/** Literal path components checked again against the owner's immutable metadata. */
export const artifactDocumentLocation = z.object({ artifactId: artifactDocumentId, filename: artifactDocumentFilename }).strict()
/** Validated native path components. */
export type ArtifactDocumentLocation = z.infer<typeof artifactDocumentLocation>

function components(path: string): { artifactId: string; filename: string } | null {
  const parts = path.split('/')
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'artifacts') return null
  return { artifactId: parts[2]!, filename: parts[3]! }
}

/** Exact absolute virtual path; no normalization, decoding, or Workspace fallback is permitted. */
export const artifactDocumentPath = z.string().max(1024).refine(value => {
  const parsed = components(value)
  return parsed !== null && artifactDocumentLocation.safeParse(parsed).success
})

/** Parse a literal native path without interpreting it as a storage root.
 * @param value - native file path received across a wire boundary.
 * @returns validated publication identity and literal filename; malformed aliases throw.
 */
export function parseArtifactDocumentPath(value: unknown): ArtifactDocumentLocation {
  return artifactDocumentLocation.parse(components(artifactDocumentPath.parse(value)))
}

/** Build the canonical native path from immutable publication metadata.
 * @param artifactId - server-created publication identity.
 * @param filename - literal filename from its metadata.
 * @returns the virtual artifact path; malformed components throw.
 */
export function artifactDocumentPathFor(artifactId: string, filename: string): string {
  const selected = artifactDocumentLocation.parse({ artifactId, filename })
  return `/artifacts/${selected.artifactId}/${selected.filename}`
}

/** An artifact admission fixes metadata and bytes without selecting its mutable Workspace source. */
export const officeArtifactSource = artifactDocumentLocation.extend({
  kind: z.literal('artifact'), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
