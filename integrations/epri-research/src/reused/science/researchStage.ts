/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProjectGitCommitSummary, ProjectGitResearchStageDisposition } from './gitTypes';
import { normalizeResearchStrategy, parseResearchCommitSubject } from './researchStrategy';

export type ResearchStageTone =
  | 'prompt'
  | 'setup'
  | 'experiment'
  | 'analysis'
  | 'decision'
  | 'result'
  | 'writing'
  | 'review'
  | 'final'
  | 'other';

export type ResearchStageDescriptor = {
  tone: ResearchStageTone;
  rawStage: string;
  labelKey:
    | 'preview.git.stages.prompt'
    | 'preview.git.stages.setup'
    | 'preview.git.stages.experiment'
    | 'preview.git.stages.analysis'
    | 'preview.git.stages.decision'
    | 'preview.git.stages.result'
    | 'preview.git.stages.writing'
    | 'preview.git.stages.review'
    | 'preview.git.stages.final'
    | 'preview.git.stages.other';
};

export type ResearchCommitSignalDescriptor = {
  tone: ResearchStageTone;
  disposition?: ProjectGitResearchStageDisposition;
  labelKey:
    | ResearchStageDescriptor['labelKey']
    | 'preview.git.signals.supported'
    | 'preview.git.signals.refuted'
    | 'preview.git.signals.exhausted'
    | 'preview.git.signals.inconclusive'
    | 'preview.git.signals.runtimeFailed';
};

export type ResearchStageInput = {
  stage?: string;
  subject: string;
  bodyPreview?: string;
};

const STAGE_RULES: Array<{ tone: Exclude<ResearchStageTone, 'other'>; values: string[] }> = [
  {
    tone: 'prompt',
    values: ['prompt', 'plan', 'planning', 'idea', 'proposal', 'hypothesis', 'scout', 'branching'],
  },
  { tone: 'setup', values: ['project', 'setup', 'init', 'initialization', 'baseline', 'intake', 'onboarding'] },
  {
    tone: 'experiment',
    values: ['experiment', 'trial', 'run', 'implementation', 'implement', 'benchmark', 'screening', 'validation'],
  },
  {
    tone: 'analysis',
    values: ['analysis', 'analyze', 'evaluation', 'evaluate', 'diagnostic', 'data-audit', 'triage'],
  },
  { tone: 'decision', values: ['decision', 'decide', 'gate', 'selection'] },
  { tone: 'result', values: ['result', 'results', 'finding', 'findings', 'outcome'] },
  { tone: 'writing', values: ['writing', 'write', 'draft', 'manuscript', 'paper'] },
  { tone: 'review', values: ['review', 'audit', 'rebuttal', 'revision'] },
  { tone: 'final', values: ['final', 'finalize', 'finalization', 'release', 'complete', 'completion'] },
];

const normalizeStage = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-');

const matchesStage = (candidate: string, value: string): boolean =>
  candidate === value || candidate.startsWith(`${value}-`) || candidate.endsWith(`-${value}`);

const inferTone = (candidate: string): Exclude<ResearchStageTone, 'other'> | undefined =>
  STAGE_RULES.find((rule) => rule.values.some((value) => matchesStage(candidate, value)))?.tone ||
  STAGE_RULES.find((rule) => rule.values.some((value) => candidate.includes(`-${value}-`)))?.tone;

const subjectStage = (subject: string): string | undefined => {
  const parsed = parseResearchCommitSubject(subject);
  const bracketed = parsed.prefixes
    .map(normalizeStage)
    .find((prefix) => !normalizeResearchStrategy(prefix) && inferTone(prefix));
  if (bracketed) return bracketed;
  const prefixed = /^\s*([a-z][a-z0-9_-]{1,30})\s*:/iu.exec(subject)?.[1];
  return prefixed ? normalizeStage(prefixed) : undefined;
};

export const classifyResearchStageInput = (input: ResearchStageInput): ResearchStageDescriptor => {
  const rawStage = normalizeStage(input.stage || subjectStage(input.subject) || 'commit');
  const subject = normalizeStage(input.subject);
  const body = normalizeStage(input.bodyPreview || '');
  const tone = inferTone(rawStage) || inferTone(subject) || inferTone(body) || 'other';

  return {
    tone,
    rawStage,
    labelKey: `preview.git.stages.${tone}`,
  } as ResearchStageDescriptor;
};

type ResearchCommitSignalInput = Pick<ProjectGitCommitSummary, 'subject'> &
  Partial<Pick<ProjectGitCommitSummary, 'bodyPreview' | 'checkpoint'>>;

export const classifyResearchStage = (commit: ResearchCommitSignalInput): ResearchStageDescriptor =>
  classifyResearchStageInput({
    stage: commit.checkpoint?.stage,
    subject: commit.subject,
    bodyPreview: commit.bodyPreview,
  });

const DISPOSITION_SIGNAL_KEYS = {
  supported: 'preview.git.signals.supported',
  refuted: 'preview.git.signals.refuted',
  exhausted: 'preview.git.signals.exhausted',
  inconclusive: 'preview.git.signals.inconclusive',
  runtime_failed: 'preview.git.signals.runtimeFailed',
} as const;

export const classifyResearchCommitSignal = (commit: ResearchCommitSignalInput): ResearchCommitSignalDescriptor => {
  const stage = classifyResearchStage(commit);
  const disposition = commit.checkpoint?.researchStage?.disposition;
  return {
    tone: stage.tone,
    ...(disposition ? { disposition } : {}),
    labelKey: disposition ? DISPOSITION_SIGNAL_KEYS[disposition] : stage.labelKey,
  };
};

export const getResearchCommitDisplayTitle = (subject: string): string => {
  const trimmed = subject.trim();
  const parsed = parseResearchCommitSubject(trimmed);
  if (parsed.prefixes.length) {
    const retainedPrefixes = parsed.prefixes.filter((prefix) => {
      const normalized = normalizeStage(prefix);
      return !normalizeResearchStrategy(normalized) && !inferTone(normalized);
    });
    const rebuilt = `${retainedPrefixes.map((prefix) => `[${prefix}]`).join('')}${
      retainedPrefixes.length && parsed.remainder ? ' ' : ''
    }${parsed.remainder}`.trim();
    if (rebuilt) return rebuilt;
  }

  const prefixed = /^\s*([a-z][a-z0-9_-]{1,30})\s*:\s*(.*)$/iu.exec(trimmed);
  if (prefixed && inferTone(normalizeStage(prefixed[1]))) return prefixed[2].trim() || trimmed;

  return trimmed || 'Untitled commit';
};
