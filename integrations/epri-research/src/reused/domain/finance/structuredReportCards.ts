import { z } from 'zod';
import { financeArtifactRefSchema } from './schemas';
import type {
  FinanceArtifactRef,
  FinanceDataMode,
  FinanceReportModuleId,
  FinanceReportSuggestion,
  FinanceTaskContractId,
  FinanceToolName,
  StructuredReportCardKind,
} from './types';

export const STRUCTURED_REPORT_CARD_SCHEMA = 'deepscientist.report_card.v1' as const;
export const MAX_STRUCTURED_REPORT_CARDS = 24;
export const MAX_STRUCTURED_REPORT_CARD_ROWS = 100;
export const MAX_STRUCTURED_REPORT_PAGE_SIZE = 20;

export type FinanceReportModuleDefinition = {
  id: FinanceReportModuleId;
  taskContractIds: FinanceTaskContractId[];
  upstreamComponents: string[];
  allowedCardKinds: StructuredReportCardKind[];
  reportSectionRoles: string[];
  defaultSectionRole: string;
  previewView: string;
};

export const FINANCE_REPORT_MODULE_REGISTRY: readonly FinanceReportModuleDefinition[] = [
  {
    id: 'market_status',
    taskContractIds: ['finance.market-theme.v1'],
    upstreamComponents: ['MarketHeroCard', 'MarketColumnPanel', 'TradingClockSwitcher'],
    allowedCardKinds: ['metric_strip', 'data_table', 'timeseries'],
    reportSectionRoles: ['market_status'],
    defaultSectionRole: 'market_status',
    previewView: 'overview',
  },
  {
    id: 'market_theme_ranking',
    taskContractIds: ['finance.market-theme.v1'],
    upstreamComponents: ['MarketSectorTreemap', 'SectorRow', 'SectorBlock', 'SectorPerformanceChart'],
    allowedCardKinds: ['data_table', 'ranked_list', 'timeseries'],
    reportSectionRoles: ['themes'],
    defaultSectionRole: 'themes',
    previewView: 'themes',
  },
  {
    id: 'event_impact_chain',
    taskContractIds: ['finance.news-impact.v1'],
    upstreamComponents: ['MarketEventTimeline', 'MarketEventDetailPanel', 'MarketEventImpactConnector'],
    allowedCardKinds: ['ranked_list', 'timeseries', 'evidence_list'],
    reportSectionRoles: ['event_facts', 'impact_paths', 'price_confirmation', 'counterevidence'],
    defaultSectionRole: 'impact_paths',
    previewView: 'impact',
  },
  {
    id: 'company_snapshot',
    taskContractIds: ['finance.company-research.v1'],
    upstreamComponents: ['EntityCard', 'EntitySnapshotPanel', 'EntityKlineChart'],
    allowedCardKinds: ['metric_strip', 'timeseries', 'data_table'],
    reportSectionRoles: ['identity', 'price'],
    defaultSectionRole: 'identity',
    previewView: 'snapshot',
  },
  {
    id: 'company_financials',
    taskContractIds: ['finance.company-research.v1'],
    upstreamComponents: [
      'EntityIncomeDistributionPanel',
      'EntityProfitabilityPanel',
      'EntityRevenueChart',
      'EntityPeBandChart',
    ],
    allowedCardKinds: ['metric_strip', 'timeseries', 'data_table', 'ranked_list'],
    reportSectionRoles: ['financials'],
    defaultSectionRole: 'financials',
    previewView: 'financials',
  },
  {
    id: 'company_events_risks',
    taskContractIds: ['finance.company-research.v1'],
    upstreamComponents: ['EntityStockEventsPanel', 'EntityStockNewsPanel', 'EntityRiskPanel'],
    allowedCardKinds: ['ranked_list', 'evidence_list'],
    reportSectionRoles: ['events', 'risks'],
    defaultSectionRole: 'events',
    previewView: 'events',
  },
  {
    id: 'simulation_policy',
    taskContractIds: ['finance.simulated-portfolio.v1'],
    upstreamComponents: ['FolioInlineConfig', 'FolioLockableField', 'FolioDatePicker'],
    allowedCardKinds: ['metric_strip', 'data_table'],
    reportSectionRoles: ['simulation_policy'],
    defaultSectionRole: 'simulation_policy',
    previewView: 'policy',
  },
  {
    id: 'simulation_performance',
    taskContractIds: ['finance.simulated-portfolio.v1'],
    upstreamComponents: ['FolioNavCurveChart', 'FolioHeadlineMetrics', 'FolioReturnAttributionPanel'],
    allowedCardKinds: ['metric_strip', 'timeseries', 'ranked_list'],
    reportSectionRoles: ['performance'],
    defaultSectionRole: 'performance',
    previewView: 'performance',
  },
  {
    id: 'simulation_holdings',
    taskContractIds: ['finance.simulated-portfolio.v1'],
    upstreamComponents: ['FolioHoldingsPanel', 'FolioHoldingNameCell', 'FolioMarketLabel'],
    allowedCardKinds: ['data_table'],
    reportSectionRoles: ['holdings'],
    defaultSectionRole: 'holdings',
    previewView: 'holdings',
  },
  {
    id: 'simulation_risk',
    taskContractIds: ['finance.simulated-portfolio.v1'],
    upstreamComponents: ['FolioRiskMetrics', 'FolioRiskExposurePanel', 'FolioSectorAllocationPanel'],
    allowedCardKinds: ['metric_strip', 'ranked_list', 'data_table'],
    reportSectionRoles: ['risk'],
    defaultSectionRole: 'risk',
    previewView: 'risk',
  },
  {
    id: 'holdings_diagnosis',
    taskContractIds: ['finance.holdings-diagnosis.v1'],
    upstreamComponents: ['FolioHoldingsPanel', 'FolioRiskExposurePanel', 'FolioSectorAllocationPanel'],
    allowedCardKinds: ['metric_strip', 'data_table', 'ranked_list', 'evidence_list'],
    reportSectionRoles: ['holdings', 'exposure', 'risks', 'data_gaps'],
    defaultSectionRole: 'holdings',
    previewView: 'diagnosis',
  },
  {
    id: 'monitor_status',
    taskContractIds: ['finance.monitor.v1'],
    upstreamComponents: ['AgentStatusPanel', 'AgentActivityTimeline', 'AgentEvalHints'],
    allowedCardKinds: ['metric_strip', 'ranked_list', 'evidence_list'],
    reportSectionRoles: ['policy', 'latest_changes', 'runs', 'errors'],
    defaultSectionRole: 'latest_changes',
    previewView: 'latest_changes',
  },
  {
    id: 'factor_research_result',
    taskContractIds: ['finance.factor-research.v1'],
    upstreamComponents: ['AgentVizPanel'],
    allowedCardKinds: ['metric_strip', 'timeseries', 'data_table', 'ranked_list', 'evidence_list'],
    reportSectionRoles: ['protocol', 'result', 'robustness', 'leakage_checks', 'evidence'],
    defaultSectionRole: 'result',
    previewView: 'overview',
  },
  {
    id: 'provenance_and_limitations',
    taskContractIds: [
      'finance.market-theme.v1',
      'finance.news-impact.v1',
      'finance.company-research.v1',
      'finance.simulated-portfolio.v1',
      'finance.holdings-diagnosis.v1',
      'finance.monitor.v1',
      'finance.factor-research.v1',
    ],
    upstreamComponents: ['AgentEvalHints', 'AgentSessionInputsPanel', 'AgentSessionOutputsPanel'],
    allowedCardKinds: ['evidence_list', 'ranked_list', 'data_table'],
    reportSectionRoles: ['evidence', 'limitations', 'data_gaps', 'errors'],
    defaultSectionRole: 'limitations',
    previewView: 'evidence',
  },
];

export const FINANCE_REPORT_MODULE_IDS = FINANCE_REPORT_MODULE_REGISTRY.map(
  (module) => module.id
) as FinanceReportModuleId[];

export const getFinanceReportModule = (id: FinanceReportModuleId): FinanceReportModuleDefinition | undefined =>
  FINANCE_REPORT_MODULE_REGISTRY.find((module) => module.id === id);

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const isoTimestamp = z.string().datetime({ offset: true });
const finiteNumber = z.number().finite();
const financeReportModuleIdSchema = z.enum(
  FINANCE_REPORT_MODULE_IDS as [FinanceReportModuleId, ...FinanceReportModuleId[]]
);
const uniqueStrings = (maxItems: number, maxLength = 160) =>
  z
    .array(boundedString(maxLength))
    .max(maxItems)
    .superRefine((items, context) => {
      if (new Set(items).size !== items.length)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be unique' });
    });

const previewTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('financial_research'),
      artifactId: boundedString(160),
      view: boundedString(80).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('science_factor'), artifactId: boundedString(160) }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: boundedString(160) }).strict(),
  z.object({ kind: z.literal('evidence'), evidenceId: boundedString(160) }).strict(),
]);

const cardBase = z.object({
  schema: z.literal(STRUCTURED_REPORT_CARD_SCHEMA),
  id: boundedString(120),
  title: boundedString(160),
  snapshotId: boundedString(160),
  artifactRef: financeArtifactRefSchema,
  evidenceIds: uniqueStrings(24),
  refreshedAt: isoTimestamp,
  lifecycle: z.enum(['loading', 'ready', 'empty', 'error', 'unsupported']),
  freshness: z.enum(['current', 'stale', 'no_change']),
  completeness: z.enum(['complete', 'partial']),
  dataMode: z.enum(['HISTORICAL', 'SIMULATION', 'LIVE_READ_ONLY']),
  tradeCapability: z.literal('disabled'),
  previewTarget: previewTargetSchema,
  moduleId: financeReportModuleIdSchema.optional(),
  reportSectionRole: boundedString(80).optional(),
  statusReason: boundedString(300).optional(),
  capability: z
    .object({ reason: boundedString(300) })
    .strict()
    .optional(),
  previousSnapshotId: boundedString(160).optional(),
  checkedAt: isoTimestamp.optional(),
  simulationAssumptionsArtifactRef: financeArtifactRefSchema.optional(),
});

const metricStripCardSchema = cardBase.extend({
  kind: z.literal('metric_strip'),
  metrics: z
    .array(
      z
        .object({
          id: boundedString(80),
          label: boundedString(80),
          value: z.union([finiteNumber, boundedString(120)]),
          unit: boundedString(32).optional(),
          change: finiteNumber.optional(),
          direction: z.enum(['up', 'down', 'flat', 'neutral']).optional(),
        })
        .strict()
    )
    .min(1)
    .max(4),
});

const timeseriesCardSchema = cardBase.extend({
  kind: z.literal('timeseries'),
  visualization: z.enum(['line', 'sparkline']).optional(),
  xLabel: boundedString(80).optional(),
  yLabel: boundedString(80).optional(),
  series: z
    .array(
      z
        .object({
          id: boundedString(80),
          label: boundedString(80),
          unit: boundedString(32).optional(),
          points: z
            .array(z.object({ x: z.union([isoTimestamp, finiteNumber]), y: finiteNumber }).strict())
            .min(1)
            .max(24),
        })
        .strict()
    )
    .min(1)
    .max(4),
});

const tableCellSchema = z.union([boundedString(200), finiteNumber, z.boolean(), z.null()]);
const dataTableCardSchema = cardBase.extend({
  kind: z.literal('data_table'),
  visualization: z.enum(['table', 'treemap', 'candlestick']).optional(),
  pageSize: z.number().int().min(1).max(MAX_STRUCTURED_REPORT_PAGE_SIZE).optional(),
  columns: z
    .array(z.object({ key: boundedString(80), label: boundedString(80), unit: boundedString(32).optional() }).strict())
    .min(1)
    .max(8),
  rows: z.array(z.record(tableCellSchema)).max(MAX_STRUCTURED_REPORT_CARD_ROWS),
});

const rankedListCardSchema = cardBase.extend({
  kind: z.literal('ranked_list'),
  visualization: z.enum(['ranked_list', 'hbar_rank', 'donut']).optional(),
  pageSize: z.number().int().min(1).max(MAX_STRUCTURED_REPORT_PAGE_SIZE).optional(),
  items: z
    .array(
      z
        .object({
          id: boundedString(120),
          rank: z.number().int().positive(),
          label: boundedString(160),
          value: z.union([finiteNumber, boundedString(120)]).optional(),
          detail: boundedString(300).optional(),
          evidenceIds: uniqueStrings(8).optional(),
        })
        .strict()
    )
    .max(MAX_STRUCTURED_REPORT_CARD_ROWS),
});

const evidenceListCardSchema = cardBase.extend({
  kind: z.literal('evidence_list'),
  visualization: z.enum(['evidence_list', 'timeline']).optional(),
  pageSize: z.number().int().min(1).max(MAX_STRUCTURED_REPORT_PAGE_SIZE).optional(),
  items: z
    .array(
      z
        .object({
          evidenceId: boundedString(160),
          title: boundedString(240),
          source: boundedString(160),
          asOf: isoTimestamp,
          detail: boundedString(300).optional(),
        })
        .strict()
    )
    .max(MAX_STRUCTURED_REPORT_CARD_ROWS),
});

export const structuredReportCardSchema = z
  .discriminatedUnion('kind', [
    metricStripCardSchema,
    timeseriesCardSchema,
    dataTableCardSchema,
    rankedListCardSchema,
    evidenceListCardSchema,
  ])
  .superRefine((card, context) => {
    const module = card.moduleId ? getFinanceReportModule(card.moduleId) : undefined;
    if (module && !module.allowedCardKinds.includes(card.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['moduleId'],
        message: `${card.moduleId} does not allow ${card.kind}`,
      });
    }
    if (module && card.reportSectionRole && !module.reportSectionRoles.includes(card.reportSectionRole)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reportSectionRole'],
        message: `${card.moduleId} cannot be placed in ${card.reportSectionRole}`,
      });
    }
    if (card.kind === 'data_table') {
      const keys = card.columns.map((column) => column.key);
      if (new Set(keys).size !== keys.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['columns'], message: 'column keys must be unique' });
      }
      const allowed = new Set(keys);
      card.rows.forEach((row, rowIndex) => {
        const unknownKey = Object.keys(row).find((key) => !allowed.has(key));
        if (unknownKey) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rows', rowIndex, unknownKey],
            message: 'row key is not declared by columns',
          });
        }
      });
    }
    if (
      card.lifecycle === 'ready' &&
      ((card.kind === 'data_table' && card.rows.length === 0) ||
        (card.kind === 'ranked_list' && card.items.length === 0) ||
        (card.kind === 'evidence_list' && card.items.length === 0))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [card.kind === 'data_table' ? 'rows' : 'items'],
        message: 'ready cards require at least one visible item',
      });
    }
    if (card.lifecycle === 'unsupported' && !card.capability?.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: 'unsupported cards require a visible capability reason',
      });
    }
    if (card.freshness === 'no_change' && (!card.previousSnapshotId || !card.checkedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness'],
        message: 'no_change requires previousSnapshotId and checkedAt',
      });
    }
    if (card.dataMode === 'SIMULATION' && !card.simulationAssumptionsArtifactRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['simulationAssumptionsArtifactRef'],
        message: 'simulation cards require an assumptions artifact',
      });
    }
  });

export type StructuredReportCard = z.infer<typeof structuredReportCardSchema>;

const STRUCTURED_REPORT_CHART_VISUALIZATIONS = new Set([
  'line',
  'sparkline',
  'treemap',
  'candlestick',
  'hbar_rank',
  'donut',
  'timeline',
]);

export const isStructuredReportChartCard = (card: StructuredReportCard | undefined): boolean => {
  if (!card || card.lifecycle === 'empty' || card.lifecycle === 'error' || card.lifecycle === 'unsupported') {
    return false;
  }
  if (card.kind === 'timeseries') return true;
  return 'visualization' in card && STRUCTURED_REPORT_CHART_VISUALIZATIONS.has(card.visualization || '');
};

const cardDraftBase = z.object({
  id: boundedString(120),
  title: boundedString(160),
  moduleId: financeReportModuleIdSchema.optional(),
  reportSectionRole: boundedString(80).optional(),
  view: boundedString(80).optional(),
  evidenceIds: uniqueStrings(24).optional(),
  lifecycle: z.enum(['ready', 'empty', 'error']).optional(),
  freshness: z.enum(['current', 'stale']).optional(),
  completeness: z.enum(['complete', 'partial']).optional(),
  statusReason: boundedString(300).optional(),
});

export const structuredReportCardDraftSchema = z.discriminatedUnion('kind', [
  cardDraftBase.extend({
    kind: z.literal('metric_strip'),
    metrics: metricStripCardSchema.shape.metrics,
  }),
  cardDraftBase.extend({
    kind: z.literal('timeseries'),
    visualization: timeseriesCardSchema.shape.visualization,
    xLabel: timeseriesCardSchema.shape.xLabel,
    yLabel: timeseriesCardSchema.shape.yLabel,
    series: timeseriesCardSchema.shape.series,
  }),
  cardDraftBase.extend({
    kind: z.literal('data_table'),
    visualization: dataTableCardSchema.shape.visualization,
    pageSize: dataTableCardSchema.shape.pageSize,
    columns: dataTableCardSchema.shape.columns,
    rows: dataTableCardSchema.shape.rows,
  }),
  cardDraftBase.extend({
    kind: z.literal('ranked_list'),
    visualization: rankedListCardSchema.shape.visualization,
    pageSize: rankedListCardSchema.shape.pageSize,
    items: rankedListCardSchema.shape.items,
  }),
  cardDraftBase.extend({
    kind: z.literal('evidence_list'),
    visualization: evidenceListCardSchema.shape.visualization,
    pageSize: evidenceListCardSchema.shape.pageSize,
    items: evidenceListCardSchema.shape.items.optional(),
  }),
]);

export type StructuredReportCardDraft = z.infer<typeof structuredReportCardDraftSchema>;

export type StructuredReportCardDraftEvidence = {
  evidenceId: string;
  title: string;
  source: string;
  asOf: string;
  detail?: string;
};

export type StructuredReportCardDraftContext = {
  artifactRef: FinanceArtifactRef;
  snapshotId: string;
  refreshedAt: string;
  dataMode: FinanceDataMode;
  completeness?: 'complete' | 'partial';
  evidence: StructuredReportCardDraftEvidence[];
  simulationAssumptionsArtifactRef?: FinanceArtifactRef;
};

const draftEvidenceItems = (
  items: StructuredReportCardDraftEvidence[] | undefined,
  context: StructuredReportCardDraftContext,
  evidenceIds: string[]
): Array<{ evidenceId: string; title: string; source: string; asOf: string; detail?: string }> => {
  if (items) return items;
  const allowed = new Set(evidenceIds);
  return context.evidence.filter((item) => allowed.has(item.evidenceId));
};

export const materializeStructuredReportCardDrafts = (
  value: unknown,
  context: StructuredReportCardDraftContext
): StructuredReportCardCollectionResult => {
  if (!Array.isArray(value)) return { ok: false, cards: [], errors: ['cardDrafts must be an array'] };
  if (value.length > MAX_STRUCTURED_REPORT_CARDS) {
    return { ok: false, cards: [], errors: [`cardDrafts cannot exceed ${MAX_STRUCTURED_REPORT_CARDS} items`] };
  }

  const parsedDrafts: StructuredReportCardDraft[] = [];
  const draftErrors: string[] = [];
  value.forEach((candidate, index) => {
    const parsed = structuredReportCardDraftSchema.safeParse(candidate);
    if (parsed.success) parsedDrafts.push(parsed.data);
    else draftErrors.push(`cardDrafts[${index}]: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  });
  if (draftErrors.length) return { ok: false, cards: [], errors: draftErrors };

  const defaultEvidenceIds = context.evidence.map((item) => item.evidenceId).slice(0, 24);
  const cards: unknown[] = [];
  for (const draft of parsedDrafts) {
    const evidenceIds = draft.evidenceIds ?? defaultEvidenceIds;
    const reportModule = draft.moduleId ? getFinanceReportModule(draft.moduleId) : undefined;
    const base = {
      schema: STRUCTURED_REPORT_CARD_SCHEMA,
      id: draft.id,
      title: draft.title,
      ...(draft.moduleId ? { moduleId: draft.moduleId } : {}),
      ...(draft.reportSectionRole || reportModule?.defaultSectionRole
        ? { reportSectionRole: draft.reportSectionRole || reportModule?.defaultSectionRole }
        : {}),
      snapshotId: context.snapshotId,
      artifactRef: context.artifactRef,
      evidenceIds,
      refreshedAt: context.refreshedAt,
      lifecycle: draft.lifecycle ?? 'ready',
      freshness: draft.freshness ?? 'current',
      completeness: draft.completeness ?? context.completeness ?? 'complete',
      dataMode: context.dataMode,
      tradeCapability: 'disabled' as const,
      previewTarget: {
        kind: 'financial_research' as const,
        artifactId: context.artifactRef.artifactId,
        ...(draft.view ? { view: draft.view } : {}),
      },
      ...(draft.statusReason ? { statusReason: draft.statusReason } : {}),
      ...(context.simulationAssumptionsArtifactRef
        ? { simulationAssumptionsArtifactRef: context.simulationAssumptionsArtifactRef }
        : {}),
    };
    if (draft.kind === 'metric_strip') {
      cards.push({ ...base, kind: draft.kind, metrics: draft.metrics });
      continue;
    }
    if (draft.kind === 'timeseries') {
      cards.push({
        ...base,
        kind: draft.kind,
        visualization: draft.visualization,
        xLabel: draft.xLabel,
        yLabel: draft.yLabel,
        series: draft.series,
      });
      continue;
    }
    if (draft.kind === 'data_table') {
      cards.push({
        ...base,
        kind: draft.kind,
        visualization: draft.visualization,
        pageSize: draft.pageSize,
        columns: draft.columns,
        rows: draft.rows,
      });
      continue;
    }
    if (draft.kind === 'ranked_list') {
      cards.push({
        ...base,
        kind: draft.kind,
        visualization: draft.visualization,
        pageSize: draft.pageSize,
        items: draft.items,
      });
      continue;
    }
    cards.push({
      ...base,
      kind: draft.kind,
      visualization: draft.visualization,
      pageSize: draft.pageSize,
      items: draftEvidenceItems(draft.items as StructuredReportCardDraftEvidence[] | undefined, context, evidenceIds),
    });
  }

  return validateStructuredReportCards(cards, {
    artifactRefs: new Set([artifactRefKey(context.artifactRef.artifactId, context.artifactRef.version)]),
    evidenceIds: new Set(context.evidence.map((item) => item.evidenceId)),
  });
};

export type StructuredReportCardCollectionContext = {
  artifactRefs?: ReadonlySet<string>;
  evidenceIds?: ReadonlySet<string>;
};

export type StructuredReportCardCollectionResult =
  { ok: true; cards: StructuredReportCard[] } | { ok: false; cards: StructuredReportCard[]; errors: string[] };

const artifactRefKey = (artifactId: string, version: number): string => `${artifactId}@${version}`;

export function validateStructuredReportCards(
  value: unknown,
  context: StructuredReportCardCollectionContext = {}
): StructuredReportCardCollectionResult {
  if (!Array.isArray(value)) return { ok: false, cards: [], errors: ['cards must be an array'] };
  if (value.length > MAX_STRUCTURED_REPORT_CARDS) {
    return { ok: false, cards: [], errors: [`cards cannot exceed ${MAX_STRUCTURED_REPORT_CARDS} items`] };
  }

  const cards: StructuredReportCard[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  value.forEach((candidate, index) => {
    const parsed = structuredReportCardSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(`cards[${index}]: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      return;
    }
    if (ids.has(parsed.data.id)) {
      errors.push(`cards[${index}]: duplicate card id ${parsed.data.id}`);
      return;
    }
    ids.add(parsed.data.id);
    const cardErrors: string[] = [];
    if (
      context.artifactRefs &&
      !context.artifactRefs.has(artifactRefKey(parsed.data.artifactRef.artifactId, parsed.data.artifactRef.version))
    ) {
      cardErrors.push(
        `cards[${index}]: unknown artifact ${artifactRefKey(parsed.data.artifactRef.artifactId, parsed.data.artifactRef.version)}`
      );
    }
    const linkedArtifactRefs = [
      parsed.data.simulationAssumptionsArtifactRef,
      parsed.data.previewTarget.kind === 'artifact' ||
      parsed.data.previewTarget.kind === 'science_factor' ||
      parsed.data.previewTarget.kind === 'financial_research'
        ? { artifactId: parsed.data.previewTarget.artifactId, version: parsed.data.artifactRef.version }
        : undefined,
    ].filter((ref): ref is { artifactId: string; version: number } => Boolean(ref));
    linkedArtifactRefs.forEach((ref) => {
      if (context.artifactRefs && !context.artifactRefs.has(artifactRefKey(ref.artifactId, ref.version))) {
        cardErrors.push(`cards[${index}]: unknown linked artifact ${artifactRefKey(ref.artifactId, ref.version)}`);
      }
    });
    const linkedEvidenceIds = [
      ...parsed.data.evidenceIds,
      ...(parsed.data.kind === 'ranked_list'
        ? parsed.data.items.flatMap((item) => item.evidenceIds ?? [])
        : parsed.data.kind === 'evidence_list'
          ? parsed.data.items.map((item) => item.evidenceId)
          : []),
      ...(parsed.data.previewTarget.kind === 'evidence' ? [parsed.data.previewTarget.evidenceId] : []),
    ];
    const missingEvidence = linkedEvidenceIds.find((evidenceId) => !context.evidenceIds?.has(evidenceId));
    if (context.evidenceIds && missingEvidence) {
      cardErrors.push(`cards[${index}]: unknown evidence ${missingEvidence}`);
    }
    errors.push(...cardErrors);
    if (!cardErrors.length) cards.push(parsed.data);
  });
  return errors.length ? { ok: false, cards, errors } : { ok: true, cards };
}

export const isStructuredReportCardKind = (value: string): value is StructuredReportCardKind =>
  ['metric_strip', 'timeseries', 'data_table', 'ranked_list', 'evidence_list'].includes(value);

const REPORT_SUGGESTIONS: Record<FinanceToolName, FinanceReportSuggestion[]> = {
  finance_market_overview: [
    {
      id: 'market-overview-metrics',
      moduleId: 'market_status',
      reportSectionRole: 'market_status',
      cardKind: 'metric_strip',
      visualization: 'metric_strip',
      preferredView: 'overview',
      purpose: 'Summarize the most decision-relevant market levels and changes; split into several cards when needed.',
      maxItems: 4,
    },
    {
      id: 'market-overview-table',
      moduleId: 'market_status',
      reportSectionRole: 'market_status',
      cardKind: 'data_table',
      visualization: 'table',
      preferredView: 'markets',
      purpose: 'Preserve a comparable cross-market index snapshot without forcing every index into the report summary.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_sector_search: [
    {
      id: 'sector-taxonomy-ranking',
      moduleId: 'market_theme_ranking',
      reportSectionRole: 'themes',
      cardKind: 'ranked_list',
      visualization: 'ranked_list',
      preferredView: 'themes',
      purpose: 'Explain the canonical sector matches used to bound later screening.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_sector_movers: [
    {
      id: 'sector-movers-treemap',
      moduleId: 'market_theme_ranking',
      reportSectionRole: 'themes',
      cardKind: 'data_table',
      visualization: 'treemap',
      preferredView: 'sectors',
      purpose: 'Compare sector direction and breadth as a treemap when enough comparable sectors are available.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'sector-movers-ranking',
      moduleId: 'market_theme_ranking',
      reportSectionRole: 'themes',
      cardKind: 'ranked_list',
      visualization: 'hbar_rank',
      preferredView: 'themes',
      purpose: 'Rank comparable sector changes when a bar view is clearer than a full treemap.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_security_screen: [
    {
      id: 'security-candidate-table',
      moduleId: 'market_theme_ranking',
      reportSectionRole: 'themes',
      cardKind: 'data_table',
      visualization: 'table',
      preferredView: 'themes',
      purpose: 'Show bounded research candidates with the fields that explain why each security was selected.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_security_snapshot: [
    {
      id: 'company-snapshot-metrics',
      moduleId: 'company_snapshot',
      reportSectionRole: 'identity',
      cardKind: 'metric_strip',
      visualization: 'metric_strip',
      preferredView: 'snapshot',
      purpose: 'Select up to four comparable headline quote, valuation, scale, or quality metrics.',
      maxItems: 4,
    },
    {
      id: 'company-financials-table',
      moduleId: 'company_financials',
      reportSectionRole: 'financials',
      cardKind: 'data_table',
      visualization: 'table',
      preferredView: 'financials',
      purpose: 'Compare only the financial periods and fields needed for the current company question.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_news_events: [
    {
      id: 'news-event-timeline',
      moduleId: 'company_events_risks',
      reportSectionRole: 'events',
      cardKind: 'evidence_list',
      visualization: 'timeline',
      preferredView: 'events',
      purpose: 'Place verified events in time order while keeping every event linked to registered evidence.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'event-impact-timeline',
      moduleId: 'event_impact_chain',
      reportSectionRole: 'event_facts',
      cardKind: 'evidence_list',
      visualization: 'timeline',
      preferredView: 'timeline',
      purpose: 'Order the verified event facts before presenting inferred impact paths.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'market-evidence-timeline',
      moduleId: 'provenance_and_limitations',
      reportSectionRole: 'evidence',
      cardKind: 'evidence_list',
      visualization: 'timeline',
      preferredView: 'evidence',
      purpose: 'Keep dated catalysts and counterevidence visible in a market-theme report.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_price_series: [
    {
      id: 'price-confirmation-series',
      moduleId: 'company_snapshot',
      reportSectionRole: 'price',
      cardKind: 'timeseries',
      visualization: 'line',
      preferredView: 'price_confirmation',
      purpose: 'Plot only the price window that tests a stated theme, event, or company claim.',
      maxItems: 24,
    },
    {
      id: 'company-price-candlestick',
      moduleId: 'company_snapshot',
      reportSectionRole: 'price',
      cardKind: 'data_table',
      visualization: 'candlestick',
      preferredView: 'price',
      purpose: 'Show a bounded OHLC window when open, high, low, and close values are all available.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'event-price-confirmation',
      moduleId: 'event_impact_chain',
      reportSectionRole: 'price_confirmation',
      cardKind: 'timeseries',
      visualization: 'line',
      preferredView: 'price_confirmation',
      purpose: 'Compare the event window with a declared benchmark without implying causality.',
      maxItems: 24,
    },
    {
      id: 'portfolio-performance-series',
      moduleId: 'simulation_performance',
      reportSectionRole: 'performance',
      cardKind: 'timeseries',
      visualization: 'line',
      preferredView: 'performance',
      purpose: 'Compare simulated NAV, benchmark, or drawdown series under the declared protocol.',
      maxItems: 24,
    },
  ],
  finance_relationship_map: [
    {
      id: 'event-impact-ranking',
      moduleId: 'event_impact_chain',
      reportSectionRole: 'impact_paths',
      cardKind: 'ranked_list',
      visualization: 'ranked_list',
      preferredView: 'impact',
      purpose: 'Summarize the strongest evidence-linked impact paths; keep the complete graph in its Artifact view.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_research_portfolio: [
    {
      id: 'portfolio-holdings-table',
      moduleId: 'simulation_holdings',
      reportSectionRole: 'holdings',
      cardKind: 'data_table',
      visualization: 'table',
      preferredView: 'holdings',
      purpose: 'Show the simulated or watchlist positions and declared weights without implying a live account.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'portfolio-headline-metrics',
      moduleId: 'simulation_performance',
      reportSectionRole: 'performance',
      cardKind: 'metric_strip',
      visualization: 'metric_strip',
      preferredView: 'performance',
      purpose: 'Show up to four simulated return and risk metrics with the benchmark and protocol kept explicit.',
      maxItems: 4,
    },
    {
      id: 'portfolio-sector-allocation',
      moduleId: 'simulation_risk',
      reportSectionRole: 'risk',
      cardKind: 'ranked_list',
      visualization: 'donut',
      preferredView: 'risk',
      purpose: 'Show non-negative sector, market, or currency allocation shares when they sum to a meaningful whole.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
    {
      id: 'portfolio-risk-exposure',
      moduleId: 'simulation_risk',
      reportSectionRole: 'risk',
      cardKind: 'ranked_list',
      visualization: 'hbar_rank',
      preferredView: 'risk',
      purpose: 'Compare numeric concentration, factor, market, or attribution contributions on one scale.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
  finance_holdings_parse: [
    {
      id: 'holdings-diagnosis-table',
      moduleId: 'holdings_diagnosis',
      reportSectionRole: 'holdings',
      cardKind: 'data_table',
      visualization: 'table',
      preferredView: 'diagnosis',
      purpose: 'Show redacted parsed holdings and confidence fields, with low-confidence rows kept visible.',
      maxItems: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    },
  ],
};

export const buildFinanceReportSuggestions = (toolName: FinanceToolName): FinanceReportSuggestion[] =>
  REPORT_SUGGESTIONS[toolName].map((suggestion) => Object.assign({}, suggestion));

export const buildStructuredReportCardAuthoringGuide = (
  context?: StructuredReportCardDraftContext,
  taskContractId?: FinanceTaskContractId
) => {
  const evidenceIds = context?.evidence.map((item) => item.evidenceId).slice(0, 24) ?? [];
  const reportModules = FINANCE_REPORT_MODULE_REGISTRY.filter(
    (module) => !taskContractId || module.taskContractIds.includes(taskContractId)
  );
  const templateModuleId = (kind: StructuredReportCardKind): FinanceReportModuleId | undefined =>
    reportModules.find((module) => module.allowedCardKinds.includes(kind))?.id;
  return {
    schema: 'deepscientist.report_card_authoring_guide.v1',
    strategy: 'agent_selected',
    draftPlacement: 'science_artifact.payload.cardDrafts',
    exactCardPlacement: 'science_artifact.payload.cards',
    maxCards: MAX_STRUCTURED_REPORT_CARDS,
    maxStoredItemsPerList: MAX_STRUCTURED_REPORT_CARD_ROWS,
    pageSize: MAX_STRUCTURED_REPORT_PAGE_SIZE,
    reportIntegration: {
      moduleField: 'cardDrafts[].moduleId',
      sectionField: 'cardDrafts[].reportSectionRole',
      behavior:
        'The server inserts one card_ref into the matching report section when moduleId or reportSectionRole resolves a placement. Otherwise the explicit report must contain the card_ref.',
      validation: 'Only cards referenced by report sections satisfy Finance completion card requirements.',
    },
    reportModules: reportModules.map((module) => ({
      id: module.id,
      upstreamComponents: module.upstreamComponents,
      allowedCardKinds: module.allowedCardKinds,
      reportSectionRoles: module.reportSectionRoles,
      defaultSectionRole: module.defaultSectionRole,
      previewView: module.previewView,
    })),
    rules: [
      'Author the report around the user question before choosing cards: executive answer, scope/asOf, key metrics, lead visual, drivers or scenarios, risks/invalidation, next actions, then sources. Cards support this reading path; they do not replace the narrative answer.',
      'Make an explicit visual delivery decision before publish. When verified structured values support comparison, trend, distribution, interval, exposure, or scenario analysis, choose the smallest useful chart-card set and place the lead visual before long evidence detail.',
      'Aim for two to four visual modules only when they answer distinct reader questions. When no meaningful visual data exists, pass the reason only as payload.internalVisualWaiverReason; it is private validation metadata and must not appear in the report or final reply.',
      'Use cardDrafts unless exact versioned card fields are already available. The server fills provenance and preview fields.',
      'Set moduleId on every finance card draft. Override reportSectionRole only when the module permits that role.',
      'Never copy example labels or values. Replace them with verified tool results and registered evidence.',
      'Give each chart/card a distinct reader question and a one-sentence interpretation. Include units, denominator, period/asOf, and evidence ids; keep raw rows and tool diagnostics in the expandable detail view.',
      'Use candlestick only for validated OHLC rows, donut only for non-negative shares, treemap only for comparable categories, timeline only for dated evidence, and timeseries only for real points.',
      'Keep at most 20 candidates on one page. Additional rows remain available through pagination.',
    ],
    availableVisualizations: {
      metric_strip: ['metric_strip'],
      timeseries: ['line', 'sparkline'],
      data_table: ['table', 'treemap', 'candlestick'],
      ranked_list: ['ranked_list', 'hbar_rank', 'donut'],
      evidence_list: ['evidence_list', 'timeline'],
    },
    visualizationDataContracts: {
      treemap: {
        requiredRowFields: ['label (or name, sector, theme, symbol)', 'changePct (or change, returnPct)'],
        optionalRowFields: ['market (or region)', 'size (or marketCap, weight, breadthPct)'],
      },
      hbar_rank: { requiredItemFields: ['label', 'finite numeric value'] },
      donut: {
        requiredItemFields: ['label', 'finite non-negative value'],
        constraint: 'sum must be greater than zero',
      },
      candlestick: {
        requiredRowFields: ['date (or x)', 'open', 'close', 'low', 'high'],
        constraint: 'low <= open/close <= high',
      },
      timeline: { source: 'registered Evidence', requiredFields: ['title', 'source', 'asOf'] },
      line: { requiredFields: ['series[].label', 'series[].points[].x', 'series[].points[].y'] },
    },
    resolvedContext: context
      ? {
          artifactRef: context.artifactRef,
          snapshotId: context.snapshotId,
          refreshedAt: context.refreshedAt,
          dataMode: context.dataMode,
          evidenceIds,
        }
      : undefined,
    draftTemplates: {
      metric_strip: {
        id: 'stable-metric-card-id',
        kind: 'metric_strip',
        moduleId: templateModuleId('metric_strip'),
        title: 'Replace with an evidence-backed title',
        view: 'overview',
        evidenceIds,
        metrics: [{ id: 'stable-metric-id', label: 'Replace label', value: 'Replace verified value' }],
      },
      timeseries: {
        id: 'stable-series-card-id',
        kind: 'timeseries',
        moduleId: templateModuleId('timeseries'),
        title: 'Replace with an evidence-backed title',
        view: 'price',
        visualization: 'line',
        evidenceIds,
        series: [{ id: 'stable-series-id', label: 'Replace label', points: [{ x: 0, y: 0 }] }],
      },
      data_table: {
        id: 'stable-table-card-id',
        kind: 'data_table',
        moduleId: templateModuleId('data_table'),
        title: 'Replace with an evidence-backed title',
        view: 'themes',
        visualization: 'table',
        pageSize: MAX_STRUCTURED_REPORT_PAGE_SIZE,
        evidenceIds,
        columns: [{ key: 'label', label: 'Replace column label' }],
        rows: [{ label: 'Replace with a verified row' }],
      },
      ranked_list: {
        id: 'stable-ranking-card-id',
        kind: 'ranked_list',
        moduleId: templateModuleId('ranked_list'),
        title: 'Replace with an evidence-backed title',
        view: 'themes',
        visualization: 'ranked_list',
        pageSize: MAX_STRUCTURED_REPORT_PAGE_SIZE,
        evidenceIds,
        items: [{ id: 'stable-item-id', rank: 1, label: 'Replace with a verified item' }],
      },
      evidence_list: {
        id: 'stable-evidence-card-id',
        kind: 'evidence_list',
        moduleId: templateModuleId('evidence_list'),
        title: 'Evidence and counterevidence',
        view: 'evidence',
        visualization: 'evidence_list',
        evidenceIds,
      },
    },
  };
};
