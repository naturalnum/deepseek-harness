/** Request admission uses the real exposure policy and explicit account/service owner fixtures. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ExposurePolicy } from '@deepseek-ai/dsh-pe-cloud-api/src/exposure.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { forwardAuthorizedPreview, PreviewAccessError, type ExistingPreviewAdmission, type ExecutionPreviewPort,
  type PreviewPolicy, type RegisteredPreviewService, type SanitizedPreviewRequest } from '../src/preview-access.ts'

function fixture() {
  const accountLife = new AbortController(), requestLife = new AbortController(), serviceLife = new AbortController()
  const binding: AccountBinding = { accountId: 'account-A' as AccountBinding['accountId'],
    epoch: '17' as AccountBinding['epoch'], recipeVersion: 'fixture-recipe', lifetime: accountLife.signal }
  const exposure = new ExposurePolicy({ recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], allowedSettings: [],
    exactFetchRoutes: ['GET', 'HEAD'].map(method => ({ method, path: '/cloud/service-preview', handlerId: 'candidate:servicePreview', guard: 'account-session' })) })
  exposure.audit(exposure.manifest)
  const policy: PreviewPolicy = { manifest: exposure.manifest, routePath: '/cloud/service-preview', handlerId: 'candidate:servicePreview',
    managementOrigin: 'https://console.example.invalid', previewOrigin: 'https://preview.example.invalid', allowedServicePorts: [8000],
    maxFieldBytes: 128, maxResourceBytes: 2048, maxHeaderCount: 32, maxHeaderBytes: 4096 }
  const scope: RegisteredPreviewService['scope'] = { accountId: binding.accountId, epoch: binding.epoch,
    sessionId: 'native-session-A' as RegisteredPreviewService['scope']['sessionId'],
    allocationId: 'allocation-A' as RegisteredPreviewService['scope']['allocationId'],
    serviceId: 'service-A' as RegisteredPreviewService['scope']['serviceId'] }
  const input = { origin: policy.previewOrigin, method: 'GET', pathname: policy.routePath, scope: { ...scope }, resourcePath: '/docs?theme=dark',
    headers: [['Accept', 'text/html'], ['Cookie', 'fixture-platform-cookie'], ['Authorization', 'fixture-platform-authorization'],
      ['OPEN-SANDBOX-API-KEY', 'fixture-internal-key'], ['X-EXECD-ACCESS-TOKEN', 'fixture-execd'], ['Proxy-Authorization', 'fixture-proxy'],
      ['Host', 'caller-selected.invalid'], ['Forwarded', 'fixture-forwarded'], ['X-Forwarded-Host', 'caller-selected.invalid'],
      ['Origin', policy.managementOrigin], ['Referer', policy.managementOrigin], ['X-Unknown-Private', 'fixture-private']] }
  const state = { calls: 0, lookups: 0, reserved: false, admissionCurrent: true, useCurrent: true, serviceCurrent: true, registered: true,
    issueScope: scope, issuePort: 8000, issueManifest: exposure.manifest, captured: undefined as SanitizedPreviewRequest | undefined,
    beforeConsume: async (): Promise<void> => {}, actual: async (): Promise<void> => {} }
  const admission: ExistingPreviewAdmission = { signal: requestLife.signal,
    use: { binding, assertCurrent() { if (!state.useCurrent) throw new PreviewAccessError('cloud/account-unavailable') } },
    api: { binding, requireFetch: (method, path) => exposure.requireFetch(method, path) },
    assertCurrent() { if (!state.admissionCurrent) throw new PreviewAccessError('cloud/forbidden') } }
  const service: RegisteredPreviewService = {
    get scope() { return state.issueScope }, get port() { return state.issuePort },
    get manifest() { return state.issueManifest }, lifetime: serviceLife.signal,
    assertCurrent() { if (!state.serviceCurrent) throw new PreviewAccessError('cloud/forbidden') },
    async forward(safe) { state.calls++; state.captured = safe; await state.actual() },
  }
  const execution: ExecutionPreviewPort = {
    async withRegisteredService(actualBinding, selector, manifest, signal, consume) {
      state.lookups++; assert.equal(actualBinding, binding); assert.equal(manifest, exposure.manifest)
      assert.deepEqual(selector, input.scope); signal.throwIfAborted()
      await state.beforeConsume()
      if (!state.registered) throw new PreviewAccessError('cloud/forbidden')
      state.reserved = true
      try { await consume(service) } finally { state.reserved = false }
    },
  }
  return { binding, policy, input, state, admission, execution, exposure, accountLife, requestLife, serviceLife,
    run: (value: unknown = input, selected: PreviewPolicy = policy) => forwardAuthorizedPreview(value, admission, selected, execution) }
}
async function denied(f: ReturnType<typeof fixture>, input: unknown = f.input, policy = f.policy) {
  await assert.rejects(f.run(input, policy)); assert.equal(f.state.calls, 0)
}

test('original audited exact fetch + exact registered scope forwards a detached credential-free request', async () => {
  const f = fixture(); await f.run()
  assert.equal(f.state.calls, 1); assert.equal(f.state.reserved, false)
  assert.deepEqual(f.state.captured, { method: 'GET', resourcePath: '/docs?theme=dark', headers: [['accept', 'text/html']] })
  assert.ok(Object.isFrozen(f.state.captured)); assert.ok(Object.isFrozen(f.state.captured?.headers))
  assert.equal(Object.hasOwn(f.state.captured, 'scope'), false)
})
test('HEAD must have its own exact approved method', async () => {
  const f = fixture(); f.input.method = 'HEAD'; await f.run(); assert.equal(f.state.captured?.method, 'HEAD')
})
test('foreign account and old epoch are denied before execution lookup', async () => {
  for (const [key, value] of [['accountId', 'account-B'], ['epoch', '16']] as const) {
    const f = fixture(); await denied(f, { ...f.input, scope: { ...f.input.scope, [key]: value } }); assert.equal(f.state.lookups, 0)
  }
})
test('all five owner-issued scope fields are checked, including Session/allocation/service generation', async () => {
  for (const key of ['accountId', 'epoch', 'sessionId', 'allocationId', 'serviceId'] as const) {
    const f = fixture(); f.state.issueScope = { ...f.input.scope, [key]: 'different-owner-value' }; await denied(f)
  }
})
test('unregistered/stopped service and non-approved registered port have no upstream call', async () => {
  const missing = fixture(); missing.state.registered = false; await denied(missing)
  const stopped = fixture(); stopped.state.serviceCurrent = false; await denied(stopped)
  const port = fixture(); port.state.issuePort = 44772; await denied(port)
})
test('client URL/host/port cannot be smuggled into selection or the fixed ingress route', async () => {
  for (const addition of [{ port: 8000 }, { targetUrl: 'http://arbitrary.invalid' }, { host: 'arbitrary.invalid' }]) {
    const f = fixture(); await denied(f, { ...f.input, ...addition }); assert.equal(f.state.lookups, 0)
  }
  const f = fixture(); await denied(f, { ...f.input, scope: { ...f.input.scope, port: 8000 } })
  await denied(f, { ...f.input, pathname: '/cloud/service-preview/8000' })
})
test('missing audit, wrong exact handler/guard and a different manifest reference are denied', async () => {
  const audit = fixture(); audit.exposure.invalidate(); await denied(audit)
  const handler = fixture(); await denied(handler, handler.input, { ...handler.policy, handlerId: 'unapproved:handler' })
  const guard = fixture(); await denied(guard, guard.input, { ...guard.policy, manifest: { ...guard.policy.manifest,
    exactFetchRoutes: guard.policy.manifest.exactFetchRoutes.map(row => ({ ...row, guard: 'authenticated-account' })) } })
  const stale = fixture(); stale.state.issueManifest = Object.freeze({ ...stale.policy.manifest }); await denied(stale)
})
test('management origin, same-host different-port deployment and unsupported method remain closed', async () => {
  const f = fixture(); await denied(f, { ...f.input, origin: f.policy.managementOrigin })
  await denied(f, f.input, { ...f.policy, previewOrigin: 'https://console.example.invalid:8443' })
  await denied(f, { ...f.input, method: 'POST' })
})
test('absolute URL, authority-form, traversal, encoded slash/double-encoding and fragment are refused', async () => {
  for (const resourcePath of ['http://arbitrary.invalid/', '//arbitrary.invalid/', '/a/../x', '/%2e%2e/x', '/%2fhost', '/%252e%252e/x', '/a\\b', '/x#secret']) {
    const f = fixture(); await denied(f, { ...f.input, resourcePath })
  }
})
test('hop-by-hop Connection nominations are removed even when nominated field is allowlisted', async () => {
  const f = fixture(); f.input.headers.push(['Connection', 'accept'], ['Accept-Language', 'en']); await f.run()
  assert.deepEqual(f.state.captured?.headers, [['accept-language', 'en']])
})
test('header injection, duplicate pass-through fields and byte/count bounds are rejected before lookup', async () => {
  for (const headers of [[['Accept', 'text/html\r\nCookie: fixture']], [['Accept', 'a'], ['accept', 'b']],
    [['Accept', 'a'.repeat(4097)]], Array.from({ length: 33 }, () => ['X-Dropped', 'x'])]) {
    const f = fixture(); await denied(f, { ...f.input, headers }); assert.equal(f.state.lookups, 0)
  }
  const f = fixture(); await denied(f, { ...f.input, resourcePath: '/' + 'x'.repeat(2048) })
})
test('original admission, Use, request/account/service lifetime and late lookup are rechecked', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.admissionCurrent = false },
    (f: ReturnType<typeof fixture>) => { f.state.useCurrent = false },
    (f: ReturnType<typeof fixture>) => { f.requestLife.abort(new Error('fixture-request-abort')) },
    (f: ReturnType<typeof fixture>) => { f.accountLife.abort(new Error('fixture-account-close')) },
    (f: ReturnType<typeof fixture>) => { f.serviceLife.abort(new Error('fixture-service-stop')) }]) {
    const f = fixture(); f.state.beforeConsume = async () => { change(f) }; await denied(f)
  }
})
test('caller abort does not pretend submitted work settled or release the original owner reservation early', async () => {
  const f = fixture(); let finish!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  f.state.actual = () => { entered(); return new Promise<void>((resolve) => { finish = resolve }) }
  const running = f.run(); await started
  const reason = new Error('fixture-caller-abort'); f.requestLife.abort(reason)
  let settled = false; void running.then(() => { settled = true }, () => { settled = true })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(settled, false); assert.equal(f.state.reserved, true)
  finish(); await assert.rejects(running, error => error === reason); assert.equal(f.state.reserved, false)
})
