/** One-shot Cordis maintenance plugin; normal Platform, Host, model and workers are never mounted. */
import { constants } from 'node:fs'
import { lstat, open, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import schema from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import { z } from 'zod'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyBundle, type LegacyFileEntry } from './legacy-import-codec.ts'
import { initializeDatabase, CURRENT_SCHEMA_VERSION } from './database.ts'
import { captureLegacyMigrationSource } from './legacy-migration-v2-source.ts'
import { legacyHistoryStorage, migrateLegacyHistories } from './legacy-migration-v2-history.ts'
import { legacyMigrationFileSource, planLegacyHistoryFiles } from './legacy-migration-v2-attachments.ts'
import { legacyMigrationImagesInput } from './legacy-migration-v2-media-contracts.ts'
import { planLegacyHistoryImages } from './legacy-migration-v2-images.ts'
import { legacyMigrationCut, prepareLegacyMigration } from './legacy-migration-v2-plan.ts'
import { writeLegacyMigration } from './legacy-migration-v2-write.ts'
import { createLegacyMigrationMcpContext } from './legacy-migration-v2-remote-mcp.ts'
import { createLegacyMigrationSshContext } from './legacy-migration-v2-ssh.ts'
import { createLegacyMigrationStdioContext } from './legacy-migration-v2-stdio.ts'
import { createLegacyMigrationStdioV2Context } from './legacy-migration-v2-stdio-management.ts'
import { createLegacyMigrationBuiltinContext } from './legacy-migration-v2-builtin-skills.ts'
import { createLegacyMigrationStdioCallContext } from './legacy-migration-v2-stdio-calls.ts'
import { createLegacyMigrationStdioNoStartContext } from './legacy-migration-v2-stdio-no-start.ts'
import { createLegacyMigrationCloudCancellationContext } from './legacy-migration-v2-cloud-cancel.ts'
import { createLegacyMigrationCloudResolutionContext } from './legacy-migration-v2-cloud-resolution.ts'
import { createLegacyMigrationStdioDiscoveryContext } from './legacy-migration-v2-stdio-discovery.ts'
import { createLegacyMigrationStoppedCreationContext } from './legacy-migration-v2-sandbox-stopped.ts'

/** Maintenance identity for the independent private Profile. */
export const name = 'power-evolve-legacy-migration-v2-maintenance'
/** Official launcher facts own the maintenance process outcome and completed shutdown. */
export const inject = ['appExit', 'appReady']
/** Required protected parameter file and explicit bounded read budgets. */
export const Config = schema.object({ requestFile: schema.string().required(),
  maxRequestBytes: schema.number().min(1).step(1).required(),
  maxEvidenceBytes: schema.number().min(1).step(1).required(),
  maxKeyBytes: schema.number().min(1).step(1).required() })
/** Parsed Cordis maintenance configuration. */
export type Config = ReturnType<typeof Config>
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const path = z.string().refine(isAbsolute)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const limitsSchema = z.object({ maxBundleBytes: positive, maxRows: positive, maxCellBytes: positive,
  maxJsonDepth: positive, maxJsonNodes: positive, maxFiles: positive, maxFileBytes: positive, maxStorageBytes: positive }).strict()
const sourceIdentity = z.object({ schema: z.literal(37), ddlSha256: digest, snapshotId: z.uuid(), codeId: z.string().min(1),
  stoppedAt: z.string(), cut: z.string() }).strict()
const baseFile = z.object({ area: z.enum(['workspace', 'home', 'skill-text', 'skill-package', 'office']), owner: z.uuid(),
  resource: z.string().min(1), path: z.string(), kind: z.enum(['file', 'directory']), sourcePath: z.string().nullable(),
  bytes: z.string().nullable(), sha256: z.string().nullable(), mode: z.number().int().min(0).max(0o777),
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }).strict()
const common = z.object({ format: z.literal('power-evolve-legacy-maintenance'), version: z.literal(2), migrationId: z.uuid(),
  limits: limitsSchema, phaseTimeoutMs: positive, outputFile: path, failureEvidenceFile: path.optional(),
  source: z.object({ purpose: z.literal('offline-readonly-export'), urlFile: path, expectedDatabase: z.string().min(1),
    expectedCatalogSha256: digest, identity: sourceIdentity, batchRows: positive, statementTimeoutMs: positive }).strict() }).strict()
const requestSchema = z.discriminatedUnion('mode', [common.extend({ mode: z.literal('capture') }),
  common.extend({ mode: z.literal('migrate'), evidenceFile: path, trustedEvidenceKeysFile: path,
    histories: z.array(legacyHistoryStorage), attachmentSources: z.array(legacyMigrationFileSource),
    attachmentSourceRoots: z.record(z.string(), path), files: z.array(baseFile), initializeCurrent: z.boolean(),
    images: legacyMigrationImagesInput.optional(),
    mcp: z.object({ keyFile: path, requestEvidenceFile: path }).strict().optional(),
    ssh: z.object({ keyFile: path }).strict().optional(),
    stdio: z.object({ requestEvidenceFile: path }).strict().optional(),
    stdioV2: z.object({ policyFile: path }).strict().optional(),
    builtinSkills: z.object({ evidenceFile: path }).strict().optional(),
    stdioCalls: z.object({ evidenceFile: path }).strict().optional(),
    cloudCancellation: z.object({ evidenceFile: path }).strict().optional(),
    stdioNoStart: z.object({ evidenceFile: path }).strict().optional(),
    cloudResolution: z.object({ evidenceFile: path }).strict().optional(),
    stoppedCreation: z.object({ evidenceFile: path }).strict().optional(),
    stdioDiscovery: z.object({ evidenceFile: path, originalApprovalKeyFile: path }).strict().optional(),
    target: z.object({ urlFile: path, expectedDatabase: z.string().min(1), statementTimeoutMs: positive }).strict(),
    storage: z.object({ bundleRoot: path, candidateRoot: path, sourceUid: z.number().int().nonnegative(),
      sourceGid: z.number().int().nonnegative(),
      sourceOwners: z.array(z.object({ uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }).strict())
        .min(1).optional(),
      targetUid: z.number().int().nonnegative(), targetGid: z.number().int().nonnegative() }).strict(),
  })])
async function protectedText(file: string, maximum: number): Promise<string> {
  if (!isAbsolute(file) || !Number.isSafeInteger(maximum) || maximum < 1) throw new LegacyImportError('maintenance_private_config')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > maximum) {
      throw new LegacyImportError('maintenance_private_file')
    }
    const data = await handle.readFile(), after = await handle.stat()
    if (data.byteLength > maximum || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new LegacyImportError('maintenance_private_file_changed')
    }
    const text = data.toString('utf8')
    if (Buffer.from(text).compare(data) !== 0) throw new LegacyImportError('maintenance_private_file_encoding')
    return text
  } finally { await handle.close() }
}
async function signedCut(evidenceFile: string, keysFile: string, config: Config, limits: z.infer<typeof limitsSchema>) {
  const envelope = z.object({ keyId: z.string().min(1), payload: z.string(), signature: z.string() }).strict()
    .parse(legacyJson(await protectedText(evidenceFile, config.maxEvidenceBytes), limits, config.maxEvidenceBytes))
  const keys = z.object({ version: z.literal(1), keys: z.array(z.object({ keyId: z.string().min(1),
    publicKeyPem: z.string().min(1) }).strict()).min(1) }).strict()
    .parse(legacyJson(await protectedText(keysFile, config.maxKeyBytes), limits, config.maxKeyBytes))
  if (new Set(keys.keys.map(key => key.keyId)).size !== keys.keys.length) throw new LegacyImportError('maintenance_trust_key_duplicate')
  const selected = keys.keys.find(key => key.keyId === envelope.keyId)
  if (!selected) throw new LegacyImportError('maintenance_cut_signer')
  const key = createPublicKey(selected.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new LegacyImportError('maintenance_cut_signature')
  }
  return legacyMigrationCut.parse(legacyJson(envelope.payload, limits, config.maxEvidenceBytes))
}
async function outputAbsent(file: string): Promise<void> {
  const parent = await lstat(dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new LegacyImportError('maintenance_output_parent')
  }
  try { await lstat(file) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new LegacyImportError('maintenance_output_exists')
}
async function poolFor(file: string, expectedDatabase: string, config: Config, timeout: number): Promise<Pool> {
  const connectionString = (await protectedText(file, config.maxKeyBytes)).trim()
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) {
    throw new LegacyImportError('maintenance_connection_identity')
  }
  return new Pool({ connectionString, max: 1, connectionTimeoutMillis: timeout })
}

/** Execute the protected maintenance request with Cordis-owned cancellation and closed PG pools.
 * @param ctx Independent maintenance context; no production services are injected or started.
 * @param config Explicit protected-file paths and read budgets from the private Profile.
 * @returns Completion only after capture or qualified migration and its private output file are durable.
 */
async function runMaintenance(ctx: Context, config: Config): Promise<void> {
  const stop = new AbortController()
  ctx.effect(() => () => { stop.abort() })
  let sourcePool: Pool | undefined, targetPool: Pool | undefined, failureEvidenceFile: string | undefined
  try {
    const text = await protectedText(config.requestFile, config.maxRequestBytes)
    const raw: unknown = JSON.parse(text)
    const preliminary = requestSchema.parse(raw)
    const request = requestSchema.parse(legacyJson(text, preliminary.limits, config.maxRequestBytes))
    await outputAbsent(request.outputFile)
    if (request.failureEvidenceFile !== undefined) {
      await outputAbsent(request.failureEvidenceFile)
      failureEvidenceFile = request.failureEvidenceFile
    }
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(request.phaseTimeoutMs)])
    sourcePool = await poolFor(request.source.urlFile, request.source.expectedDatabase, config, request.phaseTimeoutMs)
    const capture = await captureLegacyMigrationSource(sourcePool, request.source.identity satisfies LegacyBundle['source'], {
      purpose: request.source.purpose, expectedDatabase: request.source.expectedDatabase,
      expectedCatalogSha256: request.source.expectedCatalogSha256, batchRows: request.source.batchRows,
      statementTimeoutMs: request.source.statementTimeoutMs, limits: request.limits,
    }, signal)
    await sourcePool.end(); sourcePool = undefined
    if (request.mode === 'capture') {
      await writeFile(request.outputFile, JSON.stringify({ phase: 'captured', systemMigrationComplete: false, capture }) + '\n',
        { flag: 'wx', mode: 0o600 })
      return
    }
    if (request.source.expectedDatabase === request.target.expectedDatabase) throw new LegacyImportError('maintenance_source_target_overlap')
    const cut = await signedCut(request.evidenceFile, request.trustedEvidenceKeysFile, config, request.limits)
    const histories = migrateLegacyHistories(capture, request.histories, request.limits)
    const images = planLegacyHistoryImages(request.migrationId, histories, request.images?.sources ?? [])
    const receipts = planLegacyHistoryFiles(request.migrationId, histories, request.attachmentSources)
    const mcp = request.mcp === undefined ? undefined : createLegacyMigrationMcpContext(
      legacyJson(await protectedText(request.mcp.keyFile, config.maxKeyBytes), request.limits, config.maxKeyBytes),
      legacyJson(await protectedText(request.mcp.requestEvidenceFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const ssh = request.ssh === undefined ? undefined : createLegacyMigrationSshContext(
      legacyJson(await protectedText(request.ssh.keyFile, config.maxKeyBytes), request.limits, config.maxKeyBytes), capture.source.codeId)
    const stdio = request.stdio === undefined ? undefined : createLegacyMigrationStdioContext(
      legacyJson(await protectedText(request.stdio.requestEvidenceFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const stdioV2 = request.stdioV2 === undefined ? undefined : createLegacyMigrationStdioV2Context(
      legacyJson(await protectedText(request.stdioV2.policyFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId)
    const builtin = request.builtinSkills === undefined ? undefined : await createLegacyMigrationBuiltinContext(
      legacyJson(await protectedText(request.builtinSkills.evidenceFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const stdioCalls = request.stdioCalls === undefined ? undefined : createLegacyMigrationStdioCallContext(
      legacyJson(await protectedText(request.stdioCalls.evidenceFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const stdioNoStart = request.stdioNoStart === undefined ? undefined : createLegacyMigrationStdioNoStartContext(
      legacyJson(await protectedText(request.stdioNoStart.evidenceFile, config.maxEvidenceBytes), request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const cloudCancellation = request.cloudCancellation === undefined ? undefined : createLegacyMigrationCloudCancellationContext(
      legacyJson(await protectedText(request.cloudCancellation.evidenceFile, config.maxEvidenceBytes),
        request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const cloudResolution = request.cloudResolution === undefined ? undefined : createLegacyMigrationCloudResolutionContext(
      legacyJson(await protectedText(request.cloudResolution.evidenceFile, config.maxEvidenceBytes),
        request.limits, config.maxEvidenceBytes), capture.source.codeId, request.limits)
    const stoppedCreation = request.stoppedCreation === undefined ? undefined : createLegacyMigrationStoppedCreationContext(
      legacyJson(await protectedText(request.stoppedCreation.evidenceFile, config.maxEvidenceBytes),
        request.limits, config.maxEvidenceBytes),
      capture.source.codeId, request.limits)
    const originalApprovalKey = request.stdioDiscovery === undefined ? undefined
      : (await protectedText(request.stdioDiscovery.originalApprovalKeyFile, config.maxKeyBytes)).trim()
    if (originalApprovalKey !== undefined && !/^[a-f0-9]{64}$/u.test(originalApprovalKey)) {
      throw new LegacyImportError('maintenance_stdio_original_key')
    }
    const stdioDiscovery = request.stdioDiscovery === undefined || originalApprovalKey === undefined ? undefined
      : createLegacyMigrationStdioDiscoveryContext(
        legacyJson(await protectedText(request.stdioDiscovery.evidenceFile, config.maxEvidenceBytes),
          request.limits, config.maxEvidenceBytes), Buffer.from(originalApprovalKey, 'hex'), capture.source.codeId, request.limits)
    const fileDigest = legacyDigest(JSON.stringify({ files: request.files, attachmentSources: request.attachmentSources,
      attachmentSourceRoots: request.attachmentSourceRoots,
      ...(request.images === undefined ? {} : { images: request.images }),
      ...(mcp === undefined ? {} : { mcpEvidenceSha256: mcp.evidenceSha256 }),
      ...(ssh === undefined ? {} : { sshEvidenceSha256: ssh.evidenceSha256 }),
      ...(stdio === undefined ? {} : { stdioEvidenceSha256: stdio.evidenceSha256 }),
      ...(stdioV2 === undefined ? {} : { stdioV2EvidenceSha256: stdioV2.evidenceSha256 }),
      ...(builtin === undefined ? {} : { builtinEvidenceSha256: builtin.evidenceSha256 }),
      ...(stdioCalls === undefined ? {} : { stdioCallEvidenceSha256: stdioCalls.evidenceSha256 }),
      ...(cloudCancellation === undefined ? {} : { cloudCancellationEvidenceSha256: cloudCancellation.evidenceSha256 }),
      ...(stdioNoStart === undefined ? {} : { stdioNoStartEvidenceSha256: stdioNoStart.evidenceSha256 }),
      ...(cloudResolution === undefined ? {} : { cloudResolutionEvidenceSha256: cloudResolution.evidenceSha256 }),
      ...(stoppedCreation === undefined ? {} : { stoppedCreationEvidenceSha256: stoppedCreation.evidenceSha256 }),
      ...(stdioDiscovery === undefined ? {} : { stdioDiscoveryEvidenceSha256: stdioDiscovery.evidenceSha256 }) }))
    const plan = prepareLegacyMigration(request.migrationId, capture, histories, receipts,
      request.files satisfies LegacyFileEntry[], fileDigest, cut, request.limits,
      images, mcp, ssh, stdio, stdioV2, builtin, stdioCalls, cloudCancellation, stdioNoStart,
      stoppedCreation, stdioDiscovery, cloudResolution)
    targetPool = await poolFor(request.target.urlFile, request.target.expectedDatabase, config, request.phaseTimeoutMs)
    const imported = await writeLegacyMigration(targetPool, plan, { expectedDatabase: request.target.expectedDatabase,
      statementTimeoutMs: request.target.statementTimeoutMs, storage: request.storage,
      attachmentSourceRoots: request.attachmentSourceRoots,
      ...(request.images === undefined ? {} : { imageSourceHomes: request.images.sourceHomes,
        maxImagePixels: request.images.maxImagePixels }) }, signal)
    signal.throwIfAborted()
    if (request.initializeCurrent) await initializeDatabase(targetPool)
    await writeFile(request.outputFile, JSON.stringify({ phase: request.initializeCurrent ? 'current-schema-initialized' : 'schema2-compared',
      family: imported.family, version: request.initializeCurrent ? CURRENT_SCHEMA_VERSION : imported.version,
      captureSha256: imported.captureSha256, storage: imported.storage, tableCounts: imported.tableCounts,
      receipts: plan.receipts, images: plan.images, excluded: plan.excluded, systemMigrationComplete: false }) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (failureEvidenceFile !== undefined) await writeFile(failureEvidenceFile,
      JSON.stringify({ phase: 'failed', code: error instanceof LegacyImportError ? error.code : 'maintenance_request_rejected',
        systemMigrationComplete: false }) + '\n', { flag: 'wx', mode: 0o600 })
    if (error instanceof LegacyImportError) throw error
    throw new LegacyImportError('maintenance_request_rejected')
  } finally {
    const closed = await Promise.allSettled([sourcePool?.end(), targetPool?.end()])
    if (closed.some(result => result.status === 'rejected')) throw new LegacyImportError('maintenance_pool_close_failed')
  }
}

/** Complete one maintenance request and request the official launcher's bounded process shutdown.
 * @param ctx Cordis context with the dsh launcher's exit and readiness facts.
 * @param config Protected request location and explicit read budgets.
 * @returns Completion after owned resources close; failures request exit1 and retain their bounded code.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const exit = ctx.appExit, ready = ctx.appReady
  if (!exit || !ready) throw new LegacyImportError('maintenance_launcher_missing')
  try { await runMaintenance(ctx, config) }
  catch (error) { exit(1); throw error }
  ctx.effect(() => ready.onReady(() => { exit(0) }))
}
