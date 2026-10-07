/**
 * V32→current compatibility against a disposable real PG database and built application modules.
 * Office records and stop facts are synthetic; no parser, kubelet or live V32 poller runs.
 * The startup fence requires old processes to be stopped before a V33 deployment.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { CURRENT_SCHEMA_VERSION, schema, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6,
  schemaV7, schemaV8, schemaV9, schemaV10, schemaV11, schemaV12, schemaV13, schemaV14,
  schemaV15, schemaV16, schemaV17, schemaV18, schemaV19, schemaV20, schemaV21, schemaV22,
  schemaV23, schemaV24, schemaV25, schemaV26 } from '../lib/platform/schema.js'
import { schemaV27 } from '../lib/platform/storage-binding-schema.js'
import { schemaV28 } from '../lib/platform/execution-resolution-schema.js'
import { schemaV29 } from '../lib/platform/device-execution-schema.js'
import { schemaV30 } from '../lib/platform/device-resolution-schema.js'
import { schemaV31 } from '../lib/platform/device-claim-closure-schema.js'
import { schemaV32 } from '../lib/platform/office-preview-schema.js'
import { initializeDatabase, transaction } from '../lib/platform/database.js'
import { OfficePreviewPods, officePreviewPodIdentity, officePreviewStopProof,
  officePreviewWorkerExit } from '../lib/platform/office-preview-pod.js'
import { storageBinding } from '../lib/platform/workspace-binding-types.js'

// Archived official initializeDatabase body, with only TS syntax removed and the function renamed.
// Source: V32 application/src/platform/database.ts, identified by its file digest below.
// Source SHA256: d87af4483b5dc2b9cf94297f9ce5fd50af1feccbf10fede9014a2d3b9c0b83b5.
// Its schema.ts CURRENT_SCHEMA_VERSION was 32. Released V1–V32 migrations remain immutable.
const V32_CURRENT_SCHEMA_VERSION = 32
async function initializeV32Database(pool) {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    await client.query(schema)
    await client.query('INSERT INTO pe_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pe_schema)')
    const versions = await client.query('SELECT version FROM pe_schema ORDER BY version')
    if (versions.rows.length !== 1 || versions.rows[0].version < 1
      || versions.rows[0].version > V32_CURRENT_SCHEMA_VERSION) throw new Error('Unsupported PowerEvolve schema version')
    const initialVersion = versions.rows[0].version
    if (initialVersion < 2) await client.query(schemaV2)
    if (initialVersion < 3) await client.query(schemaV3)
    if (initialVersion < 4) await client.query(schemaV4)
    if (initialVersion < 5) await client.query(schemaV5)
    if (initialVersion < 6) await client.query(schemaV6)
    if (initialVersion < 7) await client.query(schemaV7)
    if (initialVersion < 8) await client.query(schemaV8)
    if (initialVersion < 9) await client.query(schemaV9)
    if (initialVersion < 10) await client.query(schemaV10)
    if (initialVersion < 11) await client.query(schemaV11)
    if (initialVersion < 12) await client.query(schemaV12)
    if (initialVersion < 13) await client.query(schemaV13)
    if (initialVersion < 14) await client.query(schemaV14)
    if (initialVersion < 15) await client.query(schemaV15)
    if (initialVersion < 16) await client.query(schemaV16)
    if (initialVersion < 17) await client.query(schemaV17)
    if (initialVersion < 18) await client.query(schemaV18)
    if (initialVersion < 19) await client.query(schemaV19)
    if (initialVersion < 20) await client.query(schemaV20)
    if (initialVersion < 21) await client.query(schemaV21)
    if (initialVersion < 22) await client.query(schemaV22)
    if (initialVersion < 23) await client.query(schemaV23)
    if (initialVersion < 24) await client.query(schemaV24)
    if (initialVersion < 25) await client.query(schemaV25)
    if (initialVersion < 26) await client.query(schemaV26)
    if (initialVersion < 27) await client.query(schemaV27)
    if (initialVersion < 28) await client.query(schemaV28)
    if (initialVersion < 29) await client.query(schemaV29)
    if (initialVersion < 30) await client.query(schemaV30)
    if (initialVersion < 31) await client.query(schemaV31)
    if (initialVersion < 32) await client.query(schemaV32)
  })
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = value => sha(canonical(value))
const limits = { inputBytes: 2 * 1024 * 1024, outputBytes: 8 * 1024 * 1024,
  timeoutMs: 120000, archiveEntries: 10000, uncompressedBytes: 128 * 1024 * 1024,
  fontLoadedBytes: 256 * 1024 * 1024, pages: 1000, fontFiles: 10000,
  fontFileBytes: 128 * 1024 * 1024, fontResolutionEntries: 100000, imageResolution: 200 }
const pod = { namespace: 'office-schema-test', image: `test.invalid/parser@sha256:${'a'.repeat(64)}`,
  volumeClaimName: 'private-output', volumeSubPath: 'office-previews', kubernetesTimeoutMs: 1000,
  terminationGraceSeconds: 10, cpuMilliCores: 1000, memoryMiB: 3072, temporaryMiB: 512 }

function officeRow(userId, sessionId, workspaceId, state) {
  const id = randomUUID(), conversion = { protocolVersion: 1, kitVersion: '0.1.1',
    fontPolicyDigest: 'f'.repeat(64), limits, pod: { namespace: pod.namespace, image: pod.image,
      volumeClaimName: pod.volumeClaimName, volumeSubPath: pod.volumeSubPath,
      terminationGraceSeconds: pod.terminationGraceSeconds, cpuMilliCores: pod.cpuMilliCores,
      memoryMiB: pod.memoryMiB, temporaryMiB: pod.temporaryMiB, safetyVersion: 1 } }
  const generation = hash(conversion)
  const request = { requestId: randomUUID(), sessionId, path: 'reports/旧报告😀.docx', priority: 'foreground', generation }
  const source = Buffer.from('synthetic immutable staged V32 Office bytes\0😀')
  const job = { protocolVersion: 1, jobId: id, nonce: randomUUID(), generation,
    sourceSha256: sha(source), sourceBytes: source.length, extension: 'docx', limits }
  // Only the pure intent constructor runs. Any accidental infrastructure call fails immediately.
  const pods = new OfficePreviewPods({ call() { throw new Error('Schema regression must not call Kubernetes') } }, pod)
  const intent = { ...pods.intent(job, userId), submittedAt: '2026-10-05T00:00:00Z' }
  const identity = officePreviewPodIdentity.parse({ name: intent.template.metadata.name, uid: randomUUID(),
    generation: 2, nodeName: 'schema-fixture-node', containerId: `containerd://${'b'.repeat(64)}`,
    imageId: `sha256:${'a'.repeat(64)}` })
  const exit = officePreviewWorkerExit.parse({ containerId: identity.containerId, imageId: identity.imageId,
    exitCode: 0, startedAt: '2026-10-05T00:00:01Z', finishedAt: '2026-10-05T00:00:30Z' })
  const proof = officePreviewStopProof.parse({ status: 'KUBELET_STOPPED', jobId: id, nonce: job.nonce,
    generation, identity, observedAt: '2026-10-05T00:01:00Z' })
  const pdf = Buffer.from('%PDF-1.4\n% synthetic stored result\n%%EOF\n')
  return { id, user_id: userId, request_id: request.requestId, generation, request_digest: hash(request), request,
    session_id: sessionId, workspace_id: workspaceId,
    binding_snapshot: storageBinding.parse({ spaceId: randomUUID(), rootRelativePath: '原资料😀',
      workspaceId, rootKey: randomUUID(), generation: 7 }), source_snapshot: job, converter_snapshot: conversion,
    state, cancel_requested: state === 'stopping', error_code: null,
    deadline_at: '2026-10-05T00:03:00Z', lease_owner: state === 'stopping' ? randomUUID() : null,
    lease_epoch: 3, lease_until: state === 'stopping' ? '2026-10-05T00:00:40Z' : null,
    attempts: 2, parser_slot: state === 'stopping' ? 0 : null, creation_intent: intent, pod_identity: identity,
    worker_observation: { exit, failure: null, errorCode: null }, stop_evidence: proof,
    result: state === 'succeeded' ? { protocolVersion: 1, jobId: id, nonce: job.nonce, generation,
      sourceSha256: job.sourceSha256, pdfSha256: sha(pdf), pdfBytes: pdf.length, pages: 2,
      missingFonts: ['Fixture Missing Font'], backend: 'wasm' } : null,
    created_at: '2026-10-05T00:00:00.123456Z', updated_at: '2026-10-05T00:01:00.654321Z',
    completed_at: state === 'succeeded' ? '2026-10-05T00:01:01.123456Z' : null }
}

async function insertOfficeRow(pool, row) {
  const columns = Object.keys(row)
  await pool.query(`INSERT INTO pe_office_preview_jobs (${columns.join(',')})
    VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row))
}

async function retainedFacts(pool) {
  const rows = (await pool.query('SELECT * FROM pe_office_preview_jobs ORDER BY id')).rows
  // PG textual JSON preserves microsecond timestamps that the pg Date decoder would otherwise truncate.
  const stored = (await pool.query(`SELECT row_to_json(j)::text AS row_bytes, request::text AS request_bytes,
    binding_snapshot::text AS binding_bytes, source_snapshot::text AS source_bytes,
    converter_snapshot::text AS converter_bytes, creation_intent::text AS intent_bytes,
    pod_identity::text AS identity_bytes, worker_observation::text AS worker_bytes,
    stop_evidence::text AS stop_bytes, result::text AS result_bytes
    FROM pe_office_preview_jobs j ORDER BY id`)).rows
  return { rows, stored, sha256: sha(JSON.stringify(stored)) }
}

test('current schema retains V32 Office admission and stop records while fencing old startup and future versions',
  { timeout: 30_000 }, async t => {
    assert.equal(CURRENT_SCHEMA_VERSION, 34, 'Review retained Office facts for each adjacent reader version')
    const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-desktop-owned-20261004')
    const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
    const databaseName = `pe_office_v33_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 0 })
    let pool, created = false
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`); created = true
      const url = new URL(databaseUrl); url.pathname = `/${databaseName}`
      pool = new Pool({ connectionString: url.href, max: 1, idleTimeoutMillis: 0 })
      await initializeV32Database(pool)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 32)
      const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID()
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, 'v32-owner', 'synthetic-fixture-only', {}])
      await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, userId])
      await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
        [sessionId, userId, workspaceId, randomUUID(), { title: '原会话😀' }])
      const stopping = officeRow(userId, sessionId, workspaceId, 'stopping')
      const succeeded = officeRow(userId, sessionId, workspaceId, 'succeeded')
      await insertOfficeRow(pool, stopping); await insertOfficeRow(pool, succeeded)
      const cancelledId = randomUUID()
      await pool.query(`INSERT INTO pe_office_preview_jobs
        (id,user_id,request_id,generation,state,cancel_requested,created_at,updated_at,completed_at)
        VALUES($1,$2,$3,$4,'cancelled',true,$5,$5,$5)`,
      [cancelledId, userId, randomUUID(), stopping.generation, '2026-10-05T00:02:00.123456Z'])
      const before = await retainedFacts(pool)
      assert.equal(before.rows.length, 3)
      for (const row of before.rows.filter(row => row.request !== null)) {
        assert.equal(row.request_digest, hash(row.request))
        assert.equal(row.generation, hash(row.converter_snapshot))
        assert.deepEqual(row.stop_evidence.identity, row.pod_identity)
      }
      assert.equal(before.rows.find(row => row.id === cancelledId).request_digest, null)
      assert.equal(before.rows.find(row => row.id === stopping.id).parser_slot, 0)

      await t.test('adjacent migration preserves complete rows, exact stored JSON bytes, hashes and stop reservations', async () => {
        await initializeDatabase(pool)
        assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, CURRENT_SCHEMA_VERSION)
        assert.deepEqual(await retainedFacts(pool), before)
      })
      await t.test('repeated current initialization leaves all retained facts unchanged', async () => {
        await initializeDatabase(pool)
        assert.deepEqual(await retainedFacts(pool), before)
      })
      await t.test('archived CURRENT32 startup rejects the current version without touching old tasks', async () => {
        await assert.rejects(initializeV32Database(pool), /Unsupported PowerEvolve schema version/u)
        assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, CURRENT_SCHEMA_VERSION)
        assert.deepEqual(await retainedFacts(pool), before)
      })
      await t.test('current startup rejects a future version without rewriting version or retained rows', async () => {
        await pool.query('UPDATE pe_schema SET version=$1 WHERE version=$2', [CURRENT_SCHEMA_VERSION+1,CURRENT_SCHEMA_VERSION])
        await assert.rejects(initializeDatabase(pool), /Unsupported PowerEvolve schema version/u)
        assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, CURRENT_SCHEMA_VERSION+1)
        assert.deepEqual(await retainedFacts(pool), before)
      })
    } finally {
      await pool?.end()
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`) }
      finally { await admin.end() }
    }
  })
