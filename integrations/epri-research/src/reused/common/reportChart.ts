import { z } from 'zod';

export const REPORT_CHART_SCHEMA_V1 = 'deepscientist.report_chart.v1' as const;
export const REPORT_CHART_SCHEMA_V2 = 'deepscientist.report_chart.v2' as const;

/**
 * Compatibility alias for persisted v1 charts and callers that have not yet
 * migrated. New chart producers should use REPORT_CHART_CURRENT_SCHEMA.
 */
export const REPORT_CHART_SCHEMA = REPORT_CHART_SCHEMA_V1;
export const REPORT_CHART_CURRENT_SCHEMA = REPORT_CHART_SCHEMA_V2;

export const REPORT_CHART_PALETTES = ['auto', 'mono', 'nature'] as const;
export const REPORT_CHART_V1_KINDS = ['bar', 'line', 'interval', 'scatter', 'matrix'] as const;
export const REPORT_CHART_V2_KINDS = [
  'bar',
  'line',
  'pair',
  'distribution',
  'composition',
  'flow',
  'timeline',
  'hierarchy',
  'scale',
  'sequence',
] as const;
export const REPORT_CHART_KINDS = [
  'bar',
  'line',
  'interval',
  'scatter',
  'matrix',
  'pair',
  'distribution',
  'composition',
  'flow',
  'timeline',
  'hierarchy',
  'scale',
  'sequence',
] as const;

export const REPORT_CHART_V1_BAR_RECIPES = ['bar.ranked', 'bar.rung', 'bar.diverging'] as const;
export const REPORT_CHART_V1_LINE_RECIPES = ['line.direct', 'line.hairline', 'line.uncertainty-band'] as const;
export const REPORT_CHART_INTERVAL_RECIPES = ['interval.forest', 'interval.range-capsule'] as const;
export const REPORT_CHART_SCATTER_RECIPES = ['scatter.quadrant', 'scatter.jitter'] as const;
export const REPORT_CHART_MATRIX_RECIPES = ['matrix.claim-matrix', 'matrix.punchcard', 'matrix.heatmap'] as const;
export const REPORT_CHART_V2_BAR_RECIPES = ['bar.grouped', 'bar.stacked', 'bar.waterfall'] as const;
export const REPORT_CHART_V2_LINE_RECIPES = ['line.area'] as const;
export const REPORT_CHART_PAIR_RECIPES = ['pair.dumbbell'] as const;
export const REPORT_CHART_DISTRIBUTION_RECIPES = ['distribution.box'] as const;
export const REPORT_CHART_COMPOSITION_RECIPES = ['composition.waffle'] as const;
export const REPORT_CHART_FLOW_RECIPES = ['flow.funnel'] as const;
export const REPORT_CHART_TIMELINE_RECIPES = ['timeline.lineage'] as const;
export const REPORT_CHART_HIERARCHY_RECIPES = ['hierarchy.tree'] as const;
export const REPORT_CHART_SCALE_RECIPES = ['scale.bipolar'] as const;
export const REPORT_CHART_SEQUENCE_RECIPES = ['sequence.rainfall'] as const;

export const REPORT_CHART_BAR_RECIPES = [...REPORT_CHART_V1_BAR_RECIPES, ...REPORT_CHART_V2_BAR_RECIPES] as const;
export const REPORT_CHART_LINE_RECIPES = [...REPORT_CHART_V1_LINE_RECIPES, ...REPORT_CHART_V2_LINE_RECIPES] as const;

export const REPORT_CHART_V1_RECIPES_BY_KIND = {
  bar: REPORT_CHART_V1_BAR_RECIPES,
  line: REPORT_CHART_V1_LINE_RECIPES,
  interval: REPORT_CHART_INTERVAL_RECIPES,
  scatter: REPORT_CHART_SCATTER_RECIPES,
  matrix: REPORT_CHART_MATRIX_RECIPES,
} as const;

export const REPORT_CHART_V2_RECIPES_BY_KIND = {
  bar: REPORT_CHART_V2_BAR_RECIPES,
  line: REPORT_CHART_V2_LINE_RECIPES,
  pair: REPORT_CHART_PAIR_RECIPES,
  distribution: REPORT_CHART_DISTRIBUTION_RECIPES,
  composition: REPORT_CHART_COMPOSITION_RECIPES,
  flow: REPORT_CHART_FLOW_RECIPES,
  timeline: REPORT_CHART_TIMELINE_RECIPES,
  hierarchy: REPORT_CHART_HIERARCHY_RECIPES,
  scale: REPORT_CHART_SCALE_RECIPES,
  sequence: REPORT_CHART_SEQUENCE_RECIPES,
} as const;

export const REPORT_CHART_RECIPES_BY_KIND = {
  bar: REPORT_CHART_BAR_RECIPES,
  line: REPORT_CHART_LINE_RECIPES,
  interval: REPORT_CHART_INTERVAL_RECIPES,
  scatter: REPORT_CHART_SCATTER_RECIPES,
  matrix: REPORT_CHART_MATRIX_RECIPES,
  pair: REPORT_CHART_PAIR_RECIPES,
  distribution: REPORT_CHART_DISTRIBUTION_RECIPES,
  composition: REPORT_CHART_COMPOSITION_RECIPES,
  flow: REPORT_CHART_FLOW_RECIPES,
  timeline: REPORT_CHART_TIMELINE_RECIPES,
  hierarchy: REPORT_CHART_HIERARCHY_RECIPES,
  scale: REPORT_CHART_SCALE_RECIPES,
  sequence: REPORT_CHART_SEQUENCE_RECIPES,
} as const;

export const REPORT_CHART_RECIPES = [
  ...REPORT_CHART_V1_BAR_RECIPES,
  ...REPORT_CHART_V1_LINE_RECIPES,
  ...REPORT_CHART_INTERVAL_RECIPES,
  ...REPORT_CHART_SCATTER_RECIPES,
  ...REPORT_CHART_MATRIX_RECIPES,
  ...REPORT_CHART_V2_BAR_RECIPES,
  ...REPORT_CHART_V2_LINE_RECIPES,
  ...REPORT_CHART_PAIR_RECIPES,
  ...REPORT_CHART_DISTRIBUTION_RECIPES,
  ...REPORT_CHART_COMPOSITION_RECIPES,
  ...REPORT_CHART_FLOW_RECIPES,
  ...REPORT_CHART_TIMELINE_RECIPES,
  ...REPORT_CHART_HIERARCHY_RECIPES,
  ...REPORT_CHART_SCALE_RECIPES,
  ...REPORT_CHART_SEQUENCE_RECIPES,
] as const;

export const REPORT_CHART_V1_RECIPES = [
  ...REPORT_CHART_V1_BAR_RECIPES,
  ...REPORT_CHART_V1_LINE_RECIPES,
  ...REPORT_CHART_INTERVAL_RECIPES,
  ...REPORT_CHART_SCATTER_RECIPES,
  ...REPORT_CHART_MATRIX_RECIPES,
] as const;

export const REPORT_CHART_V2_RECIPES = [
  ...REPORT_CHART_V2_BAR_RECIPES,
  ...REPORT_CHART_V2_LINE_RECIPES,
  ...REPORT_CHART_PAIR_RECIPES,
  ...REPORT_CHART_DISTRIBUTION_RECIPES,
  ...REPORT_CHART_COMPOSITION_RECIPES,
  ...REPORT_CHART_FLOW_RECIPES,
  ...REPORT_CHART_TIMELINE_RECIPES,
  ...REPORT_CHART_HIERARCHY_RECIPES,
  ...REPORT_CHART_SCALE_RECIPES,
  ...REPORT_CHART_SEQUENCE_RECIPES,
] as const;

export type ReportChartRecipe = (typeof REPORT_CHART_RECIPES)[number];
export type ReportChartRecipeForKind<K extends keyof typeof REPORT_CHART_RECIPES_BY_KIND> =
  (typeof REPORT_CHART_RECIPES_BY_KIND)[K][number];

export type ReportChartRecipeCatalogEntry = {
  kind: (typeof REPORT_CHART_KINDS)[number];
  grammarId: string;
  description: string;
  useWhen: string;
  avoidWhen: string;
  requiredFields: readonly string[];
};

export const REPORT_CHART_RECIPE_CATALOG = {
  'bar.ranked': {
    kind: 'bar',
    grammarId: 'v1.bar.data',
    description: 'Compare an ordered set of categories with horizontal bars.',
    useWhen: 'Readers need a clear ranking of one value per category.',
    avoidWhen: 'Several series share each category or values encode parts of a total.',
    requiredFields: ['data[].id', 'data[].label', 'data[].value'],
  },
  'bar.rung': {
    kind: 'bar',
    grammarId: 'v1.bar.data',
    description: 'Show each value as a terminal point connected to its baseline.',
    useWhen: 'Distance from one explicit baseline is the primary reading task.',
    avoidWhen: 'Bar area or multiple series within a category must be compared.',
    requiredFields: ['data[].id', 'data[].label', 'data[].value'],
  },
  'bar.diverging': {
    kind: 'bar',
    grammarId: 'v1.bar.data',
    description: 'Compare values on both sides of a shared baseline.',
    useWhen: 'Signed values fall on both sides of a meaningful baseline.',
    avoidWhen: 'Values are non-negative components of totals or have no meaningful center.',
    requiredFields: ['baseline', 'data[].id', 'data[].label', 'data[].value'],
  },
  'line.direct': {
    kind: 'line',
    grammarId: 'v1.line.series',
    description: 'Show a sequence with direct series labels.',
    useWhen: 'A small number of supplied sequences must be followed over ordered x values.',
    avoidWhen: 'Magnitude relative to a baseline or uncertainty width is the primary reading task.',
    requiredFields: ['series[].id', 'series[].label', 'series[].points[].x', 'series[].points[].y'],
  },
  'line.hairline': {
    kind: 'line',
    grammarId: 'v1.line.series',
    description: 'Show a denser sequence with restrained thin strokes.',
    useWhen: 'Several dense sequences need shape comparison without heavy marks.',
    avoidWhen: 'Exact point inspection or uncertainty bounds carry the conclusion.',
    requiredFields: ['series[].id', 'series[].label', 'series[].points[].x', 'series[].points[].y'],
  },
  'line.uncertainty-band': {
    kind: 'line',
    grammarId: 'v1.line.uncertainty',
    description: 'Show a sequence with a supplied lower and upper uncertainty bound at every point.',
    useWhen: 'Every estimate has producer-computed lower and upper bounds.',
    avoidWhen: 'Bounds are missing, inferred, or the filled region means magnitude rather than uncertainty.',
    requiredFields: [
      'series[].id',
      'series[].label',
      'series[].points[].x',
      'series[].points[].y',
      'series[].points[].low',
      'series[].points[].high',
    ],
  },
  'interval.forest': {
    kind: 'interval',
    grammarId: 'v1.interval.data',
    description: 'Compare estimates and their uncertainty intervals.',
    useWhen: 'Independent estimates and their supplied intervals need side-by-side audit.',
    avoidWhen: 'Only ranges without a central estimate are known.',
    requiredFields: ['data[].id', 'data[].label', 'data[].low', 'data[].estimate', 'data[].high'],
  },
  'interval.range-capsule': {
    kind: 'interval',
    grammarId: 'v1.interval.data',
    description: 'Show bounded ranges as compact rounded bands.',
    useWhen: 'The bounded span is more important than precise interval-estimate comparison.',
    avoidWhen: 'Readers must compare many central estimates against a reference.',
    requiredFields: ['data[].id', 'data[].label', 'data[].low', 'data[].estimate', 'data[].high'],
  },
  'scatter.quadrant': {
    kind: 'scatter',
    grammarId: 'v1.scatter.data',
    description: 'Compare numeric points around two explicit references.',
    useWhen: 'Two meaningful references divide an XY decision space.',
    avoidWhen: 'Either reference is arbitrary or overlapping observations are the main problem.',
    requiredFields: ['xReferenceValue', 'yReferenceValue', 'data[].id', 'data[].x', 'data[].y'],
  },
  'scatter.jitter': {
    kind: 'scatter',
    grammarId: 'v1.scatter.data',
    description: 'Separate exactly overlapping numeric points visually.',
    useWhen: 'Repeated XY coordinates would otherwise hide observations.',
    avoidWhen: 'Jitter could be mistaken for measured variation without an exact-value table.',
    requiredFields: ['data[].id', 'data[].x', 'data[].y'],
  },
  'matrix.claim-matrix': {
    kind: 'matrix',
    grammarId: 'v1.matrix.status',
    description: 'Scan categorical evidence states by claim and source.',
    useWhen: 'Claims and sources form a compact categorical evidence grid.',
    avoidWhen: 'Cells carry continuous magnitudes rather than auditable statuses.',
    requiredFields: ['rows', 'columns', 'cells[].row', 'cells[].column', 'cells[].status'],
  },
  'matrix.punchcard': {
    kind: 'matrix',
    grammarId: 'v1.matrix.value',
    description: 'Compare non-negative magnitudes by circle area.',
    useWhen: 'Sparse non-negative magnitudes must be scanned across two categories.',
    avoidWhen: 'Signed values or precise small differences carry the conclusion.',
    requiredFields: ['rows', 'columns', 'cells[].row', 'cells[].column', 'cells[].value'],
  },
  'matrix.heatmap': {
    kind: 'matrix',
    grammarId: 'v1.matrix.value',
    description: 'Compare numeric cell values with a continuous tone.',
    useWhen: 'A dense rectangular grid benefits from pattern-first magnitude scanning.',
    avoidWhen: 'Exact values must be read without opening the table or the matrix is sparse.',
    requiredFields: ['rows', 'columns', 'cells[].row', 'cells[].column', 'cells[].value'],
  },
  'bar.grouped': {
    kind: 'bar',
    grammarId: 'v2.categorical-series',
    description: 'Compare several explicit series side by side within every category.',
    useWhen: 'Readers must compare methods or cohorts within the same categories.',
    avoidWhen: 'Series values are additive components of a total or category-series cells are missing.',
    requiredFields: [
      'categories[].id',
      'categories[].label',
      'series[].id',
      'series[].label',
      'values[].categoryId',
      'values[].seriesId',
      'values[].value',
    ],
  },
  'bar.stacked': {
    kind: 'bar',
    grammarId: 'v2.categorical-series',
    description: 'Compare supplied non-negative totals and their explicit components.',
    useWhen: 'Each category is an additive total with the same complete component set.',
    avoidWhen: 'Values are signed, normalized percentages, non-additive, or incomplete.',
    requiredFields: [
      'categories[].id',
      'categories[].label',
      'series[].id',
      'series[].label',
      'values[].categoryId',
      'values[].seriesId',
      'values[].value',
    ],
  },
  'bar.waterfall': {
    kind: 'bar',
    grammarId: 'v2.waterfall',
    description: 'Explain a supplied additive progression with explicit start, end, and delta values.',
    useWhen: 'A start value changes through auditable steps into a final total.',
    avoidWhen: 'The producer cannot supply and reconcile every cumulative level.',
    requiredFields: [
      'baseline',
      'steps[].id',
      'steps[].label',
      'steps[].kind',
      'steps[].start',
      'steps[].end',
      'steps[].delta',
    ],
  },
  'line.area': {
    kind: 'line',
    grammarId: 'v2.area-series',
    description: 'Show one supplied sequence as magnitude relative to an explicit baseline.',
    useWhen: 'Magnitude between one ordered sequence and a meaningful baseline is the reading task.',
    avoidWhen: 'The fill represents uncertainty, multiple series, or interpolated missing observations.',
    requiredFields: ['baseline', 'series[0].id', 'series[0].label', 'series[0].points[].x', 'series[0].points[].y'],
  },
  'pair.dumbbell': {
    kind: 'pair',
    grammarId: 'v2.pair',
    description: 'Compare two named values and their signed difference for every row.',
    useWhen: 'The same entities have exactly two comparable endpoints.',
    avoidWhen: 'Rows have more than two observations or the endpoints are not directly comparable.',
    requiredFields: [
      'endpoints[0].id',
      'endpoints[1].id',
      'rows[].id',
      'rows[].label',
      'rows[].first',
      'rows[].second',
    ],
  },
  'distribution.box': {
    kind: 'distribution',
    grammarId: 'v2.box-summary',
    description: 'Compare producer-supplied five-number summaries, sample sizes, and outliers.',
    useWhen: 'Audited quartiles and whiskers are available for several distributions.',
    avoidWhen: 'Only raw samples are available or distribution shape beyond quartiles is essential.',
    requiredFields: [
      'data[].id',
      'data[].label',
      'data[].n',
      'data[].lowerWhisker',
      'data[].q1',
      'data[].median',
      'data[].q3',
      'data[].upperWhisker',
      'data[].whiskerMeaning',
    ],
  },
  'composition.waffle': {
    kind: 'composition',
    grammarId: 'v2.waffle',
    description: 'Show an exact part-to-whole composition in at most one hundred unit cells.',
    useWhen: 'A small number of non-negative parts sum exactly to a meaningful total.',
    avoidWhen: 'Parts overlap, do not sum to the total, or require more than one hundred cells.',
    requiredFields: ['total', 'unit', 'parts[].id', 'parts[].label', 'parts[].value'],
  },
  'flow.funnel': {
    kind: 'flow',
    grammarId: 'v2.funnel',
    description: 'Show how a supplied population narrows through ordered stages.',
    useWhen: 'Readers need to audit attrition, screening, eligibility, or candidate filtering across explicit stages.',
    avoidWhen: 'Stages are unordered, overlap, or values are not comparable counts on one population basis.',
    requiredFields: ['stages[].id', 'stages[].label', 'stages[].value'],
  },
  'timeline.lineage': {
    kind: 'timeline',
    grammarId: 'v2.lineage',
    description: 'Show an ordered sequence of dated or numeric milestones with explicit states.',
    useWhen: 'A lifecycle, catalyst calendar, experimental sequence, or proof history is central to the conclusion.',
    avoidWhen: 'Events have no meaningful order or durations and dependencies carry more meaning than time.',
    requiredFields: ['events[].id', 'events[].label', 'events[].at', 'events[].state'],
  },
  'hierarchy.tree': {
    kind: 'hierarchy',
    grammarId: 'v2.tree',
    description: 'Show a compact rooted hierarchy with one parent per non-root node.',
    useWhen: 'Readers need to inspect a small taxonomy, theorem dependency tree, or target/pathway breakdown.',
    avoidWhen: 'Nodes have multiple parents, cycles, more than four levels, or a dense graph needs exploration.',
    requiredFields: ['nodes[].id', 'nodes[].label', 'nodes[].parentId'],
  },
  'scale.bipolar': {
    kind: 'scale',
    grammarId: 'v2.bipolar',
    description: 'Place several supplied scores between two explicitly named semantic endpoints.',
    useWhen: 'A bounded signed or centered score has meaningful opposing endpoints and a declared center.',
    avoidWhen: 'The score is unbounded, ordinal only, or the endpoints are decorative labels without a shared scale.',
    requiredFields: ['domain', 'center', 'endpoints[0].label', 'endpoints[1].label', 'items[].id', 'items[].value'],
  },
  'sequence.rainfall': {
    kind: 'sequence',
    grammarId: 'v2.rainfall',
    description: 'Compare two aligned supplied sequences with one connector at every ordered observation.',
    useWhen: 'Readers need to see where two comparable series converge, cross, or separate over the same sequence.',
    avoidWhen: 'The series use different units, categories are unordered, or more than two series must be compared.',
    requiredFields: [
      'series[0].id',
      'series[1].id',
      'points[].id',
      'points[].label',
      'points[].first',
      'points[].second',
    ],
  },
} as const satisfies Record<ReportChartRecipe, ReportChartRecipeCatalogEntry>;

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const finiteNumber = z.number().finite();
const evidenceIdsSchema = z.array(boundedString(160)).max(32).optional();

const axisSchema = z
  .object({
    label: boundedString(120).optional(),
    unit: boundedString(40).optional(),
    scale: z.enum(['linear', 'time', 'category']).optional(),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
  })
  .strict();

const styleSchema = z
  .object({
    palette: z.enum(REPORT_CHART_PALETTES).default('auto'),
    appearance: z.enum(['auto', 'light', 'dark', 'print']).default('auto'),
    density: z.enum(['compact', 'comfortable']).default('comfortable'),
    showGrid: z.boolean().default(false),
    showLegend: z.boolean().default(false),
    directLabels: z.boolean().default(true),
    interaction: z.enum(['auto', 'inspect', 'quiet']).optional(),
  })
  .strict()
  .default({});

export const REPORT_CHART_VISUAL_QUESTIONS = [
  'compare',
  'change',
  'uncertainty',
  'process',
  'composition',
  'relationship',
  'hierarchy',
] as const;
export const REPORT_CHART_READING_MODES = ['glance', 'editorial', 'explore'] as const;
export const REPORT_CHART_PLACEMENTS = ['lead', 'supporting', 'appendix'] as const;

const visualIntentSchema = z
  .object({
    question: z.enum(REPORT_CHART_VISUAL_QUESTIONS),
    readingMode: z.enum(REPORT_CHART_READING_MODES).default('editorial'),
    placement: z.enum(REPORT_CHART_PLACEMENTS).default('supporting'),
    takeaway: boundedString(400).optional(),
  })
  .strict();

const chartBase = {
  schema: z.literal(REPORT_CHART_SCHEMA),
  id: boundedString(120).optional(),
  title: boundedString(240),
  description: boundedString(1_000).optional(),
  caption: boundedString(2_000).optional(),
  evidenceIds: evidenceIdsSchema,
  xAxis: axisSchema.optional(),
  yAxis: axisSchema.optional(),
  style: styleSchema,
  visualIntent: visualIntentSchema.optional(),
};

const barDatumSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    value: finiteNumber,
    group: boundedString(120).optional(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const linePointSchema = z
  .object({
    x: z.union([finiteNumber, boundedString(120)]),
    y: finiteNumber,
    low: finiteNumber.optional(),
    high: finiteNumber.optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict()
  .superRefine((point, context) => {
    if ((point.low === undefined) !== (point.high === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [point.low === undefined ? 'low' : 'high'],
        message: 'line point uncertainty requires both low and high',
      });
      return;
    }
    if (point.low !== undefined && point.high !== undefined && !(point.low <= point.y && point.y <= point.high)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['low'],
        message: 'line point uncertainty must satisfy low <= y <= high',
      });
    }
  });

const lineSeriesSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(160),
    unit: boundedString(40).optional(),
    points: z.array(linePointSchema).min(1).max(500),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const intervalDatumSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    estimate: finiteNumber,
    low: finiteNumber,
    high: finiteNumber,
    weight: finiteNumber.nonnegative().optional(),
    group: boundedString(120).optional(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict()
  .refine((datum) => datum.low <= datum.estimate && datum.estimate <= datum.high, {
    message: 'interval data must satisfy low <= estimate <= high',
  });

const scatterDatumSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200).optional(),
    x: finiteNumber,
    y: finiteNumber,
    size: finiteNumber.positive().optional(),
    group: boundedString(120).optional(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

export const reportChartCellStatusSchema = z.enum([
  'neutral',
  'supports',
  'against',
  'mixed',
  'unknown',
  'risk',
  'positive',
  'negative',
]);

const matrixCellSchema = z
  .object({
    row: boundedString(120),
    column: boundedString(120),
    value: finiteNumber.optional(),
    status: reportChartCellStatusSchema.optional(),
    label: boundedString(120).optional(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const barChartSchema = z
  .object({
    ...chartBase,
    kind: z.literal('bar'),
    recipe: z.enum(REPORT_CHART_V1_BAR_RECIPES).optional(),
    orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
    baseline: finiteNumber.optional(),
    data: z.array(barDatumSchema).min(1).max(200),
  })
  .strict();

const lineChartSchema = z
  .object({
    ...chartBase,
    kind: z.literal('line'),
    recipe: z.enum(REPORT_CHART_V1_LINE_RECIPES).optional(),
    referenceValue: finiteNumber.optional(),
    series: z.array(lineSeriesSchema).min(1).max(12),
  })
  .strict();

const intervalChartSchema = z
  .object({
    ...chartBase,
    kind: z.literal('interval'),
    recipe: z.enum(REPORT_CHART_INTERVAL_RECIPES).optional(),
    referenceValue: finiteNumber.optional(),
    scale: z.enum(['linear', 'log']).default('linear'),
    data: z.array(intervalDatumSchema).min(1).max(200),
  })
  .strict();

const scatterChartSchema = z
  .object({
    ...chartBase,
    kind: z.literal('scatter'),
    recipe: z.enum(REPORT_CHART_SCATTER_RECIPES).optional(),
    xReferenceValue: finiteNumber.optional(),
    yReferenceValue: finiteNumber.optional(),
    data: z.array(scatterDatumSchema).min(1).max(2_000),
  })
  .strict();

const matrixChartSchema = z
  .object({
    ...chartBase,
    kind: z.literal('matrix'),
    recipe: z.enum(REPORT_CHART_MATRIX_RECIPES).optional(),
    rows: z.array(boundedString(120)).min(1).max(60),
    columns: z.array(boundedString(120)).min(1).max(60),
    cells: z.array(matrixCellSchema).min(1).max(3_600),
    valueDomain: z.tuple([finiteNumber, finiteNumber]).optional(),
    colorScale: z.enum(['sequential', 'diverging']).optional(),
    center: finiteNumber.optional(),
  })
  .strict();

export const reportChartSpecV1Schema = z
  .discriminatedUnion('kind', [
    barChartSchema,
    lineChartSchema,
    intervalChartSchema,
    scatterChartSchema,
    matrixChartSchema,
  ])
  .superRefine((chart, context) => {
    const requireAxisContains = (axisName: 'xAxis' | 'yAxis', values: number[]): void => {
      const axis = chart[axisName];
      if (!axis || !values.length) return;
      const low = Math.min(...values);
      const high = Math.max(...values);
      if (axis.min !== undefined && axis.min > low) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [axisName, 'min'],
          message: `${axisName}.min must not exclude plotted values or references`,
        });
      }
      if (axis.max !== undefined && axis.max < high) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [axisName, 'max'],
          message: `${axisName}.max must not exclude plotted values or references`,
        });
      }
    };

    (['xAxis', 'yAxis'] as const).forEach((axisName) => {
      const axis = chart[axisName];
      if (axis?.min !== undefined && axis.max !== undefined && axis.min >= axis.max) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [axisName, 'max'],
          message: `${axisName}.max must be greater than ${axisName}.min`,
        });
      }
      if (axis?.scale === 'category' && (axis.min !== undefined || axis.max !== undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [axisName],
          message: 'category axes do not accept numeric min or max bounds',
        });
      }
    });

    if (chart.yAxis?.scale === 'time' || (chart.xAxis?.scale === 'time' && chart.kind !== 'line')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [chart.yAxis?.scale === 'time' ? 'yAxis' : 'xAxis', 'scale'],
        message: 'time scale is supported only on the x-axis of line charts',
      });
    }

    const categoryValueAxis =
      chart.kind === 'bar'
        ? chart.orientation === 'horizontal' && chart.xAxis?.scale === 'category'
          ? 'xAxis'
          : chart.orientation === 'vertical' && chart.yAxis?.scale === 'category'
            ? 'yAxis'
            : undefined
        : chart.kind === 'interval' && chart.xAxis?.scale === 'category'
          ? 'xAxis'
          : chart.kind === 'line' && chart.yAxis?.scale === 'category'
            ? 'yAxis'
            : chart.kind === 'scatter' && chart.xAxis?.scale === 'category'
              ? 'xAxis'
              : chart.kind === 'scatter' && chart.yAxis?.scale === 'category'
                ? 'yAxis'
                : undefined;
    if (categoryValueAxis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [categoryValueAxis, 'scale'],
        message: 'category scale cannot be used on a numeric value axis',
      });
    }

    const ignoredBoundAxis =
      chart.kind === 'bar'
        ? chart.orientation === 'horizontal' && (chart.yAxis?.min !== undefined || chart.yAxis?.max !== undefined)
          ? 'yAxis'
          : chart.orientation === 'vertical' && (chart.xAxis?.min !== undefined || chart.xAxis?.max !== undefined)
            ? 'xAxis'
            : undefined
        : chart.kind === 'interval' && (chart.yAxis?.min !== undefined || chart.yAxis?.max !== undefined)
          ? 'yAxis'
          : chart.kind === 'matrix' && (chart.xAxis?.min !== undefined || chart.xAxis?.max !== undefined)
            ? 'xAxis'
            : chart.kind === 'matrix' && (chart.yAxis?.min !== undefined || chart.yAxis?.max !== undefined)
              ? 'yAxis'
              : chart.kind === 'line' &&
                  chart.xAxis?.scale !== 'time' &&
                  chart.series.some((series) => series.points.some((point) => typeof point.x === 'string')) &&
                  (chart.xAxis?.min !== undefined || chart.xAxis?.max !== undefined)
                ? 'xAxis'
                : undefined;
    if (ignoredBoundAxis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [ignoredBoundAxis],
        message: `${ignoredBoundAxis} numeric bounds are not supported for this categorical axis`,
      });
    }

    const invalidCategoricalAxisScale =
      chart.kind === 'bar'
        ? chart.orientation === 'horizontal' && chart.yAxis?.scale && chart.yAxis.scale !== 'category'
          ? 'yAxis'
          : chart.orientation === 'vertical' && chart.xAxis?.scale && chart.xAxis.scale !== 'category'
            ? 'xAxis'
            : undefined
        : chart.kind === 'interval' && chart.yAxis?.scale && chart.yAxis.scale !== 'category'
          ? 'yAxis'
          : chart.kind === 'matrix' && chart.xAxis?.scale && chart.xAxis.scale !== 'category'
            ? 'xAxis'
            : chart.kind === 'matrix' && chart.yAxis?.scale && chart.yAxis.scale !== 'category'
              ? 'yAxis'
              : undefined;
    if (invalidCategoricalAxisScale) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [invalidCategoricalAxisScale, 'scale'],
        message: `${invalidCategoricalAxisScale} is categorical for this chart kind`,
      });
    }

    if (
      chart.kind === 'line' &&
      chart.xAxis?.scale === 'linear' &&
      chart.series.some((series) => series.points.some((point) => typeof point.x !== 'number'))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['xAxis', 'scale'],
        message: 'linear line-chart x-axis requires numeric x values',
      });
    }

    if (chart.kind === 'line' && chart.xAxis?.scale === 'time') {
      chart.series.forEach((series, seriesIndex) => {
        series.points.forEach((point, pointIndex) => {
          const timestamp = typeof point.x === 'number' ? point.x : Date.parse(point.x);
          if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['series', seriesIndex, 'points', pointIndex, 'x'],
              message: 'time-scale values must be valid JavaScript dates or timestamps',
            });
          }
        });
      });
      (['min', 'max'] as const).forEach((field) => {
        const value = chart.xAxis?.[field];
        if (value !== undefined && Math.abs(value) > 8_640_000_000_000_000) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['xAxis', field],
            message: `time-scale xAxis.${field} must be a valid JavaScript timestamp`,
          });
        }
      });
    }

    if (
      chart.kind === 'bar' &&
      (chart.recipe === 'bar.ranked' || chart.recipe === 'bar.rung') &&
      chart.orientation !== 'horizontal'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orientation'],
        message: `${chart.recipe} requires horizontal orientation`,
      });
    }

    if (chart.kind === 'bar' && chart.recipe === 'bar.diverging') {
      const baseline = chart.baseline ?? 0;
      if (!chart.data.some((datum) => datum.value < baseline) || !chart.data.some((datum) => datum.value > baseline)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data'],
          message: 'bar.diverging requires values on both sides of the baseline',
        });
      }
      const groupedIndex = chart.data.findIndex((datum) => datum.group !== undefined);
      if (groupedIndex >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', groupedIndex, 'group'],
          message: 'bar.diverging reserves color for direction and does not accept groups',
        });
      }
    }

    if (
      chart.kind === 'scatter' &&
      chart.recipe === 'scatter.quadrant' &&
      (chart.xReferenceValue === undefined || chart.yReferenceValue === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [chart.xReferenceValue === undefined ? 'xReferenceValue' : 'yReferenceValue'],
        message: 'scatter.quadrant requires both xReferenceValue and yReferenceValue',
      });
    }

    if (chart.kind === 'matrix' && chart.recipe === 'matrix.claim-matrix') {
      const invalidIndex = chart.cells.findIndex((cell) => cell.status === undefined);
      if (invalidIndex >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', invalidIndex, 'status'],
          message: 'matrix.claim-matrix requires a status for every cell',
        });
      }
    }

    if (chart.kind === 'matrix' && chart.recipe === 'matrix.punchcard') {
      const invalidIndex = chart.cells.findIndex((cell) => cell.value === undefined || cell.value < 0);
      if (invalidIndex >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', invalidIndex, 'value'],
          message: 'matrix.punchcard requires a non-negative value for every cell',
        });
      }
      if (chart.valueDomain && chart.valueDomain[0] < 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['valueDomain', 0],
          message: 'matrix.punchcard valueDomain must be non-negative',
        });
      }
    }

    if (chart.kind === 'matrix' && chart.recipe === 'matrix.heatmap') {
      const invalidIndex = chart.cells.findIndex((cell) => cell.value === undefined);
      if (invalidIndex >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', invalidIndex, 'value'],
          message: 'matrix.heatmap requires a numeric value for every cell',
        });
      }
    }

    if (chart.kind === 'line' && chart.recipe === 'line.uncertainty-band') {
      chart.series.forEach((series, seriesIndex) => {
        const invalidIndex = series.points.findIndex((point) => point.low === undefined || point.high === undefined);
        if (invalidIndex >= 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['series', seriesIndex, 'points', invalidIndex],
            message: 'line.uncertainty-band requires low and high on every point',
          });
        }
      });
    }

    if (chart.kind === 'bar') {
      requireAxisContains(chart.orientation === 'vertical' ? 'yAxis' : 'xAxis', [
        ...chart.data.map((datum) => datum.value),
        chart.baseline ?? 0,
      ]);
    } else if (chart.kind === 'line') {
      const xValues = chart.series.flatMap((series) =>
        series.points.flatMap((point) => {
          if (typeof point.x === 'number') return [point.x];
          return chart.xAxis?.scale === 'time' ? [Date.parse(point.x)] : [];
        })
      );
      requireAxisContains('xAxis', xValues.filter(Number.isFinite));
      requireAxisContains('yAxis', [
        ...chart.series.flatMap((series) =>
          series.points.flatMap((point) => [
            point.y,
            ...(point.low === undefined ? [] : [point.low]),
            ...(point.high === undefined ? [] : [point.high]),
          ])
        ),
        ...(chart.referenceValue === undefined ? [] : [chart.referenceValue]),
      ]);
    } else if (chart.kind === 'interval') {
      requireAxisContains('xAxis', [
        ...chart.data.flatMap((datum) => [datum.low, datum.high]),
        ...(chart.referenceValue === undefined ? [] : [chart.referenceValue]),
      ]);
    } else if (chart.kind === 'scatter') {
      requireAxisContains('xAxis', [
        ...chart.data.map((datum) => datum.x),
        ...(chart.xReferenceValue === undefined ? [] : [chart.xReferenceValue]),
      ]);
      requireAxisContains('yAxis', [
        ...chart.data.map((datum) => datum.y),
        ...(chart.yReferenceValue === undefined ? [] : [chart.yReferenceValue]),
      ]);
    }

    if (chart.kind === 'interval' && chart.scale === 'log') {
      chart.data.forEach((datum, index) => {
        (['low', 'estimate', 'high'] as const).forEach((field) => {
          if (datum[field] <= 0) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['data', index, field],
              message: 'log interval values must be greater than zero',
            });
          }
        });
      });
      if (chart.referenceValue !== undefined && chart.referenceValue <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['referenceValue'],
          message: 'log interval referenceValue must be greater than zero',
        });
      }
      if (chart.xAxis?.min !== undefined && chart.xAxis.min <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['xAxis', 'min'],
          message: 'log interval xAxis.min must be greater than zero',
        });
      }
      if (chart.xAxis?.max !== undefined && chart.xAxis.max <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['xAxis', 'max'],
          message: 'log interval xAxis.max must be greater than zero',
        });
      }
    }

    const ids =
      chart.kind === 'line'
        ? chart.series.map((series) => series.id)
        : chart.kind === 'matrix'
          ? []
          : chart.data.map((datum) => datum.id);
    const seenIds = new Set<string>();
    ids.forEach((id, index) => {
      if (seenIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [chart.kind === 'line' ? 'series' : 'data', index, 'id'],
          message: `chart ids must be unique: ${id}`,
        });
      }
      seenIds.add(id);
    });

    const nestedEvidenceIds =
      chart.kind === 'line'
        ? chart.series.flatMap((series) => [
            ...(series.evidenceIds || []),
            ...series.points.flatMap((point) => point.evidenceIds || []),
          ])
        : chart.kind === 'matrix'
          ? chart.cells.flatMap((cell) => cell.evidenceIds || [])
          : chart.data.flatMap((datum) => datum.evidenceIds || []);
    if (new Set([...(chart.evidenceIds || []), ...nestedEvidenceIds]).size > 512) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceIds'],
        message: 'a report chart may reference at most 512 unique evidence ids',
      });
    }

    if (chart.kind !== 'matrix') return;
    const rowSet = new Set(chart.rows);
    const columnSet = new Set(chart.columns);
    if (rowSet.size !== chart.rows.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'matrix row names must be unique' });
    }
    if (columnSet.size !== chart.columns.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: 'matrix column names must be unique',
      });
    }
    const coordinates = new Set<string>();
    chart.cells.forEach((cell, index) => {
      if (!rowSet.has(cell.row)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', index, 'row'],
          message: `matrix cell row is not declared: ${cell.row}`,
        });
      }
      if (!columnSet.has(cell.column)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', index, 'column'],
          message: `matrix cell column is not declared: ${cell.column}`,
        });
      }
      const coordinate = `${cell.row}\u0000${cell.column}`;
      if (coordinates.has(coordinate)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', index],
          message: `matrix cells must have unique coordinates: ${cell.row} / ${cell.column}`,
        });
      }
      coordinates.add(coordinate);
    });
    if (chart.valueDomain && chart.valueDomain[0] >= chart.valueDomain[1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valueDomain', 1],
        message: 'matrix valueDomain maximum must be greater than its minimum',
      });
    }
    if (chart.valueDomain) {
      const values = chart.cells.flatMap((cell) => (cell.value === undefined ? [] : [cell.value]));
      if (values.some((value) => value < chart.valueDomain![0] || value > chart.valueDomain![1])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['valueDomain'],
          message: 'matrix valueDomain must contain every numeric cell value',
        });
      }
    }
    if (chart.colorScale === 'diverging') {
      const center = chart.center ?? 0;
      const domain = chart.valueDomain;
      if (!domain || !(domain[0] < center && center < domain[1])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [domain ? 'center' : 'valueDomain'],
          message: 'a diverging matrix color scale requires valueDomain[0] < center < valueDomain[1]',
        });
      }
    } else if (chart.center !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['center'],
        message: 'matrix center is accepted only with colorScale="diverging"',
      });
    }
  });

export type ReportChartSpecV1 = z.infer<typeof reportChartSpecV1Schema>;

const chartBaseV2 = {
  ...chartBase,
  schema: z.literal(REPORT_CHART_SCHEMA_V2),
};

const categoricalDimensionSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
  })
  .strict();

const categoricalValueSchema = z
  .object({
    categoryId: boundedString(120),
    seriesId: boundedString(120),
    value: finiteNumber,
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const categoricalSeriesBarChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('bar'),
    recipe: z.enum(['bar.grouped', 'bar.stacked']),
    orientation: z.enum(['horizontal', 'vertical']).default('vertical'),
    baseline: finiteNumber.default(0),
    categories: z.array(categoricalDimensionSchema).min(1).max(40),
    series: z.array(categoricalDimensionSchema).min(2).max(6),
    values: z.array(categoricalValueSchema).min(1).max(240),
  })
  .strict();

const waterfallStepSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    kind: z.enum(['start', 'change', 'subtotal', 'total']),
    start: finiteNumber,
    end: finiteNumber,
    delta: finiteNumber,
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const waterfallBarChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('bar'),
    recipe: z.literal('bar.waterfall'),
    orientation: z.enum(['horizontal', 'vertical']).default('vertical'),
    baseline: finiteNumber,
    tolerance: finiteNumber.nonnegative().max(1).default(1e-9),
    steps: z.array(waterfallStepSchema).min(2).max(40),
  })
  .strict();

const areaPointSchema = z
  .object({
    x: z.union([finiteNumber, boundedString(120)]),
    y: finiteNumber,
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const areaSeriesSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(160),
    unit: boundedString(40).optional(),
    points: z.array(areaPointSchema).min(2).max(500),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const areaLineChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('line'),
    recipe: z.literal('line.area'),
    baseline: finiteNumber,
    series: z.array(areaSeriesSchema).length(1),
  })
  .strict();

const pairEndpointSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(160),
  })
  .strict();

const pairRowSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    first: finiteNumber,
    second: finiteNumber,
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const dumbbellChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('pair'),
    recipe: z.literal('pair.dumbbell'),
    endpoints: z.tuple([pairEndpointSchema, pairEndpointSchema]),
    rows: z.array(pairRowSchema).min(1).max(100),
  })
  .strict();

const boxSummarySchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    n: z.number().int().positive().max(1_000_000_000),
    lowerWhisker: finiteNumber,
    q1: finiteNumber,
    median: finiteNumber,
    q3: finiteNumber,
    upperWhisker: finiteNumber,
    outliers: z.array(finiteNumber).max(200).optional(),
    whiskerMeaning: z.enum(['min-max', 'tukey-1.5-iqr', 'custom']),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const boxDistributionChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('distribution'),
    recipe: z.literal('distribution.box'),
    data: z.array(boxSummarySchema).min(1).max(80),
  })
  .strict();

const wafflePartSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    value: finiteNumber.nonnegative(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const waffleCompositionChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('composition'),
    recipe: z.literal('composition.waffle'),
    total: finiteNumber.positive(),
    unit: finiteNumber.positive(),
    parts: z.array(wafflePartSchema).min(1).max(10),
  })
  .strict();

const funnelStageSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    value: finiteNumber.nonnegative(),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const funnelFlowChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('flow'),
    recipe: z.literal('flow.funnel'),
    stages: z.array(funnelStageSchema).min(2).max(12),
  })
  .strict();

const lineageEventSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    at: z.union([finiteNumber, boundedString(120)]),
    state: z.enum(['past', 'current', 'future', 'blocked']).default('past'),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const lineageTimelineChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('timeline'),
    recipe: z.literal('timeline.lineage'),
    events: z.array(lineageEventSchema).min(2).max(24),
  })
  .strict();

const hierarchyNodeSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    parentId: boundedString(120).optional(),
    value: finiteNumber.nonnegative().optional(),
    state: z.enum(['neutral', 'current', 'complete', 'blocked']).default('neutral'),
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const hierarchyTreeChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('hierarchy'),
    recipe: z.literal('hierarchy.tree'),
    nodes: z.array(hierarchyNodeSchema).min(2).max(32),
  })
  .strict();

const bipolarEndpointSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(160),
  })
  .strict();

const bipolarItemSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    value: finiteNumber,
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const bipolarScaleChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('scale'),
    recipe: z.literal('scale.bipolar'),
    domain: z.tuple([finiteNumber, finiteNumber]),
    center: finiteNumber,
    endpoints: z.tuple([bipolarEndpointSchema, bipolarEndpointSchema]),
    items: z.array(bipolarItemSchema).min(1).max(20),
  })
  .strict();

const rainfallPointSchema = z
  .object({
    id: boundedString(120),
    label: boundedString(200),
    first: finiteNumber,
    second: finiteNumber,
    note: boundedString(400).optional(),
    emphasis: z.boolean().optional(),
    evidenceIds: evidenceIdsSchema,
  })
  .strict();

const rainfallSequenceChartV2Schema = z
  .object({
    ...chartBaseV2,
    kind: z.literal('sequence'),
    recipe: z.literal('sequence.rainfall'),
    series: z.tuple([pairEndpointSchema, pairEndpointSchema]),
    points: z.array(rainfallPointSchema).min(2).max(40),
  })
  .strict();

const approximatelyEqual = (left: number, right: number, tolerance = 1e-9): boolean =>
  Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));

const reportChartSpecV2BaseSchema = z.discriminatedUnion('recipe', [
  categoricalSeriesBarChartV2Schema,
  waterfallBarChartV2Schema,
  areaLineChartV2Schema,
  dumbbellChartV2Schema,
  boxDistributionChartV2Schema,
  waffleCompositionChartV2Schema,
  funnelFlowChartV2Schema,
  lineageTimelineChartV2Schema,
  hierarchyTreeChartV2Schema,
  bipolarScaleChartV2Schema,
  rainfallSequenceChartV2Schema,
]);

export const reportChartSpecV2Schema = reportChartSpecV2BaseSchema.superRefine((chart, context) => {
  const addIssue = (path: Array<string | number>, message: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const requireUniqueIds = (values: Array<{ id?: string }>, path: string): void => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (!value.id) return;
      if (seen.has(value.id)) addIssue([path, index, 'id'], `${path} ids must be unique: ${value.id}`);
      seen.add(value.id);
    });
  };
  const requireAxisContains = (axisName: 'xAxis' | 'yAxis', values: number[]): void => {
    const axis = chart[axisName];
    if (!axis || values.length === 0) return;
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (axis.min !== undefined && axis.min > low) {
      addIssue([axisName, 'min'], `${axisName}.min must not exclude plotted values or references`);
    }
    if (axis.max !== undefined && axis.max < high) {
      addIssue([axisName, 'max'], `${axisName}.max must not exclude plotted values or references`);
    }
  };

  (['xAxis', 'yAxis'] as const).forEach((axisName) => {
    const axis = chart[axisName];
    if (axis?.min !== undefined && axis.max !== undefined && axis.min >= axis.max) {
      addIssue([axisName, 'max'], `${axisName}.max must be greater than ${axisName}.min`);
    }
    if (axis?.scale === 'category' && (axis.min !== undefined || axis.max !== undefined)) {
      addIssue([axisName], 'category axes do not accept numeric min or max bounds');
    }
  });

  if (chart.recipe === 'bar.grouped' || chart.recipe === 'bar.stacked') {
    requireUniqueIds(chart.categories, 'categories');
    requireUniqueIds(chart.series, 'series');
    const categoryIds = new Set(chart.categories.map((category) => category.id));
    const seriesIds = new Set(chart.series.map((series) => series.id));
    const coordinates = new Set<string>();
    chart.values.forEach((value, index) => {
      if (!categoryIds.has(value.categoryId)) {
        addIssue(['values', index, 'categoryId'], `unknown categoryId: ${value.categoryId}`);
      }
      if (!seriesIds.has(value.seriesId)) {
        addIssue(['values', index, 'seriesId'], `unknown seriesId: ${value.seriesId}`);
      }
      const coordinate = `${value.categoryId}\u0000${value.seriesId}`;
      if (coordinates.has(coordinate)) {
        addIssue(['values', index], `category-series pairs must be unique: ${value.categoryId} / ${value.seriesId}`);
      }
      coordinates.add(coordinate);
      if (chart.recipe === 'bar.stacked' && value.value < 0) {
        addIssue(['values', index, 'value'], 'bar.stacked accepts only non-negative absolute component values');
      }
    });
    chart.categories.forEach((category) => {
      chart.series.forEach((series) => {
        const coordinate = `${category.id}\u0000${series.id}`;
        if (!coordinates.has(coordinate)) {
          addIssue(['values'], `missing category-series value: ${category.id} / ${series.id}; missing is not zero`);
        }
      });
    });
    if (chart.recipe === 'bar.stacked' && chart.baseline !== 0) {
      addIssue(['baseline'], 'bar.stacked absolute components require baseline = 0');
    }
    const valueAxis = chart.orientation === 'vertical' ? 'yAxis' : 'xAxis';
    const categoryAxis = chart.orientation === 'vertical' ? 'xAxis' : 'yAxis';
    if (chart[categoryAxis]?.scale && chart[categoryAxis]?.scale !== 'category') {
      addIssue([categoryAxis, 'scale'], `${categoryAxis} is categorical for this orientation`);
    }
    if (chart[valueAxis]?.scale === 'category' || chart[valueAxis]?.scale === 'time') {
      addIssue([valueAxis, 'scale'], `${valueAxis} must use a numeric scale`);
    }
    const plottedValues =
      chart.recipe === 'bar.stacked'
        ? chart.categories.map((category) =>
            chart.values
              .filter((value) => value.categoryId === category.id)
              .reduce((total, value) => total + value.value, chart.baseline)
          )
        : chart.values.map((value) => value.value);
    requireAxisContains(valueAxis, [...plottedValues, chart.baseline]);
  } else if (chart.recipe === 'bar.waterfall') {
    requireUniqueIds(chart.steps, 'steps');
    if (chart.steps[0]?.kind !== 'start') addIssue(['steps', 0, 'kind'], 'bar.waterfall must begin with a start step');
    const lastIndex = chart.steps.length - 1;
    if (chart.steps[lastIndex]?.kind !== 'total') {
      addIssue(['steps', lastIndex, 'kind'], 'bar.waterfall must end with a total step');
    }
    chart.steps.forEach((step, index) => {
      if (index > 0 && step.kind === 'start')
        addIssue(['steps', index, 'kind'], 'only the first waterfall step may be start');
      if (index < lastIndex && step.kind === 'total')
        addIssue(['steps', index, 'kind'], 'only the last waterfall step may be total');
      if (!approximatelyEqual(step.end - step.start, step.delta, chart.tolerance)) {
        addIssue(['steps', index, 'delta'], 'waterfall step must satisfy end - start = delta within tolerance');
      }
      if (step.kind === 'start' || step.kind === 'subtotal' || step.kind === 'total') {
        if (!approximatelyEqual(step.start, chart.baseline, chart.tolerance)) {
          addIssue(['steps', index, 'start'], `${step.kind} step must start at the declared baseline`);
        }
      }
      if (index === 0) return;
      const previous = chart.steps[index - 1];
      if (step.kind === 'change' && !approximatelyEqual(step.start, previous.end, chart.tolerance)) {
        addIssue(['steps', index, 'start'], 'change step start must equal the previous supplied end');
      }
      if (
        (step.kind === 'subtotal' || step.kind === 'total') &&
        !approximatelyEqual(step.end, previous.end, chart.tolerance)
      ) {
        addIssue(['steps', index, 'end'], `${step.kind} step end must equal the previous supplied end`);
      }
    });
    const valueAxis = chart.orientation === 'vertical' ? 'yAxis' : 'xAxis';
    const categoryAxis = chart.orientation === 'vertical' ? 'xAxis' : 'yAxis';
    if (chart[categoryAxis]?.scale && chart[categoryAxis]?.scale !== 'category') {
      addIssue([categoryAxis, 'scale'], `${categoryAxis} is categorical for this orientation`);
    }
    if (chart[valueAxis]?.scale === 'category' || chart[valueAxis]?.scale === 'time') {
      addIssue([valueAxis, 'scale'], `${valueAxis} must use a numeric scale`);
    }
    requireAxisContains(valueAxis, [chart.baseline, ...chart.steps.flatMap((step) => [step.start, step.end])]);
  } else if (chart.recipe === 'line.area') {
    requireUniqueIds(chart.series, 'series');
    if (chart.xAxis?.scale === 'category') addIssue(['xAxis', 'scale'], 'line.area requires numeric or time x values');
    if (chart.yAxis?.scale === 'category' || chart.yAxis?.scale === 'time') {
      addIssue(['yAxis', 'scale'], 'line.area yAxis must use a numeric scale');
    }
    const points = chart.series[0].points;
    const xValues: number[] = [];
    points.forEach((point, index) => {
      const value = typeof point.x === 'number' ? point.x : chart.xAxis?.scale === 'time' ? Date.parse(point.x) : NaN;
      if (!Number.isFinite(value)) {
        addIssue(
          ['series', 0, 'points', index, 'x'],
          'line.area string x values require valid dates and xAxis.scale="time"'
        );
        return;
      }
      if (chart.xAxis?.scale === 'time' && Math.abs(value) > 8_640_000_000_000_000) {
        addIssue(['series', 0, 'points', index, 'x'], 'time-scale values must be valid JavaScript dates or timestamps');
      }
      const previousValue = xValues.at(-1);
      if (previousValue !== undefined && value <= previousValue) {
        addIssue(['series', 0, 'points', index, 'x'], 'line.area x values must be unique and strictly increasing');
      }
      xValues.push(value);
    });
    if (chart.xAxis?.scale === 'time') {
      (['min', 'max'] as const).forEach((field) => {
        const value = chart.xAxis?.[field];
        if (value !== undefined && Math.abs(value) > 8_640_000_000_000_000) {
          addIssue(['xAxis', field], `time-scale xAxis.${field} must be a valid JavaScript timestamp`);
        }
      });
    }
    requireAxisContains('xAxis', xValues);
    requireAxisContains('yAxis', [chart.baseline, ...points.map((point) => point.y)]);
  } else if (chart.recipe === 'pair.dumbbell') {
    if (chart.endpoints[0].id === chart.endpoints[1].id) {
      addIssue(['endpoints', 1, 'id'], 'pair endpoint ids must be unique');
    }
    requireUniqueIds(chart.rows, 'rows');
    if (chart.xAxis?.scale === 'category' || chart.xAxis?.scale === 'time') {
      addIssue(['xAxis', 'scale'], 'pair.dumbbell xAxis must use a numeric scale');
    }
    if (chart.yAxis?.scale && chart.yAxis.scale !== 'category') {
      addIssue(['yAxis', 'scale'], 'pair.dumbbell yAxis is categorical');
    }
    requireAxisContains(
      'xAxis',
      chart.rows.flatMap((row) => [row.first, row.second])
    );
  } else if (chart.recipe === 'distribution.box') {
    requireUniqueIds(chart.data, 'data');
    chart.data.forEach((datum, index) => {
      const ordered = [datum.lowerWhisker, datum.q1, datum.median, datum.q3, datum.upperWhisker];
      if (ordered.some((value, valueIndex) => valueIndex > 0 && value < ordered[valueIndex - 1])) {
        addIssue(['data', index], 'box summary must satisfy lowerWhisker <= q1 <= median <= q3 <= upperWhisker');
      }
      datum.outliers?.forEach((outlier, outlierIndex) => {
        if (!(outlier < datum.lowerWhisker || outlier > datum.upperWhisker)) {
          addIssue(
            ['data', index, 'outliers', outlierIndex],
            'box outliers must lie strictly outside the supplied whiskers'
          );
        }
      });
    });
    if (chart.xAxis?.scale === 'category' || chart.xAxis?.scale === 'time') {
      addIssue(['xAxis', 'scale'], 'distribution.box xAxis must use a numeric scale');
    }
    if (chart.yAxis?.scale && chart.yAxis.scale !== 'category') {
      addIssue(['yAxis', 'scale'], 'distribution.box yAxis is categorical');
    }
    requireAxisContains(
      'xAxis',
      chart.data.flatMap((datum) => [datum.lowerWhisker, datum.upperWhisker, ...(datum.outliers || [])])
    );
  } else if (chart.recipe === 'composition.waffle') {
    requireUniqueIds(chart.parts, 'parts');
    const sum = chart.parts.reduce((total, part) => total + part.value, 0);
    if (!approximatelyEqual(sum, chart.total, Number.EPSILON * 16)) {
      addIssue(['parts'], `waffle part values must sum to total (${chart.total}); received ${sum}`);
    }
    if (chart.total / chart.unit > 100 + Number.EPSILON) {
      addIssue(['unit'], 'composition.waffle supports at most 100 cells; require total / unit <= 100');
    }
    if (chart.xAxis) addIssue(['xAxis'], 'composition.waffle does not accept axes');
    if (chart.yAxis) addIssue(['yAxis'], 'composition.waffle does not accept axes');
  } else if (chart.recipe === 'flow.funnel') {
    requireUniqueIds(chart.stages, 'stages');
    chart.stages.forEach((stage, index) => {
      if (index > 0 && stage.value > chart.stages[index - 1].value) {
        addIssue(['stages', index, 'value'], 'flow.funnel stage values must be non-increasing');
      }
    });
    if (chart.xAxis) addIssue(['xAxis'], 'flow.funnel does not accept axes');
    if (chart.yAxis) addIssue(['yAxis'], 'flow.funnel does not accept axes');
  } else if (chart.recipe === 'timeline.lineage') {
    requireUniqueIds(chart.events, 'events');
    const coordinates: number[] = [];
    chart.events.forEach((event, index) => {
      const coordinate =
        typeof event.at === 'number'
          ? event.at
          : chart.xAxis?.scale === 'time'
            ? Date.parse(event.at)
            : Number(event.at);
      if (!Number.isFinite(coordinate)) {
        addIssue(
          ['events', index, 'at'],
          'timeline.lineage string values require numeric strings or valid dates with xAxis.scale="time"'
        );
        return;
      }
      if (coordinates.length && coordinate <= coordinates[coordinates.length - 1]) {
        addIssue(['events', index, 'at'], 'timeline.lineage events must be unique and strictly increasing');
      }
      coordinates.push(coordinate);
    });
    if (chart.xAxis?.scale === 'category') {
      addIssue(['xAxis', 'scale'], 'timeline.lineage requires a numeric or time x axis');
    }
    if (chart.yAxis) addIssue(['yAxis'], 'timeline.lineage does not accept a y axis');
    requireAxisContains('xAxis', coordinates);
  } else if (chart.recipe === 'hierarchy.tree') {
    requireUniqueIds(chart.nodes, 'nodes');
    const nodeIds = new Set(chart.nodes.map((node) => node.id));
    const roots = chart.nodes.filter((node) => node.parentId === undefined);
    if (roots.length !== 1) addIssue(['nodes'], 'hierarchy.tree requires exactly one root node without parentId');
    chart.nodes.forEach((node, index) => {
      if (node.parentId && !nodeIds.has(node.parentId)) {
        addIssue(['nodes', index, 'parentId'], `unknown hierarchy parentId: ${node.parentId}`);
      }
      if (node.parentId === node.id)
        addIssue(['nodes', index, 'parentId'], 'a hierarchy node cannot be its own parent');
      const visited = new Set<string>([node.id]);
      let current = node;
      let depth = 0;
      while (current.parentId) {
        if (visited.has(current.parentId)) {
          addIssue(['nodes', index, 'parentId'], `hierarchy cycle detected at ${current.parentId}`);
          break;
        }
        visited.add(current.parentId);
        const parent = chart.nodes.find((candidate) => candidate.id === current.parentId);
        if (!parent) break;
        current = parent;
        depth += 1;
        if (depth > 4) {
          addIssue(['nodes', index, 'parentId'], 'hierarchy.tree supports at most four levels below the root');
          break;
        }
      }
    });
    if (chart.xAxis) addIssue(['xAxis'], 'hierarchy.tree does not accept axes');
    if (chart.yAxis) addIssue(['yAxis'], 'hierarchy.tree does not accept axes');
  } else if (chart.recipe === 'scale.bipolar') {
    requireUniqueIds(chart.items, 'items');
    if (chart.endpoints[0].id === chart.endpoints[1].id) {
      addIssue(['endpoints', 1, 'id'], 'scale.bipolar endpoint ids must be unique');
    }
    if (!(chart.domain[0] < chart.center && chart.center < chart.domain[1])) {
      addIssue(['center'], 'scale.bipolar requires domain[0] < center < domain[1]');
    }
    chart.items.forEach((item, index) => {
      if (item.value < chart.domain[0] || item.value > chart.domain[1]) {
        addIssue(['items', index, 'value'], 'scale.bipolar item values must lie inside the declared domain');
      }
    });
    if (chart.xAxis?.scale === 'category' || chart.xAxis?.scale === 'time') {
      addIssue(['xAxis', 'scale'], 'scale.bipolar xAxis must use a numeric scale');
    }
    if (chart.yAxis?.scale && chart.yAxis.scale !== 'category') {
      addIssue(['yAxis', 'scale'], 'scale.bipolar yAxis is categorical');
    }
    requireAxisContains('xAxis', [
      chart.domain[0],
      chart.center,
      chart.domain[1],
      ...chart.items.map((item) => item.value),
    ]);
  } else if (chart.recipe === 'sequence.rainfall') {
    requireUniqueIds(chart.points, 'points');
    if (chart.series[0].id === chart.series[1].id) {
      addIssue(['series', 1, 'id'], 'sequence.rainfall series ids must be unique');
    }
    if (chart.xAxis?.scale && chart.xAxis.scale !== 'category') {
      addIssue(['xAxis', 'scale'], 'sequence.rainfall xAxis is categorical');
    }
    if (chart.yAxis?.scale === 'category' || chart.yAxis?.scale === 'time') {
      addIssue(['yAxis', 'scale'], 'sequence.rainfall yAxis must use a numeric scale');
    }
    requireAxisContains(
      'yAxis',
      chart.points.flatMap((point) => [point.first, point.second])
    );
  }

  const markEvidenceIds =
    chart.recipe === 'bar.grouped' || chart.recipe === 'bar.stacked'
      ? chart.values.flatMap((value) => value.evidenceIds || [])
      : chart.recipe === 'bar.waterfall'
        ? chart.steps.flatMap((step) => step.evidenceIds || [])
        : chart.recipe === 'line.area'
          ? chart.series.flatMap((series) => [
              ...(series.evidenceIds || []),
              ...series.points.flatMap((point) => point.evidenceIds || []),
            ])
          : chart.recipe === 'pair.dumbbell'
            ? chart.rows.flatMap((row) => row.evidenceIds || [])
            : chart.recipe === 'distribution.box'
              ? chart.data.flatMap((datum) => datum.evidenceIds || [])
              : chart.recipe === 'composition.waffle'
                ? chart.parts.flatMap((part) => part.evidenceIds || [])
                : chart.recipe === 'flow.funnel'
                  ? chart.stages.flatMap((stage) => stage.evidenceIds || [])
                  : chart.recipe === 'timeline.lineage'
                    ? chart.events.flatMap((event) => event.evidenceIds || [])
                    : chart.recipe === 'hierarchy.tree'
                      ? chart.nodes.flatMap((node) => node.evidenceIds || [])
                      : chart.recipe === 'scale.bipolar'
                        ? chart.items.flatMap((item) => item.evidenceIds || [])
                        : chart.recipe === 'sequence.rainfall'
                          ? chart.points.flatMap((point) => point.evidenceIds || [])
                          : [];
  if (new Set([...(chart.evidenceIds || []), ...markEvidenceIds]).size > 512) {
    addIssue(['evidenceIds'], 'a report chart may reference at most 512 unique evidence ids');
  }
});

export type ReportChartSpecV2 = z.infer<typeof reportChartSpecV2Schema>;
export const reportChartSpecSchema = z.union([reportChartSpecV1Schema, reportChartSpecV2Schema]);
export type ReportChartSpec = ReportChartSpecV1 | ReportChartSpecV2;
export type ReportChartKind = ReportChartSpec['kind'];
export type ReportChartPalette = (typeof REPORT_CHART_PALETTES)[number];

export type ReportChartValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ReportChartValidationResult =
  { ok: true; spec: ReportChartSpec; issues: [] } | { ok: false; issues: ReportChartValidationIssue[] };

export const validateReportChartSpec = (input: unknown): ReportChartValidationResult => {
  const schema =
    typeof input === 'object' && input !== null && 'schema' in input
      ? (input as { schema?: unknown }).schema
      : undefined;
  const selectedSchema =
    schema === REPORT_CHART_SCHEMA_V1
      ? reportChartSpecV1Schema
      : schema === REPORT_CHART_SCHEMA_V2
        ? reportChartSpecV2Schema
        : reportChartSpecSchema;
  const parsed = selectedSchema.safeParse(input);
  if (parsed.success) return { ok: true, spec: parsed.data, issues: [] };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code === 'custom' && /^log interval\b/u.test(issue.message) ? 'render_constraint' : issue.code,
    })),
  };
};

export function normalizeReportChartSpec(
  input: { schema: typeof REPORT_CHART_SCHEMA_V1 } & Record<string, unknown>
): ReportChartSpecV1;
export function normalizeReportChartSpec(
  input: { schema: typeof REPORT_CHART_SCHEMA_V2 } & Record<string, unknown>
): ReportChartSpecV2;
export function normalizeReportChartSpec(input: unknown): ReportChartSpec;
export function normalizeReportChartSpec(input: unknown): ReportChartSpec {
  const schema =
    typeof input === 'object' && input !== null && 'schema' in input
      ? (input as { schema?: unknown }).schema
      : undefined;
  if (schema === REPORT_CHART_SCHEMA_V1) return reportChartSpecV1Schema.parse(input);
  if (schema === REPORT_CHART_SCHEMA_V2) return reportChartSpecV2Schema.parse(input);
  return reportChartSpecSchema.parse(input);
}

export const isReportChartSpec = (input: unknown): input is ReportChartSpec => validateReportChartSpec(input).ok;

export type ReportChartTabularData = {
  columns: string[];
  rows: Array<Array<string | number>>;
  emphasizedRows?: number[];
};

const evidenceList = (ids?: string[]): string => (ids?.length ? ids.join(', ') : '');
const inheritedEvidenceIds = (...candidates: Array<string[] | undefined>): string[] | undefined =>
  candidates.find((candidate) => candidate?.length);

export type ReportChartMarkCoverage = {
  path: string;
  markId: string;
  evidenceIds: string[];
  evidenceSource: 'mark' | 'series' | 'chart' | 'none';
};

const markCoverage = (
  path: string,
  markId: string,
  markEvidenceIds: string[] | undefined,
  chartEvidenceIds: string[] | undefined,
  seriesEvidenceIds?: string[]
): ReportChartMarkCoverage => {
  const evidenceSource = markEvidenceIds?.length
    ? 'mark'
    : seriesEvidenceIds?.length
      ? 'series'
      : chartEvidenceIds?.length
        ? 'chart'
        : 'none';
  return {
    path,
    markId,
    evidenceIds: [...new Set(inheritedEvidenceIds(markEvidenceIds, seriesEvidenceIds, chartEvidenceIds) || [])],
    evidenceSource,
  };
};

export const collectReportChartMarkCoverage = (spec: ReportChartSpec): ReportChartMarkCoverage[] => {
  if (spec.schema === REPORT_CHART_SCHEMA_V2) {
    if (spec.recipe === 'bar.grouped' || spec.recipe === 'bar.stacked') {
      return spec.values.map((value, index) =>
        markCoverage(`values.${index}`, `${value.categoryId}/${value.seriesId}`, value.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'bar.waterfall') {
      return spec.steps.map((step, index) =>
        markCoverage(`steps.${index}`, step.id, step.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'line.area') {
      return spec.series[0].points.map((point, index) =>
        markCoverage(
          `series.0.points.${index}`,
          `${spec.series[0].id}/${index}`,
          point.evidenceIds,
          spec.evidenceIds,
          spec.series[0].evidenceIds
        )
      );
    }
    if (spec.recipe === 'pair.dumbbell') {
      return spec.rows.map((row, index) => markCoverage(`rows.${index}`, row.id, row.evidenceIds, spec.evidenceIds));
    }
    if (spec.recipe === 'distribution.box') {
      return spec.data.map((datum, index) =>
        markCoverage(`data.${index}`, datum.id, datum.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'composition.waffle') {
      return spec.parts.map((part, index) =>
        markCoverage(`parts.${index}`, part.id, part.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'flow.funnel') {
      return spec.stages.map((stage, index) =>
        markCoverage(`stages.${index}`, stage.id, stage.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'timeline.lineage') {
      return spec.events.map((event, index) =>
        markCoverage(`events.${index}`, event.id, event.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'hierarchy.tree') {
      return spec.nodes.map((node, index) =>
        markCoverage(`nodes.${index}`, node.id, node.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'scale.bipolar') {
      return spec.items.map((item, index) =>
        markCoverage(`items.${index}`, item.id, item.evidenceIds, spec.evidenceIds)
      );
    }
    if (spec.recipe === 'sequence.rainfall') {
      return spec.points.map((point, index) =>
        markCoverage(`points.${index}`, point.id, point.evidenceIds, spec.evidenceIds)
      );
    }
    return [];
  }

  if (spec.kind === 'line') {
    return spec.series.flatMap((series, seriesIndex) =>
      series.points.map((point, pointIndex) =>
        markCoverage(
          `series.${seriesIndex}.points.${pointIndex}`,
          `${series.id}/${pointIndex}`,
          point.evidenceIds,
          spec.evidenceIds,
          series.evidenceIds
        )
      )
    );
  }
  if (spec.kind === 'matrix') {
    return spec.cells.map((cell, index) =>
      markCoverage(`cells.${index}`, `${cell.row}/${cell.column}`, cell.evidenceIds, spec.evidenceIds)
    );
  }
  return spec.data.map((datum, index) => markCoverage(`data.${index}`, datum.id, datum.evidenceIds, spec.evidenceIds));
};

export const collectReportChartEvidenceIds = (spec: ReportChartSpec): string[] => {
  const ids = [...(spec.evidenceIds || [])];
  if (spec.schema === REPORT_CHART_SCHEMA_V2) {
    if (spec.recipe === 'bar.grouped' || spec.recipe === 'bar.stacked') {
      spec.values.forEach((value) => ids.push(...(value.evidenceIds || [])));
    } else if (spec.recipe === 'bar.waterfall') {
      spec.steps.forEach((step) => ids.push(...(step.evidenceIds || [])));
    } else if (spec.recipe === 'line.area') {
      spec.series.forEach((series) => {
        ids.push(...(series.evidenceIds || []));
        series.points.forEach((point) => ids.push(...(point.evidenceIds || [])));
      });
    } else if (spec.recipe === 'pair.dumbbell') {
      spec.rows.forEach((row) => ids.push(...(row.evidenceIds || [])));
    } else if (spec.recipe === 'distribution.box') {
      spec.data.forEach((datum) => ids.push(...(datum.evidenceIds || [])));
    } else if (spec.recipe === 'composition.waffle') {
      spec.parts.forEach((part) => ids.push(...(part.evidenceIds || [])));
    } else if (spec.recipe === 'flow.funnel') {
      spec.stages.forEach((stage) => ids.push(...(stage.evidenceIds || [])));
    } else if (spec.recipe === 'timeline.lineage') {
      spec.events.forEach((event) => ids.push(...(event.evidenceIds || [])));
    } else if (spec.recipe === 'hierarchy.tree') {
      spec.nodes.forEach((node) => ids.push(...(node.evidenceIds || [])));
    } else if (spec.recipe === 'scale.bipolar') {
      spec.items.forEach((item) => ids.push(...(item.evidenceIds || [])));
    } else if (spec.recipe === 'sequence.rainfall') {
      spec.points.forEach((point) => ids.push(...(point.evidenceIds || [])));
    }
    return [...new Set(ids)];
  }
  if (spec.kind === 'line') {
    spec.series.forEach((series) => {
      ids.push(...(series.evidenceIds || []));
      series.points.forEach((point) => ids.push(...(point.evidenceIds || [])));
    });
  } else if (spec.kind === 'matrix') {
    spec.cells.forEach((cell) => ids.push(...(cell.evidenceIds || [])));
  } else {
    spec.data.forEach((item) => ids.push(...(item.evidenceIds || [])));
  }
  return [...new Set(ids)];
};

export const reportChartToTabularData = (spec: ReportChartSpec): ReportChartTabularData => {
  if (spec.schema === REPORT_CHART_SCHEMA_V2) {
    if (spec.recipe === 'bar.grouped' || spec.recipe === 'bar.stacked') {
      const categories = new Map(spec.categories.map((category) => [category.id, category.label]));
      const series = new Map(spec.series.map((item) => [item.id, item.label]));
      return {
        columns: ['Category', 'Series', 'Value', 'Evidence'],
        rows: spec.values.map((value) => [
          categories.get(value.categoryId) || value.categoryId,
          series.get(value.seriesId) || value.seriesId,
          value.value,
          evidenceList(inheritedEvidenceIds(value.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.values.flatMap((value, index) => (value.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'bar.waterfall') {
      return {
        columns: ['Label', 'Kind', 'Start', 'End', 'Delta', 'Evidence'],
        rows: spec.steps.map((step) => [
          step.label,
          step.kind,
          step.start,
          step.end,
          step.delta,
          evidenceList(inheritedEvidenceIds(step.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.steps.flatMap((step, index) => (step.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'line.area') {
      const series = spec.series[0];
      return {
        columns: ['Series', 'X', 'Y', 'Baseline', 'Evidence'],
        rows: series.points.map((point) => [
          series.label,
          point.x,
          point.y,
          spec.baseline,
          evidenceList(inheritedEvidenceIds(point.evidenceIds, series.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: series.points.flatMap((point, index) => (point.emphasis || series.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'pair.dumbbell') {
      return {
        columns: ['Label', spec.endpoints[0].label, spec.endpoints[1].label, 'Difference', 'Evidence'],
        rows: spec.rows.map((row) => [
          row.label,
          row.first,
          row.second,
          row.second - row.first,
          evidenceList(inheritedEvidenceIds(row.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.rows.flatMap((row, index) => (row.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'distribution.box') {
      return {
        columns: [
          'Label',
          'N',
          'Lower whisker',
          'Q1',
          'Median',
          'Q3',
          'Upper whisker',
          'Outliers',
          'Whisker meaning',
          'Evidence',
        ],
        rows: spec.data.map((datum) => [
          datum.label,
          datum.n,
          datum.lowerWhisker,
          datum.q1,
          datum.median,
          datum.q3,
          datum.upperWhisker,
          (datum.outliers || []).join(', '),
          datum.whiskerMeaning,
          evidenceList(inheritedEvidenceIds(datum.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.data.flatMap((datum, index) => (datum.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'composition.waffle') {
      return {
        columns: ['Part', 'Value', 'Share', 'Units', 'Evidence'],
        rows: spec.parts.map((part) => [
          part.label,
          part.value,
          part.value / spec.total,
          part.value / spec.unit,
          evidenceList(inheritedEvidenceIds(part.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.parts.flatMap((part, index) => (part.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'flow.funnel') {
      return {
        columns: ['Stage', 'Value', 'Retained from previous', 'Retained from start', 'Evidence'],
        rows: spec.stages.map((stage, index) => [
          stage.label,
          stage.value,
          index === 0 || spec.stages[index - 1].value === 0 ? 1 : stage.value / spec.stages[index - 1].value,
          spec.stages[0].value === 0 ? 0 : stage.value / spec.stages[0].value,
          evidenceList(inheritedEvidenceIds(stage.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.stages.flatMap((stage, index) => (stage.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'timeline.lineage') {
      return {
        columns: ['Event', 'At', 'State', 'Note', 'Evidence'],
        rows: spec.events.map((event) => [
          event.label,
          event.at,
          event.state,
          event.note || '',
          evidenceList(inheritedEvidenceIds(event.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.events.flatMap((event, index) => (event.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'hierarchy.tree') {
      const labels = new Map(spec.nodes.map((node) => [node.id, node.label]));
      return {
        columns: ['Node', 'Parent', 'Value', 'State', 'Evidence'],
        rows: spec.nodes.map((node) => [
          node.label,
          node.parentId ? labels.get(node.parentId) || node.parentId : '',
          node.value ?? '',
          node.state,
          evidenceList(inheritedEvidenceIds(node.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.nodes.flatMap((node, index) => (node.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'scale.bipolar') {
      return {
        columns: ['Item', 'Value', spec.endpoints[0].label, spec.endpoints[1].label, 'Evidence'],
        rows: spec.items.map((item) => [
          item.label,
          item.value,
          spec.domain[0],
          spec.domain[1],
          evidenceList(inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.items.flatMap((item, index) => (item.emphasis ? [index] : [])),
      };
    }
    if (spec.recipe === 'sequence.rainfall') {
      return {
        columns: ['Observation', spec.series[0].label, spec.series[1].label, 'Difference', 'Evidence'],
        rows: spec.points.map((point) => [
          point.label,
          point.first,
          point.second,
          point.second - point.first,
          evidenceList(inheritedEvidenceIds(point.evidenceIds, spec.evidenceIds)),
        ]),
        emphasizedRows: spec.points.flatMap((point, index) => (point.emphasis ? [index] : [])),
      };
    }
    return { columns: [], rows: [], emphasizedRows: [] };
  }

  if (spec.kind === 'bar') {
    return {
      columns: ['Label', 'Value', 'Group', 'Evidence'],
      rows: spec.data.map((item) => [
        item.label,
        item.value,
        item.group || '',
        evidenceList(inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds)),
      ]),
      emphasizedRows: spec.data.flatMap((item, index) => (item.emphasis ? [index] : [])),
    };
  }
  if (spec.kind === 'line') {
    const includesUncertainty = spec.series.some((series) =>
      series.points.some((point) => point.low !== undefined && point.high !== undefined)
    );
    const rows = spec.series.flatMap((series) =>
      series.points.map((point) => [
        series.label,
        point.x,
        point.y,
        ...(includesUncertainty ? [point.low ?? '', point.high ?? ''] : []),
        evidenceList(inheritedEvidenceIds(point.evidenceIds, series.evidenceIds, spec.evidenceIds)),
      ])
    );
    let rowIndex = 0;
    const emphasizedRows = spec.series.flatMap((series) =>
      series.points.flatMap((point) => {
        const currentIndex = rowIndex;
        rowIndex += 1;
        return point.emphasis || series.emphasis ? [currentIndex] : [];
      })
    );
    return {
      columns: ['Series', 'X', 'Y', ...(includesUncertainty ? ['Low', 'High'] : []), 'Evidence'],
      rows,
      emphasizedRows,
    };
  }
  if (spec.kind === 'interval') {
    return {
      columns: ['Label', 'Estimate', 'Low', 'High', 'Weight', 'Evidence'],
      rows: spec.data.map((item) => [
        item.label,
        item.estimate,
        item.low,
        item.high,
        item.weight ?? '',
        evidenceList(inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds)),
      ]),
      emphasizedRows: spec.data.flatMap((item, index) => (item.emphasis ? [index] : [])),
    };
  }
  if (spec.kind === 'scatter') {
    return {
      columns: ['Label', 'X', 'Y', 'Group', 'Evidence'],
      rows: spec.data.map((item) => [
        item.label || item.id,
        item.x,
        item.y,
        item.group || '',
        evidenceList(inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds)),
      ]),
      emphasizedRows: spec.data.flatMap((item, index) => (item.emphasis ? [index] : [])),
    };
  }
  return {
    columns: ['Row', 'Column', 'Value', 'Status', 'Evidence'],
    rows: spec.cells.map((cell) => [
      cell.row,
      cell.column,
      cell.value ?? '',
      cell.status || '',
      evidenceList(inheritedEvidenceIds(cell.evidenceIds, spec.evidenceIds)),
    ]),
    emphasizedRows: spec.cells.flatMap((cell, index) => (cell.emphasis ? [index] : [])),
  };
};
