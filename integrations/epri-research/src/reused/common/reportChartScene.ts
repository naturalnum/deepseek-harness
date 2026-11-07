import type { ReportChartSpecV2 } from './reportChart';

export const REPORT_CHART_SCENE_SCHEMA = 'deepscientist.report_chart_scene.v1' as const;

export type ReportChartSceneTone =
  | 'none'
  | 'background'
  | 'surface'
  | 'ink'
  | 'muted'
  | 'grid'
  | 'emphasis'
  | 'series-1'
  | 'series-2'
  | 'series-3'
  | 'series-4'
  | 'series-5'
  | 'series-6'
  | 'positive'
  | 'negative'
  | 'risk';

export type ReportChartScenePrimitiveRole =
  'data' | 'axis' | 'grid' | 'label' | 'connector' | 'annotation' | 'background';

type ReportChartScenePrimitiveBase = {
  id: string;
  role: ReportChartScenePrimitiveRole;
  markId?: string;
  fill?: ReportChartSceneTone;
  stroke?: ReportChartSceneTone;
  strokeWidth?: number;
  opacity?: number;
  dash?: number[];
};

export type ReportChartSceneRect = ReportChartScenePrimitiveBase & {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
};

export type ReportChartSceneLine = ReportChartScenePrimitiveBase & {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type ReportChartScenePath = ReportChartScenePrimitiveBase & {
  type: 'path';
  d: string;
  lineJoin?: 'miter' | 'round' | 'bevel';
  lineCap?: 'butt' | 'round' | 'square';
};

export type ReportChartSceneCircle = ReportChartScenePrimitiveBase & {
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
};

export type ReportChartSceneText = ReportChartScenePrimitiveBase & {
  type: 'text';
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  baseline?: 'auto' | 'middle' | 'hanging';
  fontSize: number;
  fontWeight?: number;
  rotation?: number;
};

export type ReportChartScenePrimitive =
  ReportChartSceneRect | ReportChartSceneLine | ReportChartScenePath | ReportChartSceneCircle | ReportChartSceneText;

export type ReportChartSceneTick = {
  id: string;
  value: number | string;
  label: string;
  position: number;
};

export type ReportChartSceneAxis = {
  id: 'x' | 'y';
  orientation: 'bottom' | 'left';
  scale: 'linear' | 'time' | 'category';
  domain: [number, number] | string[];
  range: [number, number];
  label?: string;
  unit?: string;
  ticks: ReportChartSceneTick[];
};

export type ReportChartSceneLegendEntry = {
  id: string;
  label: string;
  tone: ReportChartSceneTone;
  symbol: 'rect' | 'circle' | 'circle-outline' | 'line';
};

export type ReportChartSceneReadoutValue = {
  label: string;
  value: number | string;
  formatted: string;
  unit?: string;
};

export type ReportChartSceneMark = {
  id: string;
  label: string;
  value: number | string;
  valueLabel: string;
  tone: ReportChartSceneTone;
  evidenceIds: string[];
  emphasis: boolean;
  primitiveIds: string[];
  readout: ReportChartSceneReadoutValue[];
};

export type ReportChartScene = {
  schema: typeof REPORT_CHART_SCENE_SCHEMA;
  sourceSchema: NonNullable<ReportChartSpecV2['schema']>;
  recipe: NonNullable<ReportChartSpecV2['recipe']>;
  kind: NonNullable<ReportChartSpecV2['kind']>;
  title: string;
  description?: string;
  caption?: string;
  width: number;
  height: number;
  plot: { x: number; y: number; width: number; height: number };
  primitives: ReportChartScenePrimitive[];
  marks: ReportChartSceneMark[];
  axes: ReportChartSceneAxis[];
  legend: ReportChartSceneLegendEntry[];
  markOrder: string[];
};

type SceneAxisInput = {
  label?: string;
  unit?: string;
  scale?: 'linear' | 'time' | 'category';
  min?: number;
  max?: number;
};

type NormalizedSceneStyle = {
  palette: 'auto' | 'mono' | 'nature';
  appearance: 'auto' | 'light' | 'dark' | 'print';
  density: 'compact' | 'comfortable';
  showGrid: boolean;
  showLegend: boolean;
  directLabels: boolean;
  interaction?: 'auto' | 'inspect' | 'quiet';
};

type NormalizedSceneBase = {
  schema: NonNullable<ReportChartSpecV2['schema']>;
  kind: NonNullable<ReportChartSpecV2['kind']>;
  recipe: NonNullable<ReportChartSpecV2['recipe']>;
  title: string;
  description?: string;
  caption?: string;
  evidenceIds?: string[];
  visualIntent?: {
    question: 'compare' | 'change' | 'uncertainty' | 'process' | 'composition' | 'relationship' | 'hierarchy';
    readingMode: 'glance' | 'editorial' | 'explore';
    placement: 'lead' | 'supporting' | 'appendix';
    takeaway?: string;
  };
  xAxis?: SceneAxisInput;
  yAxis?: SceneAxisInput;
  style: NormalizedSceneStyle;
};

type CategoricalBarSceneSpec = NormalizedSceneBase & {
  kind: 'bar';
  recipe: 'bar.grouped' | 'bar.stacked';
  orientation: 'horizontal' | 'vertical';
  baseline: number;
  categories: Array<{ id: string; label: string }>;
  series: Array<{ id: string; label: string }>;
  values: Array<{
    categoryId: string;
    seriesId: string;
    value: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type WaterfallSceneSpec = NormalizedSceneBase & {
  kind: 'bar';
  recipe: 'bar.waterfall';
  orientation: 'horizontal' | 'vertical';
  baseline: number;
  tolerance: number;
  steps: Array<{
    id: string;
    label: string;
    kind: 'start' | 'change' | 'subtotal' | 'total';
    start: number;
    end: number;
    delta: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type AreaSceneSpec = NormalizedSceneBase & {
  kind: 'line';
  recipe: 'line.area';
  baseline: number;
  series: [
    {
      id: string;
      label: string;
      unit?: string;
      points: Array<{
        x: string | number;
        y: number;
        emphasis?: boolean;
        evidenceIds?: string[];
      }>;
      emphasis?: boolean;
      evidenceIds?: string[];
    },
  ];
};

type DumbbellSceneSpec = NormalizedSceneBase & {
  kind: 'pair';
  recipe: 'pair.dumbbell';
  endpoints: [{ id: string; label: string }, { id: string; label: string }];
  rows: Array<{
    id: string;
    label: string;
    first: number;
    second: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type BoxSceneSpec = NormalizedSceneBase & {
  kind: 'distribution';
  recipe: 'distribution.box';
  data: Array<{
    id: string;
    label: string;
    n: number;
    lowerWhisker: number;
    q1: number;
    median: number;
    q3: number;
    upperWhisker: number;
    outliers?: number[];
    whiskerMeaning: 'min-max' | 'tukey-1.5-iqr' | 'custom';
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type WaffleSceneSpec = NormalizedSceneBase & {
  kind: 'composition';
  recipe: 'composition.waffle';
  total: number;
  unit: number;
  parts: Array<{
    id: string;
    label: string;
    value: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type FunnelSceneSpec = NormalizedSceneBase & {
  kind: 'flow';
  recipe: 'flow.funnel';
  stages: Array<{
    id: string;
    label: string;
    value: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type LineageSceneSpec = NormalizedSceneBase & {
  kind: 'timeline';
  recipe: 'timeline.lineage';
  events: Array<{
    id: string;
    label: string;
    at: number | string;
    state: 'past' | 'current' | 'future' | 'blocked';
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type HierarchySceneSpec = NormalizedSceneBase & {
  kind: 'hierarchy';
  recipe: 'hierarchy.tree';
  nodes: Array<{
    id: string;
    label: string;
    parentId?: string;
    value?: number;
    state: 'neutral' | 'current' | 'complete' | 'blocked';
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type BipolarSceneSpec = NormalizedSceneBase & {
  kind: 'scale';
  recipe: 'scale.bipolar';
  domain: [number, number];
  center: number;
  endpoints: [{ id: string; label: string }, { id: string; label: string }];
  items: Array<{
    id: string;
    label: string;
    value: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type RainfallSceneSpec = NormalizedSceneBase & {
  kind: 'sequence';
  recipe: 'sequence.rainfall';
  series: [{ id: string; label: string }, { id: string; label: string }];
  points: Array<{
    id: string;
    label: string;
    first: number;
    second: number;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type NormalizedSceneSpec =
  | CategoricalBarSceneSpec
  | WaterfallSceneSpec
  | AreaSceneSpec
  | DumbbellSceneSpec
  | BoxSceneSpec
  | WaffleSceneSpec
  | FunnelSceneSpec
  | LineageSceneSpec
  | HierarchySceneSpec
  | BipolarSceneSpec
  | RainfallSceneSpec;

type PrimitiveInput<T = ReportChartScenePrimitive> = T extends ReportChartScenePrimitive ? Omit<T, 'id'> : never;

type SceneBuilder = {
  primitives: ReportChartScenePrimitive[];
  marks: ReportChartSceneMark[];
  axes: ReportChartSceneAxis[];
  legend: ReportChartSceneLegendEntry[];
  add: (primitive: PrimitiveInput) => string;
};

type SceneFrame = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const BASE_WIDTH = 720;
const LABEL_FONT_SIZE = 15;
const SECONDARY_FONT_SIZE = 13;
const SERIES_TONES: ReportChartSceneTone[] = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];

const round = (value: number): number => Math.round(value * 1_000) / 1_000;
const coordinate = (value: number): string => String(round(value));

const createBuilder = (): SceneBuilder => {
  const primitives: ReportChartScenePrimitive[] = [];
  return {
    primitives,
    marks: [],
    axes: [],
    legend: [],
    add: (primitive) => {
      const id = `primitive-${primitives.length + 1}`;
      primitives.push({ ...primitive, id } as ReportChartScenePrimitive);
      return id;
    },
  };
};

const seriesTone = (index: number): ReportChartSceneTone => SERIES_TONES[index % SERIES_TONES.length];

const formatNumber = (value: number): string => {
  if (Object.is(value, -0)) return '0';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000 || (absolute > 0 && absolute < 0.001)) return value.toExponential(2);
  const decimals = absolute < 10 ? 3 : absolute < 100 ? 2 : absolute < 1_000 ? 1 : 0;
  const fixed = value
    .toFixed(decimals)
    .replace(/\.0+$/u, '')
    .replace(/(\.\d*?)0+$/u, '$1');
  const [integer, fraction] = fixed.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
};

const formatMeasure = (value: number, unit?: string): string => `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
const signedMeasure = (value: number, unit?: string): string =>
  `${value > 0 ? '+' : ''}${formatNumber(value)}${unit ? ` ${unit}` : ''}`;

const truncate = (value: string, maximum = 24): string =>
  Array.from(value).length > maximum
    ? `${Array.from(value)
        .slice(0, Math.max(1, maximum - 3))
        .join('')}...`
    : value;

const inheritedEvidenceIds = (...candidates: Array<string[] | undefined>): string[] => [
  ...new Set(candidates.find((candidate) => candidate?.length) || []),
];

const extent = (values: number[], includeZero = false): [number, number] => {
  const finite = values.filter(Number.isFinite);
  let minimum = finite.length ? Math.min(...finite) : 0;
  let maximum = finite.length ? Math.max(...finite) : 1;
  if (includeZero) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  if (minimum === maximum) {
    const padding = Math.abs(minimum || 1) * 0.1;
    return [minimum - padding, maximum + padding];
  }
  return [minimum, maximum];
};

const resolveDomain = (
  values: number[],
  axis?: SceneAxisInput,
  includeZero = false,
  paddingRatio = 0.06
): [number, number] => {
  const [minimum, maximum] = extent(values, includeZero);
  const span = maximum - minimum;
  let low = axis?.min ?? minimum - span * paddingRatio;
  let high = axis?.max ?? maximum + span * paddingRatio;
  if (axis?.min === undefined && includeZero && minimum === 0) low = 0;
  if (axis?.max === undefined && includeZero && maximum === 0) high = 0;
  if (low === high) high = low + 1;
  return [low, high];
};

const scaleLinear = (value: number, domain: [number, number], range: [number, number]): number => {
  const ratio = (value - domain[0]) / (domain[1] - domain[0] || 1);
  return round(range[0] + ratio * (range[1] - range[0]));
};

const niceStep = (span: number, requestedTicks: number): number => {
  const rough = Math.abs(span) / Math.max(1, requestedTicks);
  if (!Number.isFinite(rough) || rough === 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiple * power;
};

const numericTicks = (domain: [number, number], range: [number, number], requested = 5): ReportChartSceneTick[] => {
  const step = niceStep(domain[1] - domain[0], requested);
  const first = Math.ceil(domain[0] / step) * step;
  const ticks: ReportChartSceneTick[] = [];
  for (let value = first, index = 0; value <= domain[1] + step * 1e-8 && index < 64; value += step, index += 1) {
    const normalized = Math.abs(value) < step * 1e-10 ? 0 : round(value);
    ticks.push({
      id: `tick-${index + 1}`,
      value: normalized,
      label: formatNumber(normalized),
      position: scaleLinear(normalized, domain, range),
    });
  }
  if (!ticks.length) {
    return [
      { id: 'tick-1', value: domain[0], label: formatNumber(domain[0]), position: range[0] },
      { id: 'tick-2', value: domain[1], label: formatNumber(domain[1]), position: range[1] },
    ];
  }
  return ticks;
};

const formatTimeTick = (value: number): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return formatNumber(value);
  return date.toISOString().slice(0, 10);
};

const addLinearAxis = (
  builder: SceneBuilder,
  input: {
    id: 'x' | 'y';
    orientation: 'bottom' | 'left';
    domain: [number, number];
    range: [number, number];
    crossPosition: number;
    plotStart: number;
    plotEnd: number;
    axis?: SceneAxisInput;
    grid?: boolean;
    scale?: 'linear' | 'time';
  }
): void => {
  const ticks = numericTicks(input.domain, input.range);
  if (input.scale === 'time') {
    ticks.forEach((tick) => {
      if (typeof tick.value === 'number') tick.label = formatTimeTick(tick.value);
    });
  }
  builder.axes.push({
    id: input.id,
    orientation: input.orientation,
    scale: input.scale || 'linear',
    domain: input.domain,
    range: input.range,
    label: input.axis?.label,
    unit: input.axis?.unit,
    ticks,
  });
  builder.add({
    type: 'line',
    role: 'axis',
    stroke: 'ink',
    strokeWidth: 1,
    ...(input.orientation === 'bottom'
      ? { x1: input.range[0], y1: input.crossPosition, x2: input.range[1], y2: input.crossPosition }
      : { x1: input.crossPosition, y1: input.range[0], x2: input.crossPosition, y2: input.range[1] }),
  });
  ticks.forEach((tick) => {
    if (input.grid) {
      builder.add({
        type: 'line',
        role: 'grid',
        stroke: 'grid',
        strokeWidth: 1,
        opacity: 0.64,
        ...(input.orientation === 'bottom'
          ? { x1: tick.position, y1: input.plotStart, x2: tick.position, y2: input.plotEnd }
          : { x1: input.plotStart, y1: tick.position, x2: input.plotEnd, y2: tick.position }),
      });
    }
    builder.add({
      type: 'text',
      role: 'label',
      fill: 'muted',
      x: input.orientation === 'bottom' ? tick.position : input.crossPosition - 10,
      y: input.orientation === 'bottom' ? input.crossPosition + 22 : tick.position,
      text: tick.label,
      anchor: input.orientation === 'bottom' ? 'middle' : 'end',
      baseline: 'middle',
      fontSize: SECONDARY_FONT_SIZE,
      fontWeight: 500,
    });
  });
};

const addCategoryAxis = (
  builder: SceneBuilder,
  input: {
    id: 'x' | 'y';
    orientation: 'bottom' | 'left';
    categories: Array<{ id: string; label: string; position: number }>;
    range: [number, number];
    crossPosition: number;
    label?: string;
    unit?: string;
    maxLabelLength?: number;
    rotate?: boolean;
  }
): void => {
  builder.axes.push({
    id: input.id,
    orientation: input.orientation,
    scale: 'category',
    domain: input.categories.map((category) => category.id),
    range: input.range,
    label: input.label,
    unit: input.unit,
    ticks: input.categories.map((category, index) => ({
      id: `tick-${index + 1}`,
      value: category.id,
      label: category.label,
      position: category.position,
    })),
  });
  builder.add({
    type: 'line',
    role: 'axis',
    stroke: 'ink',
    strokeWidth: 1,
    ...(input.orientation === 'bottom'
      ? { x1: input.range[0], y1: input.crossPosition, x2: input.range[1], y2: input.crossPosition }
      : { x1: input.crossPosition, y1: input.range[0], x2: input.crossPosition, y2: input.range[1] }),
  });
  input.categories.forEach((category) => {
    builder.add({
      type: 'text',
      role: 'label',
      fill: 'ink',
      x: input.orientation === 'bottom' ? category.position : input.crossPosition - 12,
      y: input.orientation === 'bottom' ? input.crossPosition + (input.rotate ? 16 : 24) : category.position,
      text: truncate(category.label, input.maxLabelLength || 22),
      anchor: input.orientation === 'bottom' ? (input.rotate ? 'end' : 'middle') : 'end',
      baseline: input.orientation === 'bottom' ? 'hanging' : 'middle',
      fontSize: LABEL_FONT_SIZE,
      rotation: input.orientation === 'bottom' && input.rotate ? -38 : undefined,
    });
  });
};

const addAxisTitles = (
  builder: SceneBuilder,
  frame: SceneFrame,
  xAxis?: SceneAxisInput,
  yAxis?: SceneAxisInput
): void => {
  const xTitle = xAxis?.label ? `${xAxis.label}${xAxis.unit ? ` (${xAxis.unit})` : ''}` : undefined;
  const yTitle = yAxis?.label ? `${yAxis.label}${yAxis.unit ? ` (${yAxis.unit})` : ''}` : undefined;
  if (xTitle) {
    builder.add({
      type: 'text',
      role: 'label',
      fill: 'muted',
      x: frame.width - frame.right,
      y: frame.height - 10,
      text: truncate(xTitle, 56),
      anchor: 'end',
      fontSize: SECONDARY_FONT_SIZE,
      fontWeight: 500,
    });
  }
  if (yTitle) {
    builder.add({
      type: 'text',
      role: 'label',
      fill: 'muted',
      x: 16,
      y: (frame.top + frame.height - frame.bottom) / 2,
      text: truncate(yTitle, 40),
      anchor: 'middle',
      fontSize: SECONDARY_FONT_SIZE,
      fontWeight: 500,
      rotation: -90,
    });
  }
};

const addLegend = (builder: SceneBuilder, frame: SceneFrame, entries: ReportChartSceneLegendEntry[]): void => {
  builder.legend.push(...entries);
  const entriesPerRow = Math.min(4, Math.max(1, entries.length));
  const itemWidth = (frame.width - frame.left - frame.right) / entriesPerRow;
  entries.forEach((entry, index) => {
    const x = frame.left + (index % entriesPerRow) * itemWidth;
    const y = 14 + Math.floor(index / entriesPerRow) * 24;
    if (entry.symbol === 'line') {
      builder.add({
        type: 'line',
        role: 'annotation',
        stroke: entry.tone,
        strokeWidth: 2,
        x1: x,
        y1: y,
        x2: x + 16,
        y2: y,
      });
    } else if (entry.symbol === 'circle' || entry.symbol === 'circle-outline') {
      builder.add({
        type: 'circle',
        role: 'annotation',
        fill: entry.symbol === 'circle' ? entry.tone : 'background',
        stroke: entry.tone,
        strokeWidth: 1.5,
        cx: x + 7,
        cy: y,
        r: 5,
      });
    } else {
      builder.add({ type: 'rect', role: 'annotation', fill: entry.tone, x, y: y - 6, width: 14, height: 12, rx: 2 });
    }
    builder.add({
      type: 'text',
      role: 'label',
      fill: 'muted',
      x: x + 22,
      y,
      text: truncate(entry.label, 24),
      baseline: 'middle',
      fontSize: SECONDARY_FONT_SIZE,
      fontWeight: 500,
    });
  });
};

const addMark = (
  builder: SceneBuilder,
  mark: Omit<ReportChartSceneMark, 'primitiveIds'>,
  primitiveIds: string[]
): void => {
  builder.marks.push({ ...mark, primitiveIds });
};

const barFrame = (
  categoryCount: number,
  seriesCount: number,
  orientation: 'horizontal' | 'vertical',
  compact: boolean
): SceneFrame => {
  if (orientation === 'horizontal') {
    return {
      width: BASE_WIDTH,
      height: Math.max(330, 58 + categoryCount * Math.max(compact ? 36 : 44, seriesCount * 18 + 18) + 72),
      left: 164,
      right: 72,
      top: 42,
      bottom: 58,
    };
  }
  const categoryWidth = Math.max(compact ? 60 : 72, seriesCount * (compact ? 13 : 17) + 24);
  return {
    width: Math.min(2_400, Math.max(BASE_WIDTH, 74 + categoryCount * categoryWidth + 32)),
    height: compact ? 420 : 470,
    left: 68,
    right: 30,
    top: 42,
    bottom: 84,
  };
};

const compileCategoricalBars = (spec: CategoricalBarSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const frame = barFrame(spec.categories.length, spec.series.length, spec.orientation, compact);
  if (spec.style.showLegend) frame.top += Math.ceil(spec.series.length / 4) * 24;
  if (spec.orientation === 'horizontal' && spec.style.directLabels) frame.right = 128;
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const plotWidth = plotRight - frame.left;
  const plotHeight = plotBottom - frame.top;
  const baseline = spec.baseline ?? 0;
  const valueByPair = new Map(spec.values.map((value) => [`${value.categoryId}\u0000${value.seriesId}`, value]));
  const categoryTotals = spec.categories.map((category) =>
    spec.series.reduce(
      (total, series) => total + (valueByPair.get(`${category.id}\u0000${series.id}`)?.value || 0),
      baseline
    )
  );
  const rawValues = spec.values.map((value) => value.value);
  const valueAxis = spec.orientation === 'vertical' ? spec.yAxis : spec.xAxis;
  const domain = resolveDomain(
    spec.recipe === 'bar.stacked' ? [...categoryTotals, baseline] : [...rawValues, baseline],
    valueAxis,
    baseline === 0,
    0.08
  );
  const valueRange: [number, number] =
    spec.orientation === 'vertical' ? [plotBottom, frame.top] : [frame.left, plotRight];
  const groupSpan = (spec.orientation === 'vertical' ? plotWidth : plotHeight) / spec.categories.length;
  const categoryPositions = spec.categories.map((category, index) => ({
    id: category.id,
    label: category.label,
    position: round((spec.orientation === 'vertical' ? frame.left : frame.top) + groupSpan * (index + 0.5)),
  }));

  if (spec.orientation === 'vertical') {
    addLinearAxis(builder, {
      id: 'y',
      orientation: 'left',
      domain,
      range: [plotBottom, frame.top],
      crossPosition: frame.left,
      plotStart: frame.left,
      plotEnd: plotRight,
      axis: spec.yAxis,
      grid: spec.style.showGrid,
    });
    addCategoryAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      categories: categoryPositions,
      range: [frame.left, plotRight],
      crossPosition: plotBottom,
      label: spec.xAxis?.label,
      unit: spec.xAxis?.unit,
      maxLabelLength: 20,
      rotate: groupSpan < 84,
    });
  } else {
    addLinearAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      domain,
      range: [frame.left, plotRight],
      crossPosition: plotBottom,
      plotStart: frame.top,
      plotEnd: plotBottom,
      axis: spec.xAxis,
      grid: spec.style.showGrid,
    });
    addCategoryAxis(builder, {
      id: 'y',
      orientation: 'left',
      categories: categoryPositions,
      range: [frame.top, plotBottom],
      crossPosition: frame.left,
      label: spec.yAxis?.label,
      unit: spec.yAxis?.unit,
      maxLabelLength: 21,
    });
  }

  const legend = spec.series.map((series, index) => ({
    id: series.id,
    label: series.label,
    tone: seriesTone(index),
    symbol: 'rect' as const,
  }));
  if (spec.style.showLegend) addLegend(builder, frame, legend);
  else builder.legend.push(...legend);

  spec.categories.forEach((category, categoryIndex) => {
    let stackValue = baseline;
    spec.series.forEach((series, seriesIndex) => {
      const datum = valueByPair.get(`${category.id}\u0000${series.id}`);
      if (!datum) return;
      const markId = `${spec.recipe}:${category.id}:${series.id}`;
      const tone = seriesTone(seriesIndex);
      const primitiveIds: string[] = [];
      const bandStart = (spec.orientation === 'vertical' ? frame.left : frame.top) + categoryIndex * groupSpan;
      const groupFraction = spec.recipe === 'bar.grouped' ? 0.72 : 0.68;
      const usable = groupSpan * groupFraction;
      const outerOffset = (groupSpan - usable) / 2;
      const gap = spec.recipe === 'bar.grouped' ? Math.min(4, Math.max(2, usable * 0.025)) : 0;
      const barBreadth =
        spec.recipe === 'bar.grouped'
          ? Math.max(2, (usable - gap * Math.max(0, spec.series.length - 1)) / spec.series.length)
          : usable;
      const categoricalStart =
        spec.recipe === 'bar.grouped'
          ? bandStart + outerOffset + seriesIndex * (barBreadth + gap)
          : bandStart + outerOffset;
      const startValue = spec.recipe === 'bar.stacked' ? stackValue : baseline;
      const endValue = spec.recipe === 'bar.stacked' ? stackValue + datum.value : datum.value;
      if (spec.recipe === 'bar.stacked') stackValue = endValue;
      const startPosition = scaleLinear(startValue, domain, valueRange);
      const endPosition = scaleLinear(endValue, domain, valueRange);
      const rect =
        spec.orientation === 'vertical'
          ? {
              x: round(categoricalStart),
              y: Math.min(startPosition, endPosition),
              width: round(barBreadth),
              height: Math.max(1, round(Math.abs(endPosition - startPosition))),
            }
          : {
              x: Math.min(startPosition, endPosition),
              y: round(categoricalStart),
              width: Math.max(1, round(Math.abs(endPosition - startPosition))),
              height: round(barBreadth),
            };
      if (datum.emphasis) {
        primitiveIds.push(
          builder.add({
            type: 'rect',
            role: 'background',
            markId,
            fill: 'emphasis',
            opacity: 0.13,
            x: rect.x - 3,
            y: rect.y - 3,
            width: rect.width + 6,
            height: rect.height + 6,
            rx: 3,
          })
        );
      }
      primitiveIds.push(
        builder.add({
          type: 'rect',
          role: 'data',
          markId,
          fill: tone,
          stroke: spec.recipe === 'bar.stacked' ? 'background' : undefined,
          strokeWidth: spec.recipe === 'bar.stacked' ? 1 : undefined,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          rx: 1,
        })
      );
      const pixelLength = spec.orientation === 'vertical' ? rect.height : rect.width;
      const visibleDirectLabel =
        spec.recipe === 'bar.stacked' ? pixelLength >= 24 : barBreadth >= 34 || spec.series.length <= 2;
      if (spec.style.directLabels && visibleDirectLabel) {
        const positiveDirection = endPosition >= startPosition;
        primitiveIds.push(
          builder.add({
            type: 'text',
            role: 'label',
            markId,
            fill: spec.recipe === 'bar.stacked' || spec.orientation === 'vertical' ? 'background' : 'muted',
            x:
              spec.recipe === 'bar.stacked'
                ? rect.x + rect.width / 2
                : spec.orientation === 'vertical'
                  ? rect.x + rect.width / 2
                  : endPosition + (positiveDirection ? 7 : -7),
            y:
              spec.recipe === 'bar.stacked'
                ? rect.y + rect.height / 2
                : spec.orientation === 'vertical'
                  ? endPosition + (positiveDirection ? -8 : 13)
                  : rect.y + rect.height / 2,
            text: truncate(formatMeasure(datum.value, valueAxis?.unit), 18),
            anchor:
              spec.recipe === 'bar.stacked' || spec.orientation === 'vertical'
                ? 'middle'
                : positiveDirection
                  ? 'start'
                  : 'end',
            baseline: 'middle',
            fontSize: SECONDARY_FONT_SIZE,
            fontWeight: datum.emphasis ? 650 : 500,
          })
        );
      }
      addMark(
        builder,
        {
          id: markId,
          label: `${category.label} / ${series.label}`,
          value: datum.value,
          valueLabel: formatMeasure(datum.value, valueAxis?.unit),
          tone,
          evidenceIds: inheritedEvidenceIds(datum.evidenceIds, spec.evidenceIds),
          emphasis: datum.emphasis === true,
          readout: [
            { label: 'Category', value: category.label, formatted: category.label },
            { label: 'Series', value: series.label, formatted: series.label },
            {
              label: 'Value',
              value: datum.value,
              formatted: formatMeasure(datum.value, valueAxis?.unit),
              unit: valueAxis?.unit,
            },
            ...(datum.note ? [{ label: 'Note', value: datum.note, formatted: datum.note }] : []),
          ],
        },
        primitiveIds
      );
    });
    if (spec.recipe === 'bar.stacked' && spec.style.directLabels) {
      const total = categoryTotals[categoryIndex];
      const totalPosition = scaleLinear(total, domain, valueRange);
      builder.add({
        type: 'text',
        role: 'annotation',
        fill: 'ink',
        x: spec.orientation === 'vertical' ? categoryPositions[categoryIndex].position : totalPosition + 8,
        y: spec.orientation === 'vertical' ? totalPosition - 10 : categoryPositions[categoryIndex].position,
        text: formatMeasure(total - baseline, valueAxis?.unit),
        anchor: spec.orientation === 'vertical' ? 'middle' : 'start',
        baseline: 'middle',
        fontSize: SECONDARY_FONT_SIZE,
        fontWeight: 650,
      });
    }
  });
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const compileWaterfall = (spec: WaterfallSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const frame = barFrame(spec.steps.length, 1, spec.orientation, compact);
  if (spec.orientation === 'horizontal' && spec.style.directLabels) frame.right = 128;
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const plotWidth = plotRight - frame.left;
  const plotHeight = plotBottom - frame.top;
  const baseline = spec.baseline ?? 0;
  const valueAxis = spec.orientation === 'vertical' ? spec.yAxis : spec.xAxis;
  const domain = resolveDomain(
    [baseline, ...spec.steps.flatMap((step) => [step.start, step.end])],
    valueAxis,
    baseline === 0,
    0.08
  );
  const range: [number, number] = spec.orientation === 'vertical' ? [plotBottom, frame.top] : [frame.left, plotRight];
  const band = (spec.orientation === 'vertical' ? plotWidth : plotHeight) / spec.steps.length;
  const barWidth = band * 0.58;
  const centers = spec.steps.map((_, index) =>
    round((spec.orientation === 'vertical' ? frame.left : frame.top) + band * (index + 0.5))
  );
  if (spec.orientation === 'vertical') {
    addLinearAxis(builder, {
      id: 'y',
      orientation: 'left',
      domain,
      range,
      crossPosition: frame.left,
      plotStart: frame.left,
      plotEnd: plotRight,
      axis: spec.yAxis,
      grid: spec.style.showGrid,
    });
    addCategoryAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      categories: spec.steps.map((step, index) => ({ id: step.id, label: step.label, position: centers[index] })),
      range: [frame.left, plotRight],
      crossPosition: plotBottom,
      label: spec.xAxis?.label,
      unit: spec.xAxis?.unit,
      maxLabelLength: 18,
      rotate: band < 92,
    });
  } else {
    addLinearAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      domain,
      range,
      crossPosition: plotBottom,
      plotStart: frame.top,
      plotEnd: plotBottom,
      axis: spec.xAxis,
      grid: spec.style.showGrid,
    });
    addCategoryAxis(builder, {
      id: 'y',
      orientation: 'left',
      categories: spec.steps.map((step, index) => ({ id: step.id, label: step.label, position: centers[index] })),
      range: [frame.top, plotBottom],
      crossPosition: frame.left,
      label: spec.yAxis?.label,
      unit: spec.yAxis?.unit,
      maxLabelLength: 20,
    });
  }
  spec.steps.forEach((step, index) => {
    const markId = `bar.waterfall:${step.id}`;
    const isChange = step.kind === 'change';
    const startValue = isChange ? step.start : baseline;
    const endValue = step.end;
    const startPosition = scaleLinear(startValue, domain, range);
    const endPosition = scaleLinear(endValue, domain, range);
    const rect =
      spec.orientation === 'vertical'
        ? {
            x: round(centers[index] - barWidth / 2),
            y: Math.min(startPosition, endPosition),
            width: round(barWidth),
            height: Math.max(1, round(Math.abs(endPosition - startPosition))),
          }
        : {
            x: Math.min(startPosition, endPosition),
            y: round(centers[index] - barWidth / 2),
            width: Math.max(1, round(Math.abs(endPosition - startPosition))),
            height: round(barWidth),
          };
    const tone: ReportChartSceneTone = isChange
      ? step.delta > 0
        ? 'positive'
        : step.delta < 0
          ? 'negative'
          : 'muted'
      : step.kind === 'subtotal'
        ? 'series-2'
        : 'ink';
    const primitiveIds: string[] = [];
    if (step.emphasis) {
      primitiveIds.push(
        builder.add({
          type: 'rect',
          role: 'background',
          markId,
          fill: 'emphasis',
          opacity: 0.13,
          x: rect.x - 3,
          y: rect.y - 3,
          width: rect.width + 6,
          height: rect.height + 6,
          rx: 3,
        })
      );
    }
    primitiveIds.push(
      builder.add({
        type: 'rect',
        role: 'data',
        markId,
        fill: tone,
        stroke: isChange && step.delta < 0 ? 'ink' : undefined,
        strokeWidth: isChange && step.delta < 0 ? 1 : undefined,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rx: 1,
      })
    );
    if (spec.style.directLabels) {
      const displayedValue = isChange ? step.delta : step.end;
      const positiveDirection = endPosition >= startPosition;
      primitiveIds.push(
        builder.add({
          type: 'text',
          role: 'label',
          markId,
          fill: spec.orientation === 'vertical' ? 'background' : tone === 'ink' ? 'ink' : 'muted',
          x: spec.orientation === 'vertical' ? centers[index] : endPosition + (positiveDirection ? 7 : -7),
          y:
            spec.orientation === 'vertical'
              ? Math.max(frame.top + 10, endPosition + (positiveDirection ? -9 : 13))
              : centers[index],
          text: isChange
            ? signedMeasure(displayedValue, valueAxis?.unit)
            : formatMeasure(displayedValue, valueAxis?.unit),
          anchor: spec.orientation === 'vertical' ? 'middle' : positiveDirection ? 'start' : 'end',
          baseline: 'middle',
          fontSize: SECONDARY_FONT_SIZE,
          fontWeight: step.emphasis || !isChange ? 650 : 500,
        })
      );
    }
    addMark(
      builder,
      {
        id: markId,
        label: step.label,
        value: isChange ? step.delta : step.end,
        valueLabel: isChange ? signedMeasure(step.delta, valueAxis?.unit) : formatMeasure(step.end, valueAxis?.unit),
        tone,
        evidenceIds: inheritedEvidenceIds(step.evidenceIds, spec.evidenceIds),
        emphasis: step.emphasis === true,
        readout: [
          { label: 'Kind', value: step.kind, formatted: step.kind },
          {
            label: 'Start',
            value: step.start,
            formatted: formatMeasure(step.start, valueAxis?.unit),
            unit: valueAxis?.unit,
          },
          {
            label: 'End',
            value: step.end,
            formatted: formatMeasure(step.end, valueAxis?.unit),
            unit: valueAxis?.unit,
          },
          {
            label: 'Delta',
            value: step.delta,
            formatted: signedMeasure(step.delta, valueAxis?.unit),
            unit: valueAxis?.unit,
          },
          ...(step.note ? [{ label: 'Note', value: step.note, formatted: step.note }] : []),
        ],
      },
      primitiveIds
    );
    const next = spec.steps[index + 1];
    if (next) {
      builder.add({
        type: 'line',
        role: 'connector',
        stroke: 'muted',
        strokeWidth: 1,
        opacity: 0.72,
        dash: [3, 3],
        x1: spec.orientation === 'vertical' ? centers[index] + barWidth / 2 : scaleLinear(step.end, domain, range),
        y1: spec.orientation === 'vertical' ? scaleLinear(step.end, domain, range) : centers[index] + barWidth / 2,
        x2:
          spec.orientation === 'vertical' ? centers[index + 1] - barWidth / 2 : scaleLinear(next.start, domain, range),
        y2:
          spec.orientation === 'vertical' ? scaleLinear(next.start, domain, range) : centers[index + 1] - barWidth / 2,
      });
    }
  });
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const xValueFor = (value: string | number, scale: 'linear' | 'time' | 'category'): number => {
  if (scale === 'time') return typeof value === 'number' ? value : Date.parse(value);
  return typeof value === 'number' ? value : 0;
};

const compileArea = (spec: AreaSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const frame: SceneFrame = {
    width: BASE_WIDTH,
    height: compact ? 390 : 440,
    left: 68,
    right: 38,
    top: 34,
    bottom: 62,
  };
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const series = spec.series[0];
  const categorical = spec.xAxis?.scale !== 'time' && series.points.some((point) => typeof point.x === 'string');
  const xScale: 'linear' | 'time' | 'category' = categorical
    ? 'category'
    : spec.xAxis?.scale === 'time'
      ? 'time'
      : 'linear';
  const xNumeric = series.points.map((point, index) => (categorical ? index : xValueFor(point.x, xScale)));
  const xDomain = resolveDomain(xNumeric, categorical ? undefined : spec.xAxis, false, categorical ? 0 : 0.02);
  const yDomain = resolveDomain([spec.baseline, ...series.points.map((point) => point.y)], spec.yAxis, false, 0.08);
  const xRange: [number, number] = [frame.left, plotRight];
  const yRange: [number, number] = [plotBottom, frame.top];
  const positions = series.points.map((point, index) => ({
    x: categorical
      ? series.points.length === 1
        ? round((frame.left + plotRight) / 2)
        : scaleLinear(index, [0, series.points.length - 1], xRange)
      : scaleLinear(xNumeric[index], xDomain, xRange),
    y: scaleLinear(point.y, yDomain, yRange),
  }));
  if (categorical) {
    addCategoryAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      categories: series.points.map((point, index) => ({
        id: String(point.x),
        label: String(point.x),
        position: positions[index].x,
      })),
      range: xRange,
      crossPosition: plotBottom,
      label: spec.xAxis?.label,
      unit: spec.xAxis?.unit,
      maxLabelLength: 16,
      rotate: series.points.length > 7,
    });
  } else {
    addLinearAxis(builder, {
      id: 'x',
      orientation: 'bottom',
      domain: xDomain,
      range: xRange,
      crossPosition: plotBottom,
      plotStart: frame.top,
      plotEnd: plotBottom,
      axis: spec.xAxis,
      grid: spec.style.showGrid,
      scale: xScale === 'time' ? 'time' : 'linear',
    });
  }
  addLinearAxis(builder, {
    id: 'y',
    orientation: 'left',
    domain: yDomain,
    range: yRange,
    crossPosition: frame.left,
    plotStart: frame.left,
    plotEnd: plotRight,
    axis: spec.yAxis,
    grid: spec.style.showGrid,
  });
  const baselineY = scaleLinear(spec.baseline, yDomain, yRange);
  builder.add({
    type: 'line',
    role: 'annotation',
    stroke: 'ink',
    strokeWidth: 1,
    opacity: 0.72,
    x1: frame.left,
    y1: baselineY,
    x2: plotRight,
    y2: baselineY,
  });
  const pointPath = positions
    .map((point, index) => `${index ? 'L' : 'M'} ${coordinate(point.x)} ${coordinate(point.y)}`)
    .join(' ');
  const areaPath = positions.length
    ? `M ${coordinate(positions[0].x)} ${coordinate(baselineY)} ${pointPath.replace(/^M/u, 'L')} L ${coordinate(positions.at(-1)!.x)} ${coordinate(baselineY)} Z`
    : '';
  builder.add({ type: 'path', role: 'data', fill: 'series-1', opacity: 0.13, d: areaPath });
  builder.add({
    type: 'path',
    role: 'data',
    fill: 'none',
    stroke: 'series-1',
    strokeWidth: 2.15,
    lineJoin: 'round',
    lineCap: 'round',
    d: pointPath,
  });
  series.points.forEach((point, index) => {
    const markId = `line.area:${series.id}:${index}`;
    const primitiveIds: string[] = [];
    if (point.emphasis || series.emphasis) {
      primitiveIds.push(
        builder.add({
          type: 'circle',
          role: 'background',
          markId,
          fill: 'emphasis',
          opacity: 0.15,
          cx: positions[index].x,
          cy: positions[index].y,
          r: 8,
        })
      );
    }
    primitiveIds.push(
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: 'series-1',
        stroke: 'background',
        strokeWidth: 1.5,
        cx: positions[index].x,
        cy: positions[index].y,
        r: 3.5,
      })
    );
    addMark(
      builder,
      {
        id: markId,
        label: `${series.label} / ${String(point.x)}`,
        value: point.y,
        valueLabel: formatMeasure(point.y, series.unit || spec.yAxis?.unit),
        tone: 'series-1',
        evidenceIds: inheritedEvidenceIds(point.evidenceIds, series.evidenceIds, spec.evidenceIds),
        emphasis: point.emphasis === true || series.emphasis === true,
        readout: [
          { label: spec.xAxis?.label || 'X', value: point.x, formatted: String(point.x), unit: spec.xAxis?.unit },
          {
            label: spec.yAxis?.label || 'Value',
            value: point.y,
            formatted: formatMeasure(point.y, series.unit || spec.yAxis?.unit),
            unit: series.unit || spec.yAxis?.unit,
          },
          {
            label: 'Baseline',
            value: spec.baseline,
            formatted: formatMeasure(spec.baseline, series.unit || spec.yAxis?.unit),
            unit: series.unit || spec.yAxis?.unit,
          },
        ],
      },
      primitiveIds
    );
  });
  if (spec.style.directLabels && positions.length) {
    const last = positions.at(-1)!;
    builder.add({
      type: 'text',
      role: 'annotation',
      fill: 'ink',
      x: Math.min(plotRight - 2, last.x),
      y: Math.max(frame.top + 8, last.y - 12),
      text: `${truncate(series.label, 18)} · ${formatMeasure(series.points.at(-1)!.y, series.unit || spec.yAxis?.unit)}`,
      anchor: 'end',
      fontSize: SECONDARY_FONT_SIZE,
      fontWeight: 650,
    });
  }
  const legend = [{ id: series.id, label: series.label, tone: 'series-1' as const, symbol: 'line' as const }];
  if (spec.style.showLegend) addLegend(builder, frame, legend);
  else builder.legend.push(...legend);
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const rowFrame = (rowCount: number, compact: boolean, right = 104): SceneFrame => ({
  width: BASE_WIDTH,
  height: Math.max(320, 42 + rowCount * (compact ? 36 : 44) + 64),
  left: 172,
  right,
  top: 38,
  bottom: 54,
});

const compileDumbbell = (spec: DumbbellSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const frame = rowFrame(spec.rows.length, spec.style.density === 'compact', 112);
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const rowHeight = (plotBottom - frame.top) / spec.rows.length;
  const domain = resolveDomain(
    spec.rows.flatMap((row) => [row.first, row.second]),
    spec.xAxis,
    false,
    0.08
  );
  const range: [number, number] = [frame.left, plotRight];
  addLinearAxis(builder, {
    id: 'x',
    orientation: 'bottom',
    domain,
    range,
    crossPosition: plotBottom,
    plotStart: frame.top,
    plotEnd: plotBottom,
    axis: spec.xAxis,
    grid: spec.style.showGrid,
  });
  addCategoryAxis(builder, {
    id: 'y',
    orientation: 'left',
    categories: spec.rows.map((row, index) => ({
      id: row.id,
      label: row.label,
      position: round(frame.top + rowHeight * (index + 0.5)),
    })),
    range: [frame.top, plotBottom],
    crossPosition: frame.left,
    label: spec.yAxis?.label,
    unit: spec.yAxis?.unit,
    maxLabelLength: 22,
  });
  const legend: ReportChartSceneLegendEntry[] = [
    { id: spec.endpoints[0].id, label: spec.endpoints[0].label, tone: 'series-1', symbol: 'circle-outline' },
    { id: spec.endpoints[1].id, label: spec.endpoints[1].label, tone: 'series-1', symbol: 'circle' },
  ];
  if (spec.style.showLegend) addLegend(builder, frame, legend);
  else builder.legend.push(...legend);
  spec.rows.forEach((row, index) => {
    const y = round(frame.top + rowHeight * (index + 0.5));
    const firstX = scaleLinear(row.first, domain, range);
    const secondX = scaleLinear(row.second, domain, range);
    const delta = row.second - row.first;
    const labelsAreClose = Math.abs(secondX - firstX) < 56;
    const markId = `pair.dumbbell:${row.id}`;
    const primitiveIds: string[] = [];
    if (row.emphasis) {
      primitiveIds.push(
        builder.add({
          type: 'rect',
          role: 'background',
          markId,
          fill: 'emphasis',
          opacity: 0.12,
          x: Math.min(firstX, secondX) - 9,
          y: y - 11,
          width: Math.abs(secondX - firstX) + 18,
          height: 22,
          rx: 3,
        })
      );
    }
    primitiveIds.push(
      builder.add({
        type: 'line',
        role: 'connector',
        markId,
        stroke: 'muted',
        strokeWidth: 1.5,
        x1: firstX,
        y1: y,
        x2: secondX,
        y2: y,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: 'background',
        stroke: 'series-1',
        strokeWidth: 2,
        cx: firstX,
        cy: y,
        r: 5,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: 'series-1',
        stroke: 'background',
        strokeWidth: 1.2,
        cx: secondX,
        cy: y,
        r: 5.5,
      })
    );
    if (spec.style.directLabels) {
      primitiveIds.push(
        builder.add({
          type: 'text',
          role: 'label',
          markId,
          fill: 'muted',
          x: firstX,
          y: y - 11,
          text: formatNumber(row.first),
          anchor: 'middle',
          fontSize: SECONDARY_FONT_SIZE,
        }),
        builder.add({
          type: 'text',
          role: 'label',
          markId,
          fill: 'ink',
          x: secondX,
          y: labelsAreClose ? y + 16 : y - 11,
          text: formatNumber(row.second),
          anchor: 'middle',
          fontSize: SECONDARY_FONT_SIZE,
          fontWeight: 650,
        }),
        builder.add({
          type: 'text',
          role: 'annotation',
          markId,
          fill: delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'muted',
          x: plotRight + 12,
          y,
          text: signedMeasure(delta, spec.xAxis?.unit),
          baseline: 'middle',
          fontSize: SECONDARY_FONT_SIZE,
          fontWeight: 650,
        })
      );
    }
    addMark(
      builder,
      {
        id: markId,
        label: row.label,
        value: delta,
        valueLabel: signedMeasure(delta, spec.xAxis?.unit),
        tone: delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'muted',
        evidenceIds: inheritedEvidenceIds(row.evidenceIds, spec.evidenceIds),
        emphasis: row.emphasis === true,
        readout: [
          {
            label: spec.endpoints[0].label,
            value: row.first,
            formatted: formatMeasure(row.first, spec.xAxis?.unit),
            unit: spec.xAxis?.unit,
          },
          {
            label: spec.endpoints[1].label,
            value: row.second,
            formatted: formatMeasure(row.second, spec.xAxis?.unit),
            unit: spec.xAxis?.unit,
          },
          { label: 'Delta', value: delta, formatted: signedMeasure(delta, spec.xAxis?.unit), unit: spec.xAxis?.unit },
          ...(row.note ? [{ label: 'Note', value: row.note, formatted: row.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const compileBox = (spec: BoxSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const frame = rowFrame(spec.data.length, spec.style.density === 'compact', 126);
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const rowHeight = (plotBottom - frame.top) / spec.data.length;
  const domain = resolveDomain(
    spec.data.flatMap((item) => [item.lowerWhisker, item.upperWhisker, ...(item.outliers || [])]),
    spec.xAxis,
    false,
    0.08
  );
  const range: [number, number] = [frame.left, plotRight];
  addLinearAxis(builder, {
    id: 'x',
    orientation: 'bottom',
    domain,
    range,
    crossPosition: plotBottom,
    plotStart: frame.top,
    plotEnd: plotBottom,
    axis: spec.xAxis,
    grid: spec.style.showGrid,
  });
  addCategoryAxis(builder, {
    id: 'y',
    orientation: 'left',
    categories: spec.data.map((item, index) => ({
      id: item.id,
      label: item.label,
      position: round(frame.top + rowHeight * (index + 0.5)),
    })),
    range: [frame.top, plotBottom],
    crossPosition: frame.left,
    label: spec.yAxis?.label,
    unit: spec.yAxis?.unit,
    maxLabelLength: 22,
  });
  const legend: ReportChartSceneLegendEntry[] = [
    { id: 'iqr', label: 'IQR', tone: 'series-1', symbol: 'rect' },
    { id: 'median', label: 'Median', tone: 'ink', symbol: 'line' },
    { id: 'outlier', label: 'Outlier', tone: 'series-1', symbol: 'circle-outline' },
  ];
  if (spec.style.showLegend) addLegend(builder, frame, legend);
  else builder.legend.push(...legend);
  spec.data.forEach((item, index) => {
    const y = round(frame.top + rowHeight * (index + 0.5));
    const boxHeight = Math.min(24, rowHeight * 0.52);
    const lower = scaleLinear(item.lowerWhisker, domain, range);
    const q1 = scaleLinear(item.q1, domain, range);
    const median = scaleLinear(item.median, domain, range);
    const q3 = scaleLinear(item.q3, domain, range);
    const upper = scaleLinear(item.upperWhisker, domain, range);
    const markId = `distribution.box:${item.id}`;
    const primitiveIds: string[] = [];
    if (item.emphasis) {
      primitiveIds.push(
        builder.add({
          type: 'rect',
          role: 'background',
          markId,
          fill: 'emphasis',
          opacity: 0.12,
          x: lower - 8,
          y: y - boxHeight / 2 - 5,
          width: upper - lower + 16,
          height: boxHeight + 10,
          rx: 3,
        })
      );
    }
    primitiveIds.push(
      builder.add({
        type: 'line',
        role: 'connector',
        markId,
        stroke: 'muted',
        strokeWidth: 1.5,
        x1: lower,
        y1: y,
        x2: upper,
        y2: y,
      }),
      builder.add({
        type: 'line',
        role: 'data',
        markId,
        stroke: 'muted',
        strokeWidth: 1.5,
        x1: lower,
        y1: y - boxHeight * 0.32,
        x2: lower,
        y2: y + boxHeight * 0.32,
      }),
      builder.add({
        type: 'line',
        role: 'data',
        markId,
        stroke: 'muted',
        strokeWidth: 1.5,
        x1: upper,
        y1: y - boxHeight * 0.32,
        x2: upper,
        y2: y + boxHeight * 0.32,
      }),
      builder.add({
        type: 'rect',
        role: 'data',
        markId,
        fill: 'surface',
        stroke: 'series-1',
        strokeWidth: 1.5,
        x: q1,
        y: y - boxHeight / 2,
        width: Math.max(1, q3 - q1),
        height: boxHeight,
        rx: 1,
      }),
      builder.add({
        type: 'line',
        role: 'data',
        markId,
        stroke: 'ink',
        strokeWidth: 2.3,
        x1: median,
        y1: y - boxHeight / 2,
        x2: median,
        y2: y + boxHeight / 2,
      })
    );
    (item.outliers || []).forEach((outlier) => {
      primitiveIds.push(
        builder.add({
          type: 'circle',
          role: 'data',
          markId,
          fill: 'background',
          stroke: 'series-1',
          strokeWidth: 1.3,
          cx: scaleLinear(outlier, domain, range),
          cy: y,
          r: 3.2,
        })
      );
    });
    if (spec.style.directLabels) {
      primitiveIds.push(
        builder.add({
          type: 'text',
          role: 'annotation',
          markId,
          fill: 'muted',
          x: plotRight + 10,
          y,
          text: `m ${formatNumber(item.median)} · n=${item.n}`,
          baseline: 'middle',
          fontSize: SECONDARY_FONT_SIZE,
          fontWeight: item.emphasis ? 650 : 500,
        })
      );
    }
    addMark(
      builder,
      {
        id: markId,
        label: item.label,
        value: item.median,
        valueLabel: formatMeasure(item.median, spec.xAxis?.unit),
        tone: 'series-1',
        evidenceIds: inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds),
        emphasis: item.emphasis === true,
        readout: [
          {
            label: 'Lower whisker',
            value: item.lowerWhisker,
            formatted: formatMeasure(item.lowerWhisker, spec.xAxis?.unit),
            unit: spec.xAxis?.unit,
          },
          { label: 'Q1', value: item.q1, formatted: formatMeasure(item.q1, spec.xAxis?.unit), unit: spec.xAxis?.unit },
          {
            label: 'Median',
            value: item.median,
            formatted: formatMeasure(item.median, spec.xAxis?.unit),
            unit: spec.xAxis?.unit,
          },
          { label: 'Q3', value: item.q3, formatted: formatMeasure(item.q3, spec.xAxis?.unit), unit: spec.xAxis?.unit },
          {
            label: 'Upper whisker',
            value: item.upperWhisker,
            formatted: formatMeasure(item.upperWhisker, spec.xAxis?.unit),
            unit: spec.xAxis?.unit,
          },
          { label: 'n', value: item.n, formatted: formatNumber(item.n) },
          { label: 'Whiskers', value: item.whiskerMeaning, formatted: item.whiskerMeaning },
          ...(item.note ? [{ label: 'Note', value: item.note, formatted: item.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const compileWaffle = (spec: WaffleSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const totalCellUnits = spec.total / spec.unit;
  const cellCount = Math.ceil(totalCellUnits);
  if (cellCount > 100) throw new Error('composition.waffle supports at most 100 cells; increase unit');
  const columns = Math.min(10, Math.max(1, cellCount));
  const rows = Math.ceil(cellCount / columns);
  const cellSize = compact ? 23 : 27;
  const gap = compact ? 4 : 5;
  const inner = cellSize - gap;
  const gridWidth = columns * cellSize;
  const gridHeight = rows * cellSize;
  const frame: SceneFrame = {
    width: BASE_WIDTH,
    height: Math.max(270, gridHeight + 94, 42 + spec.parts.length * 31 + 24),
    left: 52,
    right: 260,
    top: 42,
    bottom: 48,
  };
  const gridX = frame.left;
  const gridY = frame.top;
  for (let index = 0; index < cellCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    builder.add({
      type: 'rect',
      role: 'background',
      fill: 'surface',
      stroke: 'grid',
      strokeWidth: 1,
      x: gridX + column * cellSize,
      y: gridY + row * cellSize,
      width: inner,
      height: inner,
      rx: 2,
    });
  }
  let offset = 0;
  const legend: ReportChartSceneLegendEntry[] = [];
  spec.parts.forEach((part, partIndex) => {
    const tone = seriesTone(partIndex);
    const markId = `composition.waffle:${part.id}`;
    const primitiveIds: string[] = [];
    const start = offset;
    const end = offset + part.value / spec.unit;
    const firstCell = Math.floor(start);
    const lastCell = Math.ceil(end) - 1;
    for (let cellIndex = firstCell; cellIndex <= lastCell && cellIndex < cellCount; cellIndex += 1) {
      const fragmentStart = Math.max(start, cellIndex);
      const fragmentEnd = Math.min(end, cellIndex + 1, totalCellUnits);
      const fraction = Math.max(0, fragmentEnd - fragmentStart);
      if (fraction <= 0) continue;
      const column = cellIndex % columns;
      const row = Math.floor(cellIndex / columns);
      const fractionOffset = fragmentStart - cellIndex;
      primitiveIds.push(
        builder.add({
          type: 'rect',
          role: 'data',
          markId,
          fill: tone,
          stroke: part.emphasis ? 'emphasis' : undefined,
          strokeWidth: part.emphasis ? 1.5 : undefined,
          x: round(gridX + column * cellSize + fractionOffset * inner),
          y: gridY + row * cellSize,
          width: Math.max(0.5, round(fraction * inner)),
          height: inner,
          rx: fraction >= 0.98 ? 2 : 0,
        })
      );
    }
    offset = end;
    const legendY = frame.top + partIndex * 31;
    primitiveIds.push(
      builder.add({
        type: 'rect',
        role: 'annotation',
        markId,
        fill: tone,
        stroke: part.emphasis ? 'emphasis' : undefined,
        strokeWidth: part.emphasis ? 1.5 : undefined,
        x: frame.width - frame.right + 42,
        y: legendY - 8,
        width: 16,
        height: 16,
        rx: 2,
      }),
      builder.add({
        type: 'text',
        role: 'label',
        markId,
        fill: part.emphasis ? 'ink' : 'muted',
        x: frame.width - frame.right + 68,
        y: legendY,
        text: `${truncate(part.label, 24)} · ${formatNumber(part.value)}`,
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: part.emphasis ? 650 : 500,
      })
    );
    legend.push({ id: part.id, label: part.label, tone, symbol: 'rect' });
    addMark(
      builder,
      {
        id: markId,
        label: part.label,
        value: part.value,
        valueLabel: `${formatNumber(part.value)} of ${formatNumber(spec.total)}`,
        tone,
        evidenceIds: inheritedEvidenceIds(part.evidenceIds, spec.evidenceIds),
        emphasis: part.emphasis === true,
        readout: [
          { label: 'Value', value: part.value, formatted: formatNumber(part.value) },
          { label: 'Total', value: spec.total, formatted: formatNumber(spec.total) },
          { label: 'Cell unit', value: spec.unit, formatted: formatNumber(spec.unit) },
          ...(part.note ? [{ label: 'Note', value: part.note, formatted: part.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  builder.legend.push(...legend);
  builder.add({
    type: 'text',
    role: 'annotation',
    fill: 'muted',
    x: gridX,
    y: gridY + gridHeight + 24,
    text: `${formatNumber(spec.total)} total · ${formatNumber(spec.unit)} per full cell`,
    fontSize: SECONDARY_FONT_SIZE,
    fontWeight: 500,
  });
  return finalizeScene(spec, frame, builder, { x: gridX, y: gridY, width: gridWidth, height: gridHeight });
};

const compileFunnel = (spec: FunnelSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const rowHeight = compact ? 48 : 56;
  const frame: SceneFrame = {
    width: BASE_WIDTH,
    height: Math.max(270, 50 + spec.stages.length * rowHeight + 42),
    left: 154,
    right: 128,
    top: 36,
    bottom: 34,
  };
  const plotRight = frame.width - frame.right;
  const plotWidth = plotRight - frame.left;
  const maximum = Math.max(...spec.stages.map((stage) => stage.value), 1);
  const first = spec.stages[0]?.value || 0;

  spec.stages.forEach((stage, index) => {
    const markId = `flow.funnel:${stage.id}`;
    const previous = index === 0 ? stage.value : spec.stages[index - 1].value;
    const width = Math.max(stage.value > 0 ? 3 : 0, (stage.value / maximum) * plotWidth);
    const x = frame.left + (plotWidth - width) / 2;
    const y = frame.top + index * rowHeight;
    const height = compact ? 30 : 36;
    const tone: ReportChartSceneTone = stage.emphasis ? 'emphasis' : index === 0 ? 'series-1' : 'series-2';
    const primitiveIds: string[] = [];
    if (index > 0) {
      primitiveIds.push(
        builder.add({
          type: 'line',
          role: 'connector',
          markId,
          stroke: 'grid',
          strokeWidth: 1,
          x1: frame.left + plotWidth / 2,
          y1: y - (rowHeight - height),
          x2: frame.left + plotWidth / 2,
          y2: y,
        })
      );
    }
    primitiveIds.push(
      builder.add({
        type: 'rect',
        role: 'data',
        markId,
        fill: tone,
        stroke: stage.emphasis ? 'ink' : undefined,
        strokeWidth: stage.emphasis ? 1.5 : undefined,
        opacity: index === 0 ? 0.92 : Math.max(0.58, 0.9 - index * 0.035),
        x,
        y,
        width,
        height,
        rx: 5,
      }),
      builder.add({
        type: 'text',
        role: 'label',
        markId,
        fill: stage.emphasis ? 'ink' : 'muted',
        x: frame.left - 14,
        y: y + height / 2,
        text: truncate(stage.label, 22),
        anchor: 'end',
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: stage.emphasis ? 650 : 550,
      }),
      builder.add({
        type: 'text',
        role: 'annotation',
        markId,
        fill: 'ink',
        x: plotRight + 14,
        y: y + height / 2,
        text: formatNumber(stage.value),
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: 650,
      })
    );
    const fromPrevious = previous > 0 ? (stage.value / previous) * 100 : 0;
    const fromStart = first > 0 ? (stage.value / first) * 100 : 0;
    addMark(
      builder,
      {
        id: markId,
        label: stage.label,
        value: stage.value,
        valueLabel: formatNumber(stage.value),
        tone,
        evidenceIds: inheritedEvidenceIds(stage.evidenceIds, spec.evidenceIds),
        emphasis: stage.emphasis === true,
        readout: [
          { label: 'Value', value: stage.value, formatted: formatNumber(stage.value) },
          { label: 'From previous', value: fromPrevious, formatted: `${formatNumber(fromPrevious)}%` },
          { label: 'From start', value: fromStart, formatted: `${formatNumber(fromStart)}%` },
          ...(stage.note ? [{ label: 'Note', value: stage.note, formatted: stage.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  return finalizeScene(spec, frame, builder);
};

const timelineValue = (value: number | string, timeScale: boolean): number =>
  typeof value === 'number' ? value : timeScale ? Date.parse(value) : Number(value);

const timelineLabel = (value: number | string, timeScale: boolean): string => {
  const numeric = timelineValue(value, timeScale);
  return timeScale ? formatTimeTick(numeric) : formatNumber(numeric);
};

const compileLineage = (spec: LineageSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const timeScale = spec.xAxis?.scale === 'time';
  const values = spec.events.map((event) => timelineValue(event.at, timeScale));
  const frame: SceneFrame = {
    width: Math.min(1_920, Math.max(BASE_WIDTH, spec.events.length * 116 + 110)),
    height: spec.style.density === 'compact' ? 300 : 340,
    left: 64,
    right: 52,
    top: 54,
    bottom: 58,
  };
  const plotRight = frame.width - frame.right;
  const axisY = Math.round((frame.top + frame.height - frame.bottom) / 2);
  const domain = resolveDomain(values, spec.xAxis, false, 0.03);
  builder.add({
    type: 'line',
    role: 'axis',
    stroke: 'ink',
    strokeWidth: 1.5,
    x1: frame.left,
    y1: axisY,
    x2: plotRight,
    y2: axisY,
  });
  spec.events.forEach((event, index) => {
    const x = scaleLinear(values[index], domain, [frame.left, plotRight]);
    const above = index % 2 === 0;
    const labelY = above ? axisY - 62 : axisY + 62;
    const markId = `timeline.lineage:${event.id}`;
    const tone: ReportChartSceneTone =
      event.state === 'current'
        ? 'emphasis'
        : event.state === 'blocked'
          ? 'risk'
          : event.state === 'future'
            ? 'muted'
            : 'ink';
    const primitiveIds = [
      builder.add({
        type: 'line',
        role: 'connector',
        markId,
        stroke: tone,
        strokeWidth: event.state === 'current' ? 2 : 1,
        dash: event.state === 'future' ? [4, 4] : undefined,
        x1: x,
        y1: axisY,
        x2: x,
        y2: above ? labelY + 18 : labelY - 18,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: event.state === 'future' ? 'background' : tone,
        stroke: tone,
        strokeWidth: event.emphasis || event.state === 'current' ? 2.5 : 1.5,
        cx: x,
        cy: axisY,
        r: event.state === 'current' ? 8 : 6,
      }),
      builder.add({
        type: 'text',
        role: 'label',
        markId,
        fill: event.state === 'future' ? 'muted' : 'ink',
        x,
        y: labelY,
        text: truncate(event.label, 20),
        anchor: 'middle',
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: event.emphasis || event.state === 'current' ? 680 : 550,
      }),
      builder.add({
        type: 'text',
        role: 'annotation',
        markId,
        fill: 'muted',
        x,
        y: above ? labelY + 22 : labelY - 22,
        text: timelineLabel(event.at, timeScale),
        anchor: 'middle',
        baseline: 'middle',
        fontSize: SECONDARY_FONT_SIZE,
        fontWeight: 500,
      }),
    ];
    addMark(
      builder,
      {
        id: markId,
        label: event.label,
        value: event.at,
        valueLabel: timelineLabel(event.at, timeScale),
        tone,
        evidenceIds: inheritedEvidenceIds(event.evidenceIds, spec.evidenceIds),
        emphasis: event.emphasis === true || event.state === 'current',
        readout: [
          { label: 'At', value: event.at, formatted: timelineLabel(event.at, timeScale) },
          { label: 'State', value: event.state, formatted: event.state },
          ...(event.note ? [{ label: 'Note', value: event.note, formatted: event.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  builder.axes.push({
    id: 'x',
    orientation: 'bottom',
    scale: timeScale ? 'time' : 'linear',
    domain,
    range: [frame.left, plotRight],
    label: spec.xAxis?.label,
    unit: spec.xAxis?.unit,
    ticks: spec.events.map((event, index) => ({
      id: `tick-${index + 1}`,
      value: event.at,
      label: timelineLabel(event.at, timeScale),
      position: scaleLinear(values[index], domain, [frame.left, plotRight]),
    })),
  });
  addAxisTitles(builder, frame, spec.xAxis, undefined);
  return finalizeScene(spec, frame, builder, {
    x: frame.left,
    y: frame.top,
    width: plotRight - frame.left,
    height: frame.height - frame.top - frame.bottom,
  });
};

const hierarchyTone = (state: HierarchySceneSpec['nodes'][number]['state']): ReportChartSceneTone =>
  state === 'current' ? 'emphasis' : state === 'complete' ? 'positive' : state === 'blocked' ? 'risk' : 'surface';

const compileHierarchy = (spec: HierarchySceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const depthById = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    const depth = node?.parentId ? depthOf(node.parentId) + 1 : 0;
    depthById.set(id, depth);
    return depth;
  };
  spec.nodes.forEach((node) => depthOf(node.id));
  const maximumDepth = Math.max(...depthById.values());
  const columns = Array.from({ length: maximumDepth + 1 }, (_, depth) =>
    spec.nodes.filter((node) => depthById.get(node.id) === depth)
  );
  const maximumColumnSize = Math.max(...columns.map((column) => column.length));
  const nodeWidth = 142;
  const nodeHeight = 54;
  const columnGap = 70;
  const rowGap = 26;
  const frame: SceneFrame = {
    width: Math.min(2_000, Math.max(BASE_WIDTH, 76 + columns.length * nodeWidth + maximumDepth * columnGap)),
    height: Math.max(310, 84 + maximumColumnSize * nodeHeight + Math.max(0, maximumColumnSize - 1) * rowGap),
    left: 38,
    right: 38,
    top: 42,
    bottom: 42,
  };
  const plotHeight = frame.height - frame.top - frame.bottom;
  const positionById = new Map<string, { x: number; y: number }>();
  columns.forEach((column, depth) => {
    const totalHeight = column.length * nodeHeight + Math.max(0, column.length - 1) * rowGap;
    const top = frame.top + (plotHeight - totalHeight) / 2;
    column.forEach((node, index) => {
      positionById.set(node.id, {
        x: frame.left + depth * (nodeWidth + columnGap),
        y: top + index * (nodeHeight + rowGap),
      });
    });
  });
  spec.nodes.forEach((node) => {
    if (!node.parentId) return;
    const parent = positionById.get(node.parentId);
    const child = positionById.get(node.id);
    if (!parent || !child) return;
    const startX = parent.x + nodeWidth;
    const startY = parent.y + nodeHeight / 2;
    const endX = child.x;
    const endY = child.y + nodeHeight / 2;
    const middle = (startX + endX) / 2;
    builder.add({
      type: 'path',
      role: 'connector',
      stroke: node.state === 'blocked' ? 'risk' : 'ink',
      strokeWidth: node.state === 'current' ? 2 : 1.25,
      opacity: node.state === 'neutral' ? 0.56 : 0.8,
      dash: node.state === 'neutral' ? [5, 5] : undefined,
      d: `M ${coordinate(startX)} ${coordinate(startY)} C ${coordinate(middle)} ${coordinate(startY)}, ${coordinate(middle)} ${coordinate(endY)}, ${coordinate(endX)} ${coordinate(endY)}`,
      lineCap: 'round',
    });
  });
  spec.nodes.forEach((node) => {
    const position = positionById.get(node.id)!;
    const markId = `hierarchy.tree:${node.id}`;
    const tone = hierarchyTone(node.state);
    const primitiveIds = [
      builder.add({
        type: 'rect',
        role: 'data',
        markId,
        fill: tone,
        stroke: node.state === 'neutral' ? 'grid' : tone,
        strokeWidth: node.emphasis || node.state === 'current' ? 2 : 1,
        opacity: node.state === 'neutral' ? 0.98 : 0.84,
        x: position.x,
        y: position.y,
        width: nodeWidth,
        height: nodeHeight,
        rx: 6,
      }),
      builder.add({
        type: 'text',
        role: 'label',
        markId,
        fill: node.state === 'neutral' ? 'ink' : 'background',
        x: position.x + 14,
        y: position.y + (node.value === undefined ? nodeHeight / 2 : 20),
        text: truncate(node.label, 18),
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: node.emphasis || node.state === 'current' ? 680 : 580,
      }),
      ...(node.value === undefined
        ? []
        : [
            builder.add({
              type: 'text',
              role: 'annotation',
              markId,
              fill: node.state === 'neutral' ? 'muted' : 'background',
              x: position.x + 14,
              y: position.y + 39,
              text: formatNumber(node.value),
              baseline: 'middle',
              fontSize: SECONDARY_FONT_SIZE,
              fontWeight: 520,
            }),
          ]),
    ];
    addMark(
      builder,
      {
        id: markId,
        label: node.label,
        value: node.value ?? node.state,
        valueLabel: node.value === undefined ? node.state : formatNumber(node.value),
        tone,
        evidenceIds: inheritedEvidenceIds(node.evidenceIds, spec.evidenceIds),
        emphasis: node.emphasis === true || node.state === 'current',
        readout: [
          { label: 'State', value: node.state, formatted: node.state },
          ...(node.value === undefined
            ? []
            : [{ label: 'Value', value: node.value, formatted: formatNumber(node.value) }]),
          ...(node.note ? [{ label: 'Note', value: node.note, formatted: node.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  return finalizeScene(spec, frame, builder);
};

const compileBipolar = (spec: BipolarSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const frame = rowFrame(spec.items.length, spec.style.density === 'compact', 150);
  frame.top = 62;
  frame.bottom = 62;
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const x = (value: number): number => scaleLinear(value, spec.domain, [frame.left, plotRight]);
  const rowHeight = (plotBottom - frame.top) / spec.items.length;
  builder.add({
    type: 'line',
    role: 'annotation',
    stroke: 'ink',
    strokeWidth: 1.5,
    x1: x(spec.center),
    y1: frame.top - 12,
    x2: x(spec.center),
    y2: plotBottom,
  });
  builder.add({
    type: 'text',
    role: 'annotation',
    fill: 'muted',
    x: frame.left,
    y: 26,
    text: truncate(spec.endpoints[0].label, 24),
    fontSize: SECONDARY_FONT_SIZE,
    fontWeight: 600,
  });
  builder.add({
    type: 'text',
    role: 'annotation',
    fill: 'muted',
    x: plotRight,
    y: 26,
    text: truncate(spec.endpoints[1].label, 24),
    anchor: 'end',
    fontSize: SECONDARY_FONT_SIZE,
    fontWeight: 600,
  });
  spec.items.forEach((item, index) => {
    const y = frame.top + rowHeight * (index + 0.5);
    const markId = `scale.bipolar:${item.id}`;
    const tone: ReportChartSceneTone = item.emphasis ? 'emphasis' : item.value >= spec.center ? 'series-2' : 'series-1';
    const primitiveIds = [
      builder.add({
        type: 'line',
        role: 'grid',
        markId,
        stroke: 'grid',
        strokeWidth: 1,
        x1: frame.left,
        y1: y,
        x2: plotRight,
        y2: y,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: tone,
        stroke: item.emphasis ? 'ink' : tone,
        strokeWidth: item.emphasis ? 2.5 : 1.5,
        cx: x(item.value),
        cy: y,
        r: item.emphasis ? 8 : 6,
      }),
      builder.add({
        type: 'text',
        role: 'label',
        markId,
        fill: 'ink',
        x: frame.left - 14,
        y,
        text: truncate(item.label, 22),
        anchor: 'end',
        baseline: 'middle',
        fontSize: LABEL_FONT_SIZE,
        fontWeight: item.emphasis ? 680 : 550,
      }),
      builder.add({
        type: 'text',
        role: 'annotation',
        markId,
        fill: 'muted',
        x: x(item.value),
        y: y - 15,
        text: formatMeasure(item.value, spec.xAxis?.unit),
        anchor: 'middle',
        fontSize: SECONDARY_FONT_SIZE,
        fontWeight: 600,
      }),
    ];
    addMark(
      builder,
      {
        id: markId,
        label: item.label,
        value: item.value,
        valueLabel: formatMeasure(item.value, spec.xAxis?.unit),
        tone,
        evidenceIds: inheritedEvidenceIds(item.evidenceIds, spec.evidenceIds),
        emphasis: item.emphasis === true,
        readout: [
          { label: 'Value', value: item.value, formatted: formatMeasure(item.value, spec.xAxis?.unit) },
          {
            label: 'From center',
            value: item.value - spec.center,
            formatted: signedMeasure(item.value - spec.center, spec.xAxis?.unit),
          },
          ...(item.note ? [{ label: 'Note', value: item.note, formatted: item.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  addLinearAxis(builder, {
    id: 'x',
    orientation: 'bottom',
    domain: spec.domain,
    range: [frame.left, plotRight],
    crossPosition: plotBottom,
    plotStart: frame.top,
    plotEnd: plotBottom,
    axis: spec.xAxis,
  });
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const compileRainfall = (spec: RainfallSceneSpec): ReportChartScene => {
  const builder = createBuilder();
  const compact = spec.style.density === 'compact';
  const frame: SceneFrame = {
    width: Math.min(2_400, Math.max(BASE_WIDTH, spec.points.length * (compact ? 66 : 82) + 104)),
    height: compact ? 390 : 440,
    left: 70,
    right: 34,
    top: spec.style.showLegend ? 58 : 36,
    bottom: 86,
  };
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const domain = resolveDomain(
    spec.points.flatMap((point) => [point.first, point.second]),
    spec.yAxis,
    false,
    0.1
  );
  const groupSpan = (plotRight - frame.left) / spec.points.length;
  const positions = spec.points.map((point, index) => ({
    id: point.id,
    label: point.label,
    position: frame.left + groupSpan * (index + 0.5),
  }));
  addLinearAxis(builder, {
    id: 'y',
    orientation: 'left',
    domain,
    range: [plotBottom, frame.top],
    crossPosition: frame.left,
    plotStart: frame.left,
    plotEnd: plotRight,
    axis: spec.yAxis,
    grid: spec.style.showGrid,
  });
  addCategoryAxis(builder, {
    id: 'x',
    orientation: 'bottom',
    categories: positions,
    range: [frame.left, plotRight],
    crossPosition: plotBottom,
    label: spec.xAxis?.label,
    maxLabelLength: 18,
    rotate: groupSpan < 92,
  });
  spec.points.forEach((point, index) => {
    const markId = `sequence.rainfall:${point.id}`;
    const x = positions[index].position;
    const firstY = scaleLinear(point.first, domain, [plotBottom, frame.top]);
    const secondY = scaleLinear(point.second, domain, [plotBottom, frame.top]);
    const directionTone: ReportChartSceneTone = point.emphasis
      ? 'emphasis'
      : point.second >= point.first
        ? 'series-2'
        : 'series-1';
    const primitiveIds = [
      builder.add({
        type: 'line',
        role: 'data',
        markId,
        stroke: directionTone,
        strokeWidth: point.emphasis ? 3 : 2,
        opacity: 0.76,
        x1: x,
        y1: firstY,
        x2: x,
        y2: secondY,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: 'background',
        stroke: 'series-1',
        strokeWidth: 2,
        cx: x,
        cy: firstY,
        r: 5.5,
      }),
      builder.add({
        type: 'circle',
        role: 'data',
        markId,
        fill: 'series-2',
        stroke: point.emphasis ? 'ink' : 'series-2',
        strokeWidth: point.emphasis ? 2.5 : 1.5,
        cx: x,
        cy: secondY,
        r: point.emphasis ? 7 : 5.5,
      }),
      ...(spec.style.directLabels
        ? [
            builder.add({
              type: 'text',
              role: 'annotation',
              markId,
              fill: 'muted',
              x: x + 9,
              y: Math.min(firstY, secondY) - 8,
              text: signedMeasure(point.second - point.first, spec.yAxis?.unit),
              fontSize: SECONDARY_FONT_SIZE,
              fontWeight: point.emphasis ? 680 : 520,
            }),
          ]
        : []),
    ];
    addMark(
      builder,
      {
        id: markId,
        label: point.label,
        value: point.second - point.first,
        valueLabel: signedMeasure(point.second - point.first, spec.yAxis?.unit),
        tone: directionTone,
        evidenceIds: inheritedEvidenceIds(point.evidenceIds, spec.evidenceIds),
        emphasis: point.emphasis === true,
        readout: [
          { label: spec.series[0].label, value: point.first, formatted: formatMeasure(point.first, spec.yAxis?.unit) },
          {
            label: spec.series[1].label,
            value: point.second,
            formatted: formatMeasure(point.second, spec.yAxis?.unit),
          },
          {
            label: 'Difference',
            value: point.second - point.first,
            formatted: signedMeasure(point.second - point.first, spec.yAxis?.unit),
          },
          ...(point.note ? [{ label: 'Note', value: point.note, formatted: point.note }] : []),
        ],
      },
      primitiveIds
    );
  });
  if (spec.style.showLegend) {
    addLegend(builder, frame, [
      { id: spec.series[0].id, label: spec.series[0].label, tone: 'series-1', symbol: 'circle-outline' },
      { id: spec.series[1].id, label: spec.series[1].label, tone: 'series-2', symbol: 'circle' },
    ]);
  }
  addAxisTitles(builder, frame, spec.xAxis, spec.yAxis);
  return finalizeScene(spec, frame, builder);
};

const finalizeScene = (
  spec: NormalizedSceneSpec,
  frame: SceneFrame,
  builder: SceneBuilder,
  plot = {
    x: frame.left,
    y: frame.top,
    width: frame.width - frame.left - frame.right,
    height: frame.height - frame.top - frame.bottom,
  }
): ReportChartScene => ({
  schema: REPORT_CHART_SCENE_SCHEMA,
  sourceSchema: spec.schema,
  recipe: spec.recipe,
  kind: spec.kind,
  title: spec.title,
  description: spec.description,
  caption: spec.caption,
  width: frame.width,
  height: frame.height,
  plot,
  primitives: builder.primitives,
  marks: builder.marks,
  axes: builder.axes,
  legend: builder.legend,
  markOrder: builder.marks.map((mark) => mark.id),
});

/** Compile an already validated and normalized v2 spec into renderer-neutral geometry. */
export const compileReportChartScene = (spec: ReportChartSpecV2): ReportChartScene => {
  switch (spec.recipe) {
    case 'bar.grouped':
    case 'bar.stacked':
      return compileCategoricalBars(spec as CategoricalBarSceneSpec);
    case 'bar.waterfall':
      return compileWaterfall(spec as WaterfallSceneSpec);
    case 'line.area':
      return compileArea(spec as AreaSceneSpec);
    case 'pair.dumbbell':
      return compileDumbbell(spec as DumbbellSceneSpec);
    case 'distribution.box':
      return compileBox(spec as BoxSceneSpec);
    case 'composition.waffle':
      return compileWaffle(spec as WaffleSceneSpec);
    case 'flow.funnel':
      return compileFunnel(spec as FunnelSceneSpec);
    case 'timeline.lineage':
      return compileLineage(spec as LineageSceneSpec);
    case 'hierarchy.tree':
      return compileHierarchy(spec as HierarchySceneSpec);
    case 'scale.bipolar':
      return compileBipolar(spec as BipolarSceneSpec);
    case 'sequence.rainfall':
      return compileRainfall(spec as RainfallSceneSpec);
    default:
      throw new Error('Unsupported report-chart scene recipe');
  }
};
