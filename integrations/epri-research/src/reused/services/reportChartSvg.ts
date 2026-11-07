/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REPORT_CHART_SCHEMA_V2,
  type ReportChartSpec,
  type ReportChartSpecV1,
  type ReportChartSpecV2,
} from '@/common/chat/reportChart';
import {
  compileReportChartScene,
  type ReportChartScene,
  type ReportChartScenePrimitive,
  type ReportChartSceneTone,
} from '@/common/chat/reportChartScene';

type ChartAxis = {
  label?: string;
  unit?: string;
  scale?: 'linear' | 'time' | 'category';
  min?: number;
  max?: number;
};

type ChartStyle = {
  palette: 'auto' | 'mono' | 'nature';
  appearance: 'auto' | 'light' | 'dark' | 'print';
  density: 'compact' | 'comfortable';
  showGrid: boolean;
  showLegend: boolean;
  directLabels: boolean;
  interaction?: 'auto' | 'inspect' | 'quiet';
};

type ChartCommon = {
  schema: 'deepscientist.report_chart.v1';
  recipe?: string;
  id?: string;
  title: string;
  description?: string;
  caption?: string;
  evidenceIds?: string[];
  xAxis?: ChartAxis;
  yAxis?: ChartAxis;
  style: ChartStyle;
};

type BarChart = ChartCommon & {
  kind: 'bar';
  orientation: 'horizontal' | 'vertical';
  baseline?: number;
  data: Array<{
    id: string;
    label: string;
    value: number;
    group?: string;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type LineChart = ChartCommon & {
  kind: 'line';
  referenceValue?: number;
  series: Array<{
    id: string;
    label: string;
    unit?: string;
    points: Array<{
      x: string | number;
      y: number;
      low?: number;
      high?: number;
      emphasis?: boolean;
      evidenceIds?: string[];
    }>;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type IntervalChart = ChartCommon & {
  kind: 'interval';
  referenceValue?: number;
  scale: 'linear' | 'log';
  data: Array<{
    id: string;
    label: string;
    estimate: number;
    low: number;
    high: number;
    weight?: number;
    group?: string;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type ScatterChart = ChartCommon & {
  kind: 'scatter';
  xReferenceValue?: number;
  yReferenceValue?: number;
  data: Array<{
    id: string;
    label?: string;
    x: number;
    y: number;
    size?: number;
    group?: string;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
};

type MatrixCellStatus = 'neutral' | 'supports' | 'against' | 'mixed' | 'unknown' | 'risk' | 'positive' | 'negative';

const MATRIX_STATUS_SYMBOLS: Record<MatrixCellStatus, string> = {
  neutral: '=',
  supports: '+',
  against: '-',
  mixed: '~',
  unknown: '?',
  risk: '!',
  positive: '+',
  negative: '-',
};

type MatrixChart = ChartCommon & {
  kind: 'matrix';
  rows: string[];
  columns: string[];
  cells: Array<{
    row: string;
    column: string;
    value?: number;
    status?: MatrixCellStatus;
    label?: string;
    note?: string;
    emphasis?: boolean;
    evidenceIds?: string[];
  }>;
  valueDomain?: [number, number];
  colorScale?: 'sequential' | 'diverging';
  center?: number;
};

type RenderableReportChart = BarChart | LineChart | IntervalChart | ScatterChart | MatrixChart;

type ChartTheme = {
  background: string;
  ink: string;
  muted: string;
  grid: string;
  surface: string;
  emphasis: string;
  series: string[];
  supports: string;
  against: string;
  positive: string;
  negative: string;
  risk: string;
  mixed: string;
};

type ChartFrame = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const LIGHT_MONO_THEME: ChartTheme = {
  background: '#FFFFFF',
  ink: '#2D2A26',
  muted: '#5D5A55',
  grid: '#DDDAD4',
  surface: '#F7F6F3',
  emphasis: '#596F96',
  series: ['#2D2A26', '#4F4A43', '#5D5A55', '#6F6B66', '#2D2A26'],
  supports: '#596F96',
  against: '#916565',
  positive: '#607369',
  negative: '#916565',
  risk: '#806A3E',
  mixed: '#716989',
};

const LIGHT_NATURE_THEME: ChartTheme = {
  ...LIGHT_MONO_THEME,
  series: ['#596F96', '#4A7780', '#716989', '#756C64', '#2D2A26', '#4F4A43', '#5D5A55', '#6F6B66'],
};

const DARK_THEME: ChartTheme = {
  background: '#171717',
  ink: '#F0E8DD',
  muted: '#C8C0B5',
  grid: '#4B4945',
  surface: '#262523',
  emphasis: '#A9BCC4',
  series: ['#F0E8DD', '#D8D1C7', '#C8C0B5', '#A7A098', '#D8D1C7'],
  supports: '#A9BCC4',
  against: '#D8B0AD',
  positive: '#AFC1B5',
  negative: '#D8B0AD',
  risk: '#D4C089',
  mixed: '#B9AFC2',
};

const DARK_NATURE_THEME: ChartTheme = {
  ...DARK_THEME,
  series: ['#A9BCC4', '#94B2B5', '#B9AFC2', '#B7A99A', '#F0E8DD', '#D8D1C7', '#C8C0B5', '#A7A098'],
};

const xml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const trimLabel = (value: string, limit = 34): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;

const glyphWidthEm = (character: string): number => {
  const codePoint = character.codePointAt(0) || 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (/\s/u.test(character)) return 0.34;
  if (/[ilI1.,'`|!:;]/u.test(character)) return 0.32;
  if (/[MW@#%&]/u.test(character)) return 0.9;
  if (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    codePoint >= 0x1f000
  ) {
    return 1;
  }
  return /[A-Z0-9]/u.test(character) ? 0.66 : 0.56;
};

const estimatedTextWidth = (value: string, fontSize: number): number =>
  [...value].reduce((width, character) => width + glyphWidthEm(character) * fontSize, 0);

const trimLabelToWidth = (value: string, maximumWidth: number, fontSize: number): string => {
  if (estimatedTextWidth(value, fontSize) <= maximumWidth) return value;
  const ellipsis = '…';
  const availableWidth = Math.max(0, maximumWidth - estimatedTextWidth(ellipsis, fontSize));
  let width = 0;
  let result = '';
  for (const character of value) {
    const characterWidth = glyphWidthEm(character) * fontSize;
    if (width + characterWidth > availableWidth) break;
    result += character;
    width += characterWidth;
  }
  return `${result}${ellipsis}`;
};

type VerticalLabelCandidate = {
  order: number;
  desiredY: number;
};

const resolveVerticalLabelPositions = <T extends VerticalLabelCandidate>(
  candidates: T[],
  minimumY: number,
  maximumY: number,
  preferredGap: number
): Map<number, number> => {
  if (!candidates.length) return new Map();
  const sorted = candidates.toSorted((left, right) => left.desiredY - right.desiredY || left.order - right.order);
  const gap = sorted.length === 1 ? 0 : Math.min(preferredGap, Math.max(0, maximumY - minimumY) / (sorted.length - 1));
  const positions = sorted.map((candidate) => Math.max(minimumY, Math.min(maximumY, candidate.desiredY)));
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  }
  if (positions[positions.length - 1] > maximumY) {
    positions[positions.length - 1] = maximumY;
    for (let index = positions.length - 2; index >= 0; index -= 1) {
      positions[index] = Math.min(positions[index], positions[index + 1] - gap);
    }
  }
  const meanDisplacement =
    positions.reduce((total, position, index) => total + position - sorted[index].desiredY, 0) / positions.length;
  const centeredShift = Math.max(
    minimumY - positions[0],
    Math.min(maximumY - positions[positions.length - 1], -meanDisplacement)
  );
  return new Map(sorted.map((candidate, index) => [candidate.order, positions[index] + centeredShift]));
};

const svgNumber = (value: number): string => Number(value.toFixed(2)).toString();

const finiteExtent = (
  values: number[],
  minimum?: number,
  maximum?: number,
  include?: number,
  paddingRatio = 0
): [number, number] => {
  let low = minimum ?? Math.min(...values, include ?? Number.POSITIVE_INFINITY);
  let high = maximum ?? Math.max(...values, include ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (low === high) {
    const padding = Math.max(Math.abs(low) * 0.08, 1);
    low -= padding;
    high += padding;
  }
  const span = high - low;
  if (minimum === undefined) low -= span * paddingRatio;
  if (maximum === undefined) high += span * paddingRatio;
  return [low, high];
};

const linear =
  (domain: [number, number], range: [number, number]) =>
  (value: number): number =>
    range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);

const logScale = (domain: [number, number], range: [number, number]) => {
  if (domain[0] <= 0 || domain[1] <= 0) {
    throw new Error('Log interval charts require positive estimates, bounds, references, and axis limits.');
  }
  const low = Math.log(domain[0]);
  const high = Math.log(domain[1]);
  return (value: number): number => {
    if (value <= 0) throw new Error('Log interval charts require every plotted value to be positive.');
    return range[0] + ((Math.log(value) - low) / (high - low)) * (range[1] - range[0]);
  };
};

const numberLabel = (value: number): string => {
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(2);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: absolute < 10 ? 3 : 1 }).format(value);
};

const ticks = (domain: [number, number], count = 5): number[] =>
  Array.from({ length: count }, (_, index) => domain[0] + ((domain[1] - domain[0]) * index) / (count - 1));

const logarithmicTicks = (domain: [number, number]): number[] => {
  if (domain[0] <= 0 || domain[1] <= 0) return [];
  const candidates: number[] = [];
  const startExponent = Math.floor(Math.log10(domain[0]));
  const endExponent = Math.ceil(Math.log10(domain[1]));
  for (let exponent = startExponent; exponent <= endExponent; exponent += 1) {
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * 10 ** exponent;
      if (value >= domain[0] && value <= domain[1]) candidates.push(value);
    }
  }
  return candidates.length >= 2 && candidates.length <= 9 ? candidates : ticks(domain);
};

const themeForStyle = (style: ChartStyle): ChartTheme => {
  if (style.appearance === 'dark') return style.palette === 'nature' ? DARK_NATURE_THEME : DARK_THEME;
  if (style.palette === 'nature') return LIGHT_NATURE_THEME;
  return LIGHT_MONO_THEME;
};

const themeFor = (spec: RenderableReportChart): ChartTheme => themeForStyle(spec.style);

const legendLabelsFor = (spec: RenderableReportChart): string[] => {
  if (!spec.style.showLegend) return [];
  if (spec.kind === 'line') return spec.series.map((series) => series.label);
  if (spec.kind === 'matrix') {
    return [...new Set(spec.cells.flatMap((cell) => (cell.status ? [cell.status] : [])))];
  }
  return [...new Set(spec.data.flatMap((datum) => (datum.group ? [datum.group] : [])))];
};

const legendSpaceFor = (spec: RenderableReportChart): number => {
  const count = legendLabelsFor(spec).length;
  return count ? Math.ceil(count / 4) * 26 + 4 : 0;
};

const frameFor = (spec: RenderableReportChart): ChartFrame => {
  const compact = spec.style.density === 'compact';
  const titleSpace = (spec.description ? 106 : 82) + legendSpaceFor(spec);
  if (spec.kind === 'bar') {
    if (spec.orientation === 'vertical') {
      return {
        width: Math.min(2_400, Math.max(960, spec.data.length * (compact ? 24 : 30) + 150)),
        height: compact ? 480 : 560,
        left: 78,
        right: 34,
        top: titleSpace,
        bottom: 92,
      };
    }
    return {
      width: 960,
      height: Math.max(compact ? 336 : 380, titleSpace + spec.data.length * (compact ? 28 : 34) + 76),
      left: 220,
      right: spec.style.directLabels ? 96 : 68,
      top: titleSpace,
      bottom: 58,
    };
  }
  if (spec.kind === 'interval') {
    return {
      width: 960,
      height: Math.max(compact ? 336 : 380, titleSpace + spec.data.length * (compact ? 28 : 34) + 76),
      left: 220,
      right: spec.style.directLabels ? 190 : 78,
      top: titleSpace,
      bottom: 58,
    };
  }
  if (spec.kind === 'matrix') {
    const columnFontSize = 13;
    const longestColumnLabel = Math.max(
      0,
      ...spec.columns.map((column) => estimatedTextWidth(trimLabel(column, 18), columnFontSize))
    );
    const cell = Math.max(compact ? 42 : 52, Math.min(compact ? 76 : 90, Math.ceil(longestColumnLabel * 0.75 + 14)));
    const horizontalPadding = 24;
    const rowLabelWidth = Math.max(
      compact ? 142 : 166,
      Math.min(
        compact ? 204 : 238,
        Math.ceil(Math.max(0, ...spec.rows.map((row) => estimatedTextWidth(trimLabel(row, 24), 14))) + 22)
      )
    );
    const gridWidth = spec.columns.length * cell;
    const naturalWidth = horizontalPadding * 2 + rowLabelWidth + gridWidth;
    const width = Math.max(720, naturalWidth);
    const contentStart = Math.max(0, (width - naturalWidth) / 2);
    const left = contentStart + horizontalPadding + rowLabelWidth;
    return {
      width,
      height: Math.max(400, titleSpace + spec.rows.length * cell + 122),
      left,
      right: width - left - gridWidth,
      top: titleSpace + 50,
      bottom: 54,
    };
  }
  if (spec.kind === 'line') {
    return {
      width: 960,
      height: compact ? 480 : 560,
      left: 82,
      right: spec.style.directLabels || spec.recipe === 'line.direct' ? 220 : 78,
      top: titleSpace,
      bottom: 72,
    };
  }
  return { width: 960, height: compact ? 480 : 560, left: 82, right: 120, top: titleSpace, bottom: 76 };
};

const chartHeader = (spec: RenderableReportChart, frame: ChartFrame, theme: ChartTheme): string[] => [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.width} ${frame.height}" width="${frame.width}" height="${frame.height}" role="img" aria-labelledby="report-chart-title report-chart-description"${spec.recipe ? ` data-report-chart-recipe="${xml(spec.recipe)}"` : ''}>`,
  `<title id="report-chart-title">${xml(spec.title)}</title>`,
  `<desc id="report-chart-description">${xml(spec.description || spec.caption || `${spec.kind} report chart`)}</desc>`,
  `<rect width="${frame.width}" height="${frame.height}" fill="${theme.background}"/>`,
  `<g font-family="Arial, Helvetica, sans-serif" fill="${theme.ink}" letter-spacing="0">`,
  `<text x="28" y="38" font-size="22" font-weight="650">${xml(trimLabel(spec.title, 76))}</text>`,
  ...(spec.description
    ? [`<text x="28" y="64" font-size="14" fill="${theme.muted}">${xml(trimLabel(spec.description, 104))}</text>`]
    : []),
];

const chartFooter = (spec: RenderableReportChart, frame: ChartFrame, theme: ChartTheme): string[] => [
  ...(spec.caption
    ? [
        `<text x="28" y="${frame.height - 18}" font-size="14" fill="${theme.muted}">${xml(trimLabel(spec.caption, 116))}</text>`,
      ]
    : []),
  '</g>',
  '</svg>',
];

const seriesDash = (index: number): string | undefined => {
  if (index % 4 === 1) return '7 4';
  if (index % 4 === 2) return '2 4';
  if (index % 4 === 3) return '10 3 2 3';
  return undefined;
};

const scatterShapeSvg = (
  index: number,
  x: number,
  y: number,
  radius: number,
  fill: string,
  stroke: string,
  title?: string,
  opacity?: number,
  className?: string
): string => {
  const content = title ? `<title>${xml(title)}</title>` : '';
  const opacityAttribute = opacity === undefined ? '' : ` opacity="${opacity}"`;
  const classAttribute = className ? ` class="${className}"` : '';
  if (index % 4 === 1) {
    return `<rect${classAttribute} x="${x - radius}" y="${y - radius}" width="${radius * 2}" height="${radius * 2}" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="1"${opacityAttribute}>${content}</rect>`;
  }
  if (index % 4 === 2) {
    return `<polygon${classAttribute} points="${x},${y - radius} ${x + radius},${y} ${x},${y + radius} ${x - radius},${y}" fill="${fill}" stroke="${stroke}" stroke-width="1"${opacityAttribute}>${content}</polygon>`;
  }
  if (index % 4 === 3) {
    return `<polygon${classAttribute} points="${x},${y - radius} ${x + radius},${y + radius} ${x - radius},${y + radius}" fill="${fill}" stroke="${stroke}" stroke-width="1"${opacityAttribute}>${content}</polygon>`;
  }
  return `<circle${classAttribute} cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1"${opacityAttribute}>${content}</circle>`;
};

const statusColor = (status: string, theme: ChartTheme): string => {
  if (status === 'supports') return theme.supports;
  if (status === 'against') return theme.against;
  if (status === 'positive') return theme.positive;
  if (status === 'negative') return theme.negative;
  if (status === 'risk') return theme.risk;
  if (status === 'mixed') return theme.mixed;
  return theme.muted;
};

type RgbColor = readonly [number, number, number];

const parseHexColor = (color: string): { rgb: RgbColor; alpha: number } | undefined => {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  if (!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(hex)) return undefined;
  return {
    rgb: [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ],
    alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
};

const compositeFillColor = (fill: string, background: string): RgbColor => {
  const foreground = parseHexColor(fill);
  const backdrop = parseHexColor(background);
  if (!foreground) return backdrop?.rgb || [0, 0, 0];
  if (!backdrop || foreground.alpha >= 1) return foreground.rgb;
  const backgroundWeight = 1 - foreground.alpha;
  return [
    foreground.rgb[0] * foreground.alpha + backdrop.rgb[0] * backgroundWeight,
    foreground.rgb[1] * foreground.alpha + backdrop.rgb[1] * backgroundWeight,
    foreground.rgb[2] * foreground.alpha + backdrop.rgb[2] * backgroundWeight,
  ];
};

const relativeLuminance = (color: RgbColor): number => {
  const [red, green, blue] = color.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrastRatio = (first: RgbColor, second: RgbColor): number => {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
};

const matrixTextColor = (fill: string, theme: ChartTheme): string => {
  const actualFill = compositeFillColor(fill, theme.background);
  const ink = compositeFillColor(theme.ink, theme.background);
  const background = compositeFillColor(theme.background, theme.background);
  return contrastRatio(actualFill, ink) >= contrastRatio(actualFill, background) ? theme.ink : theme.background;
};

const renderLegend = (spec: RenderableReportChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const labels = legendLabelsFor(spec);
  if (!labels.length) return [];
  const columns = Math.min(4, labels.length);
  const itemWidth = (frame.width - 56) / columns;
  const startY = spec.description ? 84 : 60;
  return labels.flatMap((label, index) => {
    const x = 28 + (index % columns) * itemWidth;
    const y = startY + Math.floor(index / columns) * 26;
    const isMatrix = spec.kind === 'matrix';
    const color = isMatrix ? statusColor(label, theme) : theme.series[index % theme.series.length];
    const dash = !isMatrix && spec.kind === 'line' ? seriesDash(index) : undefined;
    const symbol = isMatrix ? MATRIX_STATUS_SYMBOLS[label as MatrixCellStatus] || '=' : undefined;
    const parts: string[] = [];
    let symbolFill = theme.ink;
    if (isMatrix) {
      const outlined = label === 'unknown';
      const fill = outlined ? theme.background : color;
      symbolFill = matrixTextColor(fill, theme);
      parts.push(
        `<rect x="${x}" y="${y - 9}" width="16" height="16" rx="1" fill="${fill}" stroke="${color}"${outlined ? ' stroke-dasharray="3 2"' : ''}/>`
      );
    } else if (spec.kind === 'scatter') {
      parts.push(scatterShapeSvg(index, x + 8, y, 4.5, color, theme.background));
    } else {
      parts.push(
        `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
      );
    }
    if (symbol) {
      parts.push(
        `<text x="${x + 8}" y="${y + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="${symbolFill}">${xml(symbol)}</text>`
      );
    }
    parts.push(
      `<text x="${x + 22}" y="${y + 4}" font-size="13" fill="${theme.muted}">${xml(trimLabelToWidth(label, Math.max(36, itemWidth - 30), 13))}</text>`
    );
    return parts;
  });
};

const renderNumericAxes = (
  frame: ChartFrame,
  theme: ChartTheme,
  xDomain: [number, number],
  yDomain: [number, number],
  xLabel?: string,
  yLabel?: string,
  showGrid = false,
  xTickLabel: (value: number) => string = numberLabel
): string[] => {
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const x = linear(xDomain, [frame.left, plotRight]);
  const y = linear(yDomain, [plotBottom, frame.top]);
  const parts: string[] = [];
  for (const tick of ticks(xDomain)) {
    const position = x(tick);
    if (showGrid) {
      parts.push(
        `<line x1="${position}" y1="${frame.top}" x2="${position}" y2="${plotBottom}" stroke="${theme.grid}" stroke-width="1"/>`
      );
    }
    const label = xTickLabel(tick);
    if (label) {
      parts.push(
        `<text x="${position}" y="${plotBottom + 24}" text-anchor="middle" font-size="13" fill="${theme.muted}">${xml(label)}</text>`
      );
    }
  }
  for (const tick of ticks(yDomain)) {
    const position = y(tick);
    if (showGrid) {
      parts.push(
        `<line x1="${frame.left}" y1="${position}" x2="${plotRight}" y2="${position}" stroke="${theme.grid}" stroke-width="1"/>`
      );
    }
    parts.push(
      `<text x="${frame.left - 10}" y="${position + 4}" text-anchor="end" font-size="13" fill="${theme.muted}">${xml(numberLabel(tick))}</text>`
    );
  }
  parts.push(
    `<line x1="${frame.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${theme.ink}" stroke-width="1"/>`
  );
  parts.push(
    `<line x1="${frame.left}" y1="${frame.top}" x2="${frame.left}" y2="${plotBottom}" stroke="${theme.ink}" stroke-width="1"/>`
  );
  if (xLabel) {
    parts.push(
      `<text x="${(frame.left + plotRight) / 2}" y="${frame.height - 32}" text-anchor="middle" font-size="14" fill="${theme.muted}">${xml(xLabel)}</text>`
    );
  }
  if (yLabel) {
    parts.push(
      `<text x="18" y="${(frame.top + plotBottom) / 2}" text-anchor="middle" font-size="14" fill="${theme.muted}" transform="rotate(-90 18 ${(frame.top + plotBottom) / 2})">${xml(yLabel)}</text>`
    );
  }
  return parts;
};

const axisName = (axis?: { label?: string; unit?: string }): string | undefined => {
  if (!axis?.label) return axis?.unit;
  return axis.unit ? `${axis.label} (${axis.unit})` : axis.label;
};

const groupColors = (groups: Array<string | undefined>, theme: ChartTheme): Map<string, string> => {
  const unique = [...new Set(groups.filter((group): group is string => Boolean(group)))];
  return new Map(unique.map((group, index) => [group, theme.series[index % theme.series.length]]));
};

const deterministicJitter = (id: string, salt: string, amplitude = 3.5): number => {
  let hash = 2_166_136_261;
  for (const character of `${salt}:${id}`) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (((hash >>> 0) / 4_294_967_295) * 2 - 1) * amplitude;
};

const renderBar = (spec: BarChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const baseline = spec.baseline ?? 0;
  const valueAxis = spec.orientation === 'vertical' ? spec.yAxis : spec.xAxis;
  const domain = finiteExtent(
    spec.data.map((datum) => datum.value),
    valueAxis?.min,
    valueAxis?.max,
    baseline
  );
  const colors = groupColors(
    spec.data.map((datum) => datum.group),
    theme
  );
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const parts: string[] = [];
  if (spec.orientation === 'vertical') {
    const y = linear(domain, [plotBottom, frame.top]);
    const band = (plotRight - frame.left) / spec.data.length;
    const baseY = y(baseline);
    for (const tick of ticks(domain)) {
      const position = y(tick);
      if (spec.style.showGrid)
        parts.push(
          `<line x1="${frame.left}" y1="${position}" x2="${plotRight}" y2="${position}" stroke="${theme.grid}"/>`
        );
      parts.push(
        `<text x="${frame.left - 10}" y="${position + 4}" text-anchor="end" font-size="13" fill="${theme.muted}">${xml(numberLabel(tick))}</text>`
      );
    }
    parts.push(`<line x1="${frame.left}" y1="${baseY}" x2="${plotRight}" y2="${baseY}" stroke="${theme.ink}"/>`);
    const labelStride = Math.max(1, Math.ceil(spec.data.length / 24));
    spec.data.forEach((datum, index) => {
      const center = frame.left + band * (index + 0.5);
      const valueY = y(datum.value);
      const top = Math.min(baseY, valueY);
      const height = Math.max(1, Math.abs(valueY - baseY));
      const fill =
        spec.recipe === 'bar.diverging'
          ? datum.value >= baseline
            ? theme.positive
            : theme.negative
          : datum.group
            ? colors.get(datum.group) || theme.ink
            : theme.series[0];
      const width = Math.max(2, band * 0.64);
      const left = center - width / 2;
      if (datum.emphasis) {
        parts.push(
          `<rect class="report-chart-emphasis" x="${left - 3}" y="${top - 3}" width="${width + 6}" height="${height + 6}" fill="${theme.emphasis}" rx="3" opacity="0.13"/>`
        );
      }
      parts.push(
        `<g${spec.recipe ? ` data-report-chart-mark="${spec.recipe}"` : ''}><title>${xml(`${datum.label}: ${numberLabel(datum.value)}`)}</title><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${fill}" rx="${spec.recipe === 'bar.diverging' ? Math.min(8, width / 2) : 1}"/></g>`
      );
      if (spec.style.directLabels) {
        parts.push(
          `<text x="${center}" y="${valueY + (datum.value >= baseline ? -9 : 16)}" text-anchor="middle" font-size="13"${datum.emphasis ? ' font-weight="700"' : ''} fill="${theme.muted}">${xml(numberLabel(datum.value))}</text>`
        );
      }
      if (index % labelStride === 0) {
        parts.push(
          `<text x="${center}" y="${plotBottom + 22}" text-anchor="end" font-size="13"${datum.emphasis ? ' font-weight="700"' : ''} fill="${theme.muted}" transform="rotate(-38 ${center} ${plotBottom + 22})">${xml(trimLabel(datum.group ? `${datum.label} · ${datum.group}` : datum.label, 18))}</text>`
        );
      }
    });
  } else {
    const x = linear(domain, [frame.left, plotRight]);
    const baseX = x(baseline);
    const band = (plotBottom - frame.top) / spec.data.length;
    const categoryLabelWidth = Math.max(24, frame.left - 40);
    for (const tick of ticks(domain)) {
      const position = x(tick);
      if (spec.style.showGrid)
        parts.push(
          `<line x1="${position}" y1="${frame.top}" x2="${position}" y2="${plotBottom}" stroke="${theme.grid}"/>`
        );
      parts.push(
        `<text x="${position}" y="${plotBottom + 22}" text-anchor="middle" font-size="13" fill="${theme.muted}">${xml(numberLabel(tick))}</text>`
      );
    }
    parts.push(`<line x1="${baseX}" y1="${frame.top}" x2="${baseX}" y2="${plotBottom}" stroke="${theme.ink}"/>`);
    spec.data.forEach((datum, index) => {
      const center = frame.top + band * (index + 0.5);
      const valueX = x(datum.value);
      const start = Math.min(baseX, valueX);
      const width = Math.max(1, Math.abs(valueX - baseX));
      const categoryLabel = trimLabelToWidth(
        datum.group ? `${datum.label} · ${datum.group}` : datum.label,
        categoryLabelWidth,
        13
      );
      const fill =
        spec.recipe === 'bar.diverging'
          ? datum.value >= baseline
            ? theme.positive
            : theme.negative
          : datum.group
            ? colors.get(datum.group) || theme.ink
            : theme.series[0];
      parts.push(
        `<text data-report-chart-label="bar-category" x="${frame.left - 12}" y="${center + 5}" text-anchor="end" font-size="14"${datum.emphasis ? ' font-weight="700"' : ''} fill="${theme.ink}">${xml(categoryLabel)}</text>`
      );
      const barHeight = Math.max(4, band * 0.6);
      const barTop = center - Math.max(2, band * 0.3);
      if (datum.emphasis) {
        parts.push(
          `<rect class="report-chart-emphasis" x="${start - 3}" y="${barTop - 3}" width="${width + 6}" height="${barHeight + 6}" fill="${theme.emphasis}" rx="3" opacity="0.13"/>`
        );
      }
      if (spec.recipe === 'bar.rung') {
        parts.push(
          `<g data-report-chart-mark="bar.rung"><title>${xml(`${datum.label}: ${numberLabel(datum.value)}`)}</title><line x1="${baseX}" y1="${center}" x2="${valueX}" y2="${center}" stroke="${theme.grid}" stroke-width="2"/><circle cx="${valueX}" cy="${center}" r="5" fill="${fill}"/></g>`
        );
      } else {
        const radius = spec.recipe === 'bar.ranked' ? Math.min(8, barHeight / 2) : spec.recipe ? 3 : 1;
        parts.push(
          `<g${spec.recipe ? ` data-report-chart-mark="${spec.recipe}"` : ''}><title>${xml(`${datum.label}: ${numberLabel(datum.value)}`)}</title><rect x="${start}" y="${barTop}" width="${width}" height="${barHeight}" fill="${fill}" rx="${radius}"/></g>`
        );
      }
      if (spec.style.directLabels) {
        const onRight = datum.value >= baseline;
        parts.push(
          `<text x="${valueX + (onRight ? 7 : -7)}" y="${center + 5}" text-anchor="${onRight ? 'start' : 'end'}" font-size="13"${datum.emphasis ? ' font-weight="700"' : ''} fill="${theme.muted}">${xml(numberLabel(datum.value))}</text>`
        );
      }
    });
  }
  return parts;
};

const lineXValues = (spec: LineChart): { values: number[][]; labels?: string[]; time?: boolean } => {
  const points = spec.series.flatMap((series) => series.points);
  const allDates =
    spec.xAxis?.scale === 'time' &&
    points.every((point) =>
      typeof point.x === 'number'
        ? Number.isFinite(new Date(point.x).getTime())
        : Number.isFinite(Date.parse(String(point.x)))
    );
  if (allDates) {
    return {
      values: spec.series.map((series) =>
        series.points.map((point) => (typeof point.x === 'number' ? point.x : Date.parse(String(point.x))))
      ),
      time: true,
    };
  }
  const allNumeric = spec.xAxis?.scale !== 'category' && points.every((point) => typeof point.x === 'number');
  if (allNumeric) {
    return { values: spec.series.map((series) => series.points.map((point) => point.x as number)) };
  }
  const labels = [...new Set(points.map((point) => String(point.x)))];
  const index = new Map(labels.map((label, position) => [label, position]));
  return {
    labels,
    values: spec.series.map((series) => series.points.map((point) => index.get(String(point.x)) || 0)),
  };
};

const renderLine = (spec: LineChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const xValues = lineXValues(spec);
  const flatX = xValues.values.flat();
  const flatY = spec.series.flatMap((series) =>
    series.points.flatMap((point) => [
      point.y,
      ...(point.low === undefined ? [] : [point.low]),
      ...(point.high === undefined ? [] : [point.high]),
    ])
  );
  const xDomain = finiteExtent(flatX, spec.xAxis?.min, spec.xAxis?.max, undefined, xValues.labels ? 0 : 0.03);
  const yDomain = finiteExtent(flatY, spec.yAxis?.min, spec.yAxis?.max, spec.referenceValue, 0.05);
  const parts = renderNumericAxes(
    frame,
    theme,
    xDomain,
    yDomain,
    axisName(spec.xAxis),
    axisName(spec.yAxis),
    spec.style.showGrid,
    xValues.labels ? () => '' : xValues.time ? (value) => new Date(value).toISOString().slice(0, 10) : numberLabel
  );
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const x = linear(xDomain, [frame.left, plotRight]);
  const y = linear(yDomain, [plotBottom, frame.top]);
  const directLabels: Array<
    VerticalLabelCandidate & {
      lastX: number;
      lastY: number;
      label: string;
      color: string;
      emphasized: boolean;
    }
  > = [];
  if (spec.referenceValue !== undefined) {
    const referenceY = y(spec.referenceValue);
    parts.push(
      `<line x1="${frame.left}" y1="${referenceY}" x2="${plotRight}" y2="${referenceY}" stroke="${theme.muted}" stroke-dasharray="5 5"/>`
    );
  }
  spec.series.forEach((series, seriesIndex) => {
    const color = theme.series[seriesIndex % theme.series.length];
    const dash = seriesDash(seriesIndex);
    const coordinates = series.points.map(
      (point, pointIndex) => [x(xValues.values[seriesIndex][pointIndex]), y(point.y)] as const
    );
    const pathData = coordinates
      .map(([px, py], index) => `${index === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`)
      .join(' ');
    if (
      spec.recipe === 'line.uncertainty-band' &&
      series.points.every((point) => point.low !== undefined && point.high !== undefined)
    ) {
      const upper = series.points.map(
        (point, pointIndex) => [x(xValues.values[seriesIndex][pointIndex]), y(point.high as number)] as const
      );
      const lower = series.points.toReversed().map((point, reverseIndex) => {
        const pointIndex = series.points.length - 1 - reverseIndex;
        return [x(xValues.values[seriesIndex][pointIndex]), y(point.low as number)] as const;
      });
      const bandPath = [...upper, ...lower]
        .map(([px, py], index) => `${index === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`)
        .concat('Z')
        .join(' ');
      parts.push(
        `<path data-report-chart-mark="line.uncertainty-band" d="${bandPath}" fill="${color}" opacity="0.14"/>`
      );
    }
    if (series.emphasis) {
      parts.push(
        `<path class="report-chart-emphasis" d="${pathData}" fill="none" stroke="${theme.emphasis}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round" opacity="0.13"/>`
      );
    }
    const strokeWidth =
      spec.recipe === 'line.hairline'
        ? 0.9
        : spec.recipe === 'line.direct'
          ? 2.4
          : spec.recipe === 'line.uncertainty-band'
            ? 2.15
            : 2;
    parts.push(
      `<path${spec.recipe ? ` data-report-chart-mark="${spec.recipe}"` : ''} d="${pathData}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    );
    coordinates.forEach(([px, py], pointIndex) => {
      const point = series.points[pointIndex];
      if (point.emphasis || series.emphasis) {
        parts.push(
          `<circle class="report-chart-emphasis" cx="${px}" cy="${py}" r="5.2" fill="none" stroke="${theme.emphasis}" stroke-width="5" opacity="0.2"/>`
        );
      }
      parts.push(
        `<g><title>${xml(
          `${series.label}, ${String(point.x)}: ${numberLabel(point.y)}${
            point.low !== undefined && point.high !== undefined
              ? ` [${numberLabel(point.low)}, ${numberLabel(point.high)}]`
              : ''
          }`
        )}</title><circle cx="${px}" cy="${py}" r="${spec.recipe === 'line.hairline' ? 1.25 : 2.2}" fill="${spec.recipe === 'line.hairline' ? color : theme.background}" stroke="${color}" stroke-width="${spec.recipe === 'line.hairline' ? 0.8 : 1.5}"/></g>`
      );
    });
    if (spec.style.directLabels && coordinates.length) {
      const [lastX, lastY] = coordinates[coordinates.length - 1];
      directLabels.push({
        order: seriesIndex,
        desiredY: lastY < frame.top + 14 ? lastY + 15 : lastY - 6,
        lastX,
        lastY,
        label: trimLabel(series.label, 20),
        color,
        emphasized: Boolean(series.emphasis),
      });
    }
  });
  const directLabelPositions = resolveVerticalLabelPositions(directLabels, frame.top + 12, plotBottom - 5, 18);
  directLabels.forEach((candidate) => {
    const labelX = plotRight + 14;
    const labelY = directLabelPositions.get(candidate.order) ?? candidate.desiredY;
    parts.push(
      `<path data-report-chart-label-leader="line" d="M ${svgNumber(candidate.lastX + 2)} ${svgNumber(candidate.lastY)} L ${svgNumber(labelX - 4)} ${svgNumber(labelY - 4)}" fill="none" stroke="${candidate.color}" stroke-width="0.9" opacity="0.72"/>`
    );
    parts.push(
      `<text data-report-chart-direct-label="line" x="${svgNumber(labelX)}" y="${svgNumber(labelY)}" text-anchor="start" font-size="15"${candidate.emphasized ? ' font-weight="700"' : ''} fill="${theme.ink}">${xml(trimLabelToWidth(candidate.label, Math.max(48, frame.right - 38), 15))}</text>`
    );
  });
  if (xValues.labels?.length) {
    const stride = Math.max(1, Math.ceil(xValues.labels.length / 12));
    xValues.labels.forEach((label, index) => {
      if (index % stride !== 0) return;
      parts.push(
        `<text x="${x(index)}" y="${plotBottom + 24}" text-anchor="middle" font-size="13" fill="${theme.muted}">${xml(trimLabel(label, 16))}</text>`
      );
    });
  }
  return parts;
};

const renderInterval = (spec: IntervalChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const values = spec.data.flatMap((datum) => [datum.low, datum.estimate, datum.high]);
  const domain = finiteExtent(values, spec.xAxis?.min, spec.xAxis?.max, spec.referenceValue);
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const x = spec.scale === 'log' ? logScale(domain, [frame.left, plotRight]) : linear(domain, [frame.left, plotRight]);
  const parts: string[] = [];
  for (const tick of spec.scale === 'log' ? logarithmicTicks(domain) : ticks(domain)) {
    if (spec.scale === 'log' && tick <= 0) continue;
    const position = x(tick);
    if (spec.style.showGrid)
      parts.push(
        `<line x1="${position}" y1="${frame.top}" x2="${position}" y2="${plotBottom}" stroke="${theme.grid}"/>`
      );
    parts.push(
      `<text x="${position}" y="${plotBottom + 22}" text-anchor="middle" font-size="13" fill="${theme.muted}">${xml(numberLabel(tick))}</text>`
    );
  }
  if (spec.referenceValue !== undefined) {
    const position = x(spec.referenceValue);
    parts.push(
      `<line x1="${position}" y1="${frame.top}" x2="${position}" y2="${plotBottom}" stroke="${theme.muted}" stroke-dasharray="5 5"/>`
    );
  }
  const weights = spec.data.map((datum) => datum.weight ?? 1);
  const maxWeight = Math.max(...weights);
  const band = (plotBottom - frame.top) / spec.data.length;
  const categoryLabelWidth = Math.max(24, frame.left - 40);
  const colors = groupColors(
    spec.data.map((datum) => datum.group),
    theme
  );
  spec.data.forEach((datum, index) => {
    const center = frame.top + band * (index + 0.5);
    const color = datum.group ? colors.get(datum.group) || theme.ink : theme.series[0];
    const radius = 3.5 + 4 * Math.sqrt((datum.weight ?? 1) / (maxWeight || 1));
    const categoryLabel = trimLabelToWidth(
      datum.group ? `${datum.label} · ${datum.group}` : datum.label,
      categoryLabelWidth,
      13
    );
    parts.push(
      `<text data-report-chart-label="interval-category" x="${frame.left - 12}" y="${center + 5}" text-anchor="end" font-size="14"${datum.emphasis ? ' font-weight="700"' : ''}>${xml(categoryLabel)}</text>`
    );
    if (datum.emphasis) {
      parts.push(
        `<g class="report-chart-emphasis" opacity="0.14"><line x1="${x(datum.low)}" y1="${center}" x2="${x(datum.high)}" y2="${center}" stroke="${theme.emphasis}" stroke-width="10"/><circle cx="${x(datum.estimate)}" cy="${center}" r="${radius + 3}" fill="none" stroke="${theme.emphasis}" stroke-width="4"/></g>`
      );
    }
    if (spec.recipe === 'interval.range-capsule') {
      parts.push(
        `<g data-report-chart-mark="interval.range-capsule"><title>${xml(`${datum.label}: ${numberLabel(datum.estimate)} [${numberLabel(datum.low)}, ${numberLabel(datum.high)}]`)}</title><line x1="${x(datum.low)}" y1="${center}" x2="${x(datum.high)}" y2="${center}" stroke="${color}" stroke-width="10" stroke-linecap="round" opacity="0.78"/><circle cx="${x(datum.estimate)}" cy="${center}" r="3.25" fill="${theme.background}" stroke="${color}" stroke-width="1.5"/></g>`
      );
    } else {
      parts.push(
        `<g${spec.recipe ? ` data-report-chart-mark="${spec.recipe}"` : ''}><title>${xml(`${datum.label}: ${numberLabel(datum.estimate)} [${numberLabel(datum.low)}, ${numberLabel(datum.high)}]`)}</title><line x1="${x(datum.low)}" y1="${center}" x2="${x(datum.high)}" y2="${center}" stroke="${color}" stroke-width="1.5"/><circle cx="${x(datum.estimate)}" cy="${center}" r="${radius}" fill="${theme.background}" stroke="${color}" stroke-width="2"/></g>`
      );
    }
    if (spec.style.directLabels) {
      parts.push(
        `<text x="${x(datum.high) + 8}" y="${center + 5}" font-size="13"${datum.emphasis ? ' font-weight="700"' : ''} fill="${theme.muted}">${xml(`${numberLabel(datum.estimate)} [${numberLabel(datum.low)}, ${numberLabel(datum.high)}]`)}</text>`
      );
    }
  });
  parts.push(
    `<line x1="${frame.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${theme.ink}"/>`
  );
  return parts;
};

const renderScatter = (spec: ScatterChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const xDomain = finiteExtent(
    spec.data.map((datum) => datum.x),
    spec.xAxis?.min,
    spec.xAxis?.max,
    spec.xReferenceValue,
    0.06
  );
  const yDomain = finiteExtent(
    spec.data.map((datum) => datum.y),
    spec.yAxis?.min,
    spec.yAxis?.max,
    spec.yReferenceValue,
    0.06
  );
  const parts = renderNumericAxes(
    frame,
    theme,
    xDomain,
    yDomain,
    axisName(spec.xAxis),
    axisName(spec.yAxis),
    spec.style.showGrid
  );
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const x = linear(xDomain, [frame.left, plotRight]);
  const y = linear(yDomain, [plotBottom, frame.top]);
  if (spec.recipe === 'scatter.quadrant' && spec.xReferenceValue !== undefined && spec.yReferenceValue !== undefined) {
    const referenceX = x(spec.xReferenceValue);
    const referenceY = y(spec.yReferenceValue);
    parts.unshift(
      `<g data-report-chart-mark="scatter.quadrant" fill="${theme.surface}" opacity="0.62"><rect x="${frame.left}" y="${frame.top}" width="${Math.max(0, referenceX - frame.left)}" height="${Math.max(0, referenceY - frame.top)}"/><rect x="${referenceX}" y="${referenceY}" width="${Math.max(0, plotRight - referenceX)}" height="${Math.max(0, plotBottom - referenceY)}"/></g>`
    );
  }
  if (spec.xReferenceValue !== undefined) {
    const position = x(spec.xReferenceValue);
    parts.push(
      `<line${spec.recipe === 'scatter.quadrant' ? ' data-report-chart-reference="x"' : ''} x1="${position}" y1="${frame.top}" x2="${position}" y2="${frame.height - frame.bottom}" stroke="${theme.muted}" stroke-dasharray="5 5"/>`
    );
  }
  if (spec.yReferenceValue !== undefined) {
    const position = y(spec.yReferenceValue);
    parts.push(
      `<line${spec.recipe === 'scatter.quadrant' ? ' data-report-chart-reference="y"' : ''} x1="${frame.left}" y1="${position}" x2="${frame.width - frame.right}" y2="${position}" stroke="${theme.muted}" stroke-dasharray="5 5"/>`
    );
  }
  const colors = groupColors(
    spec.data.map((datum) => datum.group),
    theme
  );
  const shapeIndexes = new Map([...colors.keys()].map((group, index) => [group, index]));
  const maxSize = Math.max(...spec.data.map((datum) => datum.size || 1));
  const overlapCounts = new Map<string, number>();
  const directLabels: Array<
    VerticalLabelCandidate & {
      pointX: number;
      pointY: number;
      radius: number;
      labelOnLeft: boolean;
      label: string;
      emphasized: boolean;
    }
  > = [];
  let directLabelIndex = 0;
  const scatterLabelIds = (() => {
    if (spec.data.length <= 12) return new Set(spec.data.map((datum) => datum.id));
    const selected = new Set(spec.data.filter((datum) => datum.emphasis).map((datum) => datum.id));
    const candidates = [
      spec.data.toSorted((first, second) => first.x - second.x)[0],
      spec.data.toSorted((first, second) => second.x - first.x)[0],
      spec.data.toSorted((first, second) => first.y - second.y)[0],
      spec.data.toSorted((first, second) => second.y - first.y)[0],
    ];
    candidates.forEach((datum) => {
      if (datum) selected.add(datum.id);
    });
    return selected;
  })();
  spec.data.forEach((datum) => {
    const key = `${datum.x}\u0000${datum.y}`;
    overlapCounts.set(key, (overlapCounts.get(key) || 0) + 1);
  });
  spec.data.forEach((datum) => {
    const color = datum.group ? colors.get(datum.group) || theme.ink : theme.series[0];
    const shapeIndex = datum.group ? shapeIndexes.get(datum.group) || 0 : 0;
    const radius = 3.5 + 7 * Math.sqrt((datum.size ?? 1) / maxSize);
    const jitterX =
      spec.recipe === 'scatter.jitter' && (overlapCounts.get(`${datum.x}\u0000${datum.y}`) || 0) > 1
        ? deterministicJitter(datum.id, 'x', 7)
        : 0;
    const pointX = Math.max(frame.left, Math.min(frame.width - frame.right, x(datum.x) + jitterX));
    const pointY = y(datum.y);
    if (datum.emphasis) {
      parts.push(
        scatterShapeSvg(
          shapeIndex,
          pointX,
          pointY,
          radius + 4,
          theme.emphasis,
          theme.emphasis,
          undefined,
          0.14,
          'report-chart-emphasis'
        )
      );
    }
    const pointShape = scatterShapeSvg(
      shapeIndex,
      pointX,
      pointY,
      radius,
      color,
      theme.background,
      `${datum.label || datum.id}: ${numberLabel(datum.x)}, ${numberLabel(datum.y)}${datum.group ? `; ${datum.group}` : ''}`
    );
    parts.push(
      spec.recipe
        ? `<g data-report-chart-mark="${spec.recipe}"${jitterX ? ` data-report-chart-jitter-x="${jitterX.toFixed(3)}"` : ''}>${pointShape}</g>`
        : pointShape
    );
    if (spec.style.directLabels && datum.label && scatterLabelIds.has(datum.id)) {
      const nearRight = pointX > plotRight - 150;
      const nearLeft = pointX < frame.left + 150;
      const labelOnLeft = nearRight || (!nearLeft && directLabelIndex % 2 === 1);
      const labelBelow = pointY < frame.top + 18;
      directLabels.push({
        order: directLabelIndex,
        desiredY: pointY + (labelBelow ? radius + 11 : -radius - 4),
        pointX,
        pointY,
        radius,
        labelOnLeft,
        label: trimLabelToWidth(datum.group ? `${datum.label} · ${datum.group}` : datum.label, 156, 13),
        emphasized: Boolean(datum.emphasis),
      });
      directLabelIndex += 1;
    }
  });
  const directLabelPositions = new Map<number, number>();
  for (const candidates of [
    directLabels.filter((candidate) => candidate.labelOnLeft),
    directLabels.filter((candidate) => !candidate.labelOnLeft),
  ]) {
    for (const [order, position] of resolveVerticalLabelPositions(candidates, frame.top + 12, plotBottom - 3, 18)) {
      directLabelPositions.set(order, position);
    }
  }
  directLabels.forEach((candidate) => {
    const labelX = candidate.pointX + (candidate.labelOnLeft ? -candidate.radius - 3 : candidate.radius + 3);
    const labelY = directLabelPositions.get(candidate.order) ?? candidate.desiredY;
    if (Math.abs(labelY - candidate.desiredY) > 0.5) {
      const pointEdgeX = candidate.pointX + (candidate.labelOnLeft ? -candidate.radius : candidate.radius);
      const labelEdgeX = labelX + (candidate.labelOnLeft ? 1 : -1);
      parts.push(
        `<line data-report-chart-label-leader="scatter" x1="${svgNumber(pointEdgeX)}" y1="${svgNumber(candidate.pointY)}" x2="${svgNumber(labelEdgeX)}" y2="${svgNumber(labelY - 3)}" stroke="${theme.muted}" stroke-width="0.75" opacity="0.68"/>`
      );
    }
    parts.push(
      `<text data-report-chart-direct-label="scatter" x="${svgNumber(labelX)}" y="${svgNumber(labelY)}" text-anchor="${candidate.labelOnLeft ? 'end' : 'start'}" font-size="15"${candidate.emphasized ? ' font-weight="700"' : ''} fill="${theme.ink}">${xml(candidate.label)}</text>`
    );
  });
  return parts;
};

const mixWithBackground = (color: string, value: number): string => {
  const opacity = Math.max(0.12, Math.min(0.9, value));
  return (
    color +
    Math.round(opacity * 255)
      .toString(16)
      .padStart(2, '0')
  );
};

const matrixCellStyle = (
  status: MatrixCellStatus | undefined,
  value: number | undefined,
  domain: [number, number],
  theme: ChartTheme,
  colorScale?: 'sequential' | 'diverging',
  center = 0
): { fill: string; stroke: string; text: string; dash?: string } => {
  const solidStyle = (fill: string) => ({ fill, stroke: fill, text: matrixTextColor(fill, theme) });
  if (status === 'supports') return solidStyle(theme.supports);
  if (status === 'against') return solidStyle(theme.against);
  if (status === 'positive') return solidStyle(theme.positive);
  if (status === 'negative') return solidStyle(theme.negative);
  if (status === 'risk') return solidStyle(theme.risk);
  if (status === 'mixed') return solidStyle(theme.mixed);
  if (status === 'neutral') return solidStyle(theme.muted);
  if (status === 'unknown')
    return { fill: theme.background, stroke: theme.muted, text: matrixTextColor(theme.background, theme), dash: '3 3' };
  if (value !== undefined) {
    const ratio =
      colorScale === 'diverging'
        ? value >= center
          ? (value - center) / (domain[1] - center || 1)
          : (center - value) / (center - domain[0] || 1)
        : domain[0] === domain[1]
          ? 0.5
          : (value - domain[0]) / (domain[1] - domain[0]);
    const color = colorScale === 'diverging' && value < center ? theme.against : theme.supports;
    const fill = mixWithBackground(color, ratio);
    return {
      fill,
      stroke: theme.grid,
      text: matrixTextColor(fill, theme),
    };
  }
  return { fill: theme.surface, stroke: theme.grid, text: matrixTextColor(theme.surface, theme) };
};

const renderMatrix = (spec: MatrixChart, frame: ChartFrame, theme: ChartTheme): string[] => {
  const plotRight = frame.width - frame.right;
  const plotBottom = frame.height - frame.bottom;
  const cellWidth = (plotRight - frame.left) / spec.columns.length;
  const cellHeight = (plotBottom - frame.top) / spec.rows.length;
  const rowIndex = new Map(spec.rows.map((row, index) => [row, index]));
  const columnIndex = new Map(spec.columns.map((column, index) => [column, index]));
  const numericValues = spec.cells.flatMap((cell) => (cell.value === undefined ? [] : [cell.value]));
  const domain = spec.valueDomain || finiteExtent(numericValues);
  const punchcardMaximum = Math.max(0, spec.valueDomain?.[1] ?? 0, ...numericValues);
  const parts: string[] = [];
  spec.rows.forEach((row, index) => {
    const y = frame.top + cellHeight * (index + 0.5);
    parts.push(
      `<text x="${frame.left - 10}" y="${y + 5}" text-anchor="end" font-size="14" fill="${theme.ink}">${xml(trimLabel(row, 24))}</text>`
    );
  });
  spec.columns.forEach((column, index) => {
    const x = frame.left + cellWidth * (index + 0.5);
    const y = frame.top - 8;
    parts.push(
      `<text x="${x}" y="${y}" text-anchor="start" font-size="13" fill="${theme.muted}" transform="rotate(-42 ${x} ${y})">${xml(trimLabel(column, 18))}</text>`
    );
  });
  spec.cells.forEach((cell) => {
    const row = rowIndex.get(cell.row);
    const column = columnIndex.get(cell.column);
    if (row === undefined || column === undefined) return;
    const x = frame.left + column * cellWidth + 1;
    const y = frame.top + row * cellHeight + 1;
    const style = matrixCellStyle(cell.status, cell.value, domain, theme, spec.colorScale, spec.center ?? 0);
    const accessibleLabel =
      cell.label || (cell.status ? cell.status : cell.value === undefined ? 'unknown' : numberLabel(cell.value));
    if (cell.emphasis) {
      parts.push(
        `<rect class="report-chart-emphasis" x="${x - 3}" y="${y - 3}" width="${Math.max(1, cellWidth + 4)}" height="${Math.max(1, cellHeight + 4)}" rx="4" fill="${theme.emphasis}" opacity="0.13"/>`
      );
    }
    let punchcardRadius: number | undefined;
    if (spec.recipe === 'matrix.punchcard') {
      const maximumRadius = Math.max(1, Math.min(cellWidth, cellHeight) * 0.4);
      punchcardRadius = punchcardMaximum > 0 ? maximumRadius * Math.sqrt((cell.value || 0) / punchcardMaximum) : 0;
      parts.push(
        `<g data-report-chart-mark="matrix.punchcard"><title>${xml(`${cell.row} / ${cell.column}: ${accessibleLabel}`)}</title><rect x="${x}" y="${y}" width="${Math.max(1, cellWidth - 2)}" height="${Math.max(1, cellHeight - 2)}" rx="1" fill="${theme.surface}" stroke="${theme.grid}"/><circle data-report-chart-value="${cell.value ?? 0}" cx="${x + cellWidth / 2 - 1}" cy="${y + cellHeight / 2 - 1}" r="${punchcardRadius.toFixed(3)}" fill="${theme.series[0]}"/></g>`
      );
    } else {
      parts.push(
        `<g${spec.recipe ? ` data-report-chart-mark="${spec.recipe}"` : ''}><title>${xml(`${cell.row} / ${cell.column}: ${accessibleLabel}`)}</title><rect x="${x}" y="${y}" width="${Math.max(1, cellWidth - 2)}" height="${Math.max(1, cellHeight - 2)}" rx="1" fill="${style.fill}" stroke="${style.stroke}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''}/></g>`
      );
    }
    const cellLabel =
      cell.label ||
      (cell.status ? MATRIX_STATUS_SYMBOLS[cell.status] : cell.value === undefined ? '' : numberLabel(cell.value));
    if (cellLabel && cellWidth >= 26 && cellHeight >= 20) {
      const labelFill =
        spec.recipe === 'matrix.punchcard'
          ? punchcardRadius !== undefined && punchcardRadius >= 11
            ? matrixTextColor(theme.series[0], theme)
            : matrixTextColor(theme.surface, theme)
          : style.text;
      parts.push(
        `<text x="${x + cellWidth / 2 - 1}" y="${y + cellHeight / 2 + 5}" text-anchor="middle" font-size="13" font-weight="${cell.emphasis ? 700 : 600}" fill="${labelFill}">${xml(trimLabelToWidth(cellLabel, Math.max(12, cellWidth - 8), 13))}</text>`
      );
    }
  });
  return parts;
};

const sceneToneColor = (tone: ReportChartSceneTone | undefined, theme: ChartTheme): string | undefined => {
  if (!tone) return undefined;
  if (tone === 'none') return 'none';
  if (tone === 'background') return theme.background;
  if (tone === 'surface') return theme.surface;
  if (tone === 'ink') return theme.ink;
  if (tone === 'muted') return theme.muted;
  if (tone === 'grid') return theme.grid;
  if (tone === 'emphasis') return theme.emphasis;
  if (tone === 'positive') return theme.positive;
  if (tone === 'negative') return theme.negative;
  if (tone === 'risk') return theme.risk;
  const seriesIndex = Number(tone.replace('series-', '')) - 1;
  return theme.series[Math.max(0, seriesIndex) % theme.series.length];
};

const scenePatternPrefix = (scene: ReportChartScene): string => {
  let hash = 2_166_136_261;
  for (const character of `${scene.recipe}\u0000${scene.title}`) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `report-chart-${(hash >>> 0).toString(16)}`;
};

const scenePrimitiveSvg = (
  primitive: ReportChartScenePrimitive,
  scene: ReportChartScene,
  spec: ReportChartSpecV2,
  theme: ChartTheme,
  patternPrefix: string
): string => {
  const fill =
    spec.style.palette !== 'nature' && primitive.fill === 'series-5'
      ? `url(#${patternPrefix}-hatch)`
      : spec.style.palette !== 'nature' && primitive.fill === 'series-6'
        ? `url(#${patternPrefix}-dots)`
        : sceneToneColor(primitive.fill, theme);
  const stroke = sceneToneColor(primitive.stroke, theme);
  const attributes = [
    `class="report-chart-scene-${xml(primitive.role)}"`,
    primitive.markId ? `data-report-chart-mark-id="${xml(primitive.markId)}"` : '',
    fill !== undefined ? `fill="${fill}"` : '',
    stroke !== undefined ? `stroke="${stroke}"` : '',
    primitive.strokeWidth !== undefined ? `stroke-width="${primitive.strokeWidth}"` : '',
    primitive.opacity !== undefined ? `opacity="${primitive.opacity}"` : '',
    primitive.dash?.length ? `stroke-dasharray="${primitive.dash.join(' ')}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  let element: string;
  if (primitive.type === 'rect') {
    element = `<rect ${attributes} x="${primitive.x}" y="${primitive.y}" width="${primitive.width}" height="${primitive.height}"${primitive.rx !== undefined ? ` rx="${primitive.rx}"` : ''}/>`;
  } else if (primitive.type === 'line') {
    element = `<line ${attributes} x1="${primitive.x1}" y1="${primitive.y1}" x2="${primitive.x2}" y2="${primitive.y2}"/>`;
  } else if (primitive.type === 'circle') {
    element = `<circle ${attributes} cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}"/>`;
  } else if (primitive.type === 'path') {
    element = `<path ${attributes} d="${xml(primitive.d)}"${primitive.lineJoin ? ` stroke-linejoin="${primitive.lineJoin}"` : ''}${primitive.lineCap ? ` stroke-linecap="${primitive.lineCap}"` : ''}/>`;
  } else {
    const transform =
      primitive.rotation === undefined
        ? ''
        : ` transform="rotate(${primitive.rotation} ${primitive.x} ${primitive.y})"`;
    element = `<text ${attributes} x="${primitive.x}" y="${primitive.y}" text-anchor="${primitive.anchor || 'start'}"${primitive.baseline && primitive.baseline !== 'auto' ? ` dominant-baseline="${primitive.baseline === 'middle' ? 'middle' : 'hanging'}"` : ''} font-size="${primitive.fontSize}"${primitive.fontWeight ? ` font-weight="${primitive.fontWeight}"` : ''}${transform}>${xml(primitive.text)}</text>`;
  }
  if (!primitive.markId) return element;
  const mark = scene.marks.find((candidate) => candidate.id === primitive.markId);
  return `<g data-report-chart-scene-mark="${xml(primitive.markId)}"><title>${xml(
    mark ? `${mark.label}: ${mark.valueLabel}` : primitive.markId
  )}</title>${element}</g>`;
};

const renderReportChartSceneSvg = (spec: ReportChartSpecV2): string => {
  const scene = compileReportChartScene(spec);
  const theme = themeForStyle(spec.style as ChartStyle);
  const headerHeight = spec.description ? 82 : 58;
  const footerHeight = spec.caption ? 36 : 0;
  const height = scene.height + headerHeight + footerHeight;
  const patternPrefix = scenePatternPrefix(scene);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${height}" width="${scene.width}" height="${height}" role="img" aria-labelledby="report-chart-title report-chart-description" data-report-chart-schema="${xml(spec.schema)}" data-report-chart-kind="${xml(spec.kind)}" data-report-chart-recipe="${xml(spec.recipe)}">`,
    `<title id="report-chart-title">${xml(spec.title)}</title>`,
    `<desc id="report-chart-description">${xml(spec.description || spec.caption || `${spec.kind} report chart`)}</desc>`,
    `<rect width="${scene.width}" height="${height}" fill="${theme.background}"/>`,
    '<defs>',
    `<pattern id="${patternPrefix}-hatch" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="${theme.surface}"/><path d="M-2 7L7-2M2 9L9 2" stroke="${theme.series[0]}" stroke-width="1"/></pattern>`,
    `<pattern id="${patternPrefix}-dots" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="${theme.surface}"/><circle cx="3.5" cy="3.5" r="1.2" fill="${theme.series[1]}"/></pattern>`,
    '</defs>',
    `<g font-family="Arial, Helvetica, sans-serif" fill="${theme.ink}" letter-spacing="0">`,
    `<text x="28" y="38" font-size="22" font-weight="650">${xml(trimLabel(spec.title, 76))}</text>`,
    ...(spec.description
      ? [`<text x="28" y="64" font-size="14" fill="${theme.muted}">${xml(trimLabel(spec.description, 104))}</text>`]
      : []),
    `<g transform="translate(0 ${headerHeight})">`,
    ...scene.primitives.map((primitive) => scenePrimitiveSvg(primitive, scene, spec, theme, patternPrefix)),
    '</g>',
    ...(spec.caption
      ? [
          `<text x="28" y="${height - 14}" font-size="14" fill="${theme.muted}">${xml(trimLabel(spec.caption, 116))}</text>`,
        ]
      : []),
    '</g>',
    '</svg>',
  ];
  return `${parts.join('\n')}\n`;
};

export const renderReportChartSvg = (spec: ReportChartSpec): string => {
  if (spec.schema === REPORT_CHART_SCHEMA_V2) return renderReportChartSceneSvg(spec);
  // The public type is inferred under the repository's non-strict TypeScript mode,
  // while the runtime Zod parser guarantees every required normalized field.
  const chart = spec as ReportChartSpecV1 as RenderableReportChart;
  const theme = themeFor(chart);
  const frame = frameFor(chart);
  const parts = chartHeader(chart, frame, theme);
  parts.push(...renderLegend(chart, frame, theme));
  if (chart.kind === 'bar') parts.push(...renderBar(chart, frame, theme));
  else if (chart.kind === 'line') parts.push(...renderLine(chart, frame, theme));
  else if (chart.kind === 'interval') parts.push(...renderInterval(chart, frame, theme));
  else if (chart.kind === 'scatter') parts.push(...renderScatter(chart, frame, theme));
  else parts.push(...renderMatrix(chart, frame, theme));
  parts.push(...chartFooter(chart, frame, theme));
  return `${parts.join('\n')}\n`;
};
