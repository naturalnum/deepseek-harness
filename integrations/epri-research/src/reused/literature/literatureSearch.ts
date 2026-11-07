/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

export const LITERATURE_SEARCH_PROVIDER = 'paper_search' as const;

export const DEFAULT_LITERATURE_SEARCH_SOURCES = [
  'semantic_scholar',
  'openalex',
  'arxiv',
  'openreview',
  'crossref',
  'dblp',
] as const;

export type LiteratureSearchSource = (typeof DEFAULT_LITERATURE_SEARCH_SOURCES)[number];

export interface LiteratureSearchCredentials {
  semanticScholarApiKey?: string;
  openAlexApiKey?: string;
  openAlexEmail?: string;
  crossrefEmail?: string;
  crossrefApiToken?: string;
}

export interface LiteratureSearchOptions extends LiteratureSearchCredentials {
  query: string;
  maxResults: number;
  sources?: string[];
  startYear?: number;
  endYear?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LiteraturePaper {
  title: string;
  authors: string[];
  year?: number;
  publishedAt?: string;
  venue?: string;
  abstract?: string;
  url?: string;
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  semanticScholarId?: string;
  openReviewId?: string;
  dblpKey?: string;
  citationCount?: number;
  source: LiteratureSearchSource;
  sourceRank: number;
}

export interface LiteratureSearchSourceResult {
  provider: typeof LITERATURE_SEARCH_PROVIDER;
  source: LiteratureSearchSource;
  found: number;
  papers: LiteraturePaper[];
  rawPreview?: string;
  warning?: string;
  error?: string;
}

export interface LiteratureSearchResult {
  provider: typeof LITERATURE_SEARCH_PROVIDER;
  query: string;
  sources: LiteratureSearchSourceResult[];
  papers: LiteraturePaper[];
  warnings: string[];
}

const SOURCE_ALIAS: Record<string, LiteratureSearchSource | 'all'> = {
  literature: 'all',
  literature_search: 'all',
  multi_source_literature: 'all',
  paper: 'all',
  papers: 'all',
  paper_search: 'all',
  scholar: 'all',
  semantic: 'semantic_scholar',
  semanticscholar: 'semantic_scholar',
  semantic_scholar: 'semantic_scholar',
  s2: 'semantic_scholar',
  open_alex: 'openalex',
  openalex: 'openalex',
  arxiv: 'arxiv',
  open_review: 'openreview',
  openreview: 'openreview',
  crossref: 'crossref',
  dblp: 'dblp',
};

const SOURCE_LABEL: Record<LiteratureSearchSource, string> = {
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  openreview: 'OpenReview',
  crossref: 'Crossref',
  dblp: 'DBLP',
};

const PUBLIC_USER_AGENT = 'DeepScientist/0.1 (mailto:resear.ai@gmail.com)';

const nonEmpty = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const numberOrUndefined = (value: unknown): number | undefined => {
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
};

const ensureArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const textValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstString(record.value, record.text);
  }
  return undefined;
};

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        return firstString(record.name, record.display_name, record.fullname, record.value) || '';
      }
      return '';
    })
    .filter(Boolean);
};

const decodeHtml = (value: string): string =>
  value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();

const stripTags = (value?: string): string | undefined => {
  if (!value) return undefined;
  return decodeHtml(value.replace(/<[^>]+>/gu, ' '));
};

const normalizeDoi = (value?: string): string | undefined =>
  nonEmpty(value)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .toLowerCase();

const normalizeArxivId = (value?: string): string | undefined => {
  const id = nonEmpty(value)?.replace(/^arxiv:/iu, '').replace(/^https?:\/\/arxiv\.org\/abs\//iu, '');
  return id || undefined;
};

const yearFromDate = (value?: string): number | undefined => {
  const match = value?.match(/\b(19|20)\d{2}\b/u);
  return match ? Number(match[0]) : undefined;
};

const sourceFromAlias = (source: string): LiteratureSearchSource | 'all' | undefined =>
  SOURCE_ALIAS[source.trim().toLowerCase().replace(/[-\s]+/gu, '_')];

export const isLiteratureSearchSource = (source?: string): boolean => {
  if (!source) return false;
  return Boolean(sourceFromAlias(source));
};

export const normalizeLiteratureSearchSources = (sources?: string[]): LiteratureSearchSource[] => {
  const resolved = (sources || [])
    .map((source) => sourceFromAlias(source))
    .filter(Boolean) as Array<LiteratureSearchSource | 'all'>;
  if (!resolved.length || resolved.includes('all')) return [...DEFAULT_LITERATURE_SEARCH_SOURCES];
  return [...new Set(resolved.filter((source): source is LiteratureSearchSource => source !== 'all'))];
};

const buildDedupeKey = (paper: LiteraturePaper): string => {
  const doi = normalizeDoi(paper.doi);
  if (doi) return `doi:${doi}`;
  const arxivId = normalizeArxivId(paper.arxivId);
  if (arxivId) return `arxiv:${arxivId.toLowerCase()}`;
  if (paper.semanticScholarId) return `s2:${paper.semanticScholarId}`;
  if (paper.openAlexId) return `openalex:${paper.openAlexId}`;
  const title = paper.title.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  return `title:${title.slice(0, 120)}:${paper.year || ''}`;
};

export const dedupeLiteraturePapers = (papers: LiteraturePaper[]): LiteraturePaper[] => {
  const byKey = new Map<string, LiteraturePaper>();
  for (const paper of papers) {
    const key = buildDedupeKey(paper);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, paper);
      continue;
    }
    const currentScore = (current.citationCount || 0) + (current.abstract ? 3 : 0);
    const nextScore = (paper.citationCount || 0) + (paper.abstract ? 3 : 0);
    if (nextScore > currentScore) {
      byKey.set(key, {
        ...paper,
        sourceRank: Math.min(current.sourceRank, paper.sourceRank),
      });
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const citationDelta = (right.citationCount || 0) - (left.citationCount || 0);
    if (citationDelta !== 0) return citationDelta;
    return left.sourceRank - right.sourceRank;
  });
};

const withTimeout = async (url: URL, timeoutMs: number, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response> => {
    return await fetch(url, {
      headers: {
        'User-Agent': PUBLIC_USER_AGENT,
        ...headers,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
};

const fetchJson = async <T>(url: URL, timeoutMs: number, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> => {
  const response = await withTimeout(url, timeoutMs, headers, signal);
  if (!response.ok) {
    if (response.status === 429) throw new Error('在线文献源请求限流（HTTP 429），请稍后重试或切换其他来源。');
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  if (response.headers.get('content-type')?.includes('text/html')) throw new Error('在线文献源返回了网页或人机验证，自动检索暂不可用；请切换其他来源。');
  return (await response.json()) as T;
};

const fetchText = async (url: URL, timeoutMs: number, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> => {
  const response = await withTimeout(url, timeoutMs, headers, signal);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  return await response.text();
};

const withinYearRange = (paper: LiteraturePaper, startYear?: number, endYear?: number): boolean => {
  if (!startYear && !endYear) return true;
  if (!paper.year) return true;
  if (startYear && paper.year < startYear) return false;
  if (endYear && paper.year > endYear) return false;
  return true;
};

const searchSemanticScholar = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', options.query);
  url.searchParams.set('limit', String(options.maxResults));
  url.searchParams.set(
    'fields',
    'title,abstract,authors,year,venue,publicationDate,citationCount,url,externalIds,openAccessPdf'
  );
  if (options.startYear || options.endYear) {
    const start = options.startYear || options.endYear;
    const end = options.endYear || options.startYear;
    url.searchParams.set('year', start === end ? String(start) : `${start}-${end}`);
  }
  const headers = options.semanticScholarApiKey ? { 'x-api-key': options.semanticScholarApiKey } : undefined;
  const payload = await fetchJson<{ data?: Array<Record<string, unknown>> }>(url, options.timeoutMs || 30000, headers, options.signal);
  return (payload.data || []).map((item, index) => {
    const external = (item.externalIds || {}) as Record<string, unknown>;
    const authors = Array.isArray(item.authors)
      ? (item.authors as Array<Record<string, unknown>>).map((author) => firstString(author.name) || '').filter(Boolean)
      : [];
    return {
      title: firstString(item.title) || 'Untitled',
      authors,
      year: numberOrUndefined(item.year) || yearFromDate(firstString(item.publicationDate)),
      publishedAt: firstString(item.publicationDate),
      venue: firstString(item.venue),
      abstract: firstString(item.abstract),
      url: firstString(item.url),
      doi: normalizeDoi(firstString(external.DOI, external.doi)),
      arxivId: normalizeArxivId(firstString(external.ArXiv, external.arXiv)),
      semanticScholarId: firstString(item.paperId, item.corpusId),
      citationCount: numberOrUndefined(item.citationCount),
      source: 'semantic_scholar',
      sourceRank: index + 1,
    };
  });
};

const searchOpenAlex = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', options.query);
  url.searchParams.set('per-page', String(options.maxResults));
  const filters = [];
  if (options.startYear) filters.push(`from_publication_date:${options.startYear}-01-01`);
  if (options.endYear) filters.push(`to_publication_date:${options.endYear}-12-31`);
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  if (options.openAlexEmail) url.searchParams.set('mailto', options.openAlexEmail);
  if (options.openAlexApiKey) url.searchParams.set('api_key', options.openAlexApiKey);
  const payload = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url, options.timeoutMs || 30000, undefined, options.signal);
  return (payload.results || []).map((item, index) => {
    const ids = (item.ids || {}) as Record<string, unknown>;
    const primaryLocation = (item.primary_location || {}) as Record<string, unknown>;
    const source = (primaryLocation.source || {}) as Record<string, unknown>;
    return {
      title: firstString(item.title, item.display_name) || 'Untitled',
      authors: Array.isArray(item.authorships)
        ? (item.authorships as Array<Record<string, unknown>>)
            .map((authorship) => {
              const author = (authorship.author || {}) as Record<string, unknown>;
              return firstString(author.display_name);
            })
            .filter((name): name is string => Boolean(name))
        : [],
      year: numberOrUndefined(item.publication_year) || yearFromDate(firstString(item.publication_date)),
      publishedAt: firstString(item.publication_date),
      venue: firstString(source.display_name),
      abstract: openAlexAbstract((item.abstract_inverted_index || undefined) as Record<string, number[]> | undefined),
      url: firstString(ids.openalex, ids.doi, item.doi),
      doi: normalizeDoi(firstString(ids.doi, item.doi)),
      openAlexId: firstString(ids.openalex, item.id),
      citationCount: numberOrUndefined(item.cited_by_count),
      source: 'openalex',
      sourceRank: index + 1,
    };
  });
};

const openAlexAbstract = (index?: Record<string, number[]>): string | undefined => {
  if (!index) return undefined;
  const words: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push({ word, position });
  }
  return words
    .sort((left, right) => left.position - right.position)
    .map((item) => item.word)
    .join(' ')
    .trim();
};

const searchArxiv = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://export.arxiv.org/api/query');
  const terms = options.query
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
  url.searchParams.set('search_query', terms.length ? terms.map((term) => `all:${term}`).join(' AND ') : `all:${options.query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(options.maxResults));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'descending');
  const xml = await fetchText(url, options.timeoutMs || 30000, undefined, options.signal);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)].map((match) => match[1]);
  return entries
    .map((entry, index): LiteraturePaper => {
      const get = (tag: string) => stripTags(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'u'))?.[1]);
      const id = get('id');
      const arxivId = normalizeArxivId(id?.split('/abs/')[1]);
      const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/gu)]
        .map((match) => decodeHtml(match[1]))
        .filter(Boolean);
      const publishedAt = get('published') || get('updated');
      return {
        title: get('title') || 'Untitled',
        authors,
        year: yearFromDate(publishedAt),
        publishedAt,
        venue: 'arXiv',
        abstract: get('summary'),
        url: id,
        arxivId,
        source: 'arxiv',
        sourceRank: index + 1,
      };
    })
    .filter((paper) => withinYearRange(paper, options.startYear, options.endYear));
};

const searchCrossref = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic', options.query);
  url.searchParams.set('rows', String(options.maxResults));
  const filters = [];
  if (options.startYear) filters.push(`from-pub-date:${options.startYear}-01-01`);
  if (options.endYear) filters.push(`until-pub-date:${options.endYear}-12-31`);
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  if (options.crossrefEmail) url.searchParams.set('mailto', options.crossrefEmail);
  const headers = {
    ...(options.crossrefEmail
      ? { 'User-Agent': `DeepScientist/0.1 (mailto:${options.crossrefEmail})` }
      : { 'User-Agent': PUBLIC_USER_AGENT }),
    ...(options.crossrefApiToken ? { 'Crossref-Plus-API-Token': options.crossrefApiToken } : {}),
  };
  const payload = await fetchJson<{ message?: { items?: Array<Record<string, unknown>> } }>(
    url,
    options.timeoutMs || 30000,
    headers,
    options.signal
  );
  return (payload.message?.items || []).map((item, index) => {
    const dateParts = ((item.published || item['published-print'] || item['published-online'] || {}) as Record<string, unknown>)[
      'date-parts'
    ] as number[][] | undefined;
    const parts = dateParts?.[0] || [];
    const publishedAt = parts.length ? parts.filter(Boolean).join('-') : undefined;
    return {
      title: firstString(...ensureArray(item.title as string | string[] | undefined)) || 'Untitled',
      authors: Array.isArray(item.author)
        ? (item.author as Array<Record<string, unknown>>)
            .map((author) => [firstString(author.given), firstString(author.family)].filter(Boolean).join(' '))
            .filter(Boolean)
        : [],
      year: numberOrUndefined(parts[0]),
      publishedAt,
      venue: firstString(...ensureArray(item['container-title'] as string | string[] | undefined), item.publisher),
      abstract: stripTags(firstString(item.abstract)),
      url: firstString(item.URL, item.resource),
      doi: normalizeDoi(firstString(item.DOI, item.doi)),
      citationCount: numberOrUndefined(item['is-referenced-by-count']),
      source: 'crossref',
      sourceRank: index + 1,
    };
  });
};

const searchDblp = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://dblp.org/search/publ/api');
  url.searchParams.set('q', options.query);
  url.searchParams.set('h', String(options.maxResults));
  url.searchParams.set('format', 'json');
  const payload = await fetchJson<{ result?: { hits?: { hit?: unknown } } }>(url, options.timeoutMs || 30000, undefined, options.signal);
  return ensureArray(payload.result?.hits?.hit)
    .map((hit, index): LiteraturePaper => {
      const info = ((hit as Record<string, unknown>).info || {}) as Record<string, unknown>;
      const authorsField = (info.authors as Record<string, unknown> | undefined)?.author;
      const authors = stringArray(ensureArray(authorsField));
      return {
        title: firstString(info.title) || 'Untitled',
        authors,
        year: numberOrUndefined(info.year),
        venue: firstString(info.venue),
        url: firstString(info.url, info.ee),
        doi: normalizeDoi(firstString(info.doi)),
        dblpKey: firstString(info.key),
        source: 'dblp',
        sourceRank: index + 1,
      };
    })
    .filter((paper) => withinYearRange(paper, options.startYear, options.endYear));
};

const searchOpenReview = async (options: LiteratureSearchOptions): Promise<LiteraturePaper[]> => {
  const url = new URL('https://api2.openreview.net/notes/search');
  url.searchParams.set('term', options.query);
  url.searchParams.set('limit', String(options.maxResults));
  const payload = await fetchJson<{ notes?: Array<Record<string, unknown>> }>(url, options.timeoutMs || 30000, undefined, options.signal);
  return (payload.notes || [])
    .map((note, index): LiteraturePaper => {
      const content = (note.content || {}) as Record<string, unknown>;
      const forumContent = (note.forumContent || {}) as Record<string, unknown>;
      const title =
        textValue(content.title) ||
        textValue(content['paper title']) ||
        textValue(forumContent.title) ||
        textValue(forumContent['paper title']) ||
        'Untitled';
      const abstract = textValue(content.abstract) || textValue(forumContent.abstract) || textValue(content.summary);
      const authors = stringArray(
        (content.authors as Record<string, unknown> | undefined)?.value ||
          content.authors ||
          (forumContent.authors as Record<string, unknown> | undefined)?.value ||
          forumContent.authors
      );
      const tcdate = numberOrUndefined(note.tcdate);
      const pdate = numberOrUndefined(note.pdate);
      const cdate = numberOrUndefined(note.cdate);
      const year =
        yearFromDate(textValue(content.year)) ||
        yearFromDate(textValue(forumContent.year)) ||
        (pdate ? new Date(pdate).getUTCFullYear() : undefined) ||
        (tcdate ? new Date(tcdate).getUTCFullYear() : undefined) ||
        (cdate ? new Date(cdate).getUTCFullYear() : undefined);
      const forumId = firstString(note.forum);
      const id = forumId || firstString(note.id);
      return {
        title,
        authors,
        year,
        venue: textValue(forumContent.venue) || firstString(note.domain, note.invitation),
        abstract,
        url: id ? `https://openreview.net/forum?id=${id}` : undefined,
        openReviewId: id,
        source: 'openreview',
        sourceRank: index + 1,
      };
    })
    .filter((paper) => withinYearRange(paper, options.startYear, options.endYear));
};

const searchOneSource = async (
  source: LiteratureSearchSource,
  options: LiteratureSearchOptions
): Promise<LiteratureSearchSourceResult> => {
  try {
    const papers =
      source === 'semantic_scholar'
        ? await searchSemanticScholar(options)
        : source === 'openalex'
          ? await searchOpenAlex(options)
          : source === 'arxiv'
            ? await searchArxiv(options)
            : source === 'openreview'
              ? await searchOpenReview(options)
              : source === 'crossref'
                ? await searchCrossref(options)
                : await searchDblp(options);
    return {
      provider: LITERATURE_SEARCH_PROVIDER,
      source,
      found: papers.length,
      papers,
      rawPreview: papers
        .slice(0, 5)
        .map((paper, index) => `[${index + 1}] ${paper.title}${paper.year ? ` (${paper.year})` : ''}`)
        .join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const apiKeyHint =
      source === 'semantic_scholar' && !options.semanticScholarApiKey
        ? ' Add a Semantic Scholar API key for higher public rate limits.'
        : '';
    return {
      provider: LITERATURE_SEARCH_PROVIDER,
      source,
      found: 0,
      papers: [],
      error: `${SOURCE_LABEL[source]} search failed: ${message}${apiKeyHint}`,
    };
  }
};

export async function searchLiterature(options: LiteratureSearchOptions): Promise<LiteratureSearchResult> {
  const sources = normalizeLiteratureSearchSources(options.sources);
  const sourceResults = await Promise.all(sources.map((source) => searchOneSource(source, options)));
  const warnings = sourceResults.flatMap((result) => [result.warning, result.error].filter(Boolean) as string[]);
  const papers = dedupeLiteraturePapers(sourceResults.flatMap((result) => result.papers));
  return {
    provider: LITERATURE_SEARCH_PROVIDER,
    query: options.query,
    sources: sourceResults,
    papers,
    warnings,
  };
}
