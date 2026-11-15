/** Cloud container projections reuse the original native Settings redaction walker. */
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import type { ConfigRedactionExtension, ConfigSchemaNode, RedactedValue } from '@deepseek-ai/dsh-settings'

const projectContainer: ConfigRedactionExtension = (schema, value) => {
  if (schema.type === 'tuple' && Array.isArray(value)) {
    const rows = value.map((entry, index) => {
      const child = schema.list?.[index]
      return child === undefined ? { value: entry, secrets: [] } : redactSecrets(child, entry, projectContainer)
    })
    return { value: rows.map(row => row.value), secrets: rows.flatMap((row, index) => row.secrets.map(secret => ({
      path: [String(index), ...secret.path], set: secret.set,
    }))) }
  }
  if (schema.type === 'dict' && schema.sKey !== undefined
    && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (redactSecrets(schema.sKey, key, projectContainer).secrets.length > 0) {
        // A secret key cannot be exposed even as a presence-marker path.
        return { value: undefined, secrets: [{ path: [], set: true }] }
      }
    }
  }
  return undefined
}

/** Strip Cloud-selected configuration without disclosing tuple values or secret dictionary keys.
 * @param schema Original native schema metadata, without evaluating builders or validators.
 * @param value Original selected configuration value.
 * @returns Native detached redaction plus this embedding's explicit container projection.
 */
export function redactCloudConfig(schema: ConfigSchemaNode, value: unknown): RedactedValue {
  return redactSecrets(schema, value, projectContainer)
}
