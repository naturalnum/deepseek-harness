/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseResearchCommitSubject, type ResearchStrategy } from './researchStrategy';
import type { ProjectGitCommitSummary } from './gitTypes';

export interface ResearchProgressGraphNode {
  id: string;
  parentId?: string;
  parentIds?: readonly string[];
  order?: number;
}

export interface ResearchProgressGraphLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  rowGap?: number;
  paddingX?: number;
  paddingY?: number;
}

export interface PositionedResearchProgressNode<T extends ResearchProgressGraphNode> {
  node: T;
  id: string;
  parentIds: string[];
  depth: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResearchProgressGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  parentIndex: number;
}

export interface ResearchProgressGraphIssue {
  nodeId: string;
  parentId?: string;
}

export interface ResearchProgressGraphLayout<T extends ResearchProgressGraphNode> {
  nodes: PositionedResearchProgressNode<T>[];
  edges: ResearchProgressGraphEdge[];
  rootIds: string[];
  width: number;
  height: number;
  issues: {
    duplicateNodeIds: string[];
    missingParents: ResearchProgressGraphIssue[];
    unresolvedNodeIds: string[];
  };
}

const finiteDimension = (value: number | undefined, fallback: number, minimum = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, value) : fallback;

const compareText = (left: string, right: string): number => left.localeCompare(right, 'en');

/**
 * Combines the legacy single-parent field with the multi-parent field. Keeping
 * the legacy parent first preserves the primary route when both are present.
 */
export const getResearchProgressParentIds = (node: ResearchProgressGraphNode): string[] => {
  const candidates = [node.parentId, ...(Array.isArray(node.parentIds) ? node.parentIds : [])];
  const result: string[] = [];
  const seen = new Set<string>();

  candidates.forEach((candidate) => {
    const parentId = typeof candidate === 'string' ? candidate.trim() : '';
    if (!parentId || parentId === node.id || seen.has(parentId)) return;
    seen.add(parentId);
    result.push(parentId);
  });

  return result;
};

/**
 * Lays out a rooted DAG from left to right. A node with multiple parents is
 * placed after its deepest parent and receives one edge per parent. Invalid
 * input is reported and rendered safely instead of recursing indefinitely.
 */
export const layoutResearchProgressGraph = <T extends ResearchProgressGraphNode>(
  inputNodes: readonly T[],
  options: ResearchProgressGraphLayoutOptions = {}
): ResearchProgressGraphLayout<T> => {
  const nodeWidth = finiteDimension(options.nodeWidth, 220, 1);
  const nodeHeight = finiteDimension(options.nodeHeight, 76, 1);
  const columnGap = finiteDimension(options.columnGap, 72);
  const rowGap = finiteDimension(options.rowGap, 24);
  const paddingX = finiteDimension(options.paddingX, 24);
  const paddingY = finiteDimension(options.paddingY, 24);

  if (inputNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      rootIds: [],
      width: 0,
      height: 0,
      issues: { duplicateNodeIds: [], missingParents: [], unresolvedNodeIds: [] },
    };
  }

  const nodesById = new Map<string, T>();
  const inputIndexById = new Map<string, number>();
  const duplicateNodeIds: string[] = [];

  inputNodes.forEach((node, index) => {
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id || nodesById.has(id)) {
      if (id && !duplicateNodeIds.includes(id)) duplicateNodeIds.push(id);
      return;
    }
    nodesById.set(id, node);
    inputIndexById.set(id, index);
  });

  const compareNodeIds = (leftId: string, rightId: string): number => {
    const left = nodesById.get(leftId);
    const right = nodesById.get(rightId);
    const leftOrder =
      typeof left?.order === 'number' && Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder =
      typeof right?.order === 'number' && Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;
    return (
      leftOrder - rightOrder ||
      (inputIndexById.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
        (inputIndexById.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(leftId, rightId)
    );
  };

  const parentsById = new Map<string, string[]>();
  const childrenById = new Map<string, string[]>();
  const missingParents: ResearchProgressGraphIssue[] = [];
  nodesById.forEach((node, id) => {
    const validParents: string[] = [];
    getResearchProgressParentIds(node).forEach((parentId) => {
      if (!nodesById.has(parentId)) {
        missingParents.push({ nodeId: id, parentId });
        return;
      }
      validParents.push(parentId);
      const children = childrenById.get(parentId) ?? [];
      children.push(id);
      childrenById.set(parentId, children);
    });
    parentsById.set(id, validParents);
  });
  childrenById.forEach((children) => children.sort(compareNodeIds));

  const indegreeById = new Map<string, number>();
  const depthById = new Map<string, number>();
  nodesById.forEach((_node, id) => indegreeById.set(id, parentsById.get(id)?.length ?? 0));

  const queue = Array.from(nodesById.keys())
    .filter((id) => indegreeById.get(id) === 0)
    .toSorted(compareNodeIds);
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const id = queue[queueIndex++];
    const parents = parentsById.get(id) ?? [];
    depthById.set(
      id,
      parents.length === 0 ? 0 : Math.max(...parents.map((parentId) => depthById.get(parentId) ?? 0)) + 1
    );

    (childrenById.get(id) ?? []).forEach((childId) => {
      const nextIndegree = (indegreeById.get(childId) ?? 1) - 1;
      indegreeById.set(childId, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(childId);
        queue.splice(queueIndex, queue.length - queueIndex, ...queue.slice(queueIndex).toSorted(compareNodeIds));
      }
    });
  }

  // Cycles and nodes downstream from cycles cannot be assigned a DAG depth.
  // Treating them as independent roots keeps the preview usable and exposes
  // the malformed IDs to the caller for diagnostics.
  const unresolvedNodeIds = Array.from(nodesById.keys())
    .filter((id) => !depthById.has(id))
    .toSorted(compareNodeIds);
  unresolvedNodeIds.forEach((id) => depthById.set(id, 0));

  const nodesByDepth = new Map<number, string[]>();
  depthById.forEach((depth, id) => {
    const column = nodesByDepth.get(depth) ?? [];
    column.push(id);
    nodesByDepth.set(depth, column);
  });

  const rowById = new Map<string, number>();
  const depths = Array.from(nodesByDepth.keys()).toSorted((left, right) => left - right);
  depths.forEach((depth) => {
    const column = nodesByDepth.get(depth) ?? [];
    column.sort((leftId, rightId) => {
      const parentRowAverage = (id: string): number => {
        const rows = (parentsById.get(id) ?? [])
          .map((parentId) => rowById.get(parentId))
          .filter((row): row is number => typeof row === 'number');
        return rows.length > 0 ? rows.reduce((sum, row) => sum + row, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      return parentRowAverage(leftId) - parentRowAverage(rightId) || compareNodeIds(leftId, rightId);
    });
    column.forEach((id, row) => rowById.set(id, row));
  });

  const maxDepth = Math.max(0, ...depths);
  const maxRows = Math.max(1, ...Array.from(nodesByDepth.values(), (column) => column.length));
  const contentHeight = maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap;
  const positionedNodes: PositionedResearchProgressNode<T>[] = [];

  depths.forEach((depth) => {
    const column = nodesByDepth.get(depth) ?? [];
    const columnHeight = column.length * nodeHeight + Math.max(0, column.length - 1) * rowGap;
    const columnOffsetY = (contentHeight - columnHeight) / 2;
    column.forEach((id, row) => {
      const node = nodesById.get(id);
      if (!node) return;
      positionedNodes.push({
        node,
        id,
        parentIds: parentsById.get(id) ?? [],
        depth,
        row,
        x: paddingX + depth * (nodeWidth + columnGap),
        y: paddingY + columnOffsetY + row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
      });
    });
  });

  const edges: ResearchProgressGraphEdge[] = [];
  positionedNodes.forEach(({ id, depth, parentIds }) => {
    parentIds.forEach((parentId, parentIndex) => {
      const parentDepth = depthById.get(parentId);
      if (typeof parentDepth !== 'number' || parentDepth >= depth) return;
      edges.push({
        id: `${parentId}->${id}:${parentIndex}`,
        sourceId: parentId,
        targetId: id,
        parentIndex,
      });
    });
  });

  return {
    nodes: positionedNodes,
    edges,
    rootIds: positionedNodes.filter((node) => node.depth === 0).map((node) => node.id),
    width: paddingX * 2 + nodeWidth + maxDepth * (nodeWidth + columnGap),
    height: paddingY * 2 + contentHeight,
    issues: { duplicateNodeIds, missingParents, unresolvedNodeIds },
  };
};

export interface ResearchCommitBoundaryOptions {
  previousCommit?: ProjectGitCommitSummary;
  boundaryShas?: ReadonlySet<string>;
}

export const getResearchCommitStrategy = (commit: ProjectGitCommitSummary): ResearchStrategy | undefined =>
  commit.researchStrategy ??
  commit.checkpoint?.researchStrategy ??
  parseResearchCommitSubject(commit.subject).researchStrategy;

/** Returns true when a commit should remain visible as a meaningful research milestone. */
export const isResearchCommitSemanticBoundary = (
  commit: ProjectGitCommitSummary,
  options: ResearchCommitBoundaryOptions = {}
): boolean => {
  const previousStage = options.previousCommit?.checkpoint?.stage?.trim().toLowerCase();
  const currentStage = commit.checkpoint?.stage?.trim().toLowerCase();
  return Boolean(
    getResearchCommitStrategy(commit) ||
    commit.parents.length > 1 ||
    commit.refs.length > 0 ||
    options.boundaryShas?.has(commit.sha) ||
    commit.checkpoint?.routeNodeId ||
    commit.checkpoint?.researchStage?.stageId ||
    (currentStage && currentStage !== previousStage)
  );
};

export interface CollapsedResearchCommitGroup {
  boundary: ProjectGitCommitSummary;
  /** Oldest-to-newest commits represented by this visible boundary. */
  commits: ProjectGitCommitSummary[];
  collapsedCount: number;
}

export interface CollapseLinearResearchCommitsOptions {
  /** Git log order supplied by the caller. Defaults to the API's newest-first order. */
  order?: 'newest-first' | 'oldest-first';
  /** Visual budget for optional milestones; topology always takes priority. */
  maxBoundaries?: number;
  boundaryShas?: readonly string[];
}

export interface CollapsedResearchCommitHistory {
  /** Visible groups in oldest-to-newest order, ready for a left-to-right layout. */
  groups: CollapsedResearchCommitGroup[];
  selectedBoundaryShas: string[];
  collapsedCount: number;
  totalCommitCount: number;
}

/**
 * Collapses ordinary commits into the next semantic milestone on the same Git
 * ancestry chain. Structural branch and merge points always remain visible, so
 * an interleaved `git log --all` result can never fold one branch into another.
 */
export const collapseLinearResearchCommits = (
  commits: readonly ProjectGitCommitSummary[],
  options: CollapseLinearResearchCommitsOptions = {}
): CollapsedResearchCommitHistory => {
  const uniqueCommits: ProjectGitCommitSummary[] = [];
  const seenShas = new Set<string>();
  commits.forEach((commit) => {
    const sha = typeof commit?.sha === 'string' ? commit.sha.trim() : '';
    if (!sha || seenShas.has(sha)) return;
    seenShas.add(sha);
    uniqueCommits.push(commit);
  });

  const chronological = options.order === 'oldest-first' ? [...uniqueCommits] : uniqueCommits.toReversed();
  if (chronological.length === 0) {
    return { groups: [], selectedBoundaryShas: [], collapsedCount: 0, totalCommitCount: 0 };
  }

  const commitBySha = new Map(chronological.map((commit) => [commit.sha, commit]));
  const chronologicalIndex = new Map(chronological.map((commit, index) => [commit.sha, index]));
  const presentParentsBySha = new Map(
    chronological.map((commit) => [commit.sha, commit.parents.filter((parentSha) => commitBySha.has(parentSha))])
  );
  const childrenBySha = new Map(chronological.map((commit) => [commit.sha, [] as string[]]));
  chronological.forEach((commit) => {
    presentParentsBySha.get(commit.sha)?.forEach((parentSha) => childrenBySha.get(parentSha)?.push(commit.sha));
  });

  const requestedMaximum = Math.floor(finiteDimension(options.maxBoundaries, 12, 1));
  const maxBoundaries = chronological.length > 1 ? Math.max(2, requestedMaximum) : 1;
  const explicitBoundaries = new Set(options.boundaryShas ?? []);
  const structuralIndexes = new Set<number>();
  const candidateIndexes = new Set<number>();
  chronological.forEach((commit, index) => {
    const parentCount = presentParentsBySha.get(commit.sha)?.length ?? 0;
    const childCount = childrenBySha.get(commit.sha)?.length ?? 0;
    if (parentCount !== 1 || childCount !== 1) structuralIndexes.add(index);
    // Keep each incoming branch visible instead of absorbing both chains into
    // their common merge. Only single-parent ancestry may share a group.
    if (parentCount > 1) {
      presentParentsBySha.get(commit.sha)?.forEach((parent) => {
        structuralIndexes.add(chronologicalIndex.get(parent)!);
      });
    }
    if (
      isResearchCommitSemanticBoundary(commit, {
        previousCommit: commitBySha.get(commit.parents[0]),
        boundaryShas: explicitBoundaries,
      })
    ) {
      candidateIndexes.add(index);
    }
  });

  // Git topology is authoritative: roots, leaves, forks and merges are never
  // sacrificed to meet the visual budget. The budget only limits optional
  // semantic milestones on otherwise linear ancestry chains.
  const selectedIndexes = new Set<number>(structuralIndexes);
  const prioritizedIndexes = [
    ...chronological
      .map((commit, index) => ({ commit, index }))
      .filter(({ commit }) => explicitBoundaries.has(commit.sha))
      .map(({ index }) => index)
      .toSorted((left, right) => right - left),
    ...Array.from(candidateIndexes).toSorted((left, right) => right - left),
  ];
  prioritizedIndexes.forEach((index) => {
    if (selectedIndexes.size < maxBoundaries) selectedIndexes.add(index);
  });

  const selectedShas = new Set(Array.from(selectedIndexes, (index) => chronological[index].sha));
  const representedByBoundary = new Map<string, string>();
  chronological.forEach((commit) => {
    if (selectedShas.has(commit.sha)) {
      representedByBoundary.set(commit.sha, commit.sha);
      return;
    }
    let cursor = commit.sha;
    const visited = new Set<string>();
    while (!selectedShas.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      const children = childrenBySha.get(cursor) ?? [];
      if (children.length !== 1) break;
      cursor = children[0];
    }
    if (selectedShas.has(cursor)) representedByBoundary.set(commit.sha, cursor);
  });

  // A truncated or disconnected history may not expose enough topology to find
  // a safe descendant boundary. Promote such a commit instead of assigning it
  // to an unrelated branch.
  chronological.forEach((commit) => {
    if (representedByBoundary.has(commit.sha)) return;
    selectedShas.add(commit.sha);
    representedByBoundary.set(commit.sha, commit.sha);
  });

  const groupsByBoundary = new Map<string, ProjectGitCommitSummary[]>();
  chronological.forEach((commit) => {
    const boundarySha = representedByBoundary.get(commit.sha) || commit.sha;
    groupsByBoundary.set(boundarySha, [...(groupsByBoundary.get(boundarySha) || []), commit]);
  });
  const groups = Array.from(selectedShas)
    .map((sha) => commitBySha.get(sha))
    .filter((commit): commit is ProjectGitCommitSummary => Boolean(commit))
    .toSorted((left, right) => (chronologicalIndex.get(left.sha) ?? 0) - (chronologicalIndex.get(right.sha) ?? 0))
    .map((boundary) => {
      const represented = groupsByBoundary.get(boundary.sha) || [boundary];
      return {
        boundary,
        commits: represented,
        collapsedCount: Math.max(0, represented.length - 1),
      };
    });

  return {
    groups,
    selectedBoundaryShas: groups.map((group) => group.boundary.sha),
    collapsedCount: Math.max(0, chronological.length - groups.length),
    totalCommitCount: chronological.length,
  };
};
