// Minimal transport types used by the adapted upstream graph and stage modules.
import type {ResearchStrategy, ProjectGitDirectionDecision} from './researchStrategy';
export type ProjectGitResearchStageDisposition = 'supported' | 'refuted' | 'exhausted' | 'inconclusive' | 'runtime_failed';
export interface ProjectGitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  bodyPreview: string;
  parents: string[];
  refs: string[];
  authoredAt: string;
  authorName: string;
  researchStrategy?: ResearchStrategy;
  checkpoint?: {
    stage?: string;
    researchStrategy?: ResearchStrategy;
    routeNodeId?: string;
    verification?: string[];
    directionDecision?: ProjectGitDirectionDecision;
    researchStage?: {stageId?: string; disposition?: ProjectGitResearchStageDisposition};
  };
}
