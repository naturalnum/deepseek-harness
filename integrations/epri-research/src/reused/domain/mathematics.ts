/**
 * @license
 * Copyright 2026 DeepScientist contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPromptLanguageInstruction } from './language';

export const MATHEMATICS_MODE_ID = 'mathematical-research' as const;
export const MATHEMATICS_SKILL_NAME = 'deepscientist-mathematics' as const;
export const MATHEMATICS_SKILL_PATH = 'resources/skills/deepscientist-mathematics/SKILL.md' as const;
export const MATHEMATICS_PORTFOLIO_SCHEMA = 'deepscientist.mathematics.portfolio.v1' as const;
export const MATHEMATICS_PORTFOLIO_ARTIFACT_ID = 'mathematics_portfolio' as const;
export const MATHEMATICS_PORTFOLIO_PATH = 'mathematics/portfolio.json' as const;
export const MATHEMATICS_EVENT_SCHEMA = 'deepscientist.mathematics.event.v1' as const;
export const MATHEMATICS_VERIFICATION_EVENT_SCHEMA = 'deepscientist.mathematics.verification_event.v1' as const;
export const MATHEMATICS_VERIFICATION_TRACE_SCHEMA = 'deepscientist.mathematics.verification_trace.v1' as const;
export const MATHEMATICS_VERIFICATION_TRACE_PATH = 'mathematics/verification-trace.json' as const;
export const MATHEMATICS_VERIFICATION_LIVE_TRACE_PATH =
  '.deepscientist/science-artifacts/mathematics/verification-live.json' as const;

export type MathematicsStage = 'intake' | 'formalization' | 'examples' | 'proving' | 'review' | 'verified' | 'refuted';

export type MathematicsPortfolioStatus =
  | 'planning'
  | 'running'
  | 'needs_review'
  | 'verified'
  | 'refuted'
  | 'inconclusive'
  | 'blocked';
export type MathematicsProblemStatus =
  | 'draft'
  | 'formalized'
  | 'candidate'
  | 'verified'
  | 'refuted'
  | 'inconclusive'
  | 'blocked';
export type MathematicsAttemptStatus = 'draft' | 'running' | 'candidate' | 'verified' | 'refuted' | 'failed' | 'stale';
export type MathematicsExampleKind = 'positive' | 'negative' | 'boundary' | 'counterexample';
export type MathematicsEvidencePolarity = 'supporting' | 'refuting' | 'context';
export type MathematicsEvidenceStrength = 'observed' | 'reproduced' | 'supporting' | 'refuting' | 'formal';
export type MathematicsReproducibility = 'single_run' | 'reproduced' | 'independent' | 'formal';
export type MathematicsReviewStatus =
  | 'not_requested'
  | 'queued'
  | 'running'
  | 'passed'
  | 'changes_requested'
  | 'refuted'
  | 'inconclusive'
  | 'stale';
export type MathematicsVerificationStatus = 'pending' | 'kernel_verified' | 'failed' | 'blocked' | 'unavailable';
export type MathematicsVerificationClaim = 'statement' | 'negation';

export type MathematicsVerificationAuthority = 'agent' | 'lean-process' | 'lean-kernel';

export type MathematicsGoalState = {
  stateId: string;
  target: string;
  hypotheses: string[];
  theoremName?: string;
};

export type MathematicsVerificationEventPayloadMap = {
  'session.opened': {
    projectRoot: string;
    itemCount: number;
    uniqueFileCount: number;
  };
  'toolchain.resolved': {
    command: 'lake' | 'lean';
    executable: string;
    lakeFile?: string;
    available?: boolean;
  };
  'formula.submitted': {
    formulaId: string;
    formula: string;
    label?: string;
    theoremName?: string;
    sourcePath?: string;
    authority: 'agent';
  };
  'goal.opened': MathematicsGoalState & {
    authority: 'agent' | 'lean-process';
  };
  'goal.rewritten': MathematicsGoalState & {
    parentStateId: string;
    previousTarget: string;
    authority: 'agent' | 'lean-process';
  };
  'goal.branched': MathematicsGoalState & {
    parentStateId: string;
    branchLabel?: string;
    authority: 'agent' | 'lean-process';
  };
  'goal.closed': {
    stateId: string;
    parentStateId?: string;
    target?: string;
    theoremName?: string;
  } & ({ status: 'draft_closed'; authority: 'agent' } | { status: 'kernel_verified'; authority: 'lean-kernel' });
  'file.opened': {
    proofPath: string;
    proofHash: string;
    bytes: number;
    checkCount: number;
  };
  'check.draft_checked': {
    proofPath: string;
    status: 'accepted' | 'rejected';
    sorryCount: number;
    admitCount: number;
    axioms: string[];
  };
  'diagnostic.emitted': {
    source: 'git' | 'safety' | 'process' | 'stdout' | 'stderr' | 'agent';
    severity: 'info' | 'warning' | 'error';
    message: string;
    proofPath?: string;
    stateId?: string;
  };
  'check.kernel_checked': {
    proofPath: string;
    status: MathematicsVerificationStatus;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
    durationMs: number;
  };
  'receipt.published': {
    receiptId: string;
    checkId: string;
    proofPath: string;
    theoremName?: string;
    status: MathematicsVerificationStatus;
  };
  'session.closed': {
    status: MathematicsVerificationStatus;
    resultCount: number;
    durationMs: number;
  };
};

export type MathematicsVerificationEventKind = keyof MathematicsVerificationEventPayloadMap;

export type MathematicsVerificationEvent = {
  [Kind in MathematicsVerificationEventKind]: {
    schema: typeof MATHEMATICS_VERIFICATION_EVENT_SCHEMA;
    eventId: string;
    sessionId: string;
    timestamp: number;
    kind: Kind;
    payload: MathematicsVerificationEventPayloadMap[Kind];
  };
}[MathematicsVerificationEventKind];

export type MathematicsVerificationCapability = {
  available: boolean;
  command?: 'lake' | 'lean';
  executable?: string;
  version?: string;
  reason?: string;
  batchCertification: true;
  liveGoals: boolean;
  persistentSession: boolean;
};

export type MathematicsVerificationTrace = {
  schema: typeof MATHEMATICS_VERIFICATION_TRACE_SCHEMA;
  version: 1;
  updatedAt: number;
  capability?: MathematicsVerificationCapability;
  events: MathematicsVerificationEvent[];
};

export type MathematicsDecisionBasis =
  | 'supporting_evidence'
  | 'refuting_evidence'
  | 'conflicting_evidence'
  | 'insufficient_evidence';

export type MathematicsDecisionReason =
  | 'verified_by_supporting_evidence'
  | 'refuted_by_counterexample'
  | 'refuted_by_formal_negation'
  | 'conflicting_evidence'
  | 'supporting_evidence_not_verified'
  | 'refuting_evidence_not_decisive'
  | 'insufficient_evidence';

export interface MathematicsEvidenceDecision {
  disposition: 'verified' | 'refuted' | 'inconclusive';
  basis: MathematicsDecisionBasis;
  reason: MathematicsDecisionReason;
}

export interface MathematicsProblem {
  id: string;
  title: string;
  informalStatement: string;
  formalStatement?: string;
  assumptions: string[];
  statementHash?: string;
  status: MathematicsProblemStatus;
  attemptIds: string[];
  exampleIds: string[];
  verificationId?: string;
  reviewId?: string;
  updatedAt: number;
}

export interface MathematicsAttempt {
  id: string;
  problemId: string;
  strategy: string;
  status: MathematicsAttemptStatus;
  artifactId?: string;
  artifactVersion?: number;
  branch?: string;
  commit?: string;
  proofPath?: string;
  theoremName?: string;
  parentAttemptId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MathematicsExample {
  id: string;
  problemId: string;
  kind: MathematicsExampleKind;
  input: string;
  expected?: string;
  observed?: string;
  scope?: string;
  seed?: string;
  artifactId?: string;
  evidenceIds: string[];
  createdAt: number;
}

/**
 * A typed pointer into the shared Science Evidence graph.
 *
 * The math portfolio records why an observation supports or refutes a
 * specific statement; the full source/provenance remains owned by
 * `science_artifact` and is referenced through `evidenceIds`.
 */
export interface MathematicsEvidence {
  id: string;
  problemId: string;
  statementHash?: string;
  polarity: MathematicsEvidencePolarity;
  strength: MathematicsEvidenceStrength;
  scope: string;
  method: string;
  inputRefs: string[];
  outputRefs: string[];
  evidenceIds: string[];
  observed: string;
  reproducibility: MathematicsReproducibility;
  commit: string;
  command?: string;
  source?: string;
  seed?: string;
  createdAt: number;
}

export interface MathematicsToolchain {
  lean: string;
  mathlib?: string;
  lake?: string;
  lockfilePath?: string;
  lockfileHash?: string;
}

export interface MathematicsVerification {
  id: string;
  problemId: string;
  status: MathematicsVerificationStatus;
  targetCommit: string;
  statementHash: string;
  /** Omitted only by legacy proof receipts, where `statement` is implied. */
  claim?: MathematicsVerificationClaim;
  toolchain: MathematicsToolchain;
  theoremName?: string;
  proofHash?: string;
  logPath?: string;
  goalsRemaining: number;
  sorryCount: number;
  admitCount: number;
  axioms: string[];
  verifier: 'lean-kernel' | 'bounded-check' | 'unavailable';
  checkedAt?: number;
  error?: string;
}

export interface MathematicsReview {
  id: string;
  problemId: string;
  status: MathematicsReviewStatus;
  targetCommit: string;
  statementHash: string;
  reviewerSessionId?: string;
  verdict?: 'passed' | 'changes_requested' | 'refuted' | 'inconclusive';
  summary?: string;
  issueIds: string[];
  reportArtifactId?: string;
  updatedAt: number;
}

export interface MathematicsAction {
  id: string;
  label: string;
  kind: 'formalize' | 'search' | 'verify' | 'review' | 'decision';
  priority: 'now' | 'next' | 'later';
  owner?: 'agent' | 'user' | 'reviewer';
}

export interface MathematicsPortfolio {
  schema: typeof MATHEMATICS_PORTFOLIO_SCHEMA;
  version: 1;
  title: string;
  stage: MathematicsStage;
  status: MathematicsPortfolioStatus;
  updatedAt: number;
  projectRoot?: string;
  activeProblemId?: string;
  toolchain?: MathematicsToolchain;
  problems: MathematicsProblem[];
  attempts: MathematicsAttempt[];
  examples: MathematicsExample[];
  /** Evidence ledger; omitted only by legacy portfolios before this field was introduced. */
  evidence: MathematicsEvidence[];
  verifications: MathematicsVerification[];
  reviews: MathematicsReview[];
  blockers: string[];
  nextActions: MathematicsAction[];
}

export interface MathematicsConversationExtra {
  enabled: true;
  mode: typeof MATHEMATICS_MODE_ID;
  schema: typeof MATHEMATICS_PORTFOLIO_SCHEMA;
  projectRoot?: string;
  defaultSkill: typeof MATHEMATICS_SKILL_NAME;
}

export interface MathematicsValidationResult {
  ok: boolean;
  errors: string[];
}

export interface MathematicsEvidenceSummary {
  supporting: MathematicsEvidence[];
  refuting: MathematicsEvidence[];
  context: MathematicsEvidence[];
  exactStatementSupporting: MathematicsEvidence[];
  exactStatementRefuting: MathematicsEvidence[];
}

export interface MathematicsEvidenceCounts {
  total: number;
  supporting: number;
  refuting: number;
  context: number;
  exactStatementSupporting: number;
  exactStatementRefuting: number;
  qualifiedSupporting: number;
  reproducibleRefuting: number;
}

export interface MathematicsTerminalGateReadiness {
  problemId?: string;
  statementHash?: string;
  evidence: MathematicsEvidenceCounts;
  decision: MathematicsEvidenceDecision;
  hasKernelVerification: boolean;
  hasPassedReview: boolean;
  hasReproducibleCounterexample: boolean;
  hasFormalRefutation: boolean;
  /** True when both decisive evidence lanes are present for the exact statement. */
  hasConflictingEvidence: boolean;
  canVerify: boolean;
  canRefute: boolean;
  verifyMissing: string[];
  refuteMissing: string[];
}

export interface MathematicsValidationOptions {
  /**
   * Read-only migration path for v1 portfolios written before the evidence
   * ledger existed. Mutating callers should keep the strict default.
   */
  allowLegacyEvidenceOmission?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const includesValue = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T);

const MATHEMATICS_STAGES: readonly MathematicsStage[] = [
  'intake',
  'formalization',
  'examples',
  'proving',
  'review',
  'verified',
  'refuted',
];
const PORTFOLIO_STATUSES: readonly MathematicsPortfolioStatus[] = [
  'planning',
  'running',
  'needs_review',
  'verified',
  'refuted',
  'inconclusive',
  'blocked',
];
const PROBLEM_STATUSES: readonly MathematicsProblemStatus[] = [
  'draft',
  'formalized',
  'candidate',
  'verified',
  'refuted',
  'inconclusive',
  'blocked',
];
const ATTEMPT_STATUSES: readonly MathematicsAttemptStatus[] = [
  'draft',
  'running',
  'candidate',
  'verified',
  'refuted',
  'failed',
  'stale',
];
const EXAMPLE_KINDS: readonly MathematicsExampleKind[] = ['positive', 'negative', 'boundary', 'counterexample'];
const EVIDENCE_POLARITIES: readonly MathematicsEvidencePolarity[] = ['supporting', 'refuting', 'context'];
const EVIDENCE_STRENGTHS: readonly MathematicsEvidenceStrength[] = [
  'observed',
  'reproduced',
  'supporting',
  'refuting',
  'formal',
];
const REPRODUCIBILITY_LEVELS: readonly MathematicsReproducibility[] = [
  'single_run',
  'reproduced',
  'independent',
  'formal',
];
const VERIFICATION_STATUSES: readonly MathematicsVerificationStatus[] = [
  'pending',
  'kernel_verified',
  'failed',
  'blocked',
  'unavailable',
];
const VERIFICATION_CLAIMS: readonly MathematicsVerificationClaim[] = ['statement', 'negation'];
const VERIFIERS: readonly MathematicsVerification['verifier'][] = ['lean-kernel', 'bounded-check', 'unavailable'];
const REVIEW_STATUSES: readonly MathematicsReviewStatus[] = [
  'not_requested',
  'queued',
  'running',
  'passed',
  'changes_requested',
  'refuted',
  'inconclusive',
  'stale',
];

const uniqueIds = (items: Array<{ id?: unknown }>, label: string, errors: string[]): void => {
  const ids = items.map((item) => item.id).filter((id): id is string => typeof id === 'string');
  if (ids.length !== items.length) errors.push(`${label} must contain a string id for every item.`);
  if (new Set(ids).size !== ids.length) errors.push(`${label} ids must be unique.`);
};

export function validateMathematicsPortfolio(
  value: unknown,
  options: MathematicsValidationOptions = {}
): MathematicsValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['Mathematics portfolio must be an object.'] };
  if (value.schema !== MATHEMATICS_PORTFOLIO_SCHEMA) errors.push(`schema must be ${MATHEMATICS_PORTFOLIO_SCHEMA}.`);
  if (value.version !== 1) errors.push('version must be 1.');
  if (!isNonEmptyString(value.title)) errors.push('title is required.');
  if (!includesValue(MATHEMATICS_STAGES, value.stage))
    errors.push(`stage must be one of ${MATHEMATICS_STAGES.join(', ')}.`);
  if (!includesValue(PORTFOLIO_STATUSES, value.status)) {
    errors.push(`status must be one of ${PORTFOLIO_STATUSES.join(', ')}.`);
  }
  if (!isNumber(value.updatedAt)) errors.push('updatedAt must be a finite number.');

  const problems = Array.isArray(value.problems) ? value.problems.filter(isRecord) : [];
  const attempts = Array.isArray(value.attempts) ? value.attempts.filter(isRecord) : [];
  const examples = Array.isArray(value.examples) ? value.examples.filter(isRecord) : [];
  const hasEvidenceLedger = Object.prototype.hasOwnProperty.call(value, 'evidence');
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter(isRecord) : [];
  const verifications = Array.isArray(value.verifications) ? value.verifications.filter(isRecord) : [];
  const reviews = Array.isArray(value.reviews) ? value.reviews.filter(isRecord) : [];

  if (!Array.isArray(value.problems)) errors.push('problems must be an array.');
  if (!Array.isArray(value.attempts)) errors.push('attempts must be an array.');
  if (!Array.isArray(value.examples)) errors.push('examples must be an array.');
  // Legacy v1 portfolios did not have an evidence ledger. Treat an omitted
  // field as empty for parsing, but terminal decisions below still require it.
  if (value.evidence != null && !Array.isArray(value.evidence)) errors.push('evidence must be an array.');
  if (!Array.isArray(value.verifications)) errors.push('verifications must be an array.');
  if (!Array.isArray(value.reviews)) errors.push('reviews must be an array.');
  uniqueIds(problems, 'problems', errors);
  uniqueIds(attempts, 'attempts', errors);
  uniqueIds(examples, 'examples', errors);
  uniqueIds(evidence, 'evidence', errors);
  uniqueIds(verifications, 'verifications', errors);
  uniqueIds(reviews, 'reviews', errors);

  problems.forEach((problem, index) => {
    if (!isNonEmptyString(problem.id)) errors.push(`problems[${index}].id is required.`);
    if (!isNonEmptyString(problem.title)) errors.push(`problems[${index}].title is required.`);
    if (!isNonEmptyString(problem.informalStatement)) errors.push(`problems[${index}].informalStatement is required.`);
    if (!isStringArray(problem.assumptions)) errors.push(`problems[${index}].assumptions must be a string array.`);
    if (!isStringArray(problem.attemptIds)) errors.push(`problems[${index}].attemptIds must be a string array.`);
    if (!isStringArray(problem.exampleIds)) errors.push(`problems[${index}].exampleIds must be a string array.`);
    if (!includesValue(PROBLEM_STATUSES, problem.status)) {
      errors.push(`problems[${index}].status must be one of ${PROBLEM_STATUSES.join(', ')}.`);
    }
    if (!isNumber(problem.updatedAt)) errors.push(`problems[${index}].updatedAt must be a finite number.`);
  });

  const problemIds = new Set(problems.map((problem) => problem.id).filter(isNonEmptyString));
  const attemptById = new Map(
    attempts.filter((attempt) => isNonEmptyString(attempt.id)).map((attempt) => [attempt.id, attempt])
  );
  const exampleById = new Map(
    examples.filter((example) => isNonEmptyString(example.id)).map((example) => [example.id, example])
  );
  const verificationById = new Map(
    verifications
      .filter((verification) => isNonEmptyString(verification.id))
      .map((verification) => [verification.id, verification])
  );
  const reviewById = new Map(
    reviews.filter((review) => isNonEmptyString(review.id)).map((review) => [review.id, review])
  );

  if (
    value.activeProblemId != null &&
    (!isNonEmptyString(value.activeProblemId) || !problemIds.has(value.activeProblemId))
  ) {
    errors.push('activeProblemId must reference an existing problem.');
  }

  problems.forEach((problem, index) => {
    if (!isNonEmptyString(problem.id)) return;
    if (isStringArray(problem.attemptIds)) {
      problem.attemptIds.forEach((attemptId) => {
        const attempt = attemptById.get(attemptId);
        if (!attempt || attempt.problemId !== problem.id) {
          errors.push(`problems[${index}].attemptIds must reference attempts owned by problem ${problem.id}.`);
        }
      });
    }
    if (isStringArray(problem.exampleIds)) {
      problem.exampleIds.forEach((exampleId) => {
        const example = exampleById.get(exampleId);
        if (!example || example.problemId !== problem.id) {
          errors.push(`problems[${index}].exampleIds must reference examples owned by problem ${problem.id}.`);
        }
      });
    }
    if (problem.verificationId != null) {
      const verification = isNonEmptyString(problem.verificationId)
        ? verificationById.get(problem.verificationId)
        : undefined;
      if (!verification || verification.problemId !== problem.id) {
        errors.push(`problems[${index}].verificationId must reference a verification owned by problem ${problem.id}.`);
      }
    }
    if (problem.reviewId != null) {
      const review = isNonEmptyString(problem.reviewId) ? reviewById.get(problem.reviewId) : undefined;
      if (!review || review.problemId !== problem.id) {
        errors.push(`problems[${index}].reviewId must reference a review owned by problem ${problem.id}.`);
      }
    }
  });

  attempts.forEach((attempt, index) => {
    if (!isNonEmptyString(attempt.id)) errors.push(`attempts[${index}].id is required.`);
    if (!isNonEmptyString(attempt.problemId)) errors.push(`attempts[${index}].problemId is required.`);
    if (!isNonEmptyString(attempt.strategy)) errors.push(`attempts[${index}].strategy is required.`);
    if (!includesValue(ATTEMPT_STATUSES, attempt.status)) {
      errors.push(`attempts[${index}].status must be one of ${ATTEMPT_STATUSES.join(', ')}.`);
    }
    if (!isNumber(attempt.createdAt) || !isNumber(attempt.updatedAt)) {
      errors.push(`attempts[${index}] needs finite createdAt and updatedAt.`);
    }
    if (isNonEmptyString(attempt.problemId) && !problemIds.has(attempt.problemId)) {
      errors.push(`attempts[${index}].problemId must reference an existing problem.`);
    }
  });

  examples.forEach((example, index) => {
    if (!isNonEmptyString(example.id)) errors.push(`examples[${index}].id is required.`);
    if (!isNonEmptyString(example.problemId)) errors.push(`examples[${index}].problemId is required.`);
    if (!isNonEmptyString(example.input)) errors.push(`examples[${index}].input is required.`);
    if (!includesValue(EXAMPLE_KINDS, example.kind)) {
      errors.push(`examples[${index}].kind must be one of ${EXAMPLE_KINDS.join(', ')}.`);
    }
    if (!isStringArray(example.evidenceIds)) errors.push(`examples[${index}].evidenceIds must be a string array.`);
    if (!isNumber(example.createdAt)) errors.push(`examples[${index}].createdAt must be a finite number.`);
    if (isNonEmptyString(example.problemId) && !problemIds.has(example.problemId)) {
      errors.push(`examples[${index}].problemId must reference an existing problem.`);
    }
  });

  evidence.forEach((item, index) => {
    if (!isNonEmptyString(item.id)) errors.push(`evidence[${index}].id is required.`);
    if (!isNonEmptyString(item.problemId)) errors.push(`evidence[${index}].problemId is required.`);
    if (!includesValue(EVIDENCE_POLARITIES, item.polarity)) {
      errors.push(`evidence[${index}].polarity must be one of ${EVIDENCE_POLARITIES.join(', ')}.`);
    }
    if (!includesValue(EVIDENCE_STRENGTHS, item.strength)) {
      errors.push(`evidence[${index}].strength must be one of ${EVIDENCE_STRENGTHS.join(', ')}.`);
    }
    if (!includesValue(REPRODUCIBILITY_LEVELS, item.reproducibility)) {
      errors.push(`evidence[${index}].reproducibility must be one of ${REPRODUCIBILITY_LEVELS.join(', ')}.`);
    }
    for (const field of ['scope', 'method', 'observed', 'commit'] as const) {
      if (!isNonEmptyString(item[field])) errors.push(`evidence[${index}].${field} is required.`);
    }
    if (!isStringArray(item.inputRefs)) errors.push(`evidence[${index}].inputRefs must be a string array.`);
    if (!isStringArray(item.outputRefs)) errors.push(`evidence[${index}].outputRefs must be a string array.`);
    if (!isStringArray(item.evidenceIds) || item.evidenceIds.length === 0) {
      errors.push(`evidence[${index}].evidenceIds must contain at least one Science evidence id.`);
    }
    if (!isNumber(item.createdAt)) errors.push(`evidence[${index}].createdAt must be a finite number.`);
    if (item.polarity === 'supporting' && item.strength === 'refuting') {
      errors.push(`evidence[${index}] cannot use refuting strength for supporting evidence.`);
    }
    if (item.polarity === 'refuting' && item.strength === 'supporting') {
      errors.push(`evidence[${index}] cannot use supporting strength for refuting evidence.`);
    }
  });

  evidence.forEach((item, index) => {
    if (isNonEmptyString(item.problemId) && !problemIds.has(item.problemId)) {
      errors.push(`evidence[${index}].problemId must reference an existing problem.`);
    }
  });

  verifications.forEach((verification, index) => {
    if (!isNonEmptyString(verification.id)) errors.push(`verifications[${index}].id is required.`);
    if (!isNonEmptyString(verification.problemId)) errors.push(`verifications[${index}].problemId is required.`);
    if (!isNonEmptyString(verification.targetCommit)) errors.push(`verifications[${index}].targetCommit is required.`);
    if (!isNonEmptyString(verification.statementHash))
      errors.push(`verifications[${index}].statementHash is required.`);
    if (!isNumber(verification.goalsRemaining) || verification.goalsRemaining < 0) {
      errors.push(`verifications[${index}].goalsRemaining must be a non-negative number.`);
    }
    if (!isNumber(verification.sorryCount) || verification.sorryCount < 0) {
      errors.push(`verifications[${index}].sorryCount must be a non-negative number.`);
    }
    if (!isNumber(verification.admitCount) || verification.admitCount < 0) {
      errors.push(`verifications[${index}].admitCount must be a non-negative number.`);
    }
    if (!isStringArray(verification.axioms)) errors.push(`verifications[${index}].axioms must be a string array.`);
    if (!includesValue(VERIFICATION_STATUSES, verification.status)) {
      errors.push(`verifications[${index}].status must be one of ${VERIFICATION_STATUSES.join(', ')}.`);
    }
    if (!includesValue(VERIFIERS, verification.verifier)) {
      errors.push(`verifications[${index}].verifier must be one of ${VERIFIERS.join(', ')}.`);
    }
    if (verification.claim != null && !includesValue(VERIFICATION_CLAIMS, verification.claim)) {
      errors.push(`verifications[${index}].claim must be one of ${VERIFICATION_CLAIMS.join(', ')}.`);
    }
    if (!isRecord(verification.toolchain) || !isNonEmptyString(verification.toolchain.lean)) {
      errors.push(`verifications[${index}].toolchain.lean is required.`);
    }
    if (verification.status === 'kernel_verified') {
      if (verification.goalsRemaining !== 0)
        errors.push(`verifications[${index}] cannot be kernel_verified with open goals.`);
      if (verification.sorryCount !== 0 || verification.admitCount !== 0) {
        errors.push(`verifications[${index}] cannot be kernel_verified with sorry or admit.`);
      }
      if (!isNonEmptyString(verification.proofHash)) errors.push(`verifications[${index}] needs a proofHash.`);
    }
    if (isNonEmptyString(verification.problemId) && !problemIds.has(verification.problemId)) {
      errors.push(`verifications[${index}].problemId must reference an existing problem.`);
    }
  });

  reviews.forEach((review, index) => {
    if (!isNonEmptyString(review.id)) errors.push(`reviews[${index}].id is required.`);
    if (!isNonEmptyString(review.problemId)) errors.push(`reviews[${index}].problemId is required.`);
    if (!isNonEmptyString(review.targetCommit)) errors.push(`reviews[${index}].targetCommit is required.`);
    if (!isNonEmptyString(review.statementHash)) errors.push(`reviews[${index}].statementHash is required.`);
    if (!isStringArray(review.issueIds)) errors.push(`reviews[${index}].issueIds must be a string array.`);
    if (!includesValue(REVIEW_STATUSES, review.status)) {
      errors.push(`reviews[${index}].status must be one of ${REVIEW_STATUSES.join(', ')}.`);
    }
    if (review.status === 'passed' && review.verdict !== 'passed') {
      errors.push(`reviews[${index}] cannot be passed without a passed verdict.`);
    }
    if (isNonEmptyString(review.problemId) && !problemIds.has(review.problemId)) {
      errors.push(`reviews[${index}].problemId must reference an existing problem.`);
    }
  });

  const evidenceByProblem = new Map<string, MathematicsEvidence[]>();
  evidence.forEach((rawItem) => {
    const item = rawItem as unknown as MathematicsEvidence;
    const list = evidenceByProblem.get(item.problemId) || [];
    list.push(item);
    evidenceByProblem.set(item.problemId, list);
  });
  const terminalProblems = problems.filter(
    (problem) => problem.status === 'verified' || problem.status === 'refuted'
  ) as unknown as Array<MathematicsProblem>;
  // A missing ledger is accepted only for read-only migration of old v1
  // projections. A caller that explicitly supplies `evidence: []` remains
  // subject to the terminal evidence gate.
  const enforceTerminalEvidence = hasEvidenceLedger || !options.allowLegacyEvidenceOmission;
  if (enforceTerminalEvidence)
    terminalProblems.forEach((problem) => {
      const statementHash = isNonEmptyString(problem.statementHash) ? problem.statementHash : undefined;
      if (!statementHash) {
        errors.push(`problem ${problem.id} cannot be ${problem.status} without an exact statementHash.`);
        return;
      }
      const problemEvidence = evidenceByProblem.get(problem.id) || [];
      if (problem.status === 'verified') {
        const supporting = problemEvidence.filter(
          (item) =>
            item.statementHash === statementHash &&
            item.polarity === 'supporting' &&
            ['supporting', 'formal'].includes(item.strength) &&
            ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
            item.commit !== 'WORKTREE'
        );
        if (!supporting.length) {
          errors.push(
            `problem ${problem.id} cannot be verified without reproducible supporting evidence for its statementHash.`
          );
        }
        const refuting = problemEvidence.filter(
          (item) =>
            item.statementHash === statementHash &&
            item.polarity === 'refuting' &&
            ['refuting', 'formal'].includes(item.strength) &&
            ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
            item.commit !== 'WORKTREE'
        );
        if (refuting.length) {
          errors.push(
            `problem ${problem.id} cannot be verified while the exact statement also has reproducible refuting evidence; resolve the conflict first.`
          );
        }
        const verification = verifications.find(
          (item) =>
            item.id === problem.verificationId &&
            item.problemId === problem.id &&
            item.status === 'kernel_verified' &&
            item.claim !== 'negation'
        );
        if (!verification || verification.statementHash !== statementHash || verification.targetCommit === 'WORKTREE') {
          errors.push(`problem ${problem.id} cannot be verified without its matching kernel verification.`);
        }
        const review = reviews.find(
          (item) =>
            item.id === problem.reviewId &&
            item.problemId === problem.id &&
            item.status === 'passed' &&
            item.verdict === 'passed'
        );
        if (!review || review.statementHash !== statementHash || review.targetCommit === 'WORKTREE') {
          errors.push(`problem ${problem.id} cannot be verified without its matching passed review.`);
        }
        if (verification && review && verification.targetCommit !== review.targetCommit) {
          errors.push(`problem ${problem.id} verification and review must target the same Git commit.`);
        }
      }
      if (problem.status === 'refuted') {
        const refuting = problemEvidence.filter(
          (item) =>
            item.statementHash === statementHash &&
            item.polarity === 'refuting' &&
            ['refuting', 'formal'].includes(item.strength) &&
            ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
            item.commit !== 'WORKTREE'
        );
        if (!refuting.length) errors.push(`problem ${problem.id} cannot be refuted without refuting evidence.`);
        const supporting = problemEvidence.filter(
          (item) =>
            item.statementHash === statementHash &&
            item.polarity === 'supporting' &&
            ['supporting', 'formal'].includes(item.strength) &&
            ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
            item.commit !== 'WORKTREE'
        );
        if (supporting.length) {
          errors.push(
            `problem ${problem.id} cannot be refuted while the exact statement also has reproducible supporting evidence; resolve the conflict first.`
          );
        }
        const hasCounterexample = examples.some((example) => {
          const exampleEvidenceIds = isStringArray(example.evidenceIds) ? example.evidenceIds : [];
          return (
            example.problemId === problem.id &&
            example.kind === 'counterexample' &&
            exampleEvidenceIds.some((id) => refuting.some((item) => item.evidenceIds.includes(id)))
          );
        });
        const negationVerification = verifications.find(
          (item) =>
            item.id === problem.verificationId &&
            item.problemId === problem.id &&
            item.status === 'kernel_verified' &&
            item.claim === 'negation' &&
            item.statementHash === statementHash &&
            item.targetCommit !== 'WORKTREE' &&
            item.goalsRemaining === 0 &&
            item.sorryCount === 0 &&
            item.admitCount === 0 &&
            isStringArray(item.axioms) &&
            item.axioms.length === 0
        );
        const hasFormalNegation = refuting.some(
          (item) =>
            item.strength === 'formal' &&
            item.reproducibility === 'formal' &&
            Boolean(negationVerification && negationVerification.targetCommit === item.commit)
        );
        if (!hasCounterexample && !hasFormalNegation) {
          errors.push(`problem ${problem.id} needs a reproducible counterexample linked to refuting evidence.`);
        }
      }
    });

  if (enforceTerminalEvidence && value.status === 'verified') {
    if (!terminalProblems.some((problem) => problem.status === 'verified')) {
      errors.push('portfolio cannot be verified without a verified problem and supporting evidence.');
    }
    if (!isNonEmptyString(value.activeProblemId)) {
      errors.push('portfolio cannot be verified without an activeProblemId bound to the verified problem.');
    } else if (!problems.some((problem) => problem.id === value.activeProblemId && problem.status === 'verified')) {
      errors.push('portfolio activeProblemId must reference the verified problem when portfolio status is verified.');
    }
  }
  if (enforceTerminalEvidence && value.status === 'refuted') {
    if (!terminalProblems.some((problem) => problem.status === 'refuted')) {
      errors.push('portfolio cannot be refuted without a refuted problem and refuting evidence.');
    }
    if (!isNonEmptyString(value.activeProblemId)) {
      errors.push('portfolio cannot be refuted without an activeProblemId bound to the refuted problem.');
    } else if (!problems.some((problem) => problem.id === value.activeProblemId && problem.status === 'refuted')) {
      errors.push('portfolio activeProblemId must reference the refuted problem when portfolio status is refuted.');
    }
  }

  if (!isStringArray(value.blockers)) errors.push('blockers must be a string array.');
  if (!Array.isArray(value.nextActions)) {
    errors.push('nextActions must be an array.');
  } else {
    value.nextActions.forEach((action, index) => {
      if (!isRecord(action) || !isNonEmptyString(action.id) || !isNonEmptyString(action.label)) {
        errors.push(`nextActions[${index}] needs id and label.`);
      }
      if (
        isRecord(action) &&
        !includesValue(['formalize', 'search', 'verify', 'review', 'decision'] as const, action.kind)
      ) {
        errors.push(`nextActions[${index}].kind is invalid.`);
      }
      if (isRecord(action) && !includesValue(['now', 'next', 'later'] as const, action.priority)) {
        errors.push(`nextActions[${index}].priority is invalid.`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

export function readMathematicsPortfolio(metadata: unknown): MathematicsPortfolio | undefined {
  if (!isRecord(metadata)) return undefined;
  const candidate = metadata.mathematics;
  if (!isRecord(candidate)) return undefined;
  // Keep old v1 projections readable while making the new evidence ledger
  // explicit in all newly emitted portfolio objects.
  const legacyEvidenceOmitted = !Object.prototype.hasOwnProperty.call(candidate, 'evidence');
  const validation = validateMathematicsPortfolio(candidate, {
    allowLegacyEvidenceOmission: legacyEvidenceOmitted,
  });
  const normalized = legacyEvidenceOmitted ? { ...candidate, evidence: [] } : candidate;
  return validation.ok ? (normalized as unknown as MathematicsPortfolio) : undefined;
}

const MATHEMATICS_VERIFICATION_EVENT_KINDS = new Set<MathematicsVerificationEventKind>([
  'session.opened',
  'toolchain.resolved',
  'formula.submitted',
  'goal.opened',
  'goal.rewritten',
  'goal.branched',
  'goal.closed',
  'file.opened',
  'check.draft_checked',
  'diagnostic.emitted',
  'check.kernel_checked',
  'receipt.published',
  'session.closed',
]);

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

const isFiniteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isGoalStatePayload = (value: Record<string, unknown>): boolean =>
  isNonEmptyString(value.stateId) &&
  typeof value.target === 'string' &&
  isStringArray(value.hypotheses) &&
  isOptionalString(value.theoremName);

const isMathematicsVerificationEventPayload = (
  kind: MathematicsVerificationEventKind,
  payload: Record<string, unknown>
): boolean => {
  if (kind === 'session.opened') {
    return (
      isNonEmptyString(payload.projectRoot) &&
      isFiniteNonNegativeNumber(payload.itemCount) &&
      isFiniteNonNegativeNumber(payload.uniqueFileCount)
    );
  }
  if (kind === 'toolchain.resolved') {
    return (
      (payload.command === 'lake' || payload.command === 'lean') &&
      isNonEmptyString(payload.executable) &&
      isOptionalString(payload.lakeFile) &&
      (payload.available === undefined || typeof payload.available === 'boolean')
    );
  }
  if (kind === 'formula.submitted') {
    return (
      isNonEmptyString(payload.formulaId) &&
      isNonEmptyString(payload.formula) &&
      payload.authority === 'agent' &&
      isOptionalString(payload.label) &&
      isOptionalString(payload.theoremName) &&
      isOptionalString(payload.sourcePath)
    );
  }
  if (kind === 'goal.opened') {
    return isGoalStatePayload(payload) && (payload.authority === 'agent' || payload.authority === 'lean-process');
  }
  if (kind === 'goal.rewritten') {
    return (
      isGoalStatePayload(payload) &&
      isNonEmptyString(payload.parentStateId) &&
      typeof payload.previousTarget === 'string' &&
      (payload.authority === 'agent' || payload.authority === 'lean-process')
    );
  }
  if (kind === 'goal.branched') {
    return (
      isGoalStatePayload(payload) &&
      isNonEmptyString(payload.parentStateId) &&
      isOptionalString(payload.branchLabel) &&
      (payload.authority === 'agent' || payload.authority === 'lean-process')
    );
  }
  if (kind === 'goal.closed') {
    return (
      isNonEmptyString(payload.stateId) &&
      isOptionalString(payload.parentStateId) &&
      isOptionalString(payload.target) &&
      isOptionalString(payload.theoremName) &&
      (payload.status === 'draft_closed' || payload.status === 'kernel_verified') &&
      (payload.authority === 'agent' || payload.authority === 'lean-kernel') &&
      (payload.status !== 'kernel_verified' || payload.authority === 'lean-kernel')
    );
  }
  if (kind === 'file.opened') {
    return (
      isNonEmptyString(payload.proofPath) &&
      isNonEmptyString(payload.proofHash) &&
      isFiniteNonNegativeNumber(payload.bytes) &&
      isFiniteNonNegativeNumber(payload.checkCount)
    );
  }
  if (kind === 'check.draft_checked') {
    return (
      isNonEmptyString(payload.proofPath) &&
      (payload.status === 'accepted' || payload.status === 'rejected') &&
      isFiniteNonNegativeNumber(payload.sorryCount) &&
      isFiniteNonNegativeNumber(payload.admitCount) &&
      isStringArray(payload.axioms)
    );
  }
  if (kind === 'diagnostic.emitted') {
    return (
      ['git', 'safety', 'process', 'stdout', 'stderr', 'agent'].includes(String(payload.source)) &&
      ['info', 'warning', 'error'].includes(String(payload.severity)) &&
      isNonEmptyString(payload.message) &&
      isOptionalString(payload.proofPath) &&
      isOptionalString(payload.stateId)
    );
  }
  if (kind === 'check.kernel_checked') {
    return (
      isNonEmptyString(payload.proofPath) &&
      ['pending', 'kernel_verified', 'failed', 'blocked', 'unavailable'].includes(String(payload.status)) &&
      (payload.exitCode === null || (typeof payload.exitCode === 'number' && Number.isInteger(payload.exitCode))) &&
      (payload.signal === null || typeof payload.signal === 'string') &&
      typeof payload.timedOut === 'boolean' &&
      typeof payload.aborted === 'boolean' &&
      isFiniteNonNegativeNumber(payload.durationMs)
    );
  }
  if (kind === 'receipt.published') {
    return (
      isNonEmptyString(payload.receiptId) &&
      isNonEmptyString(payload.checkId) &&
      isNonEmptyString(payload.proofPath) &&
      isOptionalString(payload.theoremName) &&
      ['pending', 'kernel_verified', 'failed', 'blocked', 'unavailable'].includes(String(payload.status))
    );
  }
  return (
    ['pending', 'kernel_verified', 'failed', 'blocked', 'unavailable'].includes(String(payload.status)) &&
    isFiniteNonNegativeNumber(payload.resultCount) &&
    isFiniteNonNegativeNumber(payload.durationMs)
  );
};

const isMathematicsVerificationEvent = (value: unknown): value is MathematicsVerificationEvent => {
  if (
    !isRecord(value) ||
    value.schema !== MATHEMATICS_VERIFICATION_EVENT_SCHEMA ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.sessionId) ||
    !isFiniteNonNegativeNumber(value.timestamp) ||
    typeof value.kind !== 'string' ||
    !MATHEMATICS_VERIFICATION_EVENT_KINDS.has(value.kind as MathematicsVerificationEventKind) ||
    !isRecord(value.payload)
  ) {
    return false;
  }
  return isMathematicsVerificationEventPayload(value.kind as MathematicsVerificationEventKind, value.payload);
};

const isMathematicsVerificationCapability = (value: unknown): value is MathematicsVerificationCapability =>
  isRecord(value) &&
  typeof value.available === 'boolean' &&
  (value.command === undefined || value.command === 'lake' || value.command === 'lean') &&
  isOptionalString(value.executable) &&
  isOptionalString(value.version) &&
  isOptionalString(value.reason) &&
  value.batchCertification === true &&
  typeof value.liveGoals === 'boolean' &&
  typeof value.persistentSession === 'boolean';

export function readMathematicsVerificationTrace(value: unknown): MathematicsVerificationTrace | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.verificationTrace) ? value.verificationTrace : value;
  if (
    candidate.schema !== MATHEMATICS_VERIFICATION_TRACE_SCHEMA ||
    candidate.version !== 1 ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt) ||
    !Array.isArray(candidate.events) ||
    !candidate.events.every(isMathematicsVerificationEvent)
  ) {
    return undefined;
  }
  if (candidate.capability !== undefined && !isMathematicsVerificationCapability(candidate.capability)) {
    return undefined;
  }
  const capability = candidate.capability as MathematicsVerificationCapability | undefined;
  return {
    schema: MATHEMATICS_VERIFICATION_TRACE_SCHEMA,
    version: 1,
    updatedAt: candidate.updatedAt,
    ...(capability ? { capability } : {}),
    events: candidate.events.slice(-2_000),
  };
}

export function summarizeMathematicsEvidence(
  portfolio: Pick<MathematicsPortfolio, 'evidence'>,
  problemId?: string,
  statementHash?: string
): MathematicsEvidenceSummary {
  const evidence = (Array.isArray(portfolio.evidence) ? portfolio.evidence : []).filter(
    (item) => !problemId || item.problemId === problemId
  );
  const supporting = evidence.filter((item) => item.polarity === 'supporting');
  const refuting = evidence.filter((item) => item.polarity === 'refuting');
  const context = evidence.filter((item) => item.polarity === 'context');
  return {
    supporting,
    refuting,
    context,
    exactStatementSupporting: statementHash
      ? supporting.filter((item) => item.statementHash === statementHash)
      : supporting,
    exactStatementRefuting: statementHash ? refuting.filter((item) => item.statementHash === statementHash) : refuting,
  };
}

const hasLinkedScienceEvidence = (item: MathematicsEvidence): boolean =>
  item.evidenceIds.length > 0 && isNonEmptyString(item.commit) && item.commit !== 'WORKTREE';

const isQualifiedSupportingEvidence = (item: MathematicsEvidence): boolean =>
  item.polarity === 'supporting' &&
  ['supporting', 'formal'].includes(item.strength) &&
  ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
  hasLinkedScienceEvidence(item);

const isReproducibleRefutingEvidence = (item: MathematicsEvidence): boolean =>
  item.polarity === 'refuting' &&
  ['refuting', 'formal'].includes(item.strength) &&
  ['reproduced', 'independent', 'formal'].includes(item.reproducibility) &&
  hasLinkedScienceEvidence(item);

export function countMathematicsEvidence(
  portfolio: Pick<MathematicsPortfolio, 'evidence'> | readonly MathematicsEvidence[],
  problemId?: string,
  statementHash?: string
): MathematicsEvidenceCounts {
  const records: MathematicsEvidence[] = Array.isArray(portfolio)
    ? [...portfolio]
    : [...((portfolio as Pick<MathematicsPortfolio, 'evidence'>).evidence || [])];
  const summary = summarizeMathematicsEvidence({ evidence: records }, problemId, statementHash);
  const exactSupporting = summary.exactStatementSupporting;
  const exactRefuting = summary.exactStatementRefuting;
  return {
    total: summary.supporting.length + summary.refuting.length + summary.context.length,
    supporting: summary.supporting.length,
    refuting: summary.refuting.length,
    context: summary.context.length,
    exactStatementSupporting: exactSupporting.length,
    exactStatementRefuting: exactRefuting.length,
    qualifiedSupporting: exactSupporting.filter(isQualifiedSupportingEvidence).length,
    reproducibleRefuting: exactRefuting.filter(isReproducibleRefutingEvidence).length,
  };
}

/**
 * Computes the evidence gates without mutating the portfolio. The server can
 * use this result before accepting a terminal `verified` or `refuted` state,
 * while the renderer can use the same result to explain what is missing.
 */
export function getMathematicsTerminalGateReadiness(
  portfolio: MathematicsPortfolio,
  problemId?: string
): MathematicsTerminalGateReadiness {
  const problem = portfolio.problems.find((item) => item.id === (problemId || portfolio.activeProblemId));
  const statementHash = problem?.statementHash;
  const evidence = countMathematicsEvidence(portfolio, problem?.id, statementHash);
  const verifyMissing: string[] = [];
  const refuteMissing: string[] = [];
  const hasConflictingEvidence = evidence.qualifiedSupporting > 0 && evidence.reproducibleRefuting > 0;

  if (!problem) {
    verifyMissing.push('an active problem');
    refuteMissing.push('an active problem');
  }
  if (!statementHash) {
    verifyMissing.push('an exact statementHash');
    refuteMissing.push('an exact statementHash');
  }
  if (evidence.qualifiedSupporting === 0) verifyMissing.push('exact-statement supporting evidence');
  if (evidence.reproducibleRefuting === 0) refuteMissing.push('reproducible exact-statement refuting evidence');

  const matchingVerifications = problem
    ? portfolio.verifications.filter(
        (item) =>
          item.id === problem.verificationId &&
          item.problemId === problem.id &&
          item.status === 'kernel_verified' &&
          item.claim !== 'negation' &&
          Boolean(statementHash) &&
          item.statementHash === statementHash &&
          item.goalsRemaining === 0 &&
          item.sorryCount === 0 &&
          item.admitCount === 0 &&
          item.axioms.length === 0
      )
    : [];
  const hasKernelVerification = matchingVerifications.length > 0;
  if (!hasKernelVerification) verifyMissing.push('matching Lean kernel verification');

  const hasPassedReview = Boolean(
    problem &&
    problem.reviewId &&
    portfolio.reviews.some(
      (item) =>
        item.id === problem.reviewId &&
        item.problemId === problem.id &&
        item.status === 'passed' &&
        item.verdict === 'passed' &&
        Boolean(statementHash) &&
        item.statementHash === statementHash &&
        matchingVerifications.some((verification) => verification.targetCommit === item.targetCommit)
    )
  );
  if (!hasPassedReview) verifyMissing.push('passed independent review for the same commit');

  const exactRefuting = (Array.isArray(portfolio.evidence) ? portfolio.evidence : []).filter(
    (item) =>
      item.problemId === problem?.id &&
      Boolean(statementHash) &&
      item.statementHash === statementHash &&
      isReproducibleRefutingEvidence(item)
  );
  const exactRefutingIds = new Set(exactRefuting.flatMap((item) => item.evidenceIds));
  const hasReproducibleCounterexample = Boolean(
    problem &&
    portfolio.examples.some(
      (example) =>
        example.problemId === problem.id &&
        example.kind === 'counterexample' &&
        example.evidenceIds.some((id) => exactRefutingIds.has(id))
    )
  );
  const matchingNegationVerification = problem
    ? portfolio.verifications.find(
        (item) =>
          item.id === problem.verificationId &&
          item.problemId === problem.id &&
          item.status === 'kernel_verified' &&
          item.claim === 'negation' &&
          Boolean(statementHash) &&
          item.statementHash === statementHash &&
          item.goalsRemaining === 0 &&
          item.sorryCount === 0 &&
          item.admitCount === 0 &&
          item.axioms.length === 0
      )
    : undefined;
  const hasFormalRefutation = exactRefuting.some(
    (item) =>
      item.strength === 'formal' &&
      item.reproducibility === 'formal' &&
      Boolean(matchingNegationVerification && matchingNegationVerification.targetCommit === item.commit)
  );
  if (!hasReproducibleCounterexample && !hasFormalRefutation) {
    refuteMissing.push('a counterexample linked to the refuting evidence or a formal negation');
  }
  if (hasConflictingEvidence) {
    const conflictMessage = 'resolve conflicting supporting and refuting evidence for the exact statement';
    verifyMissing.push(conflictMessage);
    refuteMissing.push(conflictMessage);
  }

  let decision: MathematicsEvidenceDecision;
  if (hasConflictingEvidence) {
    decision = {
      disposition: 'inconclusive',
      basis: 'conflicting_evidence',
      reason: 'conflicting_evidence',
    };
  } else if (problem?.status === 'verified' && verifyMissing.length === 0) {
    decision = {
      disposition: 'verified',
      basis: 'supporting_evidence',
      reason: 'verified_by_supporting_evidence',
    };
  } else if (problem?.status === 'refuted' && refuteMissing.length === 0) {
    decision = {
      disposition: 'refuted',
      basis: 'refuting_evidence',
      reason: hasFormalRefutation ? 'refuted_by_formal_negation' : 'refuted_by_counterexample',
    };
  } else if (evidence.exactStatementSupporting > 0) {
    decision = {
      disposition: 'inconclusive',
      basis: 'supporting_evidence',
      reason: 'supporting_evidence_not_verified',
    };
  } else if (evidence.exactStatementRefuting > 0) {
    decision = {
      disposition: 'inconclusive',
      basis: 'refuting_evidence',
      reason: 'refuting_evidence_not_decisive',
    };
  } else {
    decision = {
      disposition: 'inconclusive',
      basis: 'insufficient_evidence',
      reason: 'insufficient_evidence',
    };
  }

  return {
    problemId: problem?.id,
    statementHash,
    evidence,
    decision,
    hasKernelVerification,
    hasPassedReview,
    hasReproducibleCounterexample,
    hasFormalRefutation,
    hasConflictingEvidence,
    canVerify: verifyMissing.length === 0,
    canRefute: refuteMissing.length === 0,
    verifyMissing,
    refuteMissing,
  };
}

export function buildInitialMathematicsPortfolio(input: {
  title: string;
  projectRoot?: string;
  updatedAt: number;
  nextActionLabel: string;
}): MathematicsPortfolio {
  return {
    schema: MATHEMATICS_PORTFOLIO_SCHEMA,
    version: 1,
    title: input.title,
    stage: 'intake',
    status: 'planning',
    updatedAt: input.updatedAt,
    projectRoot: input.projectRoot,
    problems: [],
    attempts: [],
    examples: [],
    evidence: [],
    verifications: [],
    reviews: [],
    blockers: [],
    nextActions: [
      {
        id: 'formalize-problem',
        label: input.nextActionLabel,
        kind: 'formalize',
        priority: 'now',
        owner: 'agent',
      },
    ],
  };
}

export function buildMathematicsConversationExtra(projectRoot?: string): MathematicsConversationExtra {
  return {
    enabled: true,
    mode: MATHEMATICS_MODE_ID,
    schema: MATHEMATICS_PORTFOLIO_SCHEMA,
    projectRoot,
    defaultSkill: MATHEMATICS_SKILL_NAME,
  };
}

export function buildMathematicsModePrompt(_preferredLocale?: string): string {
  return [
    '## Mathematical Research Extension',
    'This extension supplies mathematical evidence rules inside Science Mode; it does not create another scheduler, memory store, repository, or publication protocol.',
    '- Read `deepscientist-mathematics` before substantive work and `deepscientist-report-chart` only when a verified visual is useful. Required runtime surfaces are project_workspace, math_portfolio, lean_workspace, and science_artifact; report an unavailable surface instead of emulating it.',
    '- Treat bound Project Git as canonical memory and math_portfolio/Science Artifact as projections. Resume only meaningful committed mathematics state; an initializer-only repository is fresh.',
    '- Preserve the exact informal claim, definitions, domains, quantifiers, assumptions, formal statement, and statementHash. Record whether the formal statement is equivalent, stronger, weaker, or unknown before proof search.',
    '- Bounded checks, literature, compilation, solver output, and an unsuccessful search are scoped evidence, not a universal proof or refutation.',
    '- Verified requires exact-statement registered evidence, a matching named-theorem Lean kernel receipt from a clean committed revision, and a passed independent review for the same statementHash. The receipt binds the caller statement identity to the committed source and records theoremDeclarationHash; review must confirm that declaration formalizes the claimed statement or negation. Refuted requires an exact reproducible counterexample or matching formal negation. Model prose, UI status, native computation, external solvers, sorry/admit, unfinished goals, dirty files, stale commits, and unreviewed axioms never establish Verified.',
    '- If Discovery Mode is active, it is the sole persistent continuation controller. Do not call Codex create_goal/get_goal/update_goal or create a second Goal. If absent, do not infer a long-running Goal merely because the conjecture is difficult.',
    '- Follow the mathematical Skill for portfolio mutations, Lean batching, independent review, and publication. Publish only when the portfolio, evidence, formal receipt, review, report, statementHash, and committed revision agree; otherwise remain partial or blocked.',
    '- If Team Mode is active, its injected mathematics Lead/Worker contract exclusively governs dispatch and integration; this extension does not define another Team policy.',
  ].join('\n');
}

export function buildMathematicsReviewPrompt(preferredLocale?: string): string {
  return [
    '## Independent Mathematical Review',
    'Review only the frozen target commit and the registered Mathematics Portfolio. Git is the canonical memory; do not trust chat text, UI state, or the proposer conclusion.',
    '- Check natural-language/formal-statement alignment, assumptions, vacuity, quantifiers, domains, definitions, and declared axioms.',
    '- Check that every supporting or refuting item states its scope, command, input/output references, seed, and commit, and that the evidence actually concerns the exact statementHash.',
    '- Reconcile the two evidence lanes explicitly. Distinguish “no counterexample found” from a refutation, and reject a terminal verdict that omits the other lane’s scope or limitation.',
    '- Do not pass a verified decision without exact-statement supporting evidence, a matching statement kernel receipt, and an independent passed review. Do not pass a refuted decision without a minimal reproducible counterexample or a matching negation kernel receipt.',
    '- Try to refute first with boundary cases, generated examples, finite checks, and the smallest reproducible counterexample. Failure to find one is inconclusive.',
    '- Run lean_workspace certification from a clean checkout and reject sorry, admit, open goals, stale target commits, untracked dependencies, unavailable toolchains, and mismatched hashes.',
    '- Return structured review events and one verdict: passed, changes_requested, refuted, or inconclusive. Only a passed review plus a matching verifier result supports Verified.',
    '- Never expose hidden chain-of-thought. Record only concise findings, evidence ids, file/line anchors, commands, hashes, and the next action.',
    getPromptLanguageInstruction(preferredLocale),
  ].join('\n');
}
