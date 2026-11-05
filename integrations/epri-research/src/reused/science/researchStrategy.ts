/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

export const RESEARCH_STRATEGIES = ['explore', 'deepen', 'fuse', 'repair', 'stop'] as const;

export type ResearchStrategy = (typeof RESEARCH_STRATEGIES)[number];

export const PROJECT_GIT_DIRECTION_DECISION_SCHEMA = 'deepscientist.direction.v1' as const;

export const PROJECT_GIT_DIRECTION_CHOICES = ['advance', 'hold', 'reject', 'repair', 'stop'] as const;

export type ProjectGitDirectionChoice = (typeof PROJECT_GIT_DIRECTION_CHOICES)[number];

export const PROJECT_GIT_DIRECTION_BASIS_KINDS = ['evidence', 'artifact', 'commit'] as const;

export type ProjectGitDirectionBasisKind = (typeof PROJECT_GIT_DIRECTION_BASIS_KINDS)[number];

export interface ProjectGitDirectionBasisRef {
  kind: ProjectGitDirectionBasisKind;
  ref: string;
  label?: string;
}

export interface ProjectGitDirectionDecision {
  schema: typeof PROJECT_GIT_DIRECTION_DECISION_SCHEMA;
  choice: ProjectGitDirectionChoice;
  reason: string;
  basisRefs: ProjectGitDirectionBasisRef[];
  nextTest?: string;
  stopIf?: string;
}

const RESEARCH_STRATEGY_SET = new Set<string>(RESEARCH_STRATEGIES);
const PROJECT_GIT_DIRECTION_CHOICE_SET = new Set<string>(PROJECT_GIT_DIRECTION_CHOICES);
const PROJECT_GIT_DIRECTION_BASIS_KIND_SET = new Set<string>(PROJECT_GIT_DIRECTION_BASIS_KINDS);

const normalizeDecisionText = (value: unknown, maxLength: number): string | undefined =>
  (typeof value === 'string' ? value : '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength) || undefined;

export const normalizeProjectGitDirectionDecision = (value: unknown): ProjectGitDirectionDecision | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== PROJECT_GIT_DIRECTION_DECISION_SCHEMA) return undefined;
  const choice = normalizeDecisionText(candidate.choice, 24);
  const reason = normalizeDecisionText(candidate.reason, 360);
  if (!choice || !PROJECT_GIT_DIRECTION_CHOICE_SET.has(choice) || !reason || !Array.isArray(candidate.basisRefs)) {
    return undefined;
  }
  const seen = new Set<string>();
  const basisRefs = candidate.basisRefs
    .map((item): ProjectGitDirectionBasisRef | undefined => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      const kind = normalizeDecisionText(record.kind, 24);
      const ref = normalizeDecisionText(record.ref, 160);
      if (!kind || !PROJECT_GIT_DIRECTION_BASIS_KIND_SET.has(kind) || !ref) return undefined;
      const identity = `${kind}:${ref}`;
      if (seen.has(identity)) return undefined;
      seen.add(identity);
      const label = normalizeDecisionText(record.label, 120);
      return {
        kind: kind as ProjectGitDirectionBasisKind,
        ref,
        ...(label ? { label } : {}),
      };
    })
    .filter((item): item is ProjectGitDirectionBasisRef => Boolean(item))
    .slice(0, 4);
  if (!basisRefs.length) return undefined;
  const nextTest = normalizeDecisionText(candidate.nextTest, 280);
  const stopIf = normalizeDecisionText(candidate.stopIf, 280);
  return {
    schema: PROJECT_GIT_DIRECTION_DECISION_SCHEMA,
    choice: choice as ProjectGitDirectionChoice,
    reason,
    basisRefs,
    ...(nextTest ? { nextTest } : {}),
    ...(stopIf ? { stopIf } : {}),
  };
};

export type ParsedResearchCommitSubject = {
  prefixes: string[];
  researchStrategy?: ResearchStrategy;
  remainder: string;
};

export const normalizeResearchStrategy = (value: unknown): ResearchStrategy | undefined => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return RESEARCH_STRATEGY_SET.has(normalized) ? (normalized as ResearchStrategy) : undefined;
};

export const parseResearchCommitSubject = (subject: string): ParsedResearchCommitSubject => {
  let remainder = String(subject || '').trim();
  const prefixes: string[] = [];

  while (remainder) {
    const match = /^\[([^\]]+)\]\s*/u.exec(remainder);
    if (!match) break;
    prefixes.push(match[1].trim());
    remainder = remainder.slice(match[0].length).trim();
  }

  const strategies = Array.from(
    new Set(prefixes.map(normalizeResearchStrategy).filter((value): value is ResearchStrategy => Boolean(value)))
  );
  return {
    prefixes,
    ...(strategies.length === 1 ? { researchStrategy: strategies[0] } : {}),
    remainder,
  };
};

export const formatResearchCommitSubject = (input: {
  message: string;
  stage: string;
  researchStrategy?: ResearchStrategy;
}): string => {
  const parsedMessage = parseResearchCommitSubject(input.message);
  const normalizedStage = input.stage.trim().toLowerCase();
  const unmanagedPrefixes = parsedMessage.prefixes.filter(
    (prefix) => !normalizeResearchStrategy(prefix) && prefix.trim().toLowerCase() !== normalizedStage
  );
  const message = [...unmanagedPrefixes.map((prefix) => `[${prefix}]`), parsedMessage.remainder]
    .filter(Boolean)
    .join(' ')
    .trim();
  return `${input.researchStrategy ? `[${input.researchStrategy}]` : ''}[${input.stage}] ${message || 'checkpoint'}`;
};
