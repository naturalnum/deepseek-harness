/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import DeepScientistIcon from '../../ui/adapters/Icon';
import { Button, Spin, Tooltip } from '@arco-design/web-react';
import { PreviewOpen } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useLocalFilePreview } from '../../ui/adapters/openDocument';
import MarkdownPreview from '../../ui/adapters/MarkdownPreview';
import type { ProtocolDocument } from '../../ui/adapters/useProtocolDocuments';
import styles from './AimdProtocolWorkspace.module.css';

export type ProtocolDocumentBrowserLabels = {
  title: string;
  description: string;
  current: string;
  aimd: string;
  markdown: string;
  record: string;
  preview: string;
  open: string;
  empty: string;
};

const kindLabel = (document: ProtocolDocument, labels: ProtocolDocumentBrowserLabels): string =>
  document.kind === 'aimd' ? labels.aimd : document.kind === 'record' ? labels.record : labels.markdown;

const aimdOutline = (content: string): string[] =>
  content
    .split(/\r?\n/gu)
    .map((line) => line.match(/^#{2,3}\s+(.+)$/u)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, 5);

const ProtocolDocumentBrowser: React.FC<{
  documents: ProtocolDocument[];
  loading: boolean;
  workspace?: string;
  labels: ProtocolDocumentBrowserLabels;
}> = ({ documents, loading, workspace, labels }) => {
  const openLocalFilePreview = useLocalFilePreview(workspace);
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    if (!documents.length) {
      setSelectedId(undefined);
      return;
    }
    setSelectedId((current) => (documents.some((document) => document.id === current) ? current : documents[0].id));
  }, [documents]);

  const selected = documents.find((document) => document.id === selectedId) || documents[0];
  const outline = useMemo(() => (selected?.kind === 'aimd' ? aimdOutline(selected.content) : []), [selected]);

  return (
    <section className={styles.documentBrowser} aria-label={labels.title}>
      <header className={styles.documentBrowserHeader}>
        <div>
          <span>{labels.title}</span>
          <p>{labels.description}</p>
        </div>
        <b>{documents.length}</b>
      </header>
      {loading && !documents.length ? (
        <div className={styles.documentBrowserLoading}>
          <Spin size={18} />
        </div>
      ) : documents.length ? (
        <div className={styles.documentBrowserLayout}>
          <div className={styles.documentList}>
            {documents.map((document) => (
              <Tooltip key={document.id} content={document.relativePath} position='right'>
                <Button
                  type='text'
                  long
                  className={styles.documentRow}
                  data-selected={document.id === selected?.id}
                  onClick={() => setSelectedId(document.id)}
                >
                  <DeepScientistIcon name='artifactManuscript' size={15} />
                  <span>
                    <strong>{document.title}</strong>
                    <small>{document.name}</small>
                  </span>
                  <em>{document.current ? labels.current : kindLabel(document, labels)}</em>
                </Button>
              </Tooltip>
            ))}
          </div>
          {selected ? (
            <article className={styles.documentPreview} aria-label={labels.preview}>
              <header>
                <div>
                  <span>{kindLabel(selected, labels)}</span>
                  <h3>{selected.title}</h3>
                </div>
                <Tooltip content={labels.open}>
                  <Button
                    size='mini'
                    type='text'
                    icon={<PreviewOpen />}
                    aria-label={labels.open}
                    onClick={() =>
                      void openLocalFilePreview(selected.path, undefined, { title: selected.title, content:selected.content }, { replace: false })
                    }
                  />
                </Tooltip>
              </header>
              {selected.summary ? <p className={styles.documentSummary}>{selected.summary}</p> : null}
              {selected.kind === 'aimd' && outline.length ? (
                <ol className={styles.documentOutline}>
                  {outline.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ol>
              ) : selected.kind === 'markdown' ? (
                <div className={styles.documentMarkdownPreview}>
                  <MarkdownPreview
                    content={selected.content.slice(0, 2400)}
                    file_path={selected.path}
                    workspace={workspace}
                  />
                </div>
              ) : (
                <pre>{selected.content.slice(0, 900)}</pre>
              )}
              <footer>
                <span>{selected.relativePath}</span>
                <Button
                  size='small'
                  icon={<PreviewOpen />}
                  onClick={() =>
                    void openLocalFilePreview(selected.path, undefined, { title: selected.title, content:selected.content }, { replace: false })
                  }
                >
                  {labels.open}
                </Button>
              </footer>
            </article>
          ) : null}
        </div>
      ) : (
        <p className={styles.documentBrowserEmpty}>{labels.empty}</p>
      )}
    </section>
  );
};

export default ProtocolDocumentBrowser;
