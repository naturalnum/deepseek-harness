import { z } from 'zod';
import {
  FINANCE_ARTIFACT_KINDS,
  FINANCE_COMPLETION_SCHEMA,
  FINANCE_RESULT_SCHEMA,
  FINANCE_TASK_KINDS,
  FINANCE_TOOL_NAMES,
  FINANCE_TOOL_RECEIPT_SCHEMA,
  type FinanceArtifactKind,
  type FinanceResultEnvelope,
} from './types';

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const finiteNonNegative = z.number().finite().nonnegative();
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/iu);
const uniqueStrings = (maxItems: number, maxLength = 160, minItems = 0) =>
  z
    .array(boundedString(maxLength))
    .min(minItems)
    .max(maxItems)
    .superRefine((items, context) => {
      if (new Set(items).size !== items.length)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be unique' });
    });

export const financeCoverageSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    ratio: z.number().finite().min(0).max(1),
    missingSymbols: uniqueStrings(500, 64),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.returned > coverage.requested) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['returned'], message: 'cannot exceed requested' });
    }
    const expected = coverage.requested === 0 ? 0 : coverage.returned / coverage.requested;
    if (Math.abs(expected - coverage.ratio) > 1e-9) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['ratio'], message: 'must match returned/requested' });
    }
  });

export const financeSourceRefSchema = z
  .object({
    id: boundedString(120),
    provider: boundedString(120),
    sourceType: z.enum(['filing', 'exchange', 'market_data', 'news', 'derived']),
    uri: boundedString(2048).optional(),
    title: boundedString(300).optional(),
    asOf: isoTimestamp,
    retrievedAt: isoTimestamp,
    upstreamRevision: boundedString(240).optional(),
    contentSha256: sha256.optional(),
    licenseRef: boundedString(240).optional(),
  })
  .strict();

export const financeReportSuggestionSchema = z
  .object({
    id: boundedString(120),
    moduleId: boundedString(120),
    cardKind: z.enum(['metric_strip', 'timeseries', 'data_table', 'ranked_list', 'evidence_list']),
    visualization: z.enum([
      'metric_strip',
      'line',
      'sparkline',
      'table',
      'treemap',
      'ranked_list',
      'hbar_rank',
      'evidence_list',
      'timeline',
    ]),
    preferredView: boundedString(80),
    purpose: boundedString(300),
    maxItems: z.number().int().min(1).max(100),
  })
  .strict();

export const createFinanceResultEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z
    .object({
      schema: z.literal(FINANCE_RESULT_SCHEMA),
      requestId: boundedString(160),
      dataStatus: z.enum(['available', 'market_closed', 'no_data', 'permission_denied', 'provider_error', 'no_change']),
      asOf: isoTimestamp,
      retrievedAt: isoTimestamp,
      market: z.enum(['us', 'cn', 'hk', 'cross_market']).optional(),
      timezone: boundedString(80),
      currency: boundedString(16).optional(),
      dataRevision: boundedString(240).optional(),
      stale: z.boolean(),
      partial: z.boolean(),
      coverage: financeCoverageSchema.optional(),
      warnings: uniqueStrings(100, 500),
      sourceRefs: z.array(financeSourceRefSchema).max(100),
      reportSuggestions: z.array(financeReportSuggestionSchema).max(4).optional(),
      data: dataSchema,
    })
    .strict()
    .superRefine((envelope, context) => {
      if (envelope.dataStatus === 'available' && envelope.partial && envelope.warnings.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['warnings'],
          message: 'partial available data requires a visible warning',
        });
      }
      if (envelope.dataStatus === 'no_change' && envelope.partial) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['partial'], message: 'no_change is not partial' });
      }
    });

export const parseFinanceResultEnvelope = <T extends z.ZodTypeAny>(
  value: unknown,
  dataSchema: T
): FinanceResultEnvelope<z.infer<T>> =>
  createFinanceResultEnvelopeSchema(dataSchema).parse(value) as FinanceResultEnvelope<z.infer<T>>;

export const financeArtifactRefSchema = z
  .object({
    artifactId: boundedString(160),
    version: z.number().int().positive(),
    revision: boundedString(240).optional(),
    contentSha256: sha256.optional(),
    role: boundedString(80).optional(),
  })
  .strict();

const platformToolNames = [
  'project_workspace',
  'science_artifact',
  'research_evidence',
  'factor_search',
  'factor_lab',
  'factor_registry',
  'factor_submit',
  'user_input',
  'cron',
] as const;

export const financeToolReceiptSchema = z
  .object({
    schema: z.literal(FINANCE_TOOL_RECEIPT_SCHEMA),
    receiptId: boundedString(160),
    runId: boundedString(160),
    sessionId: boundedString(160),
    callId: boundedString(160),
    toolName: z.enum([...FINANCE_TOOL_NAMES, ...platformToolNames]),
    status: z.enum(['succeeded', 'partial', 'failed', 'skipped']),
    dataStatus: z.enum(['available', 'market_closed', 'no_data', 'permission_denied', 'provider_error', 'no_change']),
    requestHash: sha256,
    asOf: isoTimestamp.optional(),
    coverage: financeCoverageSchema.optional(),
    evidenceIds: uniqueStrings(100),
    artifactRefs: z.array(financeArtifactRefSchema).max(100),
    capabilities: uniqueStrings(100, 160),
    warnings: uniqueStrings(100, 500),
    error: z
      .object({
        code: boundedString(120),
        message: boundedString(500),
      })
      .strict()
      .optional(),
    issuedAt: isoTimestamp,
    attestation: z
      .object({
        algorithm: z.literal('hmac-sha256'),
        keyId: boundedString(80),
        value: sha256,
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status !== 'succeeded' && receipt.warnings.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warnings'],
        message: 'non-success receipt requires a reason',
      });
    }
  })
  .transform(({ error: envelopeError, ...receipt }) => {
    // Agents may accidentally copy the adjacent result-envelope error into a
    // failed receipt. It is not signed, so remove only this known field before
    // attestation verification while continuing to reject all other extras.
    void envelopeError;
    return receipt;
  });

const taskContractRefSchema = z
  .object({
    id: z.enum([
      'finance.market-theme.v1',
      'finance.news-impact.v1',
      'finance.company-research.v1',
      'finance.simulated-portfolio.v1',
      'finance.holdings-diagnosis.v1',
      'finance.monitor.v1',
      'finance.factor-research.v1',
    ]),
    version: boundedString(32),
    contractHash: sha256,
    routeSource: z.enum(['deterministic', 'agent_selected', 'user_confirmed']),
  })
  .strict();

const financePreflightGateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bound_write'),
      workspaceStatusReceiptId: boundedString(160),
      workspace: boundedString(2048),
    })
    .strict(),
  z.object({ kind: z.literal('unbound_read_only'), gateId: boundedString(160) }).strict(),
]);

const completionBase = z.object({
  schema: z.literal(FINANCE_COMPLETION_SCHEMA),
  runId: boundedString(160),
  taskKind: z.enum(FINANCE_TASK_KINDS),
  taskContract: taskContractRefSchema,
  gate: financePreflightGateSchema,
  toolReceipts: z.array(financeToolReceiptSchema).max(100),
  asOf: isoTimestamp,
  coverage: financeCoverageSchema.optional(),
  evidenceIds: uniqueStrings(200),
  artifactRefs: z.array(financeArtifactRefSchema).max(100),
  report: z
    .object({
      panelId: boundedString(160),
      sectionIds: uniqueStrings(80),
      cardIds: uniqueStrings(80),
    })
    .strict(),
  projectGit: z
    .object({ root: boundedString(2048), head: boundedString(160), checkpoint: boundedString(160).optional() })
    .strict()
    .optional(),
  artifactGit: z
    .object({ evidenceSnapshotCommit: boundedString(160), snapshotId: boundedString(160) })
    .strict()
    .optional(),
  factorRegistryReceiptId: boundedString(160).optional(),
  checkpoint: z
    .object({
      outcome: z.enum(['created', 'no_material_change']),
      commit: boundedString(160).optional(),
      stage: boundedString(80).optional(),
      verification: uniqueStrings(40, 300),
    })
    .strict()
    .optional(),
  verifiedAt: isoTimestamp,
});

export const financeCompletionManifestSchema = z.discriminatedUnion('status', [
  completionBase
    .extend({
      status: z.literal('completed'),
      reproducible: z.literal(true),
      projectGit: z
        .object({ root: boundedString(2048), head: boundedString(160), checkpoint: boundedString(160).optional() })
        .strict(),
      artifactGit: z.object({ evidenceSnapshotCommit: boundedString(160), snapshotId: boundedString(160) }).strict(),
      gaps: z.tuple([]),
    })
    .strict(),
  completionBase
    .extend({
      status: z.literal('partial'),
      reproducible: z.literal(false),
      gaps: uniqueStrings(100, 500, 1),
    })
    .strict(),
  completionBase
    .extend({
      status: z.literal('blocked'),
      reproducible: z.literal(false),
      gaps: uniqueStrings(100, 500, 1),
    })
    .strict(),
]);

export const financeArtifactMetadataSchema = z
  .object({
    schema: boundedString(160),
    kind: z.enum(FINANCE_ARTIFACT_KINDS),
    contractId: boundedString(160).optional(),
    contractVersion: boundedString(32).optional(),
    contractHash: sha256.optional(),
    snapshotId: boundedString(160),
    asOf: isoTimestamp,
    refreshedAt: isoTimestamp,
    timezone: boundedString(80),
    currency: boundedString(16).optional(),
    currencies: uniqueStrings(20, 16).optional(),
    dataMode: z.enum(['HISTORICAL', 'SIMULATION', 'LIVE_READ_ONLY']),
    tradeCapability: z.literal('disabled'),
    sopId: boundedString(160),
    sopVersion: boundedString(32),
    evidenceIds: uniqueStrings(200),
    status: z.enum(['available', 'partial', 'missing', 'stale']).optional(),
    sourceManifestPath: boundedString(2048).optional(),
    dataRevision: boundedString(240).optional(),
    contentSha256: sha256.optional(),
    simulation: z
      .object({
        enabled: z.boolean(),
        priceRule: boundedString(240).optional(),
        benchmark: uniqueStrings(20, 64).optional(),
        fees: boundedString(240).optional(),
        slippage: boundedString(240).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.dataMode === 'SIMULATION' && metadata.simulation?.enabled !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['simulation'],
        message: 'SIMULATION requires assumptions',
      });
    }
  });

export type FinanceArtifactMetadata = z.infer<typeof financeArtifactMetadataSchema>;

export const readFinanceArtifactMetadata = (metadata: unknown): FinanceArtifactMetadata | undefined => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const candidate = record.finance ?? record;
  const parsed = financeArtifactMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

export const readFinanceArtifactKind = (metadata: unknown): FinanceArtifactKind | undefined => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const nested =
    record.finance && typeof record.finance === 'object' && !Array.isArray(record.finance)
      ? (record.finance as Record<string, unknown>)
      : undefined;
  const kind = nested?.kind ?? record.financeKind ?? record.kind;
  return typeof kind === 'string' && FINANCE_ARTIFACT_KINDS.includes(kind as FinanceArtifactKind)
    ? (kind as FinanceArtifactKind)
    : undefined;
};

export const financeFiniteNonNegativeSchema = finiteNonNegative;
