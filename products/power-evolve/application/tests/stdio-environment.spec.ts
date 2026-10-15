/** Real PostgreSQL credential intake, immutable binding and worker-only decryption; no real user process is started. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { stdioEnvironmentOptions } from '@power-evolve/contracts/stdio-environment'
import { StdioEnvironmentService } from '../src/platform/stdio-environment.ts'
import { StdioConnectionServiceV2 } from '../src/platform/stdio-v2-connections.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { stdioWorkflow, workflowLimits, workflowRequest } from './employee1-stdio-workflow-fixture.ts'

const options = () => stdioEnvironmentOptions.parse({})
const configuration = { name: 'Secret process', invocation: { program: 'node', argv: [], cwd: '.' } }
const payload = (values: Record<string, string>) => Buffer.from(JSON.stringify({ formatVersion: 1,
  values: Object.entries(values).map(([name, value]) => ({ name, value })) }))

test('environment uploads encrypt values, expose names only and retain or replace an exact saved source', () => cloudFixture(async ({ pool, alice, bob }) => {
  const service = new StdioEnvironmentService(pool, randomBytes(32), workflowLimits, options())
  const connections = new StdioConnectionServiceV2(pool, workflowLimits, { maxNameBytes: 80, pageItems: 4, maxConnections: 4 })
  const bytes = payload({ API_TOKEN: 'private-中文-secret', EMPTY: '' }), requestId = randomUUID()
  const metadata = { requestId, sizeBytes: bytes.length, keys: [{ name: 'API_TOKEN', action: 'replace' }, { name: 'EMPTY', action: 'replace' }] }
  const ticket = await service.issueTicket(alice.token, metadata, 'https://platform.test')
  const reference = (await service.upload(ticket.ticket, bytes)).environment
  expect(reference.keys).toEqual(['API_TOKEN', 'EMPTY'])
  expect(await service.receipt(alice.token, { requestId })).toEqual({ environment: reference })
  expect(await service.receipt(bob.token, { requestId })).toEqual({ environment: null })
  await expect(service.upload(ticket.ticket, bytes)).rejects.toMatchObject({ status: 401 })
  const retry = await service.issueTicket(alice.token, metadata, 'https://platform.test')
  expect((await service.upload(retry.ticket, bytes)).environment).toEqual(reference)
  await expect(connections.create(bob.token, { requestId: workflowRequest(), configuration: { ...configuration, environment: reference } }))
    .rejects.toMatchObject({ status: 404 })
  const created = await connections.create(alice.token, { requestId: workflowRequest(), configuration: { ...configuration,
    presentation: { note: 'Private service', icon: null }, environment: reference } })
  await expect(connections.create(alice.token, { requestId: workflowRequest(),
    configuration: { ...configuration, environment: reference } }))
    .rejects.toMatchObject({ code: 'stdio_environment_binding_conflict' })
  const stored = z.object({ sealed: z.instanceof(Buffer) })
    .parse((await pool.query<Record<string, unknown>>('SELECT sealed FROM pe_stdio_v2_environment_versions')).rows[0]).sealed
  expect(stored.includes(Buffer.from('private-中文-secret'))).toBe(false)
  expect(JSON.stringify(await connections.list(alice.token, {}))).not.toContain('private-中文-secret')
  const nextBytes = payload({ NEW_TOKEN: 'replacement' })
  const source = { connectionId: created.connectionId, expectedRevision: 1, credentialVersion: reference.credentialVersion }
  await expect(service.issueTicket(bob.token, { requestId: randomUUID(), sizeBytes: nextBytes.length, source,
    keys: [{ name: 'API_TOKEN', action: 'retain' }] }, 'https://platform.test')).rejects.toMatchObject({ code: 'stdio_environment_source_changed' })
  const nextTicket = await service.issueTicket(alice.token, { requestId: randomUUID(), sizeBytes: nextBytes.length, source,
    keys: [{ name: 'API_TOKEN', action: 'retain' }, { name: 'NEW_TOKEN', action: 'replace' }] }, 'https://platform.test')
  const next = (await service.upload(nextTicket.ticket, nextBytes)).environment
  await connections.update(alice.token, { requestId: workflowRequest(), connectionId: created.connectionId, expectedRevision: 1,
    configuration: { ...configuration, environment: next } })
  expect((await connections.list(alice.token, {})).items[0]!.configuration.environment?.keys).toEqual(['API_TOKEN', 'NEW_TOKEN'])
  await expect(pool.query('UPDATE pe_stdio_v2_environment_versions SET sealed=$2 WHERE id=$1', [reference.credentialVersion, Buffer.alloc(30)]))
    .rejects.toMatchObject({ code: '23514' })
}))

test('original worker receives values once after approval; false authority, cancellation and stale leases cannot read them', async () => {
  const key = randomBytes(32)
  await stdioWorkflow(async (f) => {
    const service = new StdioEnvironmentService(f.pool, key, workflowLimits, options())
    const lease = await f.claim()
    await f.approve(lease)
    await f.dispatch(lease)
    const snapshot = await f.store.snapshot(lease)
    if (!snapshot.dispatch) throw new Error('Original dispatch required')
    const dispatch = snapshot.dispatch
    await expect(service.readForWorker({ lease: { ...lease, leaseEpoch: lease.leaseEpoch + 1 }, dispatch }, new AbortController().signal))
      .rejects.toMatchObject({ status: 409 })
    expect(await service.readForWorker({ lease, dispatch }, new AbortController().signal)).toEqual({ API_TOKEN: 'private-worker-secret' })
    await expect(service.readForWorker({ lease, dispatch }, new AbortController().signal)).rejects.toMatchObject({ code: 'stdio_environment_already_delivered' })
    const detail = await f.actions.detail(f.owner.token, { actionId: lease.actionId })
    expect(JSON.stringify(detail)).not.toContain('private-worker-secret')
    await f.actions.cancel(f.owner.token, { actionId: lease.actionId })
    await expect(service.readForWorker({ lease, dispatch }, new AbortController().signal)).rejects.toMatchObject({ code: 'stdio_environment_authority_lost' })
  }, 300_000, async (pool, owner) => {
    const service = new StdioEnvironmentService(pool, key, workflowLimits, options()), bytes = payload({ API_TOKEN: 'private-worker-secret' })
    const ticket = await service.issueTicket(owner.token, { requestId: randomUUID(), sizeBytes: bytes.length,
      keys: [{ name: 'API_TOKEN', action: 'replace' }] }, 'https://platform.test')
    return { presentation: { note: 'Authenticated process', icon: null }, environment: (await service.upload(ticket.ticket, bytes)).environment }
  })
})

test('credential intake rejects a changed upload plan and revoked account', () => cloudFixture(async ({ pool, alice }) => {
  const service = new StdioEnvironmentService(pool, randomBytes(32), workflowLimits, options()), bytes = payload({ OTHER: 'private' })
  const metadata = { requestId: randomUUID(), sizeBytes: bytes.length, keys: [{ name: 'TOKEN', action: 'replace' }] }
  const ticket = await service.issueTicket(alice.token, metadata, 'https://platform.test')
  await expect(service.upload(ticket.ticket, bytes)).rejects.toMatchObject({ code: 'stdio_environment_plan_mismatch' })
  await expect(service.issueTicket(alice.token, { ...metadata, sizeBytes: bytes.length + 1 }, 'https://platform.test'))
    .rejects.toMatchObject({ code: 'stdio_environment_request_conflict' })
  await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.user.userId])
  await expect(service.upload(ticket.ticket, bytes)).rejects.toMatchObject({ status: 401 })
}))
