/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IWorkspaceFlatFile } from '@/common/adapter/ipcBridge';
import { useEffect, useMemo, useState } from 'react';
import { parseAimdProtocol } from './aimdProtocolModel';

export type ProtocolDocumentKind = 'aimd' | 'markdown' | 'record';

export type ProtocolDocument = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  kind: ProtocolDocumentKind;
  title: string;
  summary?: string;
  content: string;
  current: boolean;
};

const normalizePath = (value: string): string => value.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');

const documentKind = (name: string): ProtocolDocumentKind | undefined => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.aimd')) return 'aimd';
  if (lower.endsWith('.record.json')) return 'record';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return undefined;
};

const isRelevantDocument = (file: IWorkspaceFlatFile): boolean => {
  const kind = documentKind(file.name);
  if (!kind) return false;
  if (kind === 'aimd') return true;
  const relativePath = normalizePath(file.relativePath).toLowerCase();
  if (kind === 'record') return relativePath.includes('protocol-runs/');
  return (
    /(^|\/)(protocol|protocols|reports?|results?|analysis|memory\/methods)(\/|$)/u.test(relativePath) ||
    /(protocol|report|result|summary|conclusion|method)/u.test(file.name.toLowerCase())
  );
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\{\{[^}]+\}\}/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`>#-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const fallbackTitle = (name: string): string =>
  name
    .replace(/\.record\.json$/iu, '')
    .replace(/\.(?:aimd|md|markdown)$/iu, '')
    .replace(/[-_]+/gu, ' ');

const describeDocument = (
  file: Pick<IWorkspaceFlatFile, 'name' | 'fullPath' | 'relativePath'>,
  content: string,
  currentPath?: string
): ProtocolDocument => {
  const kind = documentKind(file.name) || 'markdown';
  const heading = content.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  let title = heading || fallbackTitle(file.name);
  let summary = stripMarkdown(content).slice(0, 320) || undefined;

  if (kind === 'aimd') {
    try {
      const protocol = parseAimdProtocol(content, title);
      title = protocol.title;
      summary = protocol.summary || summary;
    } catch {
      // Keep a readable source-derived fallback for malformed protocol drafts.
    }
  } else if (kind === 'record') {
    try {
      const parsed = JSON.parse(content) as {
        protocol?: { title?: unknown };
        record?: { status?: unknown; completedAt?: unknown };
      };
      if (typeof parsed.protocol?.title === 'string') title = parsed.protocol.title;
      const status = typeof parsed.record?.status === 'string' ? parsed.record.status : undefined;
      const completedAt = typeof parsed.record?.completedAt === 'string' ? parsed.record.completedAt : undefined;
      summary = [status, completedAt].filter(Boolean).join(' · ') || summary;
    } catch {
      // A partially written run record remains visible as a plain document.
    }
  }

  const path = normalizePath(file.fullPath);
  return {
    id: path,
    name: file.name,
    path,
    relativePath: normalizePath(file.relativePath),
    kind,
    title,
    summary,
    content,
    current: Boolean(currentPath && path === normalizePath(currentPath)),
  };
};

const documentPriority = (document: ProtocolDocument): number => {
  if (document.current) return 0;
  if (document.kind === 'aimd') return 1;
  if (document.kind === 'markdown') return 2;
  return 3;
};

export const useProtocolDocuments = (options: {
  workspace?: string;
  filePath?: string;
  content: string;
}): { documents: ProtocolDocument[]; loading: boolean } => {
  const currentDocument = useMemo(() => {
    if (!options.filePath) return undefined;
    const normalized = normalizePath(options.filePath);
    return describeDocument(
      {
        name: normalized.split('/').at(-1) || 'protocol.aimd',
        fullPath: normalized,
        relativePath: options.workspace
          ? normalized.replace(`${normalizePath(options.workspace).replace(/\/$/u, '')}/`, '')
          : normalized,
      },
      options.content,
      options.filePath
    );
  }, [options.content, options.filePath, options.workspace]);
  const [documents, setDocuments] = useState<ProtocolDocument[]>(currentDocument ? [currentDocument] : []);
  const [loading, setLoading] = useState(Boolean(options.workspace));

  useEffect(() => {
    if (!options.workspace || !ipcBridge.fs.listWorkspaceFiles?.invoke) {
      setDocuments(currentDocument ? [currentDocument] : []);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void ipcBridge.fs.listWorkspaceFiles
      .invoke({ root: options.workspace })
      .then(async (files) => {
        const candidates = files.filter(isRelevantDocument).slice(0, 24);
        const loaded = await Promise.allSettled(
          candidates.map(async (file) => {
            const path = normalizePath(file.fullPath);
            if (currentDocument && currentDocument.path === path) return currentDocument;
            const content = await ipcBridge.fs.readFile.invoke({ path, workspace: options.workspace });
            return content == null ? undefined : describeDocument(file, content, options.filePath);
          })
        );
        if (!active) return;
        const next = loaded
          .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
          .concat(currentDocument ? [currentDocument] : []);
        setDocuments(
          Array.from(new Map(next.map((document) => [document.path, document])).values()).toSorted(
            (left, right) => documentPriority(left) - documentPriority(right) || left.title.localeCompare(right.title)
          )
        );
      })
      .catch(() => {
        if (active) setDocuments(currentDocument ? [currentDocument] : []);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentDocument, options.filePath, options.workspace]);

  return { documents, loading };
};
