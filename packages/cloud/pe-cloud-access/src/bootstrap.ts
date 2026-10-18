/** Pure, bounded C-11 decoding. No authentication, account graph, generation issuance or readiness inference. */
import type {
  BootstrapCapabilities, BootstrapCapability, BootstrapConfiguration, BootstrapConfigurationField,
  BootstrapDecodeLimits, BootstrapPlugin, BootstrapSubprocessCapabilities, CloudBootstrap,
} from './types.ts'

function invalid(): never { throw new TypeError('Cloud bootstrap contains invalid fields or values.') }
function exceeded(): never { throw new RangeError('Cloud bootstrap exceeds the explicit decode limits.') }

function object(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

class Decoder {
  private remainingBytes: number
  private remainingItems: number
  private readonly encoder: TextEncoder = new TextEncoder()

  constructor(private readonly limits: BootstrapDecodeLimits) {
    if (!Number.isSafeInteger(limits.maxBodyBytes) || limits.maxBodyBytes <= 0
      || !Number.isSafeInteger(limits.maxStringBytes) || limits.maxStringBytes <= 0
      || !Number.isSafeInteger(limits.maxListItems) || limits.maxListItems < 0) {
      throw new RangeError('Cloud bootstrap decode limits must be explicit finite integers.')
    }
    this.remainingBytes = limits.maxBodyBytes
    this.remainingItems = limits.maxListItems
  }

  bootstrap(input: unknown): CloudBootstrap {
    const value = this.record(input, ['account', 'recipeVersion', 'connectionGeneration', 'capabilities'])
    const account = this.record(value['account'], ['id', 'displayName'])
    return Object.freeze({
      account: Object.freeze({ id: this.token(account['id']), displayName: this.text(account['displayName']) }),
      recipeVersion: this.token(value['recipeVersion']), connectionGeneration: this.token(value['connectionGeneration']),
      capabilities: this.capabilities(value['capabilities']),
    })
  }

  private spend(bytes: number): void {
    if (bytes > this.remainingBytes) exceeded()
    this.remainingBytes -= bytes
  }

  private record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!object(input)) invalid()
    // All protocol keys are fixed ASCII. Charge braces, commas, quoted keys and colons before child values.
    this.spend(2 + Math.max(0, keys.length - 1) + keys.reduce((bytes, key) => bytes + key.length + 3, 0))
    for (const key in input) {
      if (!Object.hasOwn(input, key) || !keys.includes(key)) invalid()
    }
    for (const key of keys) if (!Object.hasOwn(input, key)) invalid()
    return input
  }

  private text(input: unknown): string {
    if (typeof input !== 'string') invalid()
    // UTF-8 and escaped JSON are never shorter than this UTF-16 length; bound work before allocating encodings.
    if (input.length > this.limits.maxStringBytes || input.length + 2 > this.remainingBytes) exceeded()
    if (this.encoder.encode(input).byteLength > this.limits.maxStringBytes) exceeded()
    // Serialize only this bounded primitive, never an unknown object or the whole response.
    this.spend(this.encoder.encode(JSON.stringify(input)).byteLength)
    return input
  }

  private token(input: unknown): string {
    const value = this.text(input)
    if (value === '' || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
    return value
  }

  private literal<T extends string>(input: unknown, expected: T): T {
    if (input !== expected) invalid()
    this.text(input)
    return expected
  }

  private boolean(input: unknown): boolean {
    if (typeof input !== 'boolean') invalid()
    this.spend(input ? 4 : 5)
    return input
  }

  private disabled(input: unknown): false {
    if (this.boolean(input)) invalid()
    return false
  }

  private list<T>(input: unknown, decode: (value: unknown) => T): readonly T[] {
    if (!Array.isArray(input)) invalid()
    if (input.length > this.remainingItems) exceeded()
    this.remainingItems -= input.length
    this.spend(2 + Math.max(0, input.length - 1))
    const output: T[] = []
    for (let index = 0; index < input.length; index++) output.push(decode(input[index]))
    return Object.freeze(output)
  }

  private capability(input: unknown): BootstrapCapability {
    if (!object(input)) invalid()
    switch (input['state']) {
      case 'available': {
        const value = this.record(input, ['state'])
        return Object.freeze({ state: this.literal(value['state'], 'available') })
      }
      case 'disabled': {
        const value = this.record(input, ['state', 'reason'])
        return Object.freeze({ state: this.literal(value['state'], 'disabled'), reason: this.literal(value['reason'], 'not-approved') })
      }
      case 'temporarily-unavailable': {
        const value = this.record(input, ['state', 'reason'])
        return Object.freeze({
          state: this.literal(value['state'], 'temporarily-unavailable'), reason: this.literal(value['reason'], 'channel-unavailable'),
        })
      }
      default: return invalid()
    }
  }

  private subprocess(input: unknown): BootstrapSubprocessCapabilities {
    const value = this.record(input, ['spawn', 'pipes', 'control', 'inherit', 'terminal', 'consumers'])
    return Object.freeze({
      spawn: this.boolean(value['spawn']), pipes: this.boolean(value['pipes']), control: this.boolean(value['control']),
      inherit: this.boolean(value['inherit']), terminal: this.boolean(value['terminal']),
      consumers: this.list(value['consumers'], item => this.token(item)),
    })
  }

  private plugin(input: unknown): BootstrapPlugin {
    const value = this.record(input, ['id', 'installable', 'toggleable'])
    return Object.freeze({ id: this.token(value['id']), installable: this.boolean(value['installable']), toggleable: this.boolean(value['toggleable']) })
  }

  private field(input: unknown): BootstrapConfigurationField {
    const value = this.record(input, ['namespace', 'path', 'application'])
    const application = this.token(value['application'])
    if (application !== 'live' && application !== 'local-remount' && application !== 'graph-rebuild') invalid()
    return Object.freeze({ namespace: this.token(value['namespace']), path: this.token(value['path']), application })
  }

  private configuration(input: unknown): BootstrapConfiguration {
    const value = this.record(input, ['catalogVersion', 'plugins', 'skills', 'credentials', 'fields'])
    const skills = this.record(value['skills'], ['manage'])
    const credentials = this.record(value['credentials'], ['write'])
    return Object.freeze({
      catalogVersion: this.token(value['catalogVersion']), plugins: this.list(value['plugins'], item => this.plugin(item)),
      skills: Object.freeze({ manage: this.boolean(skills['manage']) }), credentials: Object.freeze({ write: this.boolean(credentials['write']) }),
      fields: this.list(value['fields'], item => this.field(item)),
    })
  }

  private capabilities(input: unknown): BootstrapCapabilities {
    const value = this.record(input, [
      'projects', 'filePreview', 'shell', 'developmentServices', 'servicePreview', 'sandboxScope',
      'backgroundJobs', 'localDesktop', 'arbitraryBackendPlugins', 'subprocess', 'configuration',
    ])
    return Object.freeze({
      projects: this.capability(value['projects']), filePreview: this.capability(value['filePreview']),
      shell: this.capability(value['shell']), developmentServices: this.capability(value['developmentServices']),
      servicePreview: this.capability(value['servicePreview']), sandboxScope: this.literal(value['sandboxScope'], 'session'),
      backgroundJobs: this.disabled(value['backgroundJobs']), localDesktop: this.disabled(value['localDesktop']),
      arbitraryBackendPlugins: this.disabled(value['arbitraryBackendPlugins']), subprocess: this.subprocess(value['subprocess']),
      configuration: this.configuration(value['configuration']),
    })
  }
}

/**
 * Validate parsed C-11 JSON and return a detached, deeply frozen metadata value.
 * The caller must bound raw UTF-8 response bytes before JSON.parse. This decoder additionally
 * charges the complete compact result, each string and combined list entries as it validates
 * fixed-depth fields; it never recursively walks unknown values or infers server readiness.
 * @param input - Parsed JSON data; never a trusted principal, account capability or runtime graph.
 * @param limits - Explicit limits, which may each be derived from maxBootstrapResponseBytes; no defaults are supplied.
 * @returns Read-only metadata with no authentication, generation issuance or configuration submission authority.
 * @throws TypeError for missing/extra fields, invalid types, states or restricted capability values.
 * @throws RangeError for invalid limits or exceeded compact-body, string or list budgets.
 */
export function decodeCloudBootstrap(input: unknown, limits: BootstrapDecodeLimits): CloudBootstrap {
  return new Decoder(limits).bootstrap(input)
}
