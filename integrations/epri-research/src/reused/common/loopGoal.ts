/**
 * @license
 * Copyright 2025 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import type { ProjectGitResearchStageReceipt } from '@/common/types/office/preview';
import type { ResearchCompletionCriterion, ResearchRouteLifecycle } from './science';
import { DEEPSCIENTIST_USER_INPUT_MCP_TOOL } from './toolRouting';

export type LoopGoalStatus = 'active' | 'paused' | 'completed' | 'deleted';
export type LoopGoalEntryState = 'fresh' | 'resume' | 'unknown';

export type LoopGoalRoadmapStage = {
  id: string;
  title: string;
  lifecycle: ResearchRouteLifecycle;
  objective?: string;
  acceptanceCriteria?: string[];
  failureCriteria?: string[];
  priorWorkRefs?: string[];
  doNotRepeat?: string[];
};

export type LoopGoalRoadmapSnapshot = {
  schema: 'deepscientist.discovery.roadmap-snapshot.v1';
  runId: string;
  exists: boolean;
  revision?: string;
  goalId?: string;
  objective?: string;
  focusNodeId?: string;
  currentStage?: LoopGoalRoadmapStage;
  completionCriteria: ResearchCompletionCriterion[];
  unsatisfiedCompletionCriteria: ResearchCompletionCriterion[];
  terminal: boolean;
  terminalStageId?: string;
  updatedAt?: number;
};

export type LoopGoalRoadmapSnapshotRequest = {
  projectRoot: string;
  runId: string;
  goalId: string;
};

export type LoopGoalRoadmapSnapshotResult = {
  ok: boolean;
  snapshot?: LoopGoalRoadmapSnapshot;
  error?: string;
};

export const LOOP_GOAL_SKILL_NAME = 'deepscientist-loop-goal';
export const LOOP_GOAL_SKILL_PATH = 'resources/skills/loop-goal/SKILL.md';
export const LOOP_GOAL_ENV_KEYS = {
  runId: 'DEEPSCIENTIST_DISCOVERY_RUN_ID',
  goalId: 'DEEPSCIENTIST_DISCOVERY_GOAL_ID',
} as const;

export type LoopGoalOptions = {
  max_stages?: number;
  /** @deprecated Read as a stage cap for older persisted conversations. */
  max_iterations?: number;
  continue_when_idle?: boolean;
};

export type LoopGoalState = {
  id: string;
  goal: string;
  status: LoopGoalStatus;
  created_at: number;
  updated_at: number;
  started_at: number;
  last_resumed_at?: number;
  accumulated_active_ms: number;
  iteration_count: number;
  completed_stage_count?: number;
  last_stage_checkpoint?: string;
  last_stage_receipt?: ProjectGitResearchStageReceipt;
  science_run_id?: string;
  entry_state?: LoopGoalEntryState;
  roadmap_snapshot?: LoopGoalRoadmapSnapshot;
  completed_at?: number;
  /** Turn accepted by Core and still awaiting a terminal runtime state. */
  active_turn_id?: string;
  /** Team run accepted by Core and still waiting for the leader and all workers. */
  active_team_run_id?: string;
  /** Last Team run observed in a terminal state. Used to recover after a restart. */
  last_team_run_id?: string;
  last_turn_id?: string;
  last_triggered_turn_id?: string;
  last_error?: string;
  options?: LoopGoalOptions;
};

export type LoopGoalConversationExtra = {
  loop_goal?: LoopGoalState;
};

const LOOP_GOAL_KICKOFF_HEADINGS = [
  '# Discovery Objective Activation',
  '# DeepScientist Discovery Mode',
  '# Loop Goal Mode',
];
const LOOP_GOAL_CONTINUATION_HEADINGS = [
  '# Discovery Continuation',
  '# Discovery Continuation Envelope',
  '# Continue DeepScientist Discovery Mode',
  '# Continue Loop Goal Mode',
];
const LOOP_GOAL_USER_GOAL_MARKER = '\nUser goal:\n';
const LOOP_GOAL_ADDITIONAL_INSTRUCTION_MARKER = '\nAdditional user instruction for this first iteration:\n';

const DEFAULT_GOAL_NAME_MAX = 42;

export const createLoopGoalState = (
  goal: string,
  now = Date.now(),
  entryState: LoopGoalEntryState = 'unknown'
): LoopGoalState => {
  const id = uuid();
  return {
    id,
    goal: goal.trim(),
    status: 'active',
    created_at: now,
    updated_at: now,
    started_at: now,
    last_resumed_at: now,
    accumulated_active_ms: 0,
    iteration_count: 0,
    completed_stage_count: 0,
    science_run_id: `discovery-${id}`,
    entry_state: entryState,
    options: {
      continue_when_idle: true,
    },
  };
};

export const getLoopGoalFromExtra = (extra: unknown): LoopGoalState | undefined =>
  (extra as LoopGoalConversationExtra | undefined)?.loop_goal;

export const summarizeLoopGoal = (goal: string, maxLength = DEFAULT_GOAL_NAME_MAX): string => {
  const normalized = goal.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
};

export const normalizeLegacyLoopGoalUserMessage = (
  content: string
): { content: string; hidden: boolean; iteration?: number } | undefined => {
  const trimmed = content.trim();
  if (LOOP_GOAL_CONTINUATION_HEADINGS.some((heading) => trimmed.startsWith(heading))) {
    const iterationMatch = trimmed.match(/(?:\nLoop iteration:\s*|"loopTurn":\s*)(\d+)\b/i);
    const iteration = iterationMatch ? Number.parseInt(iterationMatch[1], 10) : undefined;
    return {
      content: '',
      hidden: true,
      ...(iteration && iteration > 0 ? { iteration } : {}),
    };
  }
  if (!LOOP_GOAL_KICKOFF_HEADINGS.some((heading) => trimmed.startsWith(heading))) return undefined;
  if (trimmed.startsWith('# Discovery Objective Activation')) {
    return { content: '', hidden: true, iteration: 1 };
  }

  const goalMarkerIndex = trimmed.indexOf(LOOP_GOAL_USER_GOAL_MARKER);
  if (goalMarkerIndex < 0) return undefined;
  const goalAndInstruction = trimmed.slice(goalMarkerIndex + LOOP_GOAL_USER_GOAL_MARKER.length);
  const instructionMarkerIndex = goalAndInstruction.indexOf(LOOP_GOAL_ADDITIONAL_INSTRUCTION_MARKER);
  const visibleContent =
    instructionMarkerIndex >= 0
      ? goalAndInstruction.slice(instructionMarkerIndex + LOOP_GOAL_ADDITIONAL_INSTRUCTION_MARKER.length)
      : goalAndInstruction;
  return { content: visibleContent.trim(), hidden: false, iteration: 1 };
};

export const getLoopGoalElapsedMs = (loopGoal: LoopGoalState, now = Date.now()): number => {
  const base = loopGoal.accumulated_active_ms || 0;
  if (loopGoal.status !== 'active' || !loopGoal.last_resumed_at) return base;
  return Math.max(0, base + now - loopGoal.last_resumed_at);
};

export const formatLoopGoalElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
};

export const pauseLoopGoal = (loopGoal: LoopGoalState, now = Date.now()): LoopGoalState => ({
  ...loopGoal,
  status: 'paused',
  updated_at: now,
  accumulated_active_ms: getLoopGoalElapsedMs(loopGoal, now),
  last_resumed_at: undefined,
});

export const completeLoopGoal = (
  loopGoal: LoopGoalState,
  roadmapSnapshot: LoopGoalRoadmapSnapshot,
  now = Date.now()
): LoopGoalState => ({
  ...loopGoal,
  status: 'completed',
  updated_at: now,
  completed_at: now,
  accumulated_active_ms: getLoopGoalElapsedMs(loopGoal, now),
  last_resumed_at: undefined,
  roadmap_snapshot: roadmapSnapshot,
  last_error: undefined,
});

export const resumeLoopGoal = (loopGoal: LoopGoalState, now = Date.now()): LoopGoalState => ({
  ...loopGoal,
  status: 'active',
  updated_at: now,
  last_resumed_at: now,
  last_error: undefined,
  entry_state: 'resume',
  completed_at: undefined,
});

export const deleteLoopGoal = (loopGoal: LoopGoalState, now = Date.now()): LoopGoalState => ({
  ...pauseLoopGoal(loopGoal, now),
  status: 'deleted',
  updated_at: now,
});

export const updateLoopGoalText = (loopGoal: LoopGoalState, goal: string, now = Date.now()): LoopGoalState => ({
  ...loopGoal,
  goal: goal.trim(),
  updated_at: now,
});

export const buildLoopGoalSystemPrompt = (active = true): string =>
  active
    ? [
        '# DeepScientist Persistent Research Control',
        '',
        '- Discovery controller is available for this conversation. The persisted `loop_goal.status` is authoritative: only `active` may schedule or auto-continue; `paused`, `completed`, and `deleted` must remain dormant until an explicit user action changes that state.',
        '- Read `deepscientist-loop-goal`. Domain Skills govern evidence and this overlay governs continuation only.',
        '- The DeepScientist Discovery overlay is the sole continuation controller. Do not call Codex create_goal, get_goal, or update_goal and do not create a second persistent Goal for the same objective.',
        '- Preserve the complete persistent objective across turns. A research stage is a subordinate test and must not replace or silently narrow that objective.',
        '- Treat committed project files, checkpoints, registered evidence, portfolios, and verified tool receipts as factual records. `research_roadmap` owns the objective, completion contract, and stage ledger; Science Artifact owns publication; chat text is only a locator.',
        '- One research stage may span multiple Agent turns. A turn boundary, context boundary, reflection budget, failed route, or runtime error is not by itself a stage outcome or overall completion.',
        '- An automatic continuation turn is not terminal delivery. Use the sole continuation controller to select the next evidence-bearing move: explore, deepen, fuse, repair, or stop. Do not create a separate round-decision log.',
        '- A tool/runtime failure is not supporting, refuting, or exhaustion evidence. Retry only with a bounded materially changed attempt, change method, or name the exact external condition required.',
        '- Overall completion requires every completion criterion to be satisfied by current authoritative evidence and an accepted roadmap transition to complete. A stage limit or time boundary pauses work; it never proves completion.',
        '- Stop automatic continuation only when the runtime marks the objective non-active, the user pauses or deletes it, a required user decision is pending, or a real external blocker prevents meaningful progress.',
      ].join('\n')
    : [
        '# DeepScientist Persistent Research Control',
        '',
        '- Discovery controller is unavailable. Do not schedule, auto-continue, or create a roadmap unless a Discovery Objective Activation instruction arrives.',
      ].join('\n');

export const buildLoopGoalKickoffPrompt = (_loopGoal: LoopGoalState, _preferredLocale?: string): string => {
  return [
    '# Discovery Objective Activation',
    '',
    "- Use the user's complete request as the persistent objective; a stage may test part of it but must not replace it.",
    '- Read `project_workspace(action="status")` and `research_roadmap(action="get")` once, preferably in parallel. The runtime supplies the bound project and task identity; omit identity arguments unless a tool explicitly requires them.',
    '- If no roadmap exists, derive one completion contract from the complete request and start exactly one substantive highest-information stage. An initializer-only repository is fresh, not a restoration task.',
    '- If persisted work exists, resume its exact running stage or the highest-value unmet criterion. Reuse supported, refuted, and exhausted work; repeat only after recording what premise, method, data, search region, tool, or verification condition changed.',
    '- Work substantively on the current stage. Planning or state inspection alone is not a completed stage, and the stage may continue across later turns.',
    '- Persist a stage outcome and one project checkpoint only when acceptance, failure, exhaustion, reflection, or real blocker conditions are reached and evidence or state materially changed.',
    '- Do not publish a final report merely because this activation turn ends. Publish only for an evidence-backed terminal result or an explicit user-requested intermediate report.',
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
};

export const buildLoopGoalContinuationPrompt = (loopGoal: LoopGoalState, _preferredLocale?: string): string => {
  return [
    '# Discovery Continuation',
    '',
    `Loop iteration: ${Math.max(2, loopGoal.iteration_count + 1)}`,
    '',
    '- Continue the active persistent objective. Read `project_workspace(action="status")` and `research_roadmap(action="get")` once, preferably in parallel; treat those Git-backed records as authoritative and do not reconstruct state from chat.',
    '- Resume the exact running stage. If none is running, select one next stage from the unmet completion criteria by expected information gain.',
    '- One stage may span multiple turns. Do not close it, create a replacement stage, checkpoint, publish, or summarize terminally merely because this turn ends.',
    '- When a stage truly closes, persist one evidence-bearing outcome. Create a project checkpoint only for a meaningful verified change; runtime failures, retries, reads, and metadata-only updates are not productive stages.',
    '- If no evidence or belief changed, alter the premise, route, data, search region, method, tool, or verification condition before retrying. Never repeat identical input, strategy, and budget.',
    `- Request user_input only when a decision or external condition materially blocks safe progress. In Codex, call the DeepScientist MCP tool \`${DEEPSCIENTIST_USER_INPUT_MCP_TOOL}\`; never call native \`request_user_input\`. If exactly one safe useful route remains, continue it directly.`,
    '- Audit overall completion against current authoritative evidence. Submit nextAction=complete only when every criterion is satisfied. The host stops continuation only after it reads that accepted persisted roadmap transition; prose claiming completion does not stop the controller.',
  ].join('\n');
};
