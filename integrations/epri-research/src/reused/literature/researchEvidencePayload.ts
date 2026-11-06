/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import { LITERATURE_SEARCH_PROVIDER, type LiteraturePaper, type LiteratureSearchResult } from './literatureSearch';

const previewOutput = (output: string, maxLength: number): string => {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...`;
};

const buildLiteratureEvidenceDraft = (paper: LiteraturePaper) => ({
  title: paper.title,
  sourceType: 'paper' as const,
  claimType: 'parsed' as const,
  confidence: 'moderate' as const,
  status: paper.abstract ? ('available' as const) : ('needs_review' as const),
  summary: paper.abstract ? previewOutput(paper.abstract, 360) : undefined,
  url: paper.url,
  database: {
    name: paper.source,
    provider: LITERATURE_SEARCH_PROVIDER,
    domain: 'literature',
    endpoint: paper.source,
    params: {
      doi: paper.doi,
      arxivId: paper.arxivId,
      semanticScholarId: paper.semanticScholarId,
      openAlexId: paper.openAlexId,
      openReviewId: paper.openReviewId,
      dblpKey: paper.dblpKey,
      year: paper.year,
      venue: paper.venue,
      citationCount: paper.citationCount,
    },
    accessDate: new Date().toISOString(),
    retrievedCount: 1,
  },
});

export const buildCompactLiteratureSearchPayload = (literature: LiteratureSearchResult, maxResults: number) => ({
  results: literature.sources.map(({ provider, source, found, error, warning }) => ({
    provider,
    source,
    found,
    error,
    warning,
  })),
  papers: literature.papers.slice(0, maxResults).map((paper) => ({
    ...paper,
    abstract: paper.abstract ? previewOutput(paper.abstract, 800) : undefined,
  })),
  evidenceDrafts: literature.papers.slice(0, maxResults).map(buildLiteratureEvidenceDraft),
  warnings: literature.warnings,
});
