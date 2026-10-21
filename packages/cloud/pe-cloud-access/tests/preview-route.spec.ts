/** Fixed input parsing and Root configuration only; no login, account, listener or service is created. */
import { afterEach, expect, it } from 'vitest'
import { AuthAccessError } from '../src/auth-error.ts'
import { parseAuthRootConfig, type ServicePreviewIngressLimits } from '../src/root-config.ts'
import { readServicePreviewSelection, SERVICE_PREVIEW_ROUTE } from '../src/preview-route.ts'
import { carrier, rootConfig } from './ingress-fixture.ts'

const limits: ServicePreviewIngressLimits = { maxUrlBytes: 1024, maxFieldBytes: 128,
  maxRequestHeaderCount: 16, maxRequestHeaderBytes: 2048,
  response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 8, maxHeaderCount: 32, maxHeaderBytes: 4096 } }
const target = '/cloud/service-preview?sessionId=session-A&serviceHandle=original-service&peAccount=A&peGeneration=original-page'
const requestId = 'route-component' as AuthAccessError['requestId']
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
function configured() {
  const original = rootConfig()
  return { ...original, publicOrigin: 'http://console.dsh.localhost:4100',
    servicePreview: { origin: 'http://preview.dsh.localhost:4100', cookieDomain: 'dsh.localhost' },
    ingress: { ...original.ingress!, servicePreview: limits } }
}
function request(path = target, method = 'GET', headers: readonly string[] = []) {
  const value = carrier(path, method, headers)
  cleanups.push(() => { value.request.destroy(); value.response.destroy(); value.socket.destroy() })
  return value.request
}

it('preserves old Root configuration and requires explicit preview origins and complete finite response limits', () => {
  expect(parseAuthRootConfig(rootConfig()).ingress).not.toHaveProperty('servicePreview')
  const enabled = parseAuthRootConfig(configured())
  expect(enabled.ingress?.servicePreview).toEqual(limits)
  const input = configured(); Reflect.deleteProperty(input, 'servicePreview')
  expect(() => parseAuthRootConfig(input)).toThrow('Cloud authentication root')
  for (const key of Object.keys(limits)) {
    const value = configured(); value.ingress = { ...value.ingress, servicePreview: { ...limits } }
    Reflect.deleteProperty(value.ingress.servicePreview, key)
    expect(() => parseAuthRootConfig(value)).toThrow('Cloud authentication root')
  }
  for (const key of Object.keys(limits.response)) {
    const value = configured(); value.ingress = { ...value.ingress, servicePreview: { ...limits, response: { ...limits.response } } }
    Reflect.deleteProperty(value.ingress.servicePreview.response, key)
    expect(() => parseAuthRootConfig(value)).toThrow('Cloud authentication root')
  }
})

it('refuses selector-name collisions, nonpositive budgets, oversized chunks and application-controlled targets', () => {
  for (const name of ['sessionId', 'serviceHandle']) {
    const value = configured(); value.bindingFields = { ...value.bindingFields, accountQuery: name }
    expect(() => parseAuthRootConfig(value)).toThrow('Cloud authentication root')
  }
  for (const field of Object.keys(limits)) {
    if (field === 'response') continue
    const value = configured(); value.ingress = { ...value.ingress, servicePreview: { ...limits, [field]: 0 } }
    expect(() => parseAuthRootConfig(value)).toThrow('Cloud authentication root')
  }
  const value = configured(); value.ingress = { ...value.ingress, servicePreview: { ...limits,
    response: { ...limits.response, maxChunkBytes: limits.response.maxBodyBytes + 2 } } }
  expect(() => parseAuthRootConfig(value)).toThrow('Cloud authentication root')
  for (const key of ['method', 'port', 'resourcePath', 'url', 'headers']) {
    const input = configured(); input.ingress = { ...input.ingress, servicePreview: { ...limits } }
    Object.assign(input.ingress.servicePreview, { [key]: 'ignored-target-must-not-enable' })
    expect(() => parseAuthRootConfig(input)).toThrow('Cloud authentication root')
  }
})

it('selects only the original native Session and service handle; C02 and raw headers are not authentication', () => {
  const req = request(target, 'GET', ['Cookie', 'component-only-cookie', 'Accept', 'application/json'])
  const parsed = readServicePreviewSelection(req, configured(), limits, requestId)
  expect(SERVICE_PREVIEW_ROUTE).toEqual({ method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' })
  expect(parsed.selection).toEqual({ sessionId: 'session-A', serviceId: 'original-service' })
  expect(Object.isFrozen(parsed.selection)).toBe(true); expect(Object.isFrozen(parsed.headers)).toBe(true)
  expect(parsed.headers).toContainEqual(['Cookie', 'component-only-cookie'])
  expect(req.url).toBe(target); expect(req.headers.cookie).toBe('component-only-cookie')
})

it.each(['HEAD', 'POST', 'OPTIONS'])('refuses unsupported %s before any task lookup', (method) => {
  expect(() => readServicePreviewSelection(request(target, method), configured(), limits, requestId))
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
})

it.each([
  target + '&sessionId=other', target + '&peAccount=B', target + '&unknown=x', target + '&allocationId=foreign',
  target.replace('original-service', 'bad%2Fhandle'), target.replace('session-A', '%20'), target.replace('&peGeneration=original-page', ''),
  target.replace('/cloud/service-preview', '/cloud/%73ervice-preview'), target + '#fragment',
  'http://preview.dsh.localhost:4100' + target, '//preview.dsh.localhost:4100' + target,
])('refuses duplicated, missing or foreign selection in %s', (path) => {
  expect(() => readServicePreviewSelection(request(path), configured(), limits, requestId)).toThrow()
})

it('applies exact UTF-8 field, raw URL and complete header budgets and refuses request bodies', () => {
  const unicode = '/cloud/service-preview?sessionId=' + encodeURIComponent('会话') + '&serviceHandle=s&peAccount=a&peGeneration=g'
  const parsed = readServicePreviewSelection(request(unicode), configured(), { ...limits, maxFieldBytes: 6 }, requestId)
  expect(parsed.selection.sessionId).toBe('会话')
  expect(() => readServicePreviewSelection(request(unicode), configured(), { ...limits, maxFieldBytes: 5 }, requestId)).toThrow()
  const shortUrl = { ...limits, maxUrlBytes: Buffer.byteLength(target) - 1 }
  expect(() => readServicePreviewSelection(request(), configured(), shortUrl, requestId)).toThrow()
  expect(() => readServicePreviewSelection(request(), configured(), { ...limits, maxRequestHeaderBytes: 4 }, requestId)).toThrow()
  const extraHeader = request(target, 'GET', ['One', 'a'])
  expect(() => readServicePreviewSelection(extraHeader, configured(), { ...limits, maxRequestHeaderCount: 1 }, requestId)).toThrow()
  for (const headers of [['Content-Length', '1'], ['Transfer-Encoding', 'chunked']]) {
    expect(() => readServicePreviewSelection(request(target, 'GET', headers), configured(), limits, requestId)).toThrow()
  }
  expect(() => readServicePreviewSelection(request(target, 'GET', ['Content-Length', '0']), configured(), limits, requestId)).not.toThrow()
})
