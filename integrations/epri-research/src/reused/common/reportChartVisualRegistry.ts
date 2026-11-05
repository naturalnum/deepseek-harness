import {
  REPORT_CHART_RECIPE_CATALOG,
  REPORT_CHART_RECIPES,
  type ReportChartRecipe,
  type ReportChartSpec,
} from './reportChart';

export const REPORT_CHART_DOMAINS = [
  'general',
  'science',
  'finance',
  'factor',
  'target',
  'mathematics',
  'medical',
  'challenge',
] as const;

export type ReportChartDomain = (typeof REPORT_CHART_DOMAINS)[number];
export type ReportChartVisualQuestion = NonNullable<ReportChartSpec['visualIntent']>['question'];
export type ReportChartReadingMode = NonNullable<ReportChartSpec['visualIntent']>['readingMode'];
export type ReportChartPlacement = NonNullable<ReportChartSpec['visualIntent']>['placement'];

type ReportChartVisualProfile = {
  domains: readonly ReportChartDomain[];
  questions: readonly ReportChartVisualQuestion[];
  readingModes: readonly ReportChartReadingMode[];
  placements: readonly ReportChartPlacement[];
  leadEligible: boolean;
  maxRecommendedMarks: number;
};

export type ReportChartVisualDefinition = ReportChartVisualProfile & {
  recipe: ReportChartRecipe;
  kind: (typeof REPORT_CHART_RECIPE_CATALOG)[ReportChartRecipe]['kind'];
  renderer: 'deterministic-svg';
  description: string;
  useWhen: string;
  avoidWhen: string;
};

const ALL_DOMAINS = REPORT_CHART_DOMAINS;
const ALL_PLACEMENTS = ['lead', 'supporting', 'appendix'] as const;
const SUPPORTING_PLACEMENTS = ['supporting', 'appendix'] as const;
const EDITORIAL_MODES = ['glance', 'editorial'] as const;
const ALL_READING_MODES = ['glance', 'editorial', 'explore'] as const;

const VISUAL_PROFILES = {
  'bar.ranked': profile(ALL_DOMAINS, ['compare'], EDITORIAL_MODES, ALL_PLACEMENTS, true, 12),
  'bar.rung': profile(ALL_DOMAINS, ['compare'], EDITORIAL_MODES, ALL_PLACEMENTS, true, 10),
  'bar.diverging': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['compare', 'change'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    14
  ),
  'line.direct': profile(ALL_DOMAINS, ['change'], ALL_READING_MODES, ALL_PLACEMENTS, true, 80),
  'line.hairline': profile(
    ['science', 'finance', 'factor', 'mathematics', 'medical', 'challenge'],
    ['change'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    180
  ),
  'line.uncertainty-band': profile(
    ['science', 'finance', 'factor', 'target', 'mathematics', 'medical'],
    ['change', 'uncertainty'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    80
  ),
  'interval.forest': profile(
    ['science', 'finance', 'factor', 'target', 'medical'],
    ['compare', 'uncertainty'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    24
  ),
  'interval.range-capsule': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical'],
    ['compare', 'uncertainty'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    16
  ),
  'scatter.quadrant': profile(
    ['science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['relationship'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    100
  ),
  'scatter.jitter': profile(
    ['science', 'finance', 'factor', 'target', 'medical'],
    ['relationship', 'uncertainty'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    140
  ),
  'matrix.claim-matrix': profile(
    ['general', 'science', 'finance', 'target', 'medical'],
    ['relationship'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    64
  ),
  'matrix.punchcard': profile(
    ['science', 'finance', 'factor', 'target', 'medical'],
    ['relationship'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    64
  ),
  'matrix.heatmap': profile(
    ['science', 'finance', 'factor', 'target', 'mathematics', 'medical'],
    ['relationship'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    100
  ),
  'bar.grouped': profile(ALL_DOMAINS, ['compare'], ALL_READING_MODES, ALL_PLACEMENTS, true, 24),
  'bar.stacked': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical'],
    ['compare', 'composition'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    24
  ),
  'bar.waterfall': profile(
    ['general', 'finance', 'factor', 'challenge'],
    ['change', 'composition'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    14
  ),
  'line.area': profile(
    ['general', 'science', 'finance', 'factor', 'medical'],
    ['change', 'composition'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    80
  ),
  'pair.dumbbell': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['compare', 'change'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    18
  ),
  'distribution.box': profile(
    ['science', 'finance', 'factor', 'target', 'mathematics', 'medical'],
    ['compare', 'uncertainty'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    20
  ),
  'composition.waffle': profile(
    ['general', 'science', 'finance', 'target', 'medical'],
    ['composition'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    100
  ),
  'flow.funnel': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['process'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    10
  ),
  'timeline.lineage': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['change', 'process'],
    ALL_READING_MODES,
    ALL_PLACEMENTS,
    true,
    24
  ),
  'hierarchy.tree': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'mathematics', 'medical'],
    ['hierarchy'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    40
  ),
  'scale.bipolar': profile(
    ['general', 'science', 'finance', 'factor', 'target', 'medical', 'challenge'],
    ['compare', 'relationship'],
    EDITORIAL_MODES,
    ALL_PLACEMENTS,
    true,
    12
  ),
  'sequence.rainfall': profile(
    ['science', 'finance', 'factor', 'target', 'mathematics', 'medical', 'challenge'],
    ['change', 'relationship'],
    ['editorial', 'explore'],
    SUPPORTING_PLACEMENTS,
    false,
    100
  ),
} satisfies Record<ReportChartRecipe, ReportChartVisualProfile>;

function profile(
  domains: readonly ReportChartDomain[],
  questions: readonly ReportChartVisualQuestion[],
  readingModes: readonly ReportChartReadingMode[],
  placements: readonly ReportChartPlacement[],
  leadEligible: boolean,
  maxRecommendedMarks: number
): ReportChartVisualProfile {
  return { domains, questions, readingModes, placements, leadEligible, maxRecommendedMarks };
}

export const REPORT_CHART_VISUAL_REGISTRY: readonly ReportChartVisualDefinition[] = REPORT_CHART_RECIPES.map(
  (recipe) => {
    const visualProfile = VISUAL_PROFILES[recipe];
    return {
      recipe,
      kind: REPORT_CHART_RECIPE_CATALOG[recipe].kind,
      renderer: 'deterministic-svg' as const,
      description: REPORT_CHART_RECIPE_CATALOG[recipe].description,
      useWhen: REPORT_CHART_RECIPE_CATALOG[recipe].useWhen,
      avoidWhen: REPORT_CHART_RECIPE_CATALOG[recipe].avoidWhen,
      domains: visualProfile.domains,
      questions: visualProfile.questions,
      readingModes: visualProfile.readingModes,
      placements: visualProfile.placements,
      leadEligible: visualProfile.leadEligible,
      maxRecommendedMarks: visualProfile.maxRecommendedMarks,
    };
  }
);

const VISUAL_DEFINITION_BY_RECIPE = new Map(
  REPORT_CHART_VISUAL_REGISTRY.map((definition) => [definition.recipe, definition] as const)
);

export const getReportChartVisualDefinition = (
  recipe: ReportChartRecipe | undefined
): ReportChartVisualDefinition | undefined => (recipe ? VISUAL_DEFINITION_BY_RECIPE.get(recipe) : undefined);

export type ReportChartRecommendationInput = {
  domain: ReportChartDomain;
  question: ReportChartVisualQuestion;
  readingMode?: ReportChartReadingMode;
  placement?: ReportChartPlacement;
  markCount?: number;
};

export const recommendReportChartRecipes = ({
  domain,
  question,
  readingMode = 'editorial',
  placement = 'supporting',
  markCount,
}: ReportChartRecommendationInput): readonly ReportChartVisualDefinition[] =>
  REPORT_CHART_VISUAL_REGISTRY.map((definition, index) => {
    let score = definition.questions.includes(question) ? 12 : 0;
    score += definition.domains.includes(domain) ? 7 : definition.domains.includes('general') ? 2 : 0;
    score += definition.readingModes.includes(readingMode) ? 4 : 0;
    score += definition.placements.includes(placement) ? 3 : 0;
    if (placement === 'lead') score += definition.leadEligible ? 5 : -10;
    if (markCount && markCount > definition.maxRecommendedMarks) score -= 6;
    return { definition, index, score };
  })
    .filter(({ definition, score }) => score > 0 && definition.questions.includes(question))
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .map(({ definition }) => definition);

export type ResolvedReportChartPresentation = {
  definition?: ReportChartVisualDefinition;
  question: ReportChartVisualQuestion;
  readingMode: ReportChartReadingMode;
  placement: ReportChartPlacement;
  takeaway?: string;
  leadEligible: boolean;
};

export const resolveReportChartPresentation = (spec: ReportChartSpec): ResolvedReportChartPresentation => {
  const definition = getReportChartVisualDefinition(spec.recipe);
  const intent = spec.visualIntent;
  return {
    definition,
    question: intent?.question || definition?.questions[0] || 'compare',
    readingMode: intent?.readingMode || 'editorial',
    placement: intent?.placement || 'supporting',
    takeaway: intent?.takeaway,
    leadEligible: Boolean(definition?.leadEligible),
  };
};
