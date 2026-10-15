/** Browser-safe MCP presentation metadata and opaque environment version references. */
import { z } from 'zod'

/** Uploaded raster artwork stays inert; remote URLs and active SVG documents are not accepted. */
export const mcpPresentation = z.object({
  note: z.string().max(1000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
  icon: z.string().max(65_536).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u).nullable(),
}).strict()

/** Display-only connection fields; neither field grants transport or execution authority. */
export type McpPresentation = z.infer<typeof mcpPresentation>

/** A frozen encrypted environment version exposes names only, never values. */
export const stdioEnvironmentRef = z.object({ credentialVersion: z.uuid(),
  keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)).min(1).max(64),
}).strict().refine(value => new Set(value.keys).size === value.keys.length)

/** Immutable environment metadata bound to one owned connection configuration revision. */
export type StdioEnvironmentRef = z.infer<typeof stdioEnvironmentRef>
