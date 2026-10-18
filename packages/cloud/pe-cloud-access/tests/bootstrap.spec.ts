/** Pure C-11 metadata validation and explicit budget boundaries; no account runtime or authentication fixtures. */
import { describe, expect, it } from 'vitest'
import { AccessConfigSchema, decodeCloudBootstrap } from '../src/schema.ts'
import type { BootstrapDecodeLimits, CloudBootstrap } from '../src/types.ts'

const limits: BootstrapDecodeLimits = { maxBodyBytes: 8192, maxStringBytes: 128, maxListItems: 16 }
const encoder = new TextEncoder()

function input() {
  return {
    account: { id: 'account-A', displayName: '账户 A' }, recipeVersion: 'recipe-1', connectionGeneration: 'opaque-generation',
    capabilities: {
      projects: { state: 'available' }, filePreview: { state: 'disabled', reason: 'not-approved' },
      shell: { state: 'temporarily-unavailable', reason: 'channel-unavailable' },
      developmentServices: { state: 'disabled', reason: 'not-approved' }, servicePreview: { state: 'disabled', reason: 'not-approved' },
      sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: true, pipes: false, control: true, inherit: false, terminal: false, consumers: ['native-bash'] },
      configuration: {
        catalogVersion: 'catalog-1', plugins: [{ id: 'plugin-a', installable: true, toggleable: false }],
        skills: { manage: false }, credentials: { write: true }, fields: [
          { namespace: 'models', path: 'key.ref', application: 'live' },
          { namespace: 'agent', path: 'limit', application: 'local-remount' },
          { namespace: 'preset', path: 'default', application: 'graph-rebuild' },
        ],
      },
    },
  }
}

function change(path: readonly string[], value: unknown, remove = false): ReturnType<typeof input> {
  const fixture = input()
  let parent: object = fixture
  for (const key of path.slice(0, -1)) {
    const next: unknown = Reflect.get(parent, key)
    if (typeof next !== 'object' || next === null) throw new Error('Invalid test mutation path')
    parent = next
  }
  const key = path.at(-1)
  if (key === undefined) throw new Error('Empty test mutation path')
  if (remove) Reflect.deleteProperty(parent, key)
  else Reflect.set(parent, key, value)
  return fixture
}

function frozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) frozen(child)
}

describe('access-owned C-11 decoder', () => {
  it('exposes structural configuration with one pure decoder and preserves the approved descriptive wire', () => {
    expect(typeof AccessConfigSchema).toBe('function')
    const wire = input()
    const decoded: CloudBootstrap = decodeCloudBootstrap(wire, limits)
    expect(decoded).toEqual(wire)
    expect(decoded.capabilities.shell).toEqual({ state: 'temporarily-unavailable', reason: 'channel-unavailable' })
    expect(decoded.capabilities.configuration.fields.map(field => field.application)).toEqual(['live', 'local-remount', 'graph-rebuild'])
    expect('ready' in decoded).toBe(false)
    expect('authSessionId' in decoded.account).toBe(false)
  })

  it('returns detached deeply frozen objects and arrays without freezing caller-owned data', () => {
    const wire = input()
    const decoded = decodeCloudBootstrap(wire, limits)
    frozen(decoded)
    wire.account.id = 'changed'
    wire.capabilities.configuration.plugins[0]!.id = 'changed'
    wire.capabilities.subprocess.consumers.push('later')
    expect(decoded.account.id).toBe('account-A')
    expect(decoded.capabilities.configuration.plugins[0]?.id).toBe('plugin-a')
    expect(decoded.capabilities.subprocess.consumers).toEqual(['native-bash'])
    expect(Reflect.set(decoded.account, 'id', 'other')).toBe(false)
    expect(Reflect.set(decoded.capabilities.configuration.fields, '0', {})).toBe(false)
    expect(Object.isFrozen(wire)).toBe(false)
  })

  it.each([
    ['root', ['secret']], ['account', ['account', 'path']], ['capability', ['capabilities', 'projects', 'schema']],
    ['capabilities', ['capabilities', 'ready']], ['subprocess', ['capabilities', 'subprocess', 'endpoint']],
    ['configuration', ['capabilities', 'configuration', 'profile']],
    ['plugin', ['capabilities', 'configuration', 'plugins', '0', 'import']],
    ['skills', ['capabilities', 'configuration', 'skills', 'schema']],
    ['credentials', ['capabilities', 'configuration', 'credentials', 'secret']],
    ['field', ['capabilities', 'configuration', 'fields', '0', 'value']],
  ] as const)('rejects extra %s fields without echoing their content', (_name, path) => {
    expect(() => decodeCloudBootstrap(change(path, 'secret-never-echo'), limits)).toThrow(TypeError)
    expect(() => decodeCloudBootstrap(change(path, 'secret-never-echo'), limits)).not.toThrow('secret-never-echo')
  })

  it.each([
    ['account'], ['recipeVersion'], ['connectionGeneration'], ['capabilities'],
    ['capabilities', 'shell', 'reason'], ['capabilities', 'subprocess', 'consumers'],
    ['capabilities', 'configuration', 'catalogVersion'], ['capabilities', 'configuration', 'credentials', 'write'],
  ].map(path => ({ path })))('rejects missing required field $path', ({ path }) => {
    expect(() => decodeCloudBootstrap(change(path, undefined, true), limits)).toThrow(TypeError)
  })

  it.each([
    [['account'], []], [['account', 'id'], 1], [['account', 'displayName'], null], [['recipeVersion'], true],
    [['capabilities', 'projects'], true], [['capabilities', 'subprocess', 'spawn'], 'true'],
    [['capabilities', 'subprocess', 'consumers'], 'native-bash'], [['capabilities', 'subprocess', 'consumers', '0'], 1],
    [['capabilities', 'configuration', 'plugins', '0', 'installable'], 1],
    [['capabilities', 'configuration', 'fields'], {}], [['capabilities', 'configuration', 'skills', 'manage'], null],
  ] as const)('rejects incorrect JSON type at %j', (path, value) => {
    expect(() => decodeCloudBootstrap(change(path, value), limits)).toThrow(TypeError)
  })

  it.each([
    { state: 'unknown' }, { state: 'available', reason: 'not-approved' },
    { state: 'disabled', reason: 'channel-unavailable' }, { state: 'temporarily-unavailable', reason: 'not-approved' },
    { state: 'disabled' }, { state: 'available', available: true },
  ])('rejects unknown or mismatched feature state %j', (feature) => {
    expect(() => decodeCloudBootstrap(change(['capabilities', 'projects'], feature), limits)).toThrow(TypeError)
  })

  it.each(['backgroundJobs', 'localDesktop', 'arbitraryBackendPlugins'])('keeps restricted capability %s exactly false', (field) => {
    for (const value of [true, 0, 'false', null]) {
      expect(() => decodeCloudBootstrap(change(['capabilities', field], value), limits)).toThrow(TypeError)
    }
  })

  it.each(['', ' ', ' padded', 'padded ', 'line\nbreak'])('rejects invalid empty/padded version or generation %j', (value) => {
    for (const field of ['recipeVersion', 'connectionGeneration']) {
      expect(() => decodeCloudBootstrap(change([field], value), limits)).toThrow(TypeError)
    }
  })

  it('requires session sandbox scope and reviewed application levels', () => {
    expect(() => decodeCloudBootstrap(change(['capabilities', 'sandboxScope'], 'project'), limits)).toThrow(TypeError)
    expect(() => decodeCloudBootstrap(change(['capabilities', 'configuration', 'fields', '0', 'application'], 'execute'), limits)).toThrow(TypeError)
  })

  it.each(['maxBodyBytes', 'maxStringBytes', 'maxListItems'] as const)('requires explicit finite integer %s', (field) => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeCloudBootstrap(input(), { ...limits, [field]: value })).toThrow(RangeError)
    }
  })

  it('rejects zero body/string budgets', () => {
    expect(() => decodeCloudBootstrap(input(), { ...limits, maxBodyBytes: 0 })).toThrow(RangeError)
    expect(() => decodeCloudBootstrap(input(), { ...limits, maxStringBytes: 0 })).toThrow(RangeError)
  })

  it('accounts for complete compact JSON, UTF-8, escapes and lone surrogates at the exact byte boundary', () => {
    for (const displayName of ['ordinary', '账户😀', 'quote" slash\\\n', '\ud800']) {
      const wire = input()
      wire.account.displayName = displayName
      const bytes = encoder.encode(JSON.stringify(wire)).byteLength
      expect(decodeCloudBootstrap(wire, { ...limits, maxBodyBytes: bytes })).toEqual(wire)
      expect(() => decodeCloudBootstrap(wire, { ...limits, maxBodyBytes: bytes - 1 })).toThrow(RangeError)
    }
  })

  it('applies per-string UTF-8 limits and a combined list-item budget', () => {
    const wire = input()
    wire.account.displayName = '界'.repeat(12)
    expect(decodeCloudBootstrap(wire, { ...limits, maxStringBytes: 36 })).toEqual(wire)
    expect(() => decodeCloudBootstrap(wire, { ...limits, maxStringBytes: 35 })).toThrow(RangeError)
    expect(decodeCloudBootstrap(input(), { ...limits, maxListItems: 5 })).toEqual(input())
    expect(() => decodeCloudBootstrap(input(), { ...limits, maxListItems: 4 })).toThrow(RangeError)
  })

  it('permits empty lists with a zero combined item budget and rejects oversized list lengths before decoding entries', () => {
    const wire = input()
    wire.capabilities.subprocess.consumers = []
    wire.capabilities.configuration.plugins = []
    wire.capabilities.configuration.fields = []
    expect(decodeCloudBootstrap(wire, { ...limits, maxListItems: 0 })).toEqual(wire)
    const oversized = change(['capabilities', 'configuration', 'fields'], new Array(100_000))
    expect(() => decodeCloudBootstrap(oversized, { ...limits, maxListItems: 100_010 })).toThrow(RangeError)
  })

  it('rejects an unknown deep value without traversing its nested objects', () => {
    let nested: object = {}
    for (let index = 0; index < 10_000; index++) nested = { child: nested }
    expect(() => decodeCloudBootstrap(change(['profile'], nested), limits)).toThrow(TypeError)
  })
})
