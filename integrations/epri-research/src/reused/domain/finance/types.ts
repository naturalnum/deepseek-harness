/**
 * Shared Financial Mode contracts.
 *
 * Keep this module runtime-neutral: renderer and standalone MCP processes both
 * consume these types, while IO and authorization remain process-owned.
 */

export const FINANCE_RESULT_SCHEMA = 'deepscientist.finance.result.v1' as const;
export const FINANCE_TOOL_RECEIPT_SCHEMA = 'deepscientist.finance.tool_receipt.v1' as const;
export const FINANCE_COMPLETION_SCHEMA = 'deepscientist.finance.completion.v1' as const;

export const FINANCE_TOOL_NAMES = [
  'finance_market_overview',
  'finance_sector_search',
  'finance_sector_movers',
  'finance_security_screen',
  'finance_security_snapshot',
  'finance_news_events',
  'finance_price_series',
  'finance_relationship_map',
  'finance_research_portfolio',
  'finance_holdings_parse',
] as const;

export type FinanceToolName = (typeof FINANCE_TOOL_NAMES)[number];

export const FINANCE_ARTIFACT_KINDS = [
  'market_theme',
  'event_impact',
  'company_research',
  'research_portfolio',
  'holdings_diagnosis',
  'monitor',
] as const;

export type FinanceArtifactKind = (typeof FINANCE_ARTIFACT_KINDS)[number];

export const FINANCE_TASK_KINDS = [...FINANCE_ARTIFACT_KINDS, 'factor_research'] as const;
export type FinanceTaskKind = (typeof FINANCE_TASK_KINDS)[number];

export type FinanceMarket = 'us' | 'cn' | 'hk' | 'cross_market';
export type FinanceDataMode = 'HISTORICAL' | 'SIMULATION' | 'LIVE_READ_ONLY';
export type FinanceDataStatus =
  | 'available'
  | 'market_closed'
  | 'no_data'
  | 'permission_denied'
  | 'provider_error'
  | 'no_change';

export type FinanceSourceRef = {
  id: string;
  provider: string;
  sourceType: 'filing' | 'exchange' | 'market_data' | 'news' | 'derived';
  uri?: string;
  title?: string;
  asOf: string;
  retrievedAt: string;
  upstreamRevision?: string;
  contentSha256?: string;
  licenseRef?: string;
};

export type FinanceCoverage = {
  requested: number;
  returned: number;
  ratio: number;
  missingSymbols: string[];
};

export type FinanceReportVisualization =
  | 'metric_strip'
  | 'line'
  | 'sparkline'
  | 'candlestick'
  | 'table'
  | 'treemap'
  | 'ranked_list'
  | 'hbar_rank'
  | 'donut'
  | 'evidence_list'
  | 'timeline';

export type FinanceReportModuleId =
  | 'market_status'
  | 'market_theme_ranking'
  | 'event_impact_chain'
  | 'company_snapshot'
  | 'company_financials'
  | 'company_events_risks'
  | 'simulation_policy'
  | 'simulation_performance'
  | 'simulation_holdings'
  | 'simulation_risk'
  | 'holdings_diagnosis'
  | 'monitor_status'
  | 'factor_research_result'
  | 'provenance_and_limitations';

/**
 * Non-binding presentation advice returned with a finance tool result.
 * The agent chooses whether it is useful for the current report and supplies
 * the evidence-backed content through science_artifact.
 */
export type FinanceReportSuggestion = {
  id: string;
  moduleId: FinanceReportModuleId;
  reportSectionRole: string;
  cardKind: StructuredReportCardKind;
  visualization: FinanceReportVisualization;
  preferredView: string;
  purpose: string;
  maxItems: number;
};

export type FinanceResultEnvelope<T> = {
  schema: typeof FINANCE_RESULT_SCHEMA;
  requestId: string;
  dataStatus: FinanceDataStatus;
  asOf: string;
  retrievedAt: string;
  market?: FinanceMarket;
  timezone: string;
  currency?: string;
  dataRevision?: string;
  stale: boolean;
  partial: boolean;
  coverage?: FinanceCoverage;
  warnings: string[];
  sourceRefs: FinanceSourceRef[];
  reportSuggestions?: FinanceReportSuggestion[];
  data: T;
};

export type FinanceArtifactRef = {
  artifactId: string;
  version: number;
  revision?: string;
  contentSha256?: string;
  role?: string;
};

export type FinanceToolReceipt = {
  schema: typeof FINANCE_TOOL_RECEIPT_SCHEMA;
  receiptId: string;
  runId: string;
  sessionId: string;
  callId: string;
  toolName: FinanceToolName | FinancePlatformToolName;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  dataStatus: FinanceDataStatus;
  requestHash: string;
  asOf?: string;
  coverage?: FinanceCoverage;
  evidenceIds: string[];
  artifactRefs: FinanceArtifactRef[];
  capabilities: string[];
  warnings: string[];
  issuedAt: string;
  attestation: {
    algorithm: 'hmac-sha256';
    keyId: string;
    value: string;
  };
};

export type FinancePlatformToolName =
  | 'project_workspace'
  | 'science_artifact'
  | 'research_evidence'
  | 'factor_search'
  | 'factor_lab'
  | 'factor_registry'
  | 'factor_submit'
  | 'user_input'
  | 'cron';

export type FinanceTaskContractId =
  | 'finance.market-theme.v1'
  | 'finance.news-impact.v1'
  | 'finance.company-research.v1'
  | 'finance.simulated-portfolio.v1'
  | 'finance.holdings-diagnosis.v1'
  | 'finance.monitor.v1'
  | 'finance.factor-research.v1';

export type FinanceToolRequirementCondition =
  | 'always'
  | 'when_catalyst_claimed'
  | 'when_price_claimed'
  | 'when_user_consented'
  | 'when_factor_mining'
  | 'when_candidate_accepted'
  | 'when_terminal_report';

export type FinanceContractToolName = FinanceToolName | FinancePlatformToolName;

export type FinanceTaskContract = {
  id: FinanceTaskContractId;
  version: string;
  contractHash: string;
  taskKind: FinanceTaskKind;
  sopReference: string;
  requiredCapabilities: string[];
  requiredTools: Array<{
    name: FinanceContractToolName;
    when: FinanceToolRequirementCondition;
  }>;
  requiredArtifactKinds: Array<FinanceArtifactKind | 'factor_research'>;
  requiredArtifactsWhen?: FinanceToolRequirementCondition;
  requiredReport: {
    when?: FinanceToolRequirementCondition;
    sectionRoles: string[];
    cardKinds: StructuredReportCardKind[];
    requiresResultSummary: boolean;
    requiresLimitations: boolean;
  };
  confirmationGates: string[];
  allowedPartialReasons: string[];
};

export type FinanceTaskContractRef = {
  id: FinanceTaskContractId;
  version: string;
  contractHash: string;
  routeSource: 'deterministic' | 'agent_selected' | 'user_confirmed';
};

export type FinancePreflightGate =
  | {
      kind: 'bound_write';
      workspaceStatusReceiptId: string;
      workspace: string;
    }
  | {
      kind: 'unbound_read_only';
      gateId: string;
    };

export type FinanceCompletionManifestBase = {
  schema: typeof FINANCE_COMPLETION_SCHEMA;
  runId: string;
  taskKind: FinanceTaskKind;
  taskContract: FinanceTaskContractRef;
  gate: FinancePreflightGate;
  toolReceipts: FinanceToolReceipt[];
  asOf: string;
  coverage?: FinanceCoverage;
  evidenceIds: string[];
  artifactRefs: FinanceArtifactRef[];
  report: {
    panelId: string;
    sectionIds: string[];
    cardIds: string[];
  };
  projectGit?: {
    root: string;
    head: string;
    checkpoint?: string;
  };
  artifactGit?: {
    evidenceSnapshotCommit: string;
    snapshotId: string;
  };
  factorRegistryReceiptId?: string;
  checkpoint?: {
    outcome: 'created' | 'no_material_change';
    commit?: string;
    stage?: string;
    verification: string[];
  };
  verifiedAt: string;
};

export type FinanceCompletionManifest =
  | (FinanceCompletionManifestBase & {
      status: 'completed';
      reproducible: true;
      projectGit: NonNullable<FinanceCompletionManifestBase['projectGit']>;
      artifactGit: NonNullable<FinanceCompletionManifestBase['artifactGit']>;
      gaps: [];
    })
  | (FinanceCompletionManifestBase & {
      status: 'partial' | 'blocked';
      reproducible: false;
      gaps: string[];
    });

export type StructuredReportCardKind = 'metric_strip' | 'timeseries' | 'data_table' | 'ranked_list' | 'evidence_list';
