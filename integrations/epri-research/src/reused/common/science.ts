/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from './chatLib';
import { getPromptLanguageInstruction } from './language';
import { readFinancialFactorPortfolio } from './financialFactor';
import {
  isStructuredReportChartCard,
  readFinanceArtifactKind,
  type FinanceCompletionManifest,
  type StructuredReportCard,
} from './finance';
import { readTargetDiscoveryPortfolio } from './targetDiscovery';
import type { ReportChartSpec } from './reportChart';
import { getReportChartVisualDefinition } from './reportChartVisualRegistry';
import type { ResearchStrategy } from './researchStrategy';
import { SCIENCE_MATERIALIZED_SKILL_IDS, SCIENCE_SKILL_PACK_MANIFEST_PATH } from './scienceSkills.generated';
import { buildDeepScientistUserInputRoutingPrompt } from './toolRouting';

export const SCIENCE_MODE_ID = 'science';
export const SCIENCE_EVENT_SCHEMA = 'deepscientist.science.event.v1';
export const SCIENCE_PANEL_SCHEMA = 'deepscientist.science.panel.v1';
export const RESEARCH_ROUTE_SCHEMA = 'deepscientist.science.research_route.v1' as const;
export const RESEARCH_ROUTE_ARTIFACT_ID = 'research_roadmap' as const;
export const SCIENCE_CORE_SKILL_NAME = 'deepscientist-science';
export const SCIENCE_CORE_SKILL_PATH = 'resources/skills/science/SKILL.md';
export const SCIENCE_ARTIFACT_SKILL_NAME = 'deepscientist-science-artifact';
export const SCIENCE_ARTIFACT_SKILL_PATH = 'resources/skills/science-artifact/SKILL.md';
export const SCIENCE_REPORT_CHART_SKILL_NAME = 'deepscientist-report-chart';
export const SCIENCE_REPORT_CHART_SKILL_PATH = 'resources/skills/report-chart/SKILL.md';
export const REPORT_AUTHORING_SKILL_NAME = 'report-authoring';
export const REPORT_AUTHORING_SKILL_PATH = 'resources/skills/report-authoring/SKILL.md';
export const SCIENCE_VISUALS_SKILL_NAME = 'deepscientist-scientific-visuals';
export const SCIENCE_VISUALS_SKILL_PATH = 'resources/skills/deepscientist-scientific-visuals/SKILL.md';
export const SCIENCE_WORKFLOW_SKILL_NAME = 'deepscientist-workflow';
export const SCIENCE_WORKFLOW_SKILL_PATH = 'resources/skills/workflow/SKILL.md';
export const SCIENCE_IDEA_SKILL_NAME = 'ds-idea';
export const SCIENCE_IDEA_SKILL_PATH = 'resources/skills/ds-idea/SKILL.md';
export const SCIENCE_ONBOARDING_SKILL_NAME = 'deepscientist-onboarding';
export const SCIENCE_ONBOARDING_SKILL_PATH = 'resources/skills/onboarding/SKILL.md';
export const SCIENCE_WRITING_SKILL_NAME = 'deepscientist-writing';
export const SCIENCE_WRITING_SKILL_PATH = 'resources/skills/writing/SKILL.md';
export const SCIENCE_PRESENTATION_SKILL_NAME = 'deepscientist-presentation';
export const SCIENCE_PRESENTATION_SKILL_PATH = 'resources/skills/presentation/SKILL.md';
export const SCIENCE_DATABASES_SKILL_NAME = 'deepscientist-databases';
export const SCIENCE_DATABASES_SKILL_PATH = 'resources/skills/databases/SKILL.md';
export const SCIENCE_BIO_SKILL_NAME = 'deepscientist-bio';
export const SCIENCE_BIO_SKILL_PATH = 'resources/skills/deepscientist-bio/SKILL.md';
export const SCIENCE_BIOMODELS_SKILL_NAME = 'deepscientist-biomodels';
export const SCIENCE_BIOMODELS_SKILL_PATH = 'resources/skills/biomodels/SKILL.md';
export const SCIENCE_SINGLECELL_SKILL_NAME = 'deepscientist-singlecell';
export const SCIENCE_SINGLECELL_SKILL_PATH = 'resources/skills/singlecell/SKILL.md';
export const SCIENCE_COMPUTE_SKILL_NAME = 'deepscientist-compute';
export const SCIENCE_COMPUTE_SKILL_PATH = 'resources/skills/compute/SKILL.md';
export const SCIENCE_EMPIRICAL_SKILL_NAME = 'deepscientist-empirical';
export const SCIENCE_EMPIRICAL_SKILL_PATH = 'resources/skills/empirical/SKILL.md';
export const SCIENCE_VENDOR_CATALOG_SKILL_NAME = 'deepscientist-science-vendor-catalog';
export const SCIENCE_VENDOR_CATALOG_SKILL_PATH = 'resources/skills/science-vendor-catalog/SKILL.md';

export const LEGACY_SCIENCE_DEFAULT_SKILL_IDS = [
  SCIENCE_CORE_SKILL_NAME,
  SCIENCE_ARTIFACT_SKILL_NAME,
  SCIENCE_VENDOR_CATALOG_SKILL_NAME,
] as const;

const PREVIOUS_DOMAIN_ROUTER_DEFAULT_SKILL_IDS = [
  SCIENCE_CORE_SKILL_NAME,
  SCIENCE_ARTIFACT_SKILL_NAME,
  SCIENCE_ONBOARDING_SKILL_NAME,
  SCIENCE_WORKFLOW_SKILL_NAME,
  SCIENCE_IDEA_SKILL_NAME,
  SCIENCE_WRITING_SKILL_NAME,
  SCIENCE_PRESENTATION_SKILL_NAME,
  SCIENCE_DATABASES_SKILL_NAME,
  SCIENCE_BIOMODELS_SKILL_NAME,
  SCIENCE_SINGLECELL_SKILL_NAME,
  SCIENCE_COMPUTE_SKILL_NAME,
  SCIENCE_EMPIRICAL_SKILL_NAME,
] as const;

const PREVIOUS_COMPACT_DOMAIN_DEFAULT_SKILL_IDS = [
  SCIENCE_CORE_SKILL_NAME,
  SCIENCE_ARTIFACT_SKILL_NAME,
  SCIENCE_ONBOARDING_SKILL_NAME,
  SCIENCE_WORKFLOW_SKILL_NAME,
  SCIENCE_IDEA_SKILL_NAME,
  SCIENCE_WRITING_SKILL_NAME,
  SCIENCE_PRESENTATION_SKILL_NAME,
  SCIENCE_DATABASES_SKILL_NAME,
  SCIENCE_BIO_SKILL_NAME,
  SCIENCE_COMPUTE_SKILL_NAME,
  SCIENCE_EMPIRICAL_SKILL_NAME,
] as const;

const PREVIOUS_MINIMAL_SCIENCE_DEFAULT_SKILL_IDS = [SCIENCE_CORE_SKILL_NAME, SCIENCE_ARTIFACT_SKILL_NAME] as const;
const PREVIOUS_REPORT_CHART_DEFAULT_SKILL_IDS = [
  SCIENCE_CORE_SKILL_NAME,
  SCIENCE_ARTIFACT_SKILL_NAME,
  SCIENCE_REPORT_CHART_SKILL_NAME,
] as const;

export const DEFAULT_SCIENCE_SKILL_IDS = [
  SCIENCE_CORE_SKILL_NAME,
  SCIENCE_ARTIFACT_SKILL_NAME,
  SCIENCE_VISUALS_SKILL_NAME,
  SCIENCE_REPORT_CHART_SKILL_NAME,
  REPORT_AUTHORING_SKILL_NAME,
] as const;

export const SCIENCE_SKILL_RESOURCE_PATH_BY_ID = {
  [SCIENCE_CORE_SKILL_NAME]: SCIENCE_CORE_SKILL_PATH,
  [SCIENCE_ARTIFACT_SKILL_NAME]: SCIENCE_ARTIFACT_SKILL_PATH,
  [SCIENCE_VISUALS_SKILL_NAME]: SCIENCE_VISUALS_SKILL_PATH,
  [SCIENCE_REPORT_CHART_SKILL_NAME]: SCIENCE_REPORT_CHART_SKILL_PATH,
  [REPORT_AUTHORING_SKILL_NAME]: REPORT_AUTHORING_SKILL_PATH,
  [SCIENCE_ONBOARDING_SKILL_NAME]: SCIENCE_ONBOARDING_SKILL_PATH,
  [SCIENCE_WORKFLOW_SKILL_NAME]: SCIENCE_WORKFLOW_SKILL_PATH,
  [SCIENCE_IDEA_SKILL_NAME]: SCIENCE_IDEA_SKILL_PATH,
  [SCIENCE_WRITING_SKILL_NAME]: SCIENCE_WRITING_SKILL_PATH,
  [SCIENCE_PRESENTATION_SKILL_NAME]: SCIENCE_PRESENTATION_SKILL_PATH,
  [SCIENCE_DATABASES_SKILL_NAME]: SCIENCE_DATABASES_SKILL_PATH,
  [SCIENCE_BIO_SKILL_NAME]: SCIENCE_BIO_SKILL_PATH,
  [SCIENCE_COMPUTE_SKILL_NAME]: SCIENCE_COMPUTE_SKILL_PATH,
  [SCIENCE_EMPIRICAL_SKILL_NAME]: SCIENCE_EMPIRICAL_SKILL_PATH,
} as const;

export const DEFAULT_SCIENCE_SKILL_RESOURCE_PATH_BY_ID = {
  [SCIENCE_CORE_SKILL_NAME]: SCIENCE_CORE_SKILL_PATH,
  [SCIENCE_ARTIFACT_SKILL_NAME]: SCIENCE_ARTIFACT_SKILL_PATH,
  [SCIENCE_VISUALS_SKILL_NAME]: SCIENCE_VISUALS_SKILL_PATH,
  [SCIENCE_REPORT_CHART_SKILL_NAME]: SCIENCE_REPORT_CHART_SKILL_PATH,
  [REPORT_AUTHORING_SKILL_NAME]: REPORT_AUTHORING_SKILL_PATH,
} as const satisfies Record<(typeof DEFAULT_SCIENCE_SKILL_IDS)[number], string>;

export function normalizeScienceDefaultSkillIds(skillIds?: readonly string[]): string[] {
  if (!skillIds?.length) return [...DEFAULT_SCIENCE_SKILL_IDS];
  const hasSameSkillIds = (expected: readonly string[]): boolean =>
    skillIds.length === expected.length && expected.every((id) => skillIds.includes(id));
  if (hasSameSkillIds(PREVIOUS_MINIMAL_SCIENCE_DEFAULT_SKILL_IDS)) return [...DEFAULT_SCIENCE_SKILL_IDS];
  if (hasSameSkillIds(PREVIOUS_REPORT_CHART_DEFAULT_SKILL_IDS)) return [...DEFAULT_SCIENCE_SKILL_IDS];
  const isLegacyDefault =
    skillIds.length === LEGACY_SCIENCE_DEFAULT_SKILL_IDS.length &&
    LEGACY_SCIENCE_DEFAULT_SKILL_IDS.every((id) => skillIds.includes(id));
  const isLegacyCatalogOnly =
    skillIds.includes(SCIENCE_VENDOR_CATALOG_SKILL_NAME) &&
    skillIds.every((id) =>
      LEGACY_SCIENCE_DEFAULT_SKILL_IDS.includes(id as (typeof LEGACY_SCIENCE_DEFAULT_SKILL_IDS)[number])
    );
  if (isLegacyDefault || isLegacyCatalogOnly) {
    return [...DEFAULT_SCIENCE_SKILL_IDS];
  }
  const previousCompactDomainDefault = PREVIOUS_DOMAIN_ROUTER_DEFAULT_SKILL_IDS.filter(
    (id) => id !== SCIENCE_PRESENTATION_SKILL_NAME
  );
  if (hasSameSkillIds(PREVIOUS_DOMAIN_ROUTER_DEFAULT_SKILL_IDS) || hasSameSkillIds(previousCompactDomainDefault)) {
    return [...DEFAULT_SCIENCE_SKILL_IDS];
  }
  const previousCompactRouterDefault = PREVIOUS_COMPACT_DOMAIN_DEFAULT_SKILL_IDS.filter(
    (id) => id !== SCIENCE_PRESENTATION_SKILL_NAME
  );
  if (hasSameSkillIds(PREVIOUS_COMPACT_DOMAIN_DEFAULT_SKILL_IDS) || hasSameSkillIds(previousCompactRouterDefault)) {
    return [...DEFAULT_SCIENCE_SKILL_IDS];
  }
  const materializedDefaultSet = new Set<string>([
    SCIENCE_CORE_SKILL_NAME,
    SCIENCE_ARTIFACT_SKILL_NAME,
    SCIENCE_WORKFLOW_SKILL_NAME,
    ...SCIENCE_MATERIALIZED_SKILL_IDS,
  ]);
  const isPreviousMaterializedDefault =
    skillIds.length === materializedDefaultSet.size && skillIds.every((id) => materializedDefaultSet.has(id));
  if (isPreviousMaterializedDefault) {
    return [...DEFAULT_SCIENCE_SKILL_IDS];
  }
  return [...skillIds];
}

export type ScienceEvidenceSourceType =
  | 'file'
  | 'paper'
  | 'database_record'
  | 'code'
  | 'command_log'
  | 'dataset'
  | 'table'
  | 'figure'
  | 'notebook'
  | 'manuscript'
  | 'package_check'
  | 'computational_run'
  | 'dataset_analysis'
  | 'parameter_sweep'
  | 'validation_result'
  | 'remote_job'
  | 'environment'
  | 'regression_output'
  | 'statistical_model'
  | 'causal_assumption'
  | 'survey_instrument'
  | 'codebook'
  | 'data_dictionary'
  | 'qualitative_code'
  | 'geospatial_layer'
  | 'replication_package'
  | 'user_input';

export type ScienceClaimType = 'computed' | 'parsed' | 'digitized' | 'hypothesis';

export interface ScienceGitLineAnchorInput {
  kind: 'git_lines';
  commit?: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  side?: 'current' | 'parent';
}

export interface ScienceGitLineAnchor {
  kind: 'git_lines';
  commit: string;
  repoRelativePath: string;
  workspacePath?: string;
  lineStart: number;
  lineEnd: number;
  side?: 'current' | 'parent';
  blobSha?: string;
  contextHash?: string;
}

export interface ScienceEvidenceItem {
  id: string;
  title: string;
  sourceType: ScienceEvidenceSourceType;
  claimType?: ScienceClaimType;
  confidence: 'high' | 'moderate' | 'low' | 'blocked';
  status?: 'available' | 'missing' | 'stale' | 'needs_review';
  summary?: string;
  path?: string;
  url?: string;
  virtualPath?: string;
  command?: string;
  lineStart?: number;
  lineEnd?: number;
  gitAnchor?: ScienceGitLineAnchor;
  cellId?: string;
  artifactId?: string;
  artifactVersion?: number;
  nodeId?: string;
  supportingEvidenceIds?: string[];
  hash?: string;
  version?: number;
  skillUseId?: string;
  connectorId?: string;
  database?: {
    name: string;
    provider?: 'paperclip' | 'bio_tools' | string;
    domain?: string;
    tool?: string;
    endpoint?: string;
    params?: Record<string, unknown>;
    accessDate?: string;
    returnedCount?: number;
    retrievedCount?: number;
    pagination?: string;
    identifierConversions?: string[];
    warnings?: string[];
  };
  region?: {
    filePath: string;
    page?: number;
    x: number;
    y: number;
    width: number;
    height: number;
    coordinateSystem: 'pixel' | 'normalized';
  };
  createdAt?: number;
  revision?: string;
}

export interface ScienceClaim {
  id: string;
  runId: string;
  text: string;
  claimType: ScienceClaimType;
  status: 'supported' | 'partial' | 'hypothesis' | 'blocked';
  supportingEvidenceIds: string[];
  artifactIds?: string[];
  provenanceNodeIds?: string[];
  limitations?: string[];
  createdAt: number;
  revision?: string;
}

export interface ScienceClaimVerification {
  state: 'verified' | 'partial' | 'blocked';
  totalClaims: number;
  supportedClaims: number;
  hypothesisClaims: number;
  unsupportedClaimIds: string[];
  blockingWarningIds: string[];
}

export type ScienceArtifactType =
  | 'report'
  | 'figure'
  | 'table'
  | 'dataset'
  | 'code'
  | 'notebook'
  | 'manuscript'
  | 'pdf'
  | 'latex'
  | 'html'
  | 'molecule'
  | 'protein_structure'
  | 'genome_track'
  | 'alignment'
  | 'regression_table'
  | 'model_diagnostic'
  | 'causal_dag'
  | 'survey_codebook'
  | 'geospatial_map'
  | 'qualitative_coding'
  | 'replication_package'
  | 'run_bundle';

export type ScienceArtifactInspectorTab =
  | 'overview'
  | 'inputs'
  | 'code'
  | 'execution_log'
  | 'messages'
  | 'environment'
  | 'history'
  | 'review';

export type ScienceStructureViewerKind = 'auto' | '3dmol' | 'molstar' | 'rcsb_molstar';
export type ScienceStructureFormat = 'pdb' | 'cif' | 'mmcif' | 'pqr' | 'sdf' | 'mol' | 'mol2' | 'xyz' | 'unknown';
export type ScienceStructureRepresentation = 'auto' | 'cartoon' | 'stick' | 'sphere' | 'line' | 'surface';
export type ScienceStructureColorBy = 'auto' | 'chain' | 'element' | 'spectrum' | 'plddt' | 'secondary_structure';
export type ScienceArtifactViewerKind =
  | ScienceStructureViewerKind
  | 'igv'
  | 'ketcher'
  | 'vitessce'
  | 'msa'
  | 'regression_table'
  | 'model_diagnostic'
  | 'causal_dag'
  | 'map'
  | 'codebook'
  | 'qualitative_coding'
  | 'target_discovery'
  | 'financial_factor'
  | 'financial_research'
  | 'mathematics'
  | 'report_chart'
  | 'proof_trace';

export interface ScienceStructureViewerSelection {
  chain?: string;
  residueStart?: number;
  residueEnd?: number;
  residues?: number[];
  ligand?: string;
  atomIds?: number[];
}

export interface ScienceStructureViewerAnnotation extends ScienceStructureViewerSelection {
  label: string;
  evidenceIds?: string[];
  color?: string;
}

export interface ScienceStructureViewerSpec {
  kind?: ScienceStructureViewerKind;
  format?: ScienceStructureFormat;
  representation?: ScienceStructureRepresentation;
  colorBy?: ScienceStructureColorBy;
  background?: 'light' | 'dark' | 'transparent';
  focus?: ScienceStructureViewerSelection;
  annotations?: ScienceStructureViewerAnnotation[];
}

export interface ScienceArtifactViewerSpec {
  kind?: ScienceArtifactViewerKind;
  format?: string;
  representation?: ScienceStructureRepresentation;
  colorBy?: ScienceStructureColorBy;
  background?: 'light' | 'dark' | 'transparent';
  focus?: ScienceStructureViewerSelection | Record<string, unknown>;
  annotations?: Array<ScienceStructureViewerAnnotation | Record<string, unknown>>;
  configPath?: string;
  dataPath?: string;
  indexPath?: string;
  sourcePath?: string;
  tablePath?: string;
  modelPath?: string;
  logPath?: string;
  schemaPath?: string;
  codebookPath?: string;
  variableDictionaryPath?: string;
  dagPath?: string;
  mapPath?: string;
  editable?: boolean;
  savePolicy?: 'read_only' | 'new_version_required' | 'overwrite_allowed';
  tracks?: Array<Record<string, unknown>>;
  datasets?: Array<Record<string, unknown>>;
  layers?: Array<Record<string, unknown>>;
  variables?: Array<Record<string, unknown>>;
  diagnostics?: Array<Record<string, unknown>>;
  assumptions?: Array<Record<string, unknown>>;
  evidenceIds?: string[];
  chartSpec?: ReportChartSpec;
}

export type ScienceOptimizationArtifactKind =
  | 'idea_candidate'
  | 'optimization_line'
  | 'implementation_attempt'
  | 'main_experiment';

export type ScienceOptimizationRoute = 'explore' | 'exploit' | 'fusion' | 'debug' | 'stop';

export type ScienceOptimizationFailureClass = 'execution_error' | 'invalid_result' | 'valid_no_gain' | 'valid_gain';

export interface ScienceOptimizationTaskScope {
  taskId: string;
  sealId: string;
}

export type ScienceOptimizationDispatchAction =
  | 'dispatch_attempt'
  | 'prepare_attempt'
  | 'prepare_repair'
  | 'promote_candidate'
  | 'fuse_lines'
  | 'generate_candidate'
  | 'wait'
  | 'stop';

export interface ScienceOptimizationDispatchTarget {
  kind: 'implementation_attempt' | 'optimization_line' | 'idea_candidate' | 'main_experiment' | 'fusion';
  id: string;
  lineId: string | null;
  mechanismFamily: string | null;
  evidenceRefs: string[];
}

export interface ScienceOptimizationDispatchDecision {
  schema: 'deepscientist.ioai.candidate-dispatch.v1';
  taskScope: ScienceOptimizationTaskScope | null;
  metricContractId: string | null;
  route: ScienceOptimizationRoute;
  action: ScienceOptimizationDispatchAction;
  maxParallel: 2;
  occupiedSlots: number;
  availableSlots: number;
  selected: ScienceOptimizationDispatchTarget[];
  heldIds: string[];
  reason: string;
}

export interface ScienceOptimizationCandidateQuality {
  schema: 'deepscientist.ioai.candidate-quality.v1';
  eligible: boolean;
  missingFields: string[];
  evidenceLevel: 'artifact' | 'narrative' | 'none';
  verifiedEvidencePaths: string[];
  unverifiedEvidencePaths: string[];
  estimatedCostMinutes: number | null;
}

export interface ScienceOptimizationStrongestAlternative {
  mechanismFamily: string;
  disposition: 'evaluated' | 'rejected' | 'budget_excluded' | 'not_applicable';
  reason: string;
  evidenceRefs: string[];
}

export interface ScienceOptimizationMetric {
  metricId: string;
  value: number;
  direction: 'higher' | 'lower';
  baselineValue?: number;
  split?: string;
  primary?: boolean;
}

export interface ScienceOptimizationStabilityAssessment {
  aggregateImprovement: number | null;
  minimumImprovement: number;
  splitCount: number;
  worstSplitImprovement: number | null;
  promotionEligible: boolean;
  evidenceBasis: 'split_evidence' | 'aggregate_only' | 'deterministic_simple_task' | 'invalid_result';
  reason: string;
}

export interface ScienceOptimizationLessonCapsule {
  observedEffect: string;
  failedAssumption: string;
  usefulComponent: string;
  doNotRepeat: string;
  nextSearchBoundary: string;
  evidenceRefs: string[];
}

export interface ScienceOptimizationFusionEvidence {
  complementaryLineIds: string[];
  basis: 'prediction_correlation' | 'error_correlation' | 'error_cluster';
  summary: string;
  evidenceIds?: string[];
  evidencePaths?: string[];
}

/**
 * Durable optimization state stored inside a versioned Science artifact.
 * Candidate briefs, promoted lines, implementation attempts, and measured
 * results intentionally share one envelope but remain different object kinds.
 */
export interface ScienceOptimizationArtifactMetadata {
  schema: 'deepscientist.optimization.v1';
  kind: ScienceOptimizationArtifactKind;
  ideaId?: string;
  lineId?: string;
  attemptId?: string;
  runId?: string;
  taskId?: string;
  sealId?: string;
  sourceCandidateId?: string;
  parentLineId?: string;
  branch?: string;
  foundationRef?: string | Record<string, unknown>;
  lineageIntent?: 'continue_line' | 'branch_alternative';
  status?: string;
  title?: string;
  problem?: string;
  hypothesis?: string;
  mechanism?: string;
  methodBrief?: string;
  mechanismFamily?: string;
  changeLayer?: string;
  sourceLens?: string;
  whyNow?: string;
  whyCurrentLineIsLimited?: string;
  keepUnchanged?: string[];
  implementationSurface?: string;
  mainRisks?: string[];
  estimatedCostMinutes?: number;
  strongestAlternative?: ScienceOptimizationStrongestAlternative;
  evidenceBasis?: string[];
  evidencePaths?: string[];
  falsificationPlan?: string;
  abandonmentCondition?: string;
  decisionReason?: string;
  selectionScores?: Record<string, number>;
  expectedGain?: string;
  valid?: boolean;
  failureKind?: string;
  failureClass?: ScienceOptimizationFailureClass;
  repairOfRunId?: string;
  metrics?: ScienceOptimizationMetric[];
  metricContractId?: string;
  comparable?: boolean;
  verdict?: string;
  conclusion?: string;
  evaluationSummary?: Record<string, unknown>;
  stabilityAssessment?: ScienceOptimizationStabilityAssessment;
  lesson?: ScienceOptimizationLessonCapsule;
  fusionEvidence?: ScienceOptimizationFusionEvidence;
  latestResultArtifactId?: string;
  latestRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScienceArtifact {
  id: string;
  runId: string;
  type: ScienceArtifactType;
  title: string;
  version: number;
  versionGroupId?: string;
  previousArtifactId?: string;
  previousVersion?: number;
  revision?: string;
  changeSummary?: string;
  status?: 'available' | 'missing' | 'stale' | 'generating' | 'failed';
  primaryPath?: string;
  previewPath?: string;
  thumbnailPath?: string;
  sourcePaths?: string[];
  inputPaths?: string[];
  outputPaths?: string[];
  contentHash?: string;
  sizeBytes?: number;
  mimeType?: string;
  code?: {
    path?: string;
    language?: 'python' | 'r' | 'shell' | 'latex' | 'markdown';
    entrypoint?: string;
    cellIds?: string[];
  };
  execution?: {
    command?: string;
    scriptPath?: string;
    cwd?: string;
    logPath?: string;
    stdoutPreview?: string;
    stderrPreview?: string;
    startedAt?: number;
    endedAt?: number;
    exitCode?: number;
  };
  environment?: {
    kind?: 'local' | 'conda' | 'uv' | 'renv' | 'docker' | 'slurm' | 'modal' | 'ssh';
    python?: string;
    r?: string;
    packages?: Array<{ name: string; version?: string }>;
    lockfilePath?: string;
    hardware?: string;
  };
  inputs?: Array<{
    label?: string;
    role?: 'primary' | 'reference' | 'parameter' | 'metadata' | 'derived';
    path?: string;
    artifactId?: string;
    evidenceId?: string;
    contentHash?: string;
    sizeBytes?: number;
    mimeType?: string;
  }>;
  relatedMessageIds?: string[];
  relatedToolCallIds?: string[];
  defaultInspectorTab?: ScienceArtifactInspectorTab;
  availableTabs?: ScienceArtifactInspectorTab[];
  evidenceIds?: string[];
  provenanceNodeIds?: string[];
  reviewStatus?: 'not_reviewed' | 'passed' | 'warnings' | 'failed';
  viewer?: ScienceArtifactViewerSpec;
  metadata?: Record<string, unknown> & {
    deepScientistOptimization?: ScienceOptimizationArtifactMetadata;
  };
  git?: ScienceArtifactGitRef;
  createdAt: number;
}

export type ResearchRouteLifecycle =
  | 'proposed'
  | 'selected'
  | 'running'
  | 'completed'
  | 'verified'
  | 'blocked'
  | 'pruned';

export type ResearchRouteMode = ResearchStrategy;

export interface ResearchRouteEta {
  min?: number;
  max?: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
}

export type ResearchStageDisposition = 'supported' | 'refuted' | 'exhausted' | 'inconclusive' | 'runtime_failed';

export type ResearchStageFailureClass = 'mathematical' | 'insufficient_evidence' | 'tool_runtime';

export type ResearchStageNextAction = 'continue' | 'advance' | 'branch' | 'ask_user' | 'pause' | 'complete';

export type ResearchCompletionCriterionStatus = 'pending' | 'satisfied' | 'unsatisfied' | 'blocked';

export interface ResearchCompletionCriterion {
  id: string;
  requirement: string;
  status: ResearchCompletionCriterionStatus;
  evidenceIds: string[];
  note?: string;
}

export interface ResearchCompletionContract {
  criteria: ResearchCompletionCriterion[];
  updatedAt: number;
}

export interface ResearchStageOutcome {
  disposition: ResearchStageDisposition;
  supportingEvidenceIds: string[];
  refutingEvidenceIds: string[];
  exhaustionEvidenceIds?: string[];
  producedArtifactIds?: string[];
  checkpointCommit?: string;
  beliefDelta: string;
  reflection: string;
  failureClass?: ResearchStageFailureClass;
  nextAction: ResearchStageNextAction;
  nextObjective?: string;
}

export interface ResearchRouteNode {
  id: string;
  parentId?: string;
  parentIds?: string[];
  strategy?: ResearchRouteMode;
  repairsNodeId?: string;
  order: number;
  title: string;
  summary: string;
  lifecycle: ResearchRouteLifecycle;
  eta?: ResearchRouteEta;
  execution?: {
    objective: string;
    hypothesis?: string;
    acceptanceCriteria: string[];
    failureCriteria?: string[];
    exitCriteria?: string[];
    requiredEvidenceIds?: string[];
    priorWorkRefs?: string[];
    doNotRepeat?: string[];
    authoritativeChecks?: string[];
    expectedArtifacts?: string[];
    budget?: {
      maxMinutes?: number;
      maxAttempts?: number;
    };
  };
  outcome?: ResearchStageOutcome;
  evidenceIds?: string[];
  artifactIds?: string[];
  git?: {
    branchRef?: string;
    baseCommit?: string;
    checkpointCommit?: string;
  };
  blockedReason?: string;
  prunedReason?: string;
}

export type ResearchRouteDecisionStatus = 'none' | 'pending' | 'answered' | 'cancelled' | 'timeout' | 'orphaned';

export interface ResearchRouteMap {
  schema: typeof RESEARCH_ROUTE_SCHEMA;
  roadmapId: string;
  goalId?: string;
  objective: string;
  routeMode?: ResearchRouteMode;
  completionContract?: ResearchCompletionContract;
  rootNodeId: string;
  focusNodeId?: string;
  selectedTargetId?: string;
  decision?: {
    requestId?: string;
    status: ResearchRouteDecisionStatus;
    selectableNodeIds?: string[];
    selectedNodeId?: string;
    updatedAt: number;
  };
  nodes: ResearchRouteNode[];
  updatedAt: number;
}

export type ResearchRouteDisplayStatus =
  | 'planned'
  | 'available'
  | 'selected'
  | 'running'
  | 'completed'
  | 'verified'
  | 'blocked'
  | 'pruned';

export interface ResearchRoutePresentationNode {
  id: string;
  parentId?: string;
  parentIds?: string[];
  strategy?: ResearchRouteMode;
  repairsNodeId?: string;
  order: number;
  title: string;
  summary: string;
  displayStatus: ResearchRouteDisplayStatus;
  eta?: ResearchRouteEta;
  etaLabel?: string;
}

export interface ResearchRoutePresentation {
  kind: 'research_route';
  explicitConfirmation: true;
  allowAutoRecommend: false;
  goalId?: string;
  artifactRef: {
    runId: string;
    artifactId: string;
    version?: number;
    baseRevision: string;
  };
  selectedTargetId?: string;
  selectableNodeIds: string[];
  nodes: ResearchRoutePresentationNode[];
}

export type ResearchRouteValidationResult = { ok: true; value: ResearchRouteMap } | { ok: false; error: string };

const RESEARCH_ROUTE_LIFECYCLES = new Set<ResearchRouteLifecycle>([
  'proposed',
  'selected',
  'running',
  'completed',
  'verified',
  'blocked',
  'pruned',
]);
const RESEARCH_ROUTE_MODES = new Set<ResearchRouteMode>(['explore', 'deepen', 'fuse', 'repair', 'stop']);
const RESEARCH_ROUTE_DECISION_STATUSES = new Set<ResearchRouteDecisionStatus>([
  'none',
  'pending',
  'answered',
  'cancelled',
  'timeout',
  'orphaned',
]);
const RESEARCH_ROUTE_ETA_UNITS = new Set<ResearchRouteEta['unit']>(['minute', 'hour', 'day', 'week']);
const RESEARCH_STAGE_DISPOSITIONS = new Set<ResearchStageDisposition>([
  'supported',
  'refuted',
  'exhausted',
  'inconclusive',
  'runtime_failed',
]);
const RESEARCH_STAGE_FAILURE_CLASSES = new Set<ResearchStageFailureClass>([
  'mathematical',
  'insufficient_evidence',
  'tool_runtime',
]);
const RESEARCH_STAGE_NEXT_ACTIONS = new Set<ResearchStageNextAction>([
  'continue',
  'advance',
  'branch',
  'ask_user',
  'pause',
  'complete',
]);
const RESEARCH_COMPLETION_CRITERION_STATUSES = new Set<ResearchCompletionCriterionStatus>([
  'pending',
  'satisfied',
  'unsatisfied',
  'blocked',
]);
const RESEARCH_ROUTE_MAX_NODES = 36;
const RESEARCH_ROUTE_MAX_DEPTH = 8;
export const RESEARCH_ROUTE_PRESENTATION_MAX_NODES = 12;
export const RESEARCH_ROUTE_PRESENTATION_MAX_DEPTH = 3;
export const RESEARCH_ROUTE_MIN_SELECTABLE_NODES = 2;
export const RESEARCH_ROUTE_MAX_SELECTABLE_NODES = 4;

const researchRouteRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const researchRouteString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
};

const researchRouteStringArray = (value: unknown, maxItems = 36): string[] | undefined => {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result = value.map((item) => researchRouteString(item, 160));
  if (result.some((item) => !item)) return undefined;
  return result as string[];
};

const researchRouteUniqueStringArray = (value: unknown, maxItems = 36): string[] | undefined => {
  const result = researchRouteStringArray(value, maxItems);
  if (!result || new Set(result).size !== result.length) return undefined;
  return result;
};

export const getResearchRouteParentIds = (
  node:
    | Pick<ResearchRouteNode, 'parentId' | 'parentIds'>
    | Pick<ResearchRoutePresentationNode, 'parentId' | 'parentIds'>
): string[] => node.parentIds || (node.parentId ? [node.parentId] : []);

const parseResearchRouteEta = (value: unknown): ResearchRouteEta | undefined => {
  if (value == null) return undefined;
  const record = researchRouteRecord(value);
  if (!record || !RESEARCH_ROUTE_ETA_UNITS.has(record.unit as ResearchRouteEta['unit'])) return undefined;
  const min = typeof record.min === 'number' && Number.isFinite(record.min) && record.min >= 0 ? record.min : undefined;
  const max = typeof record.max === 'number' && Number.isFinite(record.max) && record.max >= 0 ? record.max : undefined;
  if (record.min != null && min == null) return undefined;
  if (record.max != null && max == null) return undefined;
  if (min != null && max != null && max < min) return undefined;
  return { min, max, unit: record.unit as ResearchRouteEta['unit'] };
};

export function validateResearchRouteMap(value: unknown): ResearchRouteValidationResult {
  const record = researchRouteRecord(value);
  if (!record || record.schema !== RESEARCH_ROUTE_SCHEMA) {
    return { ok: false, error: `schema must equal ${RESEARCH_ROUTE_SCHEMA}` };
  }
  const roadmapId = researchRouteString(record.roadmapId, 120);
  const goalId = record.goalId == null ? undefined : researchRouteString(record.goalId, 120);
  const objective = researchRouteString(record.objective, 500);
  const routeMode = record.routeMode == null ? undefined : (record.routeMode as ResearchRouteMode);
  const rootNodeId = researchRouteString(record.rootNodeId, 120);
  const focusNodeId = record.focusNodeId == null ? undefined : researchRouteString(record.focusNodeId, 120);
  const selectedTargetId =
    record.selectedTargetId == null ? undefined : researchRouteString(record.selectedTargetId, 120);
  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : undefined;
  if (!roadmapId || !objective || !rootNodeId || updatedAt == null || (record.goalId != null && !goalId)) {
    return { ok: false, error: 'roadmapId, objective, rootNodeId, updatedAt, and optional goalId must be valid' };
  }
  if (routeMode != null && !RESEARCH_ROUTE_MODES.has(routeMode)) {
    return { ok: false, error: 'routeMode must be explore, deepen, fuse, repair, or stop when provided' };
  }
  let completionContract: ResearchCompletionContract | undefined;
  if (record.completionContract != null) {
    const completionRecord = researchRouteRecord(record.completionContract);
    const completionUpdatedAt =
      typeof completionRecord?.updatedAt === 'number' && Number.isFinite(completionRecord.updatedAt)
        ? completionRecord.updatedAt
        : undefined;
    if (
      !completionRecord ||
      completionUpdatedAt == null ||
      !Array.isArray(completionRecord.criteria) ||
      completionRecord.criteria.length < 1 ||
      completionRecord.criteria.length > 20
    ) {
      return { ok: false, error: 'completionContract requires updatedAt and 1-20 criteria' };
    }
    const criterionIds = new Set<string>();
    const criteria: ResearchCompletionCriterion[] = [];
    for (const [index, candidate] of completionRecord.criteria.entries()) {
      const criterion = researchRouteRecord(candidate);
      const id = researchRouteString(criterion?.id, 120);
      const requirement = researchRouteString(criterion?.requirement, 500);
      const status = criterion?.status as ResearchCompletionCriterionStatus | undefined;
      const evidenceIds = researchRouteUniqueStringArray(criterion?.evidenceIds, 36) ?? [];
      const note = criterion?.note == null ? undefined : researchRouteString(criterion.note, 500);
      if (
        !criterion ||
        !id ||
        criterionIds.has(id) ||
        !requirement ||
        !status ||
        !RESEARCH_COMPLETION_CRITERION_STATUSES.has(status) ||
        (criterion.evidenceIds != null && !researchRouteUniqueStringArray(criterion.evidenceIds, 36)) ||
        (criterion.note != null && !note)
      ) {
        return { ok: false, error: `completionContract.criteria[${index}] is invalid` };
      }
      if ((status === 'satisfied' || status === 'unsatisfied') && evidenceIds.length === 0) {
        return {
          ok: false,
          error: `completionContract.criteria[${index}] ${status} requires evidenceIds`,
        };
      }
      criterionIds.add(id);
      criteria.push({ id, requirement, status, evidenceIds, note });
    }
    completionContract = { criteria, updatedAt: completionUpdatedAt };
  }
  if (!Array.isArray(record.nodes) || !record.nodes.length || record.nodes.length > RESEARCH_ROUTE_MAX_NODES) {
    return { ok: false, error: `nodes must contain 1-${RESEARCH_ROUTE_MAX_NODES} items` };
  }

  const nodes: ResearchRouteNode[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of record.nodes.entries()) {
    const node = researchRouteRecord(candidate);
    const id = researchRouteString(node?.id, 120);
    const parentId = node?.parentId == null ? undefined : researchRouteString(node.parentId, 120);
    const parentIds = node?.parentIds == null ? undefined : researchRouteUniqueStringArray(node.parentIds, 4);
    const strategy = node?.strategy == null ? undefined : (node.strategy as ResearchRouteMode);
    const repairsNodeId = node?.repairsNodeId == null ? undefined : researchRouteString(node.repairsNodeId, 120);
    const title = researchRouteString(node?.title, 48);
    const summary = researchRouteString(node?.summary, 240);
    const lifecycle = node?.lifecycle as ResearchRouteLifecycle | undefined;
    const order = typeof node?.order === 'number' && Number.isFinite(node.order) ? node.order : undefined;
    if (
      !node ||
      !id ||
      ids.has(id) ||
      !title ||
      !summary ||
      order == null ||
      !RESEARCH_ROUTE_LIFECYCLES.has(lifecycle!)
    ) {
      return {
        ok: false,
        error: `nodes[${index}] has an invalid or duplicate id, title, summary, order, or lifecycle`,
      };
    }
    if (strategy != null && !RESEARCH_ROUTE_MODES.has(strategy)) {
      return { ok: false, error: `nodes[${index}].strategy must be explore, deepen, fuse, repair, or stop` };
    }
    if (node.parentIds != null && (!parentIds?.length || parentIds.length > 4)) {
      return { ok: false, error: `nodes[${index}].parentIds must contain 1-4 unique node ids` };
    }
    if (parentId && parentIds && parentIds[0] !== parentId) {
      return { ok: false, error: `nodes[${index}].parentId must match the first parentIds entry` };
    }
    const effectiveParentIds = parentIds || (parentId ? [parentId] : []);
    if (effectiveParentIds.length > 1 && strategy !== 'fuse') {
      return { ok: false, error: `nodes[${index}] with multiple parents must use strategy=fuse` };
    }
    if (strategy === 'fuse' && effectiveParentIds.length < 2) {
      return { ok: false, error: `nodes[${index}] strategy=fuse requires at least two parents` };
    }
    if ((strategy === 'repair') !== Boolean(repairsNodeId)) {
      return { ok: false, error: `nodes[${index}] strategy=repair requires repairsNodeId and only repair may set it` };
    }
    const eta = parseResearchRouteEta(node.eta);
    if (node.eta != null && !eta) return { ok: false, error: `nodes[${index}].eta is invalid` };
    const evidenceIds = researchRouteStringArray(node.evidenceIds);
    const artifactIds = researchRouteStringArray(node.artifactIds);
    if ((node.evidenceIds != null && !evidenceIds) || (node.artifactIds != null && !artifactIds)) {
      return { ok: false, error: `nodes[${index}] evidenceIds or artifactIds is invalid` };
    }
    const executionRecord = researchRouteRecord(node.execution);
    const execution = executionRecord
      ? {
          objective: researchRouteString(executionRecord.objective, 500),
          hypothesis:
            executionRecord.hypothesis == null ? undefined : researchRouteString(executionRecord.hypothesis, 500),
          acceptanceCriteria: researchRouteStringArray(executionRecord.acceptanceCriteria, 20),
          failureCriteria: researchRouteStringArray(executionRecord.failureCriteria, 20),
          exitCriteria: researchRouteStringArray(executionRecord.exitCriteria, 20),
          requiredEvidenceIds: researchRouteStringArray(executionRecord.requiredEvidenceIds, 36),
          priorWorkRefs: researchRouteStringArray(executionRecord.priorWorkRefs, 36),
          doNotRepeat: researchRouteStringArray(executionRecord.doNotRepeat, 20),
          authoritativeChecks: researchRouteStringArray(executionRecord.authoritativeChecks, 20),
          expectedArtifacts: researchRouteStringArray(executionRecord.expectedArtifacts, 20),
          budget: (() => {
            const budget = researchRouteRecord(executionRecord.budget);
            if (!budget) return undefined;
            const maxMinutes =
              typeof budget.maxMinutes === 'number' && Number.isFinite(budget.maxMinutes) && budget.maxMinutes > 0
                ? Math.min(10_080, Math.floor(budget.maxMinutes))
                : undefined;
            const maxAttempts =
              typeof budget.maxAttempts === 'number' && Number.isFinite(budget.maxAttempts) && budget.maxAttempts > 0
                ? Math.min(100, Math.floor(budget.maxAttempts))
                : undefined;
            return maxMinutes || maxAttempts ? { maxMinutes, maxAttempts } : undefined;
          })(),
        }
      : undefined;
    if (executionRecord && (!execution?.objective || !execution.acceptanceCriteria)) {
      return { ok: false, error: `nodes[${index}].execution requires objective and acceptanceCriteria` };
    }
    if (
      executionRecord &&
      ((executionRecord.failureCriteria != null && !execution?.failureCriteria) ||
        (executionRecord.priorWorkRefs != null && !execution?.priorWorkRefs) ||
        (executionRecord.doNotRepeat != null && !execution?.doNotRepeat) ||
        (executionRecord.authoritativeChecks != null && !execution?.authoritativeChecks) ||
        (executionRecord.expectedArtifacts != null && !execution?.expectedArtifacts) ||
        (executionRecord.budget != null && !execution?.budget))
    ) {
      return { ok: false, error: `nodes[${index}].execution contains invalid stage criteria, prior work, or budget` };
    }
    const outcomeRecord = researchRouteRecord(node.outcome);
    const outcome = outcomeRecord
      ? {
          disposition: outcomeRecord.disposition as ResearchStageDisposition,
          supportingEvidenceIds: researchRouteStringArray(outcomeRecord.supportingEvidenceIds, 36),
          refutingEvidenceIds: researchRouteStringArray(outcomeRecord.refutingEvidenceIds, 36),
          exhaustionEvidenceIds: researchRouteStringArray(outcomeRecord.exhaustionEvidenceIds, 36),
          producedArtifactIds: researchRouteStringArray(outcomeRecord.producedArtifactIds, 36),
          checkpointCommit:
            outcomeRecord.checkpointCommit == null
              ? undefined
              : researchRouteString(outcomeRecord.checkpointCommit, 160),
          beliefDelta: researchRouteString(outcomeRecord.beliefDelta, 500),
          reflection: researchRouteString(outcomeRecord.reflection, 800),
          failureClass:
            outcomeRecord.failureClass == null ? undefined : (outcomeRecord.failureClass as ResearchStageFailureClass),
          nextAction: outcomeRecord.nextAction as ResearchStageNextAction,
          nextObjective:
            outcomeRecord.nextObjective == null ? undefined : researchRouteString(outcomeRecord.nextObjective, 500),
        }
      : undefined;
    if (
      outcomeRecord &&
      (!RESEARCH_STAGE_DISPOSITIONS.has(outcome!.disposition) ||
        !outcome?.supportingEvidenceIds ||
        !outcome.refutingEvidenceIds ||
        !outcome.beliefDelta ||
        !outcome.reflection ||
        !RESEARCH_STAGE_NEXT_ACTIONS.has(outcome.nextAction) ||
        (outcomeRecord.producedArtifactIds != null && !outcome.producedArtifactIds) ||
        (outcomeRecord.exhaustionEvidenceIds != null && !outcome.exhaustionEvidenceIds) ||
        (outcomeRecord.checkpointCommit != null && !outcome.checkpointCommit) ||
        (outcome.failureClass != null && !RESEARCH_STAGE_FAILURE_CLASSES.has(outcome.failureClass)))
    ) {
      return { ok: false, error: `nodes[${index}].outcome is invalid` };
    }
    if (outcome?.disposition === 'supported' && outcome.supportingEvidenceIds.length === 0) {
      return { ok: false, error: `nodes[${index}].outcome supported requires supportingEvidenceIds` };
    }
    if (outcome && outcome.disposition === 'refuted' && outcome.refutingEvidenceIds.length === 0) {
      return { ok: false, error: `nodes[${index}].outcome ${outcome.disposition} requires refutingEvidenceIds` };
    }
    if (
      outcome?.disposition === 'exhausted' &&
      !outcome.exhaustionEvidenceIds?.length &&
      outcome.refutingEvidenceIds.length === 0
    ) {
      return {
        ok: false,
        error: `nodes[${index}].outcome exhausted requires exhaustionEvidenceIds (or legacy refutingEvidenceIds)`,
      };
    }
    if (outcome?.disposition === 'runtime_failed' && outcome.failureClass !== 'tool_runtime') {
      return { ok: false, error: `nodes[${index}].outcome runtime_failed requires failureClass=tool_runtime` };
    }
    const gitRecord = researchRouteRecord(node.git);
    if (node.git != null && !gitRecord) return { ok: false, error: `nodes[${index}].git is invalid` };
    const git = gitRecord
      ? {
          branchRef: gitRecord.branchRef == null ? undefined : researchRouteString(gitRecord.branchRef, 240),
          baseCommit: gitRecord.baseCommit == null ? undefined : researchRouteString(gitRecord.baseCommit, 160),
          checkpointCommit:
            gitRecord.checkpointCommit == null ? undefined : researchRouteString(gitRecord.checkpointCommit, 160),
        }
      : undefined;
    if (
      gitRecord &&
      ((gitRecord.branchRef != null && !git?.branchRef) ||
        (gitRecord.baseCommit != null && !git?.baseCommit) ||
        (gitRecord.checkpointCommit != null && !git?.checkpointCommit))
    ) {
      return { ok: false, error: `nodes[${index}].git contains an invalid reference` };
    }
    if (lifecycle === 'proposed' && (gitRecord || artifactIds?.length)) {
      return {
        ok: false,
        error: `nodes[${index}] is virtual/proposed and cannot claim Git or completed artifact references before selection`,
      };
    }
    ids.add(id);
    nodes.push({
      id,
      parentId,
      parentIds,
      strategy,
      repairsNodeId,
      order,
      title,
      summary,
      lifecycle: lifecycle!,
      eta,
      execution: execution as ResearchRouteNode['execution'],
      outcome: outcome as ResearchRouteNode['outcome'],
      evidenceIds,
      artifactIds,
      git,
      blockedReason: node.blockedReason == null ? undefined : researchRouteString(node.blockedReason, 240),
      prunedReason: node.prunedReason == null ? undefined : researchRouteString(node.prunedReason, 240),
    });
  }

  if (
    !ids.has(rootNodeId) ||
    (focusNodeId && !ids.has(focusNodeId)) ||
    (selectedTargetId && !ids.has(selectedTargetId))
  ) {
    return { ok: false, error: 'rootNodeId, focusNodeId, and selectedTargetId must reference existing nodes' };
  }
  const rootNode = nodes.find((node) => node.id === rootNodeId);
  if (rootNode && getResearchRouteParentIds(rootNode).length) {
    return { ok: false, error: 'rootNodeId must identify a root node without parents' };
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parents = getResearchRouteParentIds(node);
    if (parents.some((parent) => parent === node.id)) {
      return { ok: false, error: `node ${node.id} cannot reference itself as a parent` };
    }
    if (parents.some((parent) => !ids.has(parent))) {
      return { ok: false, error: `node ${node.id} references a missing parent` };
    }
    if (node.repairsNodeId && (node.repairsNodeId === node.id || !ids.has(node.repairsNodeId))) {
      return { ok: false, error: `node ${node.id} references an invalid repairsNodeId` };
    }
  }
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFromRoot = (node: ResearchRouteNode): number => {
    const cached = depthMemo.get(node.id);
    if (cached != null) return cached;
    if (visiting.has(node.id)) return Number.POSITIVE_INFINITY;
    visiting.add(node.id);
    const parents = getResearchRouteParentIds(node);
    const depth =
      node.id === rootNodeId
        ? 1
        : parents.length
          ? Math.max(...parents.map((parentId) => depthFromRoot(nodeById.get(parentId)!))) + 1
          : Number.NaN;
    visiting.delete(node.id);
    depthMemo.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) {
    const depth = depthFromRoot(node);
    if (!Number.isFinite(depth)) {
      return { ok: false, error: `node ${node.id} creates a cycle or is not connected to rootNodeId` };
    }
    if (depth > RESEARCH_ROUTE_MAX_DEPTH) {
      return { ok: false, error: `node ${node.id} exceeds the maximum route depth` };
    }
  }

  let decision: ResearchRouteMap['decision'];
  if (record.decision != null) {
    const decisionRecord = researchRouteRecord(record.decision);
    const status = decisionRecord?.status as ResearchRouteDecisionStatus | undefined;
    const decisionUpdatedAt =
      typeof decisionRecord?.updatedAt === 'number' && Number.isFinite(decisionRecord.updatedAt)
        ? decisionRecord.updatedAt
        : undefined;
    const selectableNodeIds = researchRouteUniqueStringArray(decisionRecord?.selectableNodeIds, 4);
    const selectedNodeId =
      decisionRecord?.selectedNodeId == null ? undefined : researchRouteString(decisionRecord.selectedNodeId, 120);
    const requestId =
      decisionRecord?.requestId == null ? undefined : researchRouteString(decisionRecord.requestId, 160);
    if (!decisionRecord || !status || !RESEARCH_ROUTE_DECISION_STATUSES.has(status) || decisionUpdatedAt == null) {
      return { ok: false, error: 'decision status and updatedAt are invalid' };
    }
    if (decisionRecord.selectableNodeIds != null && !selectableNodeIds) {
      return {
        ok: false,
        error: `decision.selectableNodeIds must contain ${RESEARCH_ROUTE_MIN_SELECTABLE_NODES}-${RESEARCH_ROUTE_MAX_SELECTABLE_NODES} unique valid node ids`,
      };
    }
    if (selectableNodeIds?.some((id) => !ids.has(id))) {
      return { ok: false, error: 'decision.selectableNodeIds must reference existing nodes' };
    }
    if (
      (status === 'pending' || status === 'answered') &&
      (!selectableNodeIds ||
        selectableNodeIds.length < RESEARCH_ROUTE_MIN_SELECTABLE_NODES ||
        selectableNodeIds.length > RESEARCH_ROUTE_MAX_SELECTABLE_NODES)
    ) {
      return {
        ok: false,
        error: `a pending or answered decision requires ${RESEARCH_ROUTE_MIN_SELECTABLE_NODES}-${RESEARCH_ROUTE_MAX_SELECTABLE_NODES} selectableNodeIds; requestId is optional`,
      };
    }
    if (status === 'pending' && selectableNodeIds) {
      const focusId = focusNodeId || rootNodeId;
      for (const selectableId of selectableNodeIds) {
        const selectable = nodeById.get(selectableId);
        if (!selectable || selectable.lifecycle !== 'proposed') {
          return { ok: false, error: 'pending selectableNodeIds must reference virtual proposed nodes' };
        }
        if (!isResearchRouteNodeAvailable(selectable, nodeById)) {
          return { ok: false, error: 'pending selectableNodeIds must reference currently available virtual nodes' };
        }
        const queue = [{ id: selectable.id, depth: 0 }];
        const seen = new Set<string>();
        let focusDepth: number | undefined;
        while (queue.length) {
          const current = queue.shift()!;
          if (seen.has(current.id)) continue;
          seen.add(current.id);
          if (current.id === focusId) {
            focusDepth = current.depth;
            break;
          }
          getResearchRouteParentIds(nodeById.get(current.id)!).forEach((parent) =>
            queue.push({ id: parent, depth: current.depth + 1 })
          );
        }
        if (focusDepth == null) {
          return { ok: false, error: 'pending selectableNodeIds must descend from focusNodeId' };
        }
        if (focusDepth >= RESEARCH_ROUTE_PRESENTATION_MAX_DEPTH) {
          return { ok: false, error: 'pending selectableNodeIds must be within the visible route depth' };
        }
      }
    }
    if (
      selectedNodeId &&
      (!ids.has(selectedNodeId) || (selectableNodeIds?.length && !selectableNodeIds.includes(selectedNodeId)))
    ) {
      return { ok: false, error: 'decision.selectedNodeId must be one of the selectable nodes' };
    }
    if (status === 'pending' && selectedNodeId) {
      return { ok: false, error: 'a pending decision cannot already contain selectedNodeId' };
    }
    if (status === 'answered' && !selectedNodeId) {
      return { ok: false, error: 'an answered decision requires selectedNodeId' };
    }
    decision = { requestId, status, selectableNodeIds, selectedNodeId, updatedAt: decisionUpdatedAt };
  }

  return {
    ok: true,
    value: {
      schema: RESEARCH_ROUTE_SCHEMA,
      roadmapId,
      goalId,
      objective,
      routeMode,
      completionContract,
      rootNodeId,
      focusNodeId,
      selectedTargetId,
      decision,
      nodes,
      updatedAt,
    },
  };
}

export const readResearchRouteMap = (metadata: unknown): ResearchRouteMap | undefined => {
  const record = researchRouteRecord(metadata);
  if (!record || !Object.hasOwn(record, 'researchRoute')) return undefined;
  const result = validateResearchRouteMap(record.researchRoute);
  return result.ok ? result.value : undefined;
};

export const isResearchRouteNodeAvailable = (
  node: ResearchRouteNode,
  byId: ReadonlyMap<string, ResearchRouteNode>
): boolean => {
  if (node.lifecycle !== 'proposed') return false;
  const parents = getResearchRouteParentIds(node);
  if (!parents.length) return true;
  return parents.every((parentId) => {
    const parent = byId.get(parentId);
    return parent?.lifecycle === 'completed' || parent?.lifecycle === 'verified';
  });
};

export type ResearchRouteBranchSelectionResult = { ok: true; node?: ResearchRouteNode } | { ok: false; error: string };

/**
 * Branch operations require an explicit route decision. While a decision is
 * pending, no branch may be selected; an answer must identify the exact node.
 */
export const validateResearchRouteBranchSelection = (
  route: ResearchRouteMap | undefined,
  routeNodeId?: string
): ResearchRouteBranchSelectionResult => {
  const decision = route?.decision;
  if (!decision || decision.status === 'none') return { ok: true };
  if (decision.status === 'pending') {
    return { ok: false, error: 'A research route decision is still pending; wait for an explicit user selection.' };
  }
  if (decision.status !== 'answered') return { ok: true };
  const selectedNodeId = decision.selectedNodeId;
  const requestedNodeId = researchRouteString(routeNodeId, 120);
  if (!selectedNodeId || !requestedNodeId) {
    return { ok: false, error: 'An answered research route requires routeNodeId for branch operations.' };
  }
  if (requestedNodeId !== selectedNodeId) {
    return { ok: false, error: 'routeNodeId must match the explicitly selected research route node.' };
  }
  const node = route?.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (!node) return { ok: false, error: 'The selected research route node no longer exists.' };
  if (node.lifecycle === 'proposed') {
    return { ok: false, error: 'Patch the selected research route node before creating or activating a branch.' };
  }
  return { ok: true, node };
};

export function buildResearchRoutePresentation(
  route: ResearchRouteMap,
  artifactRef: ResearchRoutePresentation['artifactRef']
): ResearchRoutePresentation {
  const byId = new Map(route.nodes.map((node) => [node.id, node]));
  const focusId = route.focusNodeId || route.rootNodeId;
  const depthById = new Map<string, number>([[focusId, 1]]);
  const ordered = route.nodes.toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of ordered) {
      if (depthById.has(node.id)) continue;
      const parentDepths = getResearchRouteParentIds(node)
        .map((parentId) => depthById.get(parentId))
        .filter((depth): depth is number => depth != null);
      if (parentDepths.length) {
        depthById.set(node.id, Math.min(...parentDepths) + 1);
        changed = true;
      }
    }
  }

  const selectableIds = new Set(route.decision?.selectableNodeIds || []);
  const requiredIds = new Set<string>([focusId]);
  const addPathToFocus = (nodeId: string): void => {
    const seen = new Set<string>();
    const visit = (currentId: string): void => {
      if (seen.has(currentId)) return;
      seen.add(currentId);
      const current = byId.get(currentId);
      if (!current) return;
      requiredIds.add(current.id);
      if (current.id === focusId) return;
      getResearchRouteParentIds(current).forEach(visit);
    };
    visit(nodeId);
  };
  for (const nodeId of selectableIds) addPathToFocus(nodeId);

  const relativeDepth = (node: ResearchRouteNode): number => {
    if (node.id === focusId) return 1;
    const queue = [{ id: node.id, depth: 1 }];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const candidate = byId.get(current.id);
      if (!candidate) continue;
      for (const parentId of getResearchRouteParentIds(candidate)) {
        if (parentId === focusId) return current.depth + 1;
        queue.push({ id: parentId, depth: current.depth + 1 });
      }
    }
    return Number.POSITIVE_INFINITY;
  };

  const requiredNodes = ordered
    .filter((node) => requiredIds.has(node.id))
    .toSorted((left, right) => relativeDepth(left) - relativeDepth(right) || left.order - right.order);
  const optionalNodes = ordered.filter(
    (node) => !requiredIds.has(node.id) && relativeDepth(node) <= RESEARCH_ROUTE_PRESENTATION_MAX_DEPTH
  );
  const optionalBudget = Math.max(0, RESEARCH_ROUTE_PRESENTATION_MAX_NODES - requiredNodes.length);
  const visibleNodes = [...requiredNodes, ...optionalNodes.slice(0, optionalBudget)];
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleSelectableNodeIds = [...selectableIds].filter((id) => visibleIds.has(id));
  return {
    kind: 'research_route',
    explicitConfirmation: true,
    allowAutoRecommend: false,
    goalId: route.goalId,
    artifactRef,
    selectedTargetId: route.selectedTargetId,
    selectableNodeIds: visibleSelectableNodeIds,
    nodes: visibleNodes.map((node) => {
      const parentIds = getResearchRouteParentIds(node).filter((parentId) => visibleIds.has(parentId));
      const displayStatus: ResearchRouteDisplayStatus =
        node.lifecycle === 'proposed'
          ? isResearchRouteNodeAvailable(node, byId)
            ? 'available'
            : 'planned'
          : node.lifecycle;
      return Object.assign(
        {
          id: node.id,
          parentId: node.parentId && visibleIds.has(node.parentId) ? node.parentId : undefined,
          strategy: node.strategy,
          repairsNodeId: node.repairsNodeId,
          order: node.order,
          title: node.title,
          summary: node.summary,
          displayStatus,
          eta: node.eta,
        },
        parentIds.length ? { parentIds } : {}
      );
    }),
  };
}

export interface ScienceArtifactPage {
  id: string;
  runId: string;
  title: string;
  kind:
    | 'report'
    | 'artifact_workspace'
    | 'figure'
    | 'table'
    | 'code'
    | 'log'
    | 'latex'
    | 'notebook'
    | 'pdf'
    | 'provenance'
    | 'structure'
    | 'regression_table'
    | 'model_diagnostic'
    | 'causal_dag'
    | 'codebook'
    | 'map'
    | 'qualitative_coding'
    | 'target_discovery'
    | 'financial_factor'
    | 'financial_research';
  layout: 'report_artifact_inspector' | 'single_preview' | 'split_editor_preview' | 'ledger' | 'drawer';
  panes: Array<{
    id: string;
    type:
      | 'report'
      | 'preview'
      | 'inspector'
      | 'code'
      | 'execution_log'
      | 'latex_editor'
      | 'compiled_pdf'
      | 'notebook'
      | 'evidence_ledger'
      | 'provenance_chain'
      | 'structure_viewer'
      | 'social_science_viewer'
      | 'regression_table'
      | 'model_diagnostic'
      | 'causal_dag'
      | 'map'
      | 'codebook'
      | 'qualitative_coding'
      | 'target_discovery'
      | 'financial_factor'
      | 'financial_research';
    target?: {
      artifactId?: string;
      artifactVersion?: number;
      evidenceId?: string;
      claimId?: string;
      path?: string;
    };
  }>;
  revision?: string;
}

export type ScienceProvenanceEdgeType =
  | 'derived_from'
  | 'uses_input'
  | 'uses_code'
  | 'has_log'
  | 'generated'
  | 'supports'
  | 'contradicts'
  | 'validates'
  | 'cites'
  | 'annotates'
  | 'supersedes'
  | 'selected_by_skill'
  | 'answers';

export interface ScienceProvenanceNode {
  id: string;
  type: 'input' | 'activity' | 'output' | 'environment' | 'claim' | 'skill_use' | 'review' | 'user_decision';
  label: string;
  artifactId?: string;
  evidenceIds?: string[];
  parents?: string[];
  command?: string;
  path?: string;
  contentHash?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
  revision?: string;
}

export interface ScienceProvenanceEdge {
  id: string;
  runId: string;
  from:
    | { kind: 'evidence'; id: string }
    | { kind: 'artifact'; id: string; version?: number }
    | { kind: 'node'; id: string }
    | { kind: 'claim'; id: string }
    | { kind: 'skill_use'; id: string }
    | { kind: 'message'; id: string };
  to:
    | { kind: 'evidence'; id: string }
    | { kind: 'artifact'; id: string; version?: number }
    | { kind: 'node'; id: string }
    | { kind: 'claim'; id: string }
    | { kind: 'skill_use'; id: string }
    | { kind: 'message'; id: string };
  type: ScienceProvenanceEdgeType;
  label?: string;
  confidence?: 'certain' | 'inferred' | 'declared';
  createdAt: number;
}

export interface ScienceGraphWarning {
  id: string;
  runId: string;
  severity: 'info' | 'warning' | 'error';
  code:
    | 'missing_source'
    | 'missing_edge'
    | 'unopenable_evidence'
    | 'untraced_artifact'
    | 'unsupported_claim'
    | 'broken_reference'
    | 'stale_version'
    | 'missing_environment'
    | 'missing_execution_log';
  message: string;
  target?:
    | { kind: 'evidence'; id: string }
    | { kind: 'artifact'; id: string; version?: number }
    | { kind: 'claim'; id: string }
    | { kind: 'node'; id: string }
    | { kind: 'edge'; id: string };
  blocking?: boolean;
  createdAt: number;
}

export interface ScienceSkillUse {
  id: string;
  runId: string;
  skillId: string;
  skillName: string;
  source: 'deepscientist' | 'k-dense' | 'auto-empirical' | 'nature-skills' | 'sciagent' | 'local' | 'custom';
  sourceUrl?: string;
  version?: string;
  purpose:
    | 'routing'
    | 'database_lookup'
    | 'package_workflow'
    | 'pipeline'
    | 'visualization'
    | 'writing'
    | 'review'
    | 'empirical_design'
    | 'causal_inference'
    | 'replication'
    | 'citation_audit'
    | 'paper_reading'
    | 'data_availability'
    | 'proposal'
    | 'patent_drafting'
    | 'presentation'
    | 'experiment_log'
    | 'codebook'
    | 'qualitative_analysis';
  status: 'selected' | 'used' | 'blocked' | 'unavailable';
  triggeredBy: string;
  selectedBecause?: string;
  limitations?: string[];
  evidenceIds?: string[];
  artifactIds?: string[];
  createdAt: number;
  revision?: string;
}

export type ScienceResultSummaryMetricBasis = 'measured' | 'synthetic' | 'literature' | 'estimated' | 'pending';

export interface ScienceResultSummaryMetric {
  key: string;
  label: string;
  role: 'primary' | 'baseline' | 'secondary';
  value?: number;
  unit?: string;
  direction?: 'maximize' | 'minimize';
  interval?: {
    kind: 'confidence' | 'credible' | 'range';
    lower: number;
    upper: number;
    level?: number;
    method?: string;
  };
  comparison?: string;
  basis: ScienceResultSummaryMetricBasis;
  evidenceIds?: string[];
}

export type ScienceResultSummaryFactKey =
  | 'system'
  | 'dataset'
  | 'sample_size'
  | 'replicates'
  | 'condition'
  | 'method'
  | 'comparator'
  | 'scope'
  | 'threshold'
  | 'environment'
  | 'endpoint'
  | 'participants'
  | 'events'
  | 'censoring'
  | 'validation'
  | 'data_release'
  | 'modalities'
  | 'other';

export interface ScienceResultSummaryFact {
  key?: ScienceResultSummaryFactKey;
  label: string;
  value: string;
  evidenceIds?: string[];
}

export interface ScienceResultSummaryBlock {
  type: 'result_summary';
  variant?: 'generic' | 'survival_prediction';
  title?: string;
  takeaway: string;
  metrics: ScienceResultSummaryMetric[];
  facts?: ScienceResultSummaryFact[];
  note?: string;
  evidenceIds?: string[];
}

export const SCIENCE_REPORT_VISUAL_ROLES = [
  'report.summary',
  'research.question',
  'research.hypothesis',
  'research.method',
  'evidence.source',
  'claim.conclusion',
  'data.dataset',
  'data.table',
  'visual.figure',
  'run.computation',
  'quality.validation',
  'risk.limitation',
  'trace.provenance',
  'math.formal',
  'medical.appraisal',
  'domain.portfolio',
] as const;

export type ScienceReportVisualRole = (typeof SCIENCE_REPORT_VISUAL_ROLES)[number];

export type ScienceReportBlock =
  | { type: 'paragraph'; text: string; evidenceIds?: string[] }
  | { type: 'bullet_list'; items: Array<{ text: string; evidenceIds?: string[]; confidence?: string }> }
  | { type: 'checklist'; items: Array<{ label: string; detail?: string; status?: string; evidenceIds?: string[] }> }
  | ScienceResultSummaryBlock
  | { type: 'figure_ref'; artifactId: string }
  | { type: 'table_ref'; artifactId: string }
  | { type: 'artifact_ref'; artifactId: string }
  | {
      type: 'artifact_embed';
      artifactId: string;
      display?: 'inline' | 'wide' | 'compact';
      renderer?:
        | 'auto'
        | 'image'
        | 'svg'
        | 'html'
        | 'pdf'
        | 'table'
        | 'notebook'
        | 'latex_pdf'
        | 'report_chart'
        | 'proof_trace';
      caption?: string;
      evidenceIds?: string[];
      showSource?: boolean;
      maxHeight?: number;
    }
  | { type: 'code_ref'; artifactId: string }
  | { type: 'card_ref'; cardId: string };

export type ScienceReportTextField =
  | 'question'
  | 'summary'
  | 'report.title'
  | 'section.heading'
  | 'block.text'
  | 'bullet.text'
  | 'checklist.label'
  | 'checklist.detail'
  | 'artifact.caption';

export interface ScienceReportTextTarget {
  field: ScienceReportTextField;
  sectionId?: string;
  blockIndex?: number;
  itemIndex?: number;
}

export interface SciencePanelData {
  schema: typeof SCIENCE_PANEL_SCHEMA;
  runId: string;
  conversationId?: string;
  projectRoot?: string;
  question: string;
  generatedAt: number;
  summary?: string;
  status: 'completed' | 'partial' | 'blocked' | 'failed' | 'running' | 'draft';
  stats: {
    searches: number;
    artifacts: number;
    evidence: number;
    commands: number;
    validations: number;
    warnings: number;
  };
  report: {
    revision?: string;
    title: string;
    /** @deprecated Accepted only while restoring legacy runs; public panels strip this field. */
    visualWaiverReason?: string;
    sections: Array<{
      id: string;
      role?: string;
      visualRole?: ScienceReportVisualRole;
      heading: string;
      blocks: ScienceReportBlock[];
    }>;
    evidence?: ScienceEvidenceItem[];
    claims?: ScienceClaim[];
  };
  evidence: ScienceEvidenceItem[];
  artifacts: ScienceArtifact[];
  cards?: StructuredReportCard[];
  cardDiagnostics?: string[];
  visualReview?: ScienceReportVisualReview;
  financeCompletion?: FinanceCompletionManifest;
  financePreflight?: {
    status: 'completed' | 'partial' | 'blocked' | 'legacy_uncontracted';
    gaps: string[];
    verifiedAt: string;
  };
  pages?: ScienceArtifactPage[];
  claims?: ScienceClaim[];
  verification?: ScienceClaimVerification;
  provenance: ScienceProvenanceNode[];
  edges?: ScienceProvenanceEdge[];
  graphWarnings?: ScienceGraphWarning[];
  usedSkills?: ScienceSkillUse[];
  methods?: {
    queryPlan?: string[];
    commands?: string[];
    environmentSummary?: string;
    limitations?: string[];
  };
  researchRoute?: ResearchRoutePresentation;
  git?: ScienceArtifactGitRef;
  sourceGit?: ScienceSourceGitRef;
}

export type ScienceReportVisualReviewStatus = 'included' | 'recommended' | 'waived' | 'simplify' | 'not_required';

export interface ScienceReportVisualReview {
  status: ScienceReportVisualReviewStatus;
  demand: 'required' | 'recommended' | 'not_required';
  visualCount: number;
  /** Present on newly reviewed reports; omitted by legacy persisted panels. */
  explicitLeadVisualCount?: number;
  /** Present on newly reviewed reports; omitted by legacy persisted panels. */
  supportingVisualCount?: number;
  recommendedRange: { min: number; max: number };
  primaryRange: { min: 1; max: 2 };
  artifactIds: string[];
  cardIds: string[];
  message: string;
}

const SCIENCE_REPORT_VISUAL_RENDERERS = new Set(['image', 'svg', 'report_chart', 'proof_trace']);
const SCIENCE_REPORT_VISUAL_ARTIFACT_TYPES = new Set<ScienceArtifactType>([
  'figure',
  'molecule',
  'protein_structure',
  'genome_track',
  'alignment',
  'model_diagnostic',
  'causal_dag',
  'geospatial_map',
  'qualitative_coding',
]);
const SCIENCE_REPORT_VISUAL_VIEWERS = new Set<ScienceArtifactViewerKind>([
  '3dmol',
  'molstar',
  'rcsb_molstar',
  'igv',
  'vitessce',
  'msa',
  'model_diagnostic',
  'causal_dag',
  'map',
  'qualitative_coding',
  'report_chart',
  'proof_trace',
]);
const SCIENCE_REPORT_IMAGE_PATH = /\.(?:gif|jpe?g|png|svg|tiff?|webp)$/iu;

const structuredNumericObservationCount = (
  report: SciencePanelData['report'],
  cards: readonly StructuredReportCard[]
): number => {
  const summaryValues = report.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.type === 'result_summary'
        ? block.metrics.flatMap((metric) => [metric.value, metric.interval?.lower, metric.interval?.upper])
        : []
    )
  );
  const cardValues = cards.flatMap((card) => {
    if (card.lifecycle === 'empty' || card.lifecycle === 'error' || card.lifecycle === 'unsupported') return [];
    if (card.kind === 'metric_strip') {
      return card.metrics.flatMap((metric) => (typeof metric.value === 'number' ? [metric.value] : []));
    }
    if (card.kind === 'timeseries') return card.series.flatMap((series) => series.points.map((point) => point.y));
    if (card.kind === 'ranked_list') {
      return card.items.flatMap((item) => (typeof item.value === 'number' ? [item.value] : []));
    }
    if (card.kind === 'data_table') {
      return card.rows.flatMap((row) =>
        Object.values(row).filter((value): value is number => typeof value === 'number')
      );
    }
    return [];
  });
  return [...summaryValues, ...cardValues].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  ).length;
};

const isScienceReportVisualArtifact = (
  block: Extract<ScienceReportBlock, { type: 'artifact_embed' }>,
  artifact: ScienceArtifact | undefined
): boolean => {
  if (!artifact) return false;
  if (artifact.status === 'missing' || artifact.status === 'failed') return false;
  if (block.renderer && SCIENCE_REPORT_VISUAL_RENDERERS.has(block.renderer)) return true;
  if (SCIENCE_REPORT_VISUAL_ARTIFACT_TYPES.has(artifact.type)) return true;
  if (artifact.viewer?.kind && SCIENCE_REPORT_VISUAL_VIEWERS.has(artifact.viewer.kind)) return true;
  return [artifact.previewPath, artifact.primaryPath].some(
    (candidate) => typeof candidate === 'string' && SCIENCE_REPORT_IMAGE_PATH.test(candidate)
  );
};

export const reviewScienceReportVisuals = (
  report: SciencePanelData['report'],
  artifacts: readonly ScienceArtifact[],
  reportStatus: SciencePanelData['status'],
  cards: readonly StructuredReportCard[] = [],
  internalVisualWaiverReason?: string
): ScienceReportVisualReview => {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const artifactIds = Array.from(
    new Set(
      report.sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.type === 'artifact_embed' && isScienceReportVisualArtifact(block, artifactById.get(block.artifactId))
            ? [block.artifactId]
            : []
        )
      )
    )
  );
  const cardIds = Array.from(
    new Set(
      report.sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.type === 'card_ref' && isStructuredReportChartCard(cardById.get(block.cardId)) ? [block.cardId] : []
        )
      )
    )
  );
  const visualCount = artifactIds.length + cardIds.length;
  const explicitLeadVisualCount = report.sections.reduce(
    (count, section) =>
      count +
      section.blocks.filter((block) => {
        if (block.type !== 'artifact_embed') return false;
        const artifact = artifactById.get(block.artifactId);
        const chartSpec = artifact?.viewer?.chartSpec;
        const chartDefinition = getReportChartVisualDefinition(chartSpec?.recipe);
        return (
          isScienceReportVisualArtifact(block, artifact) &&
          chartSpec?.visualIntent?.placement === 'lead' &&
          chartDefinition?.leadEligible !== false
        );
      }).length,
    0
  );
  const supportingVisualCount = Math.max(0, visualCount - explicitLeadVisualCount);
  const placementSummary = { explicitLeadVisualCount, supportingVisualCount };
  const numericObservationCount = structuredNumericObservationCount(report, cards);
  const demand =
    reportStatus !== 'completed' && reportStatus !== 'partial'
      ? 'not_required'
      : numericObservationCount >= 2
        ? 'required'
        : 'recommended';
  const reportBlockCount = report.sections.reduce((count, section) => count + section.blocks.length, 0);
  const isNonTrivialReport = report.sections.length >= 2 || reportBlockCount >= 4;
  const recommendedRange = isNonTrivialReport ? { min: 2, max: 4 } : { min: 1, max: 3 };
  const primaryRange = { min: 1, max: 2 } as const;

  if (visualCount > recommendedRange.max) {
    return {
      status: 'simplify',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message:
        'The report has too many visuals for a clear reading path. Keep one or two lead visuals, retain only supporting visuals that answer distinct reader questions, and move the rest to compact references or collapsed evidence.',
    };
  }
  if (visualCount >= recommendedRange.min) {
    return {
      status: 'included',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message:
        'The report has a useful visual reading path. Keep one or two lead visuals near the result summary, place supporting visuals beside the section they explain, and preserve captions and evidence links.',
    };
  }

  if (visualCount > 0) {
    return {
      status: 'recommended',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message:
        'The current visual may be sufficient. Add a supporting visual only when it answers a different reader question about comparison, mechanism, robustness, or limitations; otherwise keep the report compact.',
    };
  }

  // The waiver is an internal editorial decision. Keep accepting the legacy
  // report field for callers that have not migrated yet, but never return the
  // reason as part of the public review object or report panel.
  const waiverReason = (internalVisualWaiverReason || report.visualWaiverReason)?.trim();
  if (waiverReason && demand !== 'required') {
    return {
      status: 'waived',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message:
        'The report does not need a visual for this evidence shape. Keep the reading path compact and do not add a decorative image.',
    };
  }

  if (reportStatus !== 'completed' && reportStatus !== 'partial') {
    return {
      status: 'not_required',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message: 'A draft, running, blocked, or failed report does not need a primary visual yet.',
    };
  }

  if (demand === 'required') {
    return {
      status: 'recommended',
      demand,
      visualCount,
      ...placementSummary,
      recommendedRange,
      primaryRange,
      artifactIds,
      cardIds,
      message:
        'The report contains comparable structured numeric results but no primary visual. Add one evidence-bound lead chart or chart card before completion; use two to four visuals only when they answer distinct comparison, trend, robustness, or risk questions. Never fabricate missing values.',
    };
  }

  return {
    status: 'recommended',
    demand,
    visualCount,
    ...placementSummary,
    recommendedRange,
    primaryRange,
    artifactIds,
    cardIds,
    message:
      'The report has no primary visual. Add one evidence-bearing chart, verified source image, editable diagram, or domain Viewer when it materially improves understanding. If the available material is narrative or not meaningfully visualizable, keep the report compact without adding decoration.',
  };
};

export const getScienceReportReferencedArtifactIds = (report: SciencePanelData['report']): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const section of report.sections || []) {
    for (const block of section.blocks || []) {
      if (!('artifactId' in block) || !block.artifactId || seen.has(block.artifactId)) continue;
      seen.add(block.artifactId);
      ids.push(block.artifactId);
    }
  }
  return ids;
};

const compactStringHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const getSciencePanelCardFingerprint = (panel: SciencePanelData): string =>
  compactStringHash(
    JSON.stringify({
      cards: panel.cards ?? [],
      cardDiagnostics: panel.cardDiagnostics ?? [],
      financeCompletion: panel.financeCompletion ?? null,
      financePreflight: panel.financePreflight ?? null,
    })
  );

export type ScienceArtifactAction =
  | 'describe'
  | 'status'
  | 'reserve_id'
  | 'get'
  | 'list'
  | 'query_many'
  | 'transact'
  | 'create'
  | 'patch'
  | 'replace'
  | 'append'
  | 'version'
  | 'submit_idea'
  | 'get_optimization_frontier'
  | 'record_main_experiment'
  | 'checkpoint'
  | 'research_frontier'
  | 'prepare_branch'
  | 'activate_branch'
  | 'compare_branches'
  | 'snapshot'
  | 'publish'
  | 'annotate'
  | 'focus_page';

export type ScienceArtifactResourceKind =
  | 'run'
  | 'report'
  | 'artifact'
  | 'page'
  | 'evidence'
  | 'claim'
  | 'provenance'
  | 'skill_use'
  | 'annotation'
  | 'memory';

export interface ScienceArtifactMemoryEvent {
  id: string;
  runId: string;
  artifactId?: string;
  artifactVersion?: number;
  actor: 'user' | 'agent' | 'system';
  action: ScienceArtifactAction | 'edit' | 'ask';
  summary: string;
  changedPaths?: string[];
  evidenceIds?: string[];
  claimIds?: string[];
  commit?: string;
  timestamp: number;
  hidden: true;
}

export interface ScienceArtifactEvent {
  schema: typeof SCIENCE_EVENT_SCHEMA;
  eventId: string;
  runId: string;
  action: ScienceArtifactAction;
  timestamp: number;
  conversationId?: string;
  messageId?: string;
  toolCallId?: string;
  target?: {
    kind?: ScienceArtifactResourceKind;
    id?: string;
    version?: number;
    pageId?: string;
  };
  baseRevision?: string;
  resultingRevision?: string;
  artifactIds?: string[];
  pageIds?: string[];
  evidenceIds?: string[];
  claimIds?: string[];
  provenanceNodeIds?: string[];
  panel?: SciencePanelData;
  edges?: ScienceProvenanceEdge[];
  warnings?: ScienceGraphWarning[];
  git?: ScienceArtifactGitRef;
  sourceGit?: ScienceSourceGitRef;
  gitAnchor?: ScienceGitLineAnchor;
  memoryId?: string;
  displayIntent?: 'background' | 'open' | 'focus';
  snapshot?: {
    includePaths?: ScienceArtifactSnapshotIncludePath[];
    files?: ScienceArtifactGitFile[];
  };
}

export interface ScienceArtifactSnapshotIncludePath {
  path: string;
  role?:
    | 'primary'
    | 'preview'
    | 'thumbnail'
    | 'input'
    | 'source'
    | 'output'
    | 'code'
    | 'log'
    | 'environment'
    | 'reference'
    | 'other';
  artifactId?: string;
  artifactVersion?: number;
  recursive?: boolean;
  snapshotId?: string;
}

export interface ScienceArtifactGitFile {
  path: string;
  relativePath?: string;
  role?: ScienceArtifactSnapshotIncludePath['role'];
  artifactId?: string;
  artifactVersion?: number;
  mode: 'copied' | 'pointer' | 'missing' | 'ignored';
  storedPath?: string;
  sha256?: string;
  sizeBytes?: number;
  reason?: string;
}

export interface ScienceArtifactGitRef {
  projectId?: string;
  repoPath?: string;
  commit?: string;
  shortCommit?: string;
  snapshotPath?: string;
  runPath?: string;
  status?: 'committed' | 'unchanged' | 'unavailable';
  files?: ScienceArtifactGitFile[];
  changedFiles?: string[];
  error?: string;
  warning?: string;
}

export interface ScienceSourceGitRef {
  repoRoot?: string;
  branch?: string;
  commit: string;
  shortCommit: string;
  subject: string;
  stage?: string;
  researchStrategy?: ResearchRouteMode;
  routeNodeId?: string;
  repairsNodeId?: string;
  domain?: import('@/common/types/office/preview').ProjectGitDomain;
  artifactRef?: {
    runId: string;
    artifactId: string;
    version: number;
    revision?: string;
  };
  targetSummary?: import('./targetDiscovery').TargetDiscoveryProgressSummary;
  changedFiles: string[];
  verification?: string[];
  metrics?: Array<{
    name: string;
    value: number;
    unit?: string;
    direction?: 'maximize' | 'minimize';
  }>;
  metricContext?: import('@/common/types/office/preview').ProjectGitMetricContext;
  goalId?: string;
  researchStage?: import('@/common/types/office/preview').ProjectGitResearchStageReceipt;
  directionDecision?: import('./researchStrategy').ProjectGitDirectionDecision;
}

export interface ScienceArtifactFileProvenanceRecord {
  projectId?: string;
  projectRoot?: string;
  runId: string;
  conversationId?: string;
  messageId?: string;
  toolCallId?: string;
  eventId?: string;
  action?: ScienceArtifactAction;
  timestamp: number;
  path: string;
  relativePath?: string;
  role?: ScienceArtifactSnapshotIncludePath['role'];
  artifactId?: string;
  artifactVersion?: number;
  artifactTitle?: string;
  artifactType?: ScienceArtifactType;
  evidenceIds?: string[];
  provenanceNodeIds?: string[];
  mode: ScienceArtifactGitFile['mode'];
  storedPath?: string;
  sha256?: string;
  sizeBytes?: number;
  reason?: string;
  commit?: string;
  shortCommit?: string;
  snapshotPath?: string;
  status?: 'tracked' | 'modified' | 'missing' | 'pointer' | 'ignored' | 'untracked' | 'unknown';
}

export interface ScienceArtifactFileProvenanceHistoryItem {
  commit?: string;
  shortCommit?: string;
  timestamp: number;
  action?: ScienceArtifactAction;
  role?: ScienceArtifactSnapshotIncludePath['role'];
  artifactId?: string;
  artifactVersion?: number;
  mode?: ScienceArtifactGitFile['mode'];
}

export interface ScienceArtifactFileProvenanceResult {
  ok: boolean;
  status: 'tracked' | 'modified' | 'missing' | 'pointer' | 'ignored' | 'untracked' | 'unknown';
  filePath: string;
  relativePath?: string;
  projectId?: string;
  projectRoot?: string;
  record?: ScienceArtifactFileProvenanceRecord;
  history?: ScienceArtifactFileProvenanceHistoryItem[];
  error?: string;
}

export type SciencePayload = ScienceArtifactEvent | SciencePanelData;

export interface ScienceConversationExtra {
  enabled: true;
  mode: typeof SCIENCE_MODE_ID;
  projectRoot?: string;
  sopVersion: 1;
  report: {
    enabled: true;
    render: 'inline_structured';
    artifacts: true;
    provenance: true;
    figures: true;
    artifactInspector: true;
  };
  evidence: {
    searchTool: 'research_evidence';
    sharedWithMedicalEvidence: true;
  };
  provenance: {
    evidenceIds: true;
    claimTypes: true;
    contentHash: true;
    environment: true;
    graphWarnings: true;
  };
  skills: {
    rootDiscipline: typeof SCIENCE_CORE_SKILL_NAME;
    artifactSkill: typeof SCIENCE_ARTIFACT_SKILL_NAME;
    materializedSkillPackManifestPath: typeof SCIENCE_SKILL_PACK_MANIFEST_PATH;
    vendorCatalogSkill?: typeof SCIENCE_VENDOR_CATALOG_SKILL_NAME;
    enabledSkillIds: string[];
  };
}

export const buildScienceConversationExtra = (projectRoot?: string): ScienceConversationExtra => ({
  enabled: true,
  mode: SCIENCE_MODE_ID,
  projectRoot,
  sopVersion: 1,
  report: {
    enabled: true,
    render: 'inline_structured',
    artifacts: true,
    provenance: true,
    figures: true,
    artifactInspector: true,
  },
  evidence: {
    searchTool: 'research_evidence',
    sharedWithMedicalEvidence: true,
  },
  provenance: {
    evidenceIds: true,
    claimTypes: true,
    contentHash: true,
    environment: true,
    graphWarnings: true,
  },
  skills: {
    rootDiscipline: SCIENCE_CORE_SKILL_NAME,
    artifactSkill: SCIENCE_ARTIFACT_SKILL_NAME,
    materializedSkillPackManifestPath: SCIENCE_SKILL_PACK_MANIFEST_PATH,
    enabledSkillIds: [...DEFAULT_SCIENCE_SKILL_IDS],
  },
});

/**
 * DeepScientist default identity prompt — injected into every conversation's preset_context
 * to override Codex CLI's built-in self-introduction as "Codex".
 */
export const buildDeepScientistIdentityPrompt = (preferredLocale?: string): string =>
  [
    '# Identity',
    '',
    "You are **DeepScientist**, an AI-powered scientific research assistant running inside the user's local workspace.",
    '',
    '- **Never** introduce yourself as "Codex", "ChatGPT", "Claude", or any other model/product name.',
    '- When users ask who you are, identify yourself as **DeepScientist**, the local AI research assistant.',
    getPromptLanguageInstruction(preferredLocale),
    '- Use only the files, tools, and Skills provided by the runtime; keep claims tied to observable results.',
    '',
    '## Working with the user',
    '- Use `user_input` only when missing information or approval could materially change the result or block safe progress. Ask at most 3 concise, actionable questions and prefer enumerated choices when the options are known.',
    '- After opening `user_input`, wait for that answer. Do not call another tool, continue the analysis, update the report, or send more assistant text while the question is still open.',
    '- Never claim that a command ran, a source was retrieved, a metric was measured, or an artifact was verified unless the runtime result actually supports that claim.',
    '- Read the Skill id provided by the runtime on demand. Do not search guessed application folders or invent a path to `SKILL.md`.',
    '',
    buildDeepScientistUserInputRoutingPrompt(),
    '',
  ].join('\n');

const SCIENCE_CHINESE_COMMUNICATION_AND_NAMING_PROMPT = [
  '## 中文沟通与命名规范',
  '',
  '本规范只约束中文内容；回复语言仍由用户使用的语言决定。以下标准适用于中文回复以及 commit message、docs、SKILL.md、hook stderr 字符串等中文产出，尤其是在给事物起编号或代号前。写之前逐字检查；每次都要检查，不能因为之前改过就跳过。',
  '',
  '本规范的用词标准对全部中文产出有效——含 docs、SKILL.md、commit message、hook 文案、回复正文与思考过程。',
  '',
  '### 命名用具体动词和直接描述',
  '',
  '给事物起名时，用「具体动词 + 具体对象」或直接描述事实。例如“TL-7DR7230 LED 配置”而非“L1 问题”，“上下文压缩前备份”而非“阶段 A 存档”。',
  '',
  '判断标准：读者能否从名称本身确定指的是什么。编号只有顺序信息，没有内容信息——读者看到“T3”无法知道那是什么测试；看到“验证 3：CLI 实测”可以直接知道内容。因此，不使用自造的字母 + 数字组合作为名称；确需编号的序列（测试、验证、实验等按顺序推进的场合），采用「数字 + 具体内容描述」的形式，让编号项自带内容。',
  '',
  '反例：工作记录中使用 T1-T5 标记五项验证、S1/S2 标记两组判决实验、E1/E2 标记两组行为对照——读者必须翻到定义处才能知道每个编号是什么，且文档间引用时编号含义容易断裂。应改写为「数字 + 具体内容描述」。',
  '',
  '### 文本中避免特殊格式字符',
  '',
  '文档和提交信息中不使用 emoji（如勾、叉、警告图案）、不使用 § 等特殊排版符号。用中文文字表述状态和结论。',
  '',
  '### 回复用完整中文句子解释',
  '',
  '每个操作和结论都用完整的中文句子说明做了什么、为什么、影响范围。不写口号式短句或笼统总结。',
  '',
  '### 新编号需先登记',
  '',
  '确实需要引入新编号或代号时，先把定义和用途写进当前项目已有的命名规范或术语表，登记后再使用。已登记代号以该项目的单一登记表为准，不复制清单，避免双处登记各自漂移。项目没有登记表时，不要为当前任务自行建立无内容含义的代号体系，改用具体内容描述。',
  '',
  '### 非正式术语的三类来源',
  '',
  '1. 跨领域借用的比喻词：把其他行业的词借来描述代码或文档行为，读者无法从词本身判断具体动作是什么。例如：兜底改为备用、拷贝改为复制、补齐改为补充、落地改为部署或实施、锚点改为创建标签。',
  '2. 口语和网络用语：语义依赖说话时的语境，写入文档后语义不唯一，同一句话在不同读者那里有多个解读档位。',
  '3. 夸张程度词与管理学表达：不携带具体动作信息，只携带情绪。',
  '',
  '### 高频表述的标准替换',
  '',
  '以下是强调性示例，不是穷举。判断标准是：读者能否从词本身确定具体动作、对象和范围。',
  '',
  '- “钉死”按语境改为“验证成立”“证据齐全”或“当次实测确认”——“钉死”不携带具体动作信息，读者无法判断执行了什么验证。',
  '- “落盘”改为“存档”，即写入并保存到指定位置。',
  '- “闭合”按语境改为“信息完善”“证据齐全”或“调用链完整追踪”——说明是什么闭合了。',
  '- “颗粒度”改为说明测量对象与测量方式，例如“逐行修订”或“逐函数核对”——该词是抽象名词叠加，不指明测量对象与动作。',
  '- “锚定”按实际关系替代：效力关系用“以……为准”，来源关系用“引自”——该词不指明关系类型，无法区分抄入、引用、以它为准或仅供参考。',
  '- “拍板”改为“选择”或“决定”——口语词的语义依赖说话时的语境。',
  '- 同类词（“搞定”“跑通”等）按同一标准处理：换成能说明具体动作的词。',
  '',
  '边界：审计、会计等学科术语（穿行测试、期后事项、证据充分且适当等）有清晰的学科定义，属于专业化表述，不是非正式术语。一个概念能清晰定义其内涵时，它就不属于本条要替换的表述。产物文件名与源码标识符（函数名、枚举名、宏名）是事实引用，不受本条限制。',
  '',
  '### 序号项的写法',
  '',
  '序号项 = 数字 + 具体动作，按需要附必要条件、推论、判断、结果、建议。裸名词式序号不合格——读者无法从条目知道要做什么或发生了什么。',
  '',
  '合格示例：“2. tools 剥离验证通过（首次 400 暴露 alpha 协议扁平 tools 格式，改后回显只有客户端工具，无服务端注入）”——动作、判断、结果齐全。',
  '不合格示例：“2. tools 剥离”——只有名词，不知道做了什么、结果如何。',
  '',
  '### 平实中文与专业化表述的定义',
  '',
  '- 平实中文：句子完整、词义从字面可得的书面中文。不依赖口语语境，不借用行业外比喻，不使用网络用语；读者不需要猜测作者的意思。',
  '- 专业化表述：使用有清晰定义的专业术语。术语的定义可以在学科文献或当前项目文档中核实，语义唯一。专业术语不是黑话——黑话没有公开定义，专业术语有可查证的定义。',
  '',
  '### 为什么专业词汇必须较真',
  '',
  '专业词汇在工程语境里语义唯一。非正式术语在读者那里有多个解读档位——读者无法确定作者执行的是全部验证还是部分验证、写的是确定结论还是推测。结论的可信度会随引用传递逐层降档：下一位读者（人或 AI）按降档后的理解继续工作，错误由此放大。',
  '',
  '### 引用用户原话时的转述规则',
  '',
  '用户在日常交流中使用口语化表述（例如“垃圾”“糊弄”“快挖完了”）。写入仓库文档、CONTEXT、提交信息时，把口语化表述改写为可定义的专业表述（“垃圾”改为“未验证内容”、“糊弄”改为“未按规范执行的行为”、“快挖完了”改为“自认为接近完成”）；技术术语、函数名、错误码、文件路径原样保留。',
].join('\n');

export const buildScienceModePrompt = (
  _projectRoot?: string,
  _preferredLocale?: string,
  agentBackend?: string
): string => {
  const codexImageWorkflow =
    agentBackend === 'codex'
      ? '- Codex report-image workflow: for a substantive report, strongly prefer calling `deepscientist_image_generation` with GPT-Image-2 or a configured newer GPT Image model to generate 1-3 complementary lead figures in parallel, then inspect every result and include only scientifically consistent, legible figures in the report. Start each production prompt from: "Create a publication-ready explanatory lead figure on a pure white background. Lead with the visual rather than decoration; use a clear scientific composition, strong hierarchy, generous whitespace, restrained color, and concise labels in the same language as the user. Make the central mechanism, workflow, comparison, or conclusion immediately understandable. Do not invent measurements, citations, experimental observations, or unsupported claims." Adapt the scientific subject, composition, panels, labels, aspect ratio, and evidence boundary for each figure; do not generate three cosmetic variants of one idea. Quantitative plots must still come from verified data and chart tools, and a report may use fewer or no generated figures when they would be decorative, redundant, or scientifically misleading.'
      : undefined;

  return [
    '# DeepScientist Science Mode',
    '',
    'Science Mode is the default project mode for natural science, engineering, data analysis, computational experiments, and manuscript-producing work.',
    '',
    '## How to work',
    '- Follow `deepscientist-science` and `deepscientist-science-artifact`. Read `report-authoring` for reader-first structure and visual hierarchy.',
    '- Open a workflow or subject-specific Skill only when the current task needs it.',
    '- Perform computation and inspection in the real runtime; MCP tools save sources, results, files, and history but do not replace analysis.',
    '- When `DEEPSCIENTIST_SCIENCE_PYTHON` is available, use it for scientific Python instead of host Python; treat the prepared environment as read-only.',
    '- Use `research_evidence` for sources, `science_artifact` for the report and support, and `project_workspace` for Git history.',
    '- Continue one clear, low-risk route. At a meaningful verified checkpoint, optionally attach one compact `directionDecision` with reason, 1-3 decisive references, next test, and stop condition; never create an empty decision commit.',
    '- Keep a compact persistent research state: question, acceptance criteria, evidence, open items, and next action. On resume, update the checkpoint; do not restart or duplicate terminal reports.',
    '- For a paper-like result, optionally use an abstract-style answer, scope, Figure 1 or result table, methods and reproducibility, observed versus interpreted results, limitations, and conclusion.',
    '- Ask `deepscientist-scientific-visuals` for a visual decision. Two comparable values or a real series require one lead chart. Use `deepscientist-report-chart`, `research-figure-diagram`, `ds-nature-figure`, a verified Viewer, or reviewed `deepscientist_image_generation`; `payload.internalVisualWaiverReason` must never appear in the report; never add decorative or fabricated evidence.',
    codexImageWorkflow,
    '- answer the question first, then scope, key result/figure, methods, interpretation, limitations/next check, and conclusion. Organize by the research question, not MCP chronology; give every visual units/sample size, evidence ids, and a nearby takeaway.',
    '- Use science_artifact query_many for independent reads and transact for related writes. Reuse receipts and nextContext; reread only when resuming or resolving a conflict.',
    '- Unless the user asks only to brainstorm, create or update the task Science report and connect its conclusions to supporting material before the final reply.',
    '- Keep one `runId` and ids; update them instead of duplicating.',
    '',
    SCIENCE_CHINESE_COMMUNICATION_AND_NAMING_PROMPT,
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
};

export const isScienceConversationExtra = (extra: unknown): extra is { science: ScienceConversationExtra } => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return false;
  const science = (extra as Record<string, unknown>).science;
  if (!science || typeof science !== 'object' || Array.isArray(science)) return false;
  const record = science as Partial<ScienceConversationExtra> & Record<string, unknown>;
  return record.enabled === true && (record.mode === SCIENCE_MODE_ID || record.report !== undefined);
};

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const SCIENCE_PAYLOAD_MAX_DEPTH = 12;

const stripFence = (value: string): string => {
  const trimmed = value.trim();
  const opening = trimmed.match(/^```(?:json)?\s*/u);
  if (!opening) return trimmed;
  return trimmed
    .slice(opening[0].length)
    .replace(/\s*```\s*$/u, '')
    .trim();
};

function parsePayloadString(text: string, depth = 0): SciencePayload | undefined {
  if (depth > SCIENCE_PAYLOAD_MAX_DEPTH || !text.includes('deepscientist.science.')) return undefined;
  const candidates = [stripFence(text)];
  const schemaIndex = text.indexOf('deepscientist.science.');
  if (schemaIndex >= 0) {
    const start = text.lastIndexOf('{', schemaIndex);
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      candidates.push(text.slice(start, end + 1));
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const payload = findPayloadCandidate(parsed, depth + 1);
      if (payload) return payload;
    } catch {
      // Continue with the next candidate.
    }
  }
  return undefined;
}

function findPayloadCandidate(value: unknown, depth = 0): SciencePayload | undefined {
  if (depth > SCIENCE_PAYLOAD_MAX_DEPTH) return undefined;
  if (typeof value === 'string') return parsePayloadString(value, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) {
      const payload = findPayloadCandidate(item, depth + 1);
      if (payload) return payload;
    }
    return undefined;
  }
  const record = toRecord(value);
  if (!record) return undefined;
  if (record.schema === SCIENCE_PANEL_SCHEMA) return value as SciencePanelData;
  if (record.schema === SCIENCE_EVENT_SCHEMA) return value as ScienceArtifactEvent;
  for (const nested of Object.values(record)) {
    const payload = findPayloadCandidate(nested, depth + 1);
    if (payload) return payload;
  }
  return undefined;
}

const parsePayloadCandidate = (value: unknown): SciencePayload | undefined =>
  typeof value === 'string' ? parsePayloadString(value) : findPayloadCandidate(value);

const getToolGroupOutput = (message: IMessageToolGroup): unknown[] =>
  Array.isArray(message.content)
    ? message.content
        .flatMap((tool) => {
          const result = tool.result_display;
          if (!result) return [];
          return [result];
        })
        .filter(Boolean)
    : [];

const getAcpToolOutput = (message: IMessageAcpToolCall): unknown[] => {
  const content = message.content;
  return content ? [content] : [];
};

const getToolCallOutput = (message: IMessageToolCall): unknown[] =>
  [message.content.output, message.content.error].filter((item): item is string => Boolean(item));

export const extractSciencePayloadsFromTools = (
  messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>
): SciencePayload[] =>
  messages.flatMap((message) => {
    const outputs =
      message.type === 'tool_group'
        ? getToolGroupOutput(message)
        : message.type === 'acp_tool_call'
          ? getAcpToolOutput(message)
          : getToolCallOutput(message);
    return outputs.map(parsePayloadCandidate).filter((payload): payload is SciencePayload => Boolean(payload));
  });

export const latestSciencePanel = (
  messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>
): SciencePanelData | undefined => {
  const panels = extractSciencePayloadsFromTools(messages)
    .map((payload) => {
      if ((payload as SciencePanelData).schema === SCIENCE_PANEL_SCHEMA) {
        return payload as SciencePanelData;
      }
      const event = payload as ScienceArtifactEvent;
      if (event.schema === SCIENCE_EVENT_SCHEMA && event.action === 'publish') {
        return event.panel;
      }
      return undefined;
    })
    .filter((panel): panel is SciencePanelData => Boolean(panel));
  return panels.at(-1);
};

function collectPublishedSciencePanels(value: unknown, panels: SciencePanelData[], depth = 0): void {
  if (depth > SCIENCE_PAYLOAD_MAX_DEPTH) return;
  if (typeof value === 'string') {
    if (!value.includes(SCIENCE_EVENT_SCHEMA)) return;
    const text = stripFence(value);
    const candidates = [text];
    const schemaIndex = value.indexOf(SCIENCE_EVENT_SCHEMA);
    if (schemaIndex >= 0) {
      const start = value.lastIndexOf('{', schemaIndex);
      const end = value.lastIndexOf('}');
      if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));
    }
    for (const candidate of candidates) {
      try {
        collectPublishedSciencePanels(JSON.parse(candidate), panels, depth + 1);
        return;
      } catch {
        // Continue with the next candidate.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPublishedSciencePanels(item, panels, depth + 1));
    return;
  }
  const record = toRecord(value);
  if (!record) return;
  if (record.schema === SCIENCE_EVENT_SCHEMA && record.action === 'publish') {
    const panel = toRecord(record.panel);
    if (panel?.schema === SCIENCE_PANEL_SCHEMA) panels.push(record.panel as SciencePanelData);
    return;
  }
  Object.values(record).forEach((nested) => collectPublishedSciencePanels(nested, panels, depth + 1));
}

/**
 * Returns only an explicitly published Science report. Domain tools may embed a
 * Science panel for intermediate visualization; those panels are not reports.
 */
export const latestPublishedSciencePanel = (
  messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>
): SciencePanelData | undefined => {
  const panels: SciencePanelData[] = [];
  for (const message of messages) {
    const outputs =
      message.type === 'tool_group'
        ? getToolGroupOutput(message)
        : message.type === 'acp_tool_call'
          ? getAcpToolOutput(message)
          : getToolCallOutput(message);
    outputs.forEach((output) => collectPublishedSciencePanels(output, panels));
  }
  return panels.at(-1);
};

export const getScienceArtifactPreviewPath = (artifact?: ScienceArtifact): string | undefined =>
  artifact?.previewPath ||
  artifact?.primaryPath ||
  artifact?.viewer?.dataPath ||
  artifact?.viewer?.sourcePath ||
  artifact?.thumbnailPath ||
  artifact?.outputPaths?.[0] ||
  artifact?.code?.path;

export const findSciencePanelArtifact = (
  panel: SciencePanelData,
  artifactId?: string,
  artifactVersion?: number
): ScienceArtifact | undefined => {
  if (!artifactId) return undefined;
  return (
    panel.artifacts.find(
      (artifact) => artifact.id === artifactId && (artifactVersion == null || artifact.version === artifactVersion)
    ) || panel.artifacts.find((artifact) => artifact.id === artifactId)
  );
};

export type ScienceDisplayTarget =
  | {
      kind: 'report';
      intent: 'open' | 'focus';
      panel: SciencePanelData;
      eventId: string;
      pageId?: string;
    }
  | {
      kind: 'target_discovery';
      intent: 'open' | 'focus';
      panel: SciencePanelData;
      eventId: string;
      artifact: ScienceArtifact;
      pageId?: string;
    }
  | {
      kind: 'financial_factor';
      intent: 'open' | 'focus';
      panel: SciencePanelData;
      eventId: string;
      artifact: ScienceArtifact;
      pageId?: string;
    }
  | {
      kind: 'financial_research';
      intent: 'open' | 'focus';
      panel: SciencePanelData;
      eventId: string;
      artifact: ScienceArtifact;
      pageId?: string;
    }
  | {
      kind: 'artifact';
      intent: 'open' | 'focus';
      panel: SciencePanelData;
      eventId: string;
      artifact: ScienceArtifact;
      path: string;
      pageId?: string;
    };

const SCIENCE_PREVIEW_PANE_TYPES = new Set([
  'preview',
  'structure_viewer',
  'science_viewer',
  'latex_editor',
  'compiled_pdf',
  'notebook',
  'regression_table',
  'model_diagnostic',
  'causal_dag',
  'map',
  'codebook',
  'qualitative_coding',
  'target_discovery',
  'financial_factor',
  'financial_research',
]);

export const resolveScienceDisplayTarget = (payload: SciencePayload): ScienceDisplayTarget | undefined => {
  const event = payload as ScienceArtifactEvent;
  if (event.schema !== SCIENCE_EVENT_SCHEMA) return undefined;
  const intent = event.displayIntent === 'open' || event.displayIntent === 'focus' ? event.displayIntent : undefined;
  if (!intent || !event.panel) return undefined;

  const panel = event.panel;
  const explicitlyTargetsReport = event.target?.kind === 'report';
  // Publishing is report-first. `focus` is the explicit escape hatch for a viewer the user asked to inspect.
  const publishDefaultsToReport = event.action === 'publish' && event.displayIntent !== 'focus';
  if (explicitlyTargetsReport || publishDefaultsToReport) {
    return { kind: 'report', intent, panel, eventId: event.eventId };
  }

  const pageId =
    event.target?.pageId || event.pageIds?.[0] || (event.target?.kind === 'page' ? event.target.id : undefined);
  const page = pageId ? panel.pages?.find((item) => item.id === pageId) : undefined;
  const pane = page?.panes.find((item) => SCIENCE_PREVIEW_PANE_TYPES.has(item.type));
  const paneArtifact = findSciencePanelArtifact(panel, pane?.target?.artifactId, pane?.target?.artifactVersion);
  if (
    paneArtifact &&
    (page?.kind === 'target_discovery' ||
      pane?.type === 'target_discovery' ||
      paneArtifact.viewer?.kind === 'target_discovery' ||
      Boolean(readTargetDiscoveryPortfolio(paneArtifact.metadata)))
  ) {
    return { kind: 'target_discovery', intent, panel, eventId: event.eventId, pageId, artifact: paneArtifact };
  }
  if (
    paneArtifact &&
    (pane?.type === 'financial_factor' ||
      paneArtifact.viewer?.kind === 'financial_factor' ||
      Boolean(readFinancialFactorPortfolio(paneArtifact.metadata)))
  ) {
    return { kind: 'financial_factor', intent, panel, eventId: event.eventId, pageId, artifact: paneArtifact };
  }
  if (
    paneArtifact &&
    (pane?.type === 'financial_research' ||
      paneArtifact.viewer?.kind === 'financial_research' ||
      Boolean(readFinanceArtifactKind(paneArtifact.metadata)))
  ) {
    return { kind: 'financial_research', intent, panel, eventId: event.eventId, pageId, artifact: paneArtifact };
  }
  const panePath = pane?.target?.path || getScienceArtifactPreviewPath(paneArtifact);
  if (paneArtifact && panePath) {
    return { kind: 'artifact', intent, panel, eventId: event.eventId, pageId, artifact: paneArtifact, path: panePath };
  }

  const targetArtifact = findSciencePanelArtifact(
    panel,
    event.target?.kind === 'artifact' ? event.target.id : event.artifactIds?.[0],
    event.target?.kind === 'artifact' ? event.target.version : undefined
  );
  const targetPath = getScienceArtifactPreviewPath(targetArtifact);
  if (
    targetArtifact &&
    (targetArtifact.viewer?.kind === 'target_discovery' ||
      Boolean(readTargetDiscoveryPortfolio(targetArtifact.metadata)))
  ) {
    return { kind: 'target_discovery', intent, panel, eventId: event.eventId, pageId, artifact: targetArtifact };
  }
  if (
    targetArtifact &&
    (targetArtifact.viewer?.kind === 'financial_factor' ||
      Boolean(readFinancialFactorPortfolio(targetArtifact.metadata)))
  ) {
    return { kind: 'financial_factor', intent, panel, eventId: event.eventId, pageId, artifact: targetArtifact };
  }
  if (
    targetArtifact &&
    (targetArtifact.viewer?.kind === 'financial_research' || Boolean(readFinanceArtifactKind(targetArtifact.metadata)))
  ) {
    return { kind: 'financial_research', intent, panel, eventId: event.eventId, pageId, artifact: targetArtifact };
  }
  if (targetArtifact && targetPath) {
    return {
      kind: 'artifact',
      intent,
      panel,
      eventId: event.eventId,
      pageId,
      artifact: targetArtifact,
      path: targetPath,
    };
  }

  return { kind: 'report', intent, panel, eventId: event.eventId, pageId };
};

export type ScienceTraceKind = 'run' | 'search' | 'artifact' | 'evidence' | 'claim' | 'page' | 'publish';

export interface ScienceTraceItem {
  id: string;
  kind: ScienceTraceKind;
  label: string;
  detail?: string;
  count?: number;
  timestamp?: number;
}

export interface ScienceRuntimeSummary {
  stats: SciencePanelData['stats'];
  trace: ScienceTraceItem[];
  hasPanel: boolean;
  processEventCount: number;
  stageKeys: ScienceTraceKind[];
}

const traceFromPayload = (payload: SciencePayload, index: number): ScienceTraceItem | undefined => {
  if ((payload as SciencePanelData).schema === SCIENCE_PANEL_SCHEMA) return undefined;
  const event = payload as ScienceArtifactEvent;
  if (event.schema !== SCIENCE_EVENT_SCHEMA) return undefined;
  const kind: ScienceTraceKind =
    event.action === 'publish'
      ? 'publish'
      : event.target?.kind === 'artifact'
        ? 'artifact'
        : event.target?.kind === 'evidence'
          ? 'evidence'
          : event.target?.kind === 'claim'
            ? 'claim'
            : event.target?.kind === 'page'
              ? 'page'
              : event.target?.kind === 'run'
                ? 'run'
                : 'artifact';
  return {
    id: `science-${event.runId}-${event.eventId || index}`,
    kind,
    label: event.action,
    detail: event.target?.id || event.target?.kind,
    count:
      (event.artifactIds?.length || 0) +
      (event.evidenceIds?.length || 0) +
      (event.claimIds?.length || 0) +
      (event.pageIds?.length || 0),
    timestamp: event.timestamp,
  };
};

export const summarizeScienceRuntime = (
  messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>
): ScienceRuntimeSummary | undefined => {
  const payloads = extractSciencePayloadsFromTools(messages);
  if (!payloads.length) return undefined;
  const panel = latestSciencePanel(messages);
  const trace = payloads.map(traceFromPayload).filter((item): item is ScienceTraceItem => Boolean(item));
  const processEvents = payloads.filter(
    (payload): payload is ScienceArtifactEvent =>
      (payload as ScienceArtifactEvent).schema === SCIENCE_EVENT_SCHEMA &&
      (payload as ScienceArtifactEvent).action !== 'publish'
  );
  const stageKeys = Array.from(new Set(trace.map((item) => item.kind)));
  if (panel) {
    return {
      stats: panel.stats,
      trace,
      hasPanel: true,
      processEventCount: processEvents.length,
      stageKeys,
    };
  }
  return {
    stats: {
      searches: 0,
      artifacts: processEvents.filter((event) => event.target?.kind === 'artifact').length,
      evidence: processEvents.filter((event) => event.target?.kind === 'evidence').length,
      commands: 0,
      validations: 0,
      warnings: processEvents.reduce((sum, event) => sum + (event.warnings?.length || 0), 0),
    },
    trace,
    hasPanel: false,
    processEventCount: processEvents.length,
    stageKeys,
  };
};
