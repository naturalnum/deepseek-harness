/** Exact Cloud deployment parsing with schema-owned paths and value-free diagnostics. */
import z from '@deepseek-ai/schemastery'

/** Safe deployment diagnostic containing a field path and rule, never supplied values. */
export class DeploymentConfigError extends TypeError {}

/**
 * Validate Cloud deployment keys and native field constraints before resource allocation.
 * @param schema Original native schema, including optional fields and transformations.
 * @returns A native schema that rejects unknown keys and never echoes supplied values.
 */
export function deploymentConfig<T>(schema: z<T>): z<T> {
  return z.transform(z.any<T>(), (input) => {
    checkKeys(schema, input, '$')
    try { return schema(input) }
    catch (cause) {
      if (!z.ValidationError.is(cause)) throw cause
      const path = cause.options.path ?? []
      let field: z | undefined = schema
      for (const segment of path) field = child(field, segment)
      while (field?.inner !== undefined && field.type === 'transform') field = field.inner
      const range = field?.meta.min !== undefined || field?.meta.max !== undefined
        ? ` in range ${field.meta.min ?? '-Infinity'}..${field.meta.max ?? 'Infinity'}` : ''
      throw new DeploymentConfigError(`${path.reduce<string>((text, part) => text + '.' + safeKey(String(part)), '$')}: required valid ${field?.type ?? 'configured value'}${range}; check the declared field constraints`)
    }
  })
}

function safeKey(key: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : '<unsupported-field>'
}

function child(schema: z | undefined, key: string | number | symbol): z | undefined {
  if (schema === undefined) return undefined
  if (schema.type === 'transform') return child(schema.inner, key)
  if (schema.type === 'union' || schema.type === 'intersect') {
    return schema.list?.map(node => child(node, key)).find(node => node !== undefined)
  }
  return schema.type === 'array' ? schema.inner : schema.dict?.[String(key)]
}

function objectFields(schema: z): Record<string, z> | undefined {
  if (schema.type === 'object') return schema.dict
  if (schema.type === 'transform') return schema.inner === undefined ? undefined : objectFields(schema.inner)
  if (schema.type === 'intersect' || schema.type === 'union') {
    const fields = schema.list?.map(objectFields).filter(row => row !== undefined)
    return fields?.length ? Object.assign({}, ...fields) : undefined
  }
  return undefined
}

function checkKeys(schema: z, input: unknown, path: string): void {
  if (input === undefined || input === null) return
  if (schema.type === 'transform' && schema.inner !== undefined) return checkKeys(schema.inner, input, path)
  if (Array.isArray(input)) {
    const inner = schema.inner
    if (inner !== undefined) input.forEach((value, index) => { checkKeys(inner, value, `${path}.${index}`) })
    return
  }
  if (typeof input !== 'object') return
  const fields = objectFields(schema)
  if (fields === undefined) return
  for (const key of Object.keys(input)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (field === undefined) throw new DeploymentConfigError(`${path}.${safeKey(key)}: unknown deployment field; remove or correct the field name`)
    checkKeys(field, Reflect.get(input, key), `${path}.${safeKey(key)}`)
  }
}
