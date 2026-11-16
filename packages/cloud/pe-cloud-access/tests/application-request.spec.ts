/** Dedicated content wire parsing with real memory Node carriers; no login or service authority is simulated. */
import { expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AuthAccessError } from '../src/auth-error.ts'
import { readApplicationSelection, readServiceApplicationRequest, readServiceApplicationCookie,
  SERVICE_APPLICATION_AUTHORIZE_PATH } from '../src/application-request.ts'
import type { ServiceApplicationConfig } from '../src/application-policy.ts'
import { accessConfig, carrier } from './ingress-fixture.ts'

const requestId = brandString<AuthAccessError['requestId']>('application-wire-test')
const config: ServiceApplicationConfig = { origin: 'http://apps.dsh.localhost:4101', siteDomain: 'dsh.localhost',
  maxUrlBytes: 2048, maxPathBytes: 1024, maxRequestHeaderCount: 32, maxRequestHeaderBytes: 4096,
  maxRequestBodyBytes: 4096, maxQueuedRequests: 8, queueTimeoutMs: 1000,
  views: { maxViews: 4, maxViewsPerAccount: 2, maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 10000 },
  response: { maxBodyBytes: 8192, maxChunkBytes: 4096, maxChunks: 32, maxHeaderCount: 32, maxHeaderBytes: 4096 } }
const access = { ...accessConfig(), publicOrigin: 'http://console.auth.dsh.localhost:4100' }
const id = 'a'.repeat(32), host = id + '.apps.dsh.localhost:4101', origin = 'http://' + host
function request(path = '/', method = 'GET', headers: readonly string[] = []) {
  const input = carrier(path, method, headers)
  input.request.headers.host = host; input.request.rawHeaders[1] = host
  onTestFinished(() => { input.request.destroy(); input.response.destroy(); input.socket.destroy() })
  return input.request
}

it('preserves same-service resource queries while consuming the host-only credential separately', () => {
  const cookie = 'b'.repeat(64), req = request('/api/counter?read=1', 'GET', ['Cookie', 'dsh-service-preview=' + cookie, 'Accept', 'application/json'])
  expect(readServiceApplicationRequest(req, config, access, requestId)).toEqual({ id, origin, path: '/api/counter?read=1',
    control: undefined, headers: [['accept', 'application/json']] })
  expect(readServiceApplicationCookie(req, requestId)).toBe(cookie)
})

it.each(['//evil.test/', '/%2e%2e/api', '/%252fapi', '/x%2fapi', '/x%5capi', '/#fragment'])('rejects noncanonical resource %s', (path) => {
  expect(() => readServiceApplicationRequest(request(path), config, access, requestId)).toThrow()
})

it('requires the exact management Origin for proof handoff and same-view Origin for backend writes', () => {
  const req = request(SERVICE_APPLICATION_AUTHORIZE_PATH, 'POST', ['Origin', access.publicOrigin])
  expect(readServiceApplicationRequest(req, config, access, requestId).control).toBe('authorize')
  expect(() => readServiceApplicationRequest(request('/api/counter', 'POST', ['Origin', access.publicOrigin]), config, access, requestId)).toThrow()
  expect(() => readServiceApplicationRequest(request('/api/counter', 'POST'), config, access, requestId)).toThrow()
  expect(readServiceApplicationRequest(request('/api/counter', 'POST', ['Origin', origin]), config, access, requestId).control).toBeUndefined()
})

it.each(['X-Forwarded-Host', 'Forwarded', 'Authorization', 'X-DSH-Cloud-Owner-Hop', 'Upgrade'])('rejects %s overrides before credential lookup', (name) => {
  expect(() => readServiceApplicationRequest(request('/', 'GET', [name, 'foreign']), config, access, requestId)).toThrow()
})

it('accepts only two bounded Session/service selectors and refuses duplicate preview credentials', () => {
  expect(readApplicationSelection({ sessionId: 'session-A', serviceHandle: 'service-A' }, 128, requestId))
    .toEqual({ sessionId: 'session-A', serviceId: 'service-A' })
  expect(() => readApplicationSelection({ sessionId: 'session-A', serviceHandle: 'service-A', port: 9000 }, 128, requestId)).toThrow()
  const value = 'b'.repeat(64)
  expect(() => readServiceApplicationCookie(request('/', 'GET', ['Cookie', `dsh-service-preview=${value}; dsh-service-preview=${value}`]), requestId)).toThrow()
})
