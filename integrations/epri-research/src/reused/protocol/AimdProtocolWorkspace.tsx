/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AimdQuizNode, AimdSubvar, AimdVarNode, AimdVarTableField } from '@airalogy/aimd-core';
import { Button, Checkbox, Input, InputNumber, Message, Radio, Select, Switch, Tooltip } from '@arco-design/web-react';
import { ArrowLeft, CheckOne, CheckSmall, Delete, Download, Info, PlayOne, Plus, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadTextContent } from '../../ui/adapters/download';
import MarkdownPreview from '../../ui/adapters/MarkdownPreview';
import AttachmentField, { AttachmentBusyContext } from '../../ui/adapters/AttachmentField';
import {
  buildAimdFieldOwnership,
  createAimdRecordId,
  isAimdValueComplete,
  parseAimdProtocol,
  type AimdFieldOwnership,
  type AimdInline,
  type AimdProtocolBlock,
  type ParsedAimdProtocol,
} from './aimdProtocolModel';
import ProtocolDocumentBrowser from './ProtocolDocumentBrowser';
import { useProtocolDocuments } from '../../ui/adapters/useProtocolDocuments';
import styles from './AimdProtocolWorkspace.module.css';
import {stripCalculated} from './calculation-state.mjs';

type RunStatus = 'ready' | 'running' | 'completed';

type AuditAction =
  | 'run_created'
  | 'run_started'
  | 'field_updated'
  | 'table_updated'
  | 'step_updated'
  | 'check_updated'
  | 'decision_updated'
  | 'run_completed'
  | 'record_exported';

type AimdAuditEvent = {
  id: string;
  at: string;
  actor: AimdFieldOwnership;
  action: AuditAction;
  target?: string;
  detail?: string;
};

export type AimdRunState = {
  id: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  values: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
  steps: Record<string, boolean>;
  checks: Record<string, boolean>;
  quizzes: Record<string, unknown>;
  fieldOwnership: Record<string, AimdFieldOwnership>;
  events: AimdAuditEvent[];
  calculation?: {runId:string;pending:string[];errors:Array<{field:string;row?:number;message:string}>};
};

export type AimdProtocolRunSeed = {
  id?: string;
  status?: RunStatus;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  values?: Record<string, unknown>;
  tables?: Record<string, Array<Record<string, unknown>>>;
  steps?: Record<string, boolean>;
  checks?: Record<string, boolean>;
  quizzes?: Record<string, unknown>;
  calculation?:AimdRunState['calculation'];
};

export type AimdProtocolWorkspaceProps = {
  content: string;
  filePath?: string;
  workspace?: string;
  revision?: string;
  initialRun?: AimdProtocolRunSeed;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  adapter?: { automatic?: {targets:string[];charts:Array<{id:string;title:string;table:string;label:string;value:string}>}; save: (run: AimdRunState) => Promise<AimdRunState>; submit: (run: AimdRunState) => Promise<AimdRunState>; create: () => Promise<void>; export: () => Promise<void> };
};

type Labels = {
  protocol: string;
  ready: string;
  running: string;
  completed: string;
  start: string;
  newRun: string;
  export: string;
  finish: string;
  saveDraft: string;
  unsavedDraft: string;
  saveFailed: string;
  progress: string;
  steps: string;
  fields: string;
  checks: string;
  duration: string;
  recordId: string;
  version: string;
  source: string;
  notStarted: string;
  completedHint: string;
  savedHint: string;
  protocolError: string;
  openMedia: string;
  automation: string;
  workflow: string;
  sources: string;
  collectors: string;
  calculations: string;
  references: string;
  addRow: string;
  removeRow: string;
  noRows: string;
  details: string;
  back: string;
  outcome: string;
  outcomeReady: string;
  outcomeRunning: string;
  outcomeCompleted: string;
  outcomeReadyDetail: string;
  outcomeRunningDetail: string;
  outcomeCompletedDetail: string;
  remaining: string;
  items: string;
  humanInput: string;
  agentGenerated: string;
  systemRecorded: string;
  awaitingAutomation: string;
  technicalDetails: string;
  operationalSummary: string;
  auditTrail: string;
  noAudit: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  workspace: string;
  fieldOwnership: string;
  workingTree: string;
  exported: string;
  eventRunCreated: string;
  eventRunStarted: string;
  eventFieldUpdated: string;
  eventTableUpdated: string;
  eventStepUpdated: string;
  eventCheckUpdated: string;
  eventDecisionUpdated: string;
  eventRunCompleted: string;
  eventRecordExported: string;
  relatedDocuments: string;
  relatedDocumentsDescription: string;
  runInformation: string;
  runInformationDescription: string;
  elapsed: string;
  currentDocument: string;
  aimdDocument: string;
  markdownDocument: string;
  recordDocument: string;
  documentPreview: string;
  openDocument: string;
  noDocuments: string;
  startWith: string;
  currentStep: string;
  expectedOutput: string;
  decision: string;
};

const LABELS: Record<'zh' | 'en', Labels> = {
  zh: {
    protocol: '研究执行流程',
    ready: '准备就绪',
    running: '正在执行',
    completed: '记录完成',
    start: '开始运行',
    newRun: '再次运行',
    export: '导出结果',
    finish: '完成运行',
    saveDraft: '保存草稿',
    unsavedDraft: '有未保存的修改，请先保存草稿后再请求人工确认。',
    saveFailed: '保存未完成：',
    progress: '完成度',
    steps: '步骤',
    fields: '记录项',
    checks: '检查点',
    duration: '预计用时',
    recordId: '记录编号',
    version: '协议版本',
    source: '源文件',
    notStarted: '开始后会按顺序展示需要填写、执行和核验的内容。',
    completedHint: '本次结论已形成，可导出或再次运行。',
    savedHint: '修改后点击“保存草稿”写入共享数据库；导出读取最后保存的版本。',
    protocolError: '这个研究流程暂时无法读取，请检查流程定义。',
    openMedia: '打开媒体',
    automation: '自动化与来源',
    workflow: '组合流程',
    sources: '数据连接',
    collectors: '采集规则',
    calculations: '自动计算',
    references: '参考资料',
    addRow: '添加一行',
    removeRow: '删除本行',
    noRows: '尚未记录重复测量数据。',
    details: '流程详情',
    back: '返回流程',
    outcome: '运行结果',
    outcomeReady: '尚未形成本次运行结果',
    outcomeRunning: '正在形成本次运行结果',
    outcomeCompleted: '本次运行已完成并封存',
    outcomeReadyDetail: '开始运行后，依次完成必要输入、执行步骤和检查点，最终结论不会被提前生成。',
    outcomeRunningDetail: '当前内容仍是过程记录；只有必要项目全部完成后才能封存结果。',
    outcomeCompletedDetail: '必要输入、步骤与检查点已记录。可在下方查看固定的协议版本，或导出本次结果。',
    remaining: '待完成',
    items: '项',
    humanInput: '人工填写',
    agentGenerated: 'Agent 生成',
    systemRecorded: '系统记录',
    awaitingAutomation: '等待自动写入',
    technicalDetails: '技术信息',
    operationalSummary: '运行概况',
    auditTrail: '操作记录',
    noAudit: '尚无运行操作。',
    createdAt: '创建时间',
    startedAt: '启动时间',
    completedAt: '完成时间',
    workspace: '项目目录',
    fieldOwnership: '字段责任',
    workingTree: '工作区版本',
    exported: '记录已导出',
    eventRunCreated: '创建运行记录',
    eventRunStarted: '开始执行协议',
    eventFieldUpdated: '填写记录项',
    eventTableUpdated: '更新重复测量表',
    eventStepUpdated: '更新执行步骤',
    eventCheckUpdated: '更新检查点',
    eventDecisionUpdated: '更新判断结果',
    eventRunCompleted: '封存运行记录',
    eventRecordExported: '导出正式记录',
    relatedDocuments: '关联协议',
    relatedDocumentsDescription: '查看本次记录固定使用的协议定义。',
    runInformation: '运行信息',
    runInformationDescription: '先确认当前状态与必要输入，再按顺序执行与核验。',
    elapsed: '已运行',
    currentDocument: '当前',
    aimdDocument: '流程定义',
    markdownDocument: 'Markdown 报告',
    recordDocument: '运行记录',
    documentPreview: '内容预览',
    openDocument: '在预览中打开',
    noDocuments: '当前项目尚无其他协议或报告文件。',
    startWith: '从这里开始',
    currentStep: '当前步骤',
    expectedOutput: '本次结论',
    decision: '本次决定',
  },
  en: {
    protocol: 'Research workflow',
    ready: 'Ready',
    running: 'In progress',
    completed: 'Run complete',
    start: 'Start run',
    newRun: 'Run again',
    export: 'Export results',
    finish: 'Complete run',
    saveDraft: 'Save draft',
    unsavedDraft: 'Unsaved changes: save the draft before requesting human review.',
    saveFailed: 'Save did not complete:',
    progress: 'Progress',
    steps: 'Steps',
    fields: 'Fields',
    checks: 'Checks',
    duration: 'Est. time',
    recordId: 'Record ID',
    version: 'Workflow version',
    source: 'Source file',
    notStarted: 'Start the run to reveal the required inputs, execution steps, and checks in order.',
    completedHint: 'The run conclusion is ready to export or repeat.',
    savedHint: 'Save edits to the shared database before leaving. Export reads the last saved version.',
    protocolError: 'This research workflow could not be read. Check the workflow definition.',
    openMedia: 'Open media',
    automation: 'Automation and sources',
    workflow: 'Composed workflow',
    sources: 'Data connectors',
    collectors: 'Collection rules',
    calculations: 'Automatic calculations',
    references: 'References',
    addRow: 'Add row',
    removeRow: 'Remove row',
    noRows: 'No repeated measurements have been recorded.',
    details: 'Workflow details',
    back: 'Back to workflow',
    outcome: 'Run result',
    outcomeReady: 'No result has been produced for this run yet',
    outcomeRunning: 'The result for this run is still being formed',
    outcomeCompleted: 'This run is complete and sealed',
    outcomeReadyDetail:
      'Start the run, then complete its required inputs, execution steps, and checks. A final conclusion is never produced early.',
    outcomeRunningDetail:
      'Complete the remaining required items before sealing; incomplete work is never presented as final.',
    outcomeCompletedDetail:
      'Required inputs, steps, and checks have been recorded. Review the pinned protocol below or export this run result.',
    remaining: 'Remaining',
    items: 'items',
    humanInput: 'Human input',
    agentGenerated: 'Agent generated',
    systemRecorded: 'System recorded',
    awaitingAutomation: 'Waiting for automatic entry',
    technicalDetails: 'Technical information',
    operationalSummary: 'Run summary',
    auditTrail: 'Activity record',
    noAudit: 'No run activity has been recorded yet.',
    createdAt: 'Created',
    startedAt: 'Started',
    completedAt: 'Completed',
    workspace: 'Project workspace',
    fieldOwnership: 'Field ownership',
    workingTree: 'Working tree',
    exported: 'Record exported',
    eventRunCreated: 'Created run record',
    eventRunStarted: 'Started protocol run',
    eventFieldUpdated: 'Updated field',
    eventTableUpdated: 'Updated measurement table',
    eventStepUpdated: 'Updated protocol step',
    eventCheckUpdated: 'Updated checkpoint',
    eventDecisionUpdated: 'Updated decision',
    eventRunCompleted: 'Sealed run record',
    eventRecordExported: 'Exported formal record',
    relatedDocuments: 'Pinned protocol',
    relatedDocumentsDescription: 'Review the exact protocol definition used by this record.',
    runInformation: 'Run information',
    runInformationDescription: 'Confirm the current state and required inputs before following the execution steps.',
    elapsed: 'Elapsed',
    currentDocument: 'Current',
    aimdDocument: 'Workflow definition',
    markdownDocument: 'Markdown report',
    recordDocument: 'Run record',
    documentPreview: 'Content preview',
    openDocument: 'Open in preview',
    noDocuments: 'No additional protocol or report files are available in this project.',
    startWith: 'Start here',
    currentStep: 'Current step',
    expectedOutput: 'Run conclusion',
    decision: 'Run decision',
  },
};

const uniqueVariables = (protocol: ParsedAimdProtocol): AimdVarNode[] =>
  Array.from(new Map(protocol.variables.map((field) => [field.id, field])).values());

const makeAuditEvent = (
  actor: AimdFieldOwnership,
  action: AuditAction,
  target?: string,
  detail?: string,
  at = new Date().toISOString()
): AimdAuditEvent => ({
  id: `${at}-${action}-${target || 'run'}-${Math.random().toString(36).slice(2, 7)}`,
  at,
  actor,
  action,
  target,
  detail,
});

const appendAuditEvent = (
  events: AimdAuditEvent[],
  event: AimdAuditEvent,
  coalesceTarget = false
): AimdAuditEvent[] => {
  const previous = events.at(-1);
  if (
    coalesceTarget &&
    previous?.action === event.action &&
    previous.target === event.target &&
    Date.parse(event.at) - Date.parse(previous.at) < 1_500
  ) {
    return [...events.slice(0, -1), event];
  }
  return [...events, event].slice(-240);
};

const initialRunState = (protocol: ParsedAimdProtocol, filePath?: string, seed?: AimdProtocolRunSeed): AimdRunState => {
  const createdAt = seed?.createdAt || new Date().toISOString();
  const fieldOwnership = buildAimdFieldOwnership(protocol);
  const base: AimdRunState = {
    id: seed?.id || createAimdRecordId(filePath),
    status: seed?.status || 'ready',
    createdAt,
    startedAt: seed?.startedAt,
    completedAt: seed?.completedAt,
    values: Object.fromEntries(
      uniqueVariables(protocol)
        .filter((field) => field.definition?.default !== undefined)
        .map((field) => [field.id, field.definition?.default])
    ),
    tables: Object.fromEntries(
      (protocol.fields.var_table || []).map((table) => [
        table.id,
        Array.isArray(table.default)
          ? table.default.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
          : [],
      ])
    ),
    steps: {},
    checks: {},
    quizzes: Object.fromEntries(
      protocol.quizzes.filter((quiz) => quiz.default !== undefined).map((quiz) => [quiz.id, quiz.default])
    ),
    fieldOwnership,
    events: [makeAuditEvent('system', 'run_created', fileName(filePath), undefined, createdAt)],
  };
  return {
    ...base,
    values: { ...base.values, ...seed?.values },
    tables: { ...base.tables, ...seed?.tables },
    steps: { ...base.steps, ...seed?.steps },
    checks: { ...base.checks, ...seed?.checks },
    quizzes: { ...base.quizzes, ...seed?.quizzes },
    calculation:seed?.calculation,
  };
};

const formatDuration = (milliseconds: number, locale: 'zh' | 'en'): string => {
  if (milliseconds <= 0) return locale === 'zh' ? '未标注' : 'Not specified';
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return locale === 'zh'
    ? `${hours} 小时${remainder ? ` ${remainder} 分` : ''}`
    : `${hours} h${remainder ? ` ${remainder} min` : ''}`;
};

const fieldLabel = (field: AimdVarNode): string =>
  String(field.definition?.kwargs?.title || field.definition?.id || field.id);

const fieldDescription = (field: AimdVarNode): string | undefined => {
  const value = field.definition?.kwargs?.description;
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const fieldExample = (field: AimdVarNode): string | undefined => {
  const examples = field.definition?.kwargs?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return undefined;
  return String(examples[0]);
};

const fieldUnit = (field: AimdVarNode): string | undefined => {
  const value = field.definition?.kwargs?.unit;
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const ownershipLabel = (ownership: AimdFieldOwnership, labels: Labels): string =>
  ownership === 'human' ? labels.humanInput : ownership === 'agent' ? labels.agentGenerated : labels.systemRecorded;

const ProtocolField: React.FC<{
  field: AimdVarNode;
  value: unknown;
  disabled: boolean;
  readOnly: boolean;
  ownership: AimdFieldOwnership;
  labels: Labels;
  recentlyUpdated: boolean;
  onChange: (value: unknown) => void;
}> = ({ field, value, disabled, readOnly, ownership, labels, recentlyUpdated, onChange }) => {
  const type = String(field.definition?.type || 'str').toLowerCase();
  const enumValues = field.definition?.enum || field.definition?.kwargs?.enum;
  const title = fieldLabel(field);
  const description = fieldDescription(field);
  const example = fieldExample(field);
  const unit = fieldUnit(field);
  const automaticallyManaged = ownership !== 'human';

  if (type === 'file') return <span className={styles.inlineField}><span className={styles.inlineFieldLabel}>{title}</span><AttachmentField value={value} label={title} disabled={disabled || readOnly || automaticallyManaged} onChange={onChange} /></span>;

  if (readOnly) {
    return (
      <span
        className={styles.inlineField}
        data-complete={isAimdValueComplete(value)}
        data-owner={ownership}
        data-read-only='true'
      >
        <span className={styles.inlineFieldLabel}>{title}</span>
        <strong className={styles.recordedFieldValue}>
          {isAimdValueComplete(value) ? String(value) : '—'}
          {unit ? <small>{unit}</small> : null}
        </strong>
        {description ? (
          <Tooltip content={description} position='top'>
            <Info className={styles.inlineFieldInfo} size={12} aria-label={description} />
          </Tooltip>
        ) : null}
      </span>
    );
  }

  if (automaticallyManaged) {
    return (
      <span
        className={styles.inlineField}
        data-complete={isAimdValueComplete(value)}
        data-owner={ownership}
        data-updated={recentlyUpdated}
      >
        <span className={styles.inlineFieldLabel}>{title}</span>
        <span className={styles.automaticFieldValue}>
          {isAimdValueComplete(value) ? String(value) : labels.awaitingAutomation}
        </span>
        {description ? (
          <Tooltip content={description} position='top'>
            <Info className={styles.inlineFieldInfo} size={13} aria-label={description} />
          </Tooltip>
        ) : null}
      </span>
    );
  }

  const control = (() => {
    if (Array.isArray(enumValues) && enumValues.length) {
      return (
        <Select
          aria-label={title}
          size='small'
          value={value as string | number | undefined}
          disabled={disabled}
          placeholder={example}
          onChange={onChange}
          options={enumValues.map((item) => ({ label: String(item), value: item as string | number }))}
        />
      );
    }
    if (type.includes('bool')) {
      return (
        <Switch aria-label={title} size='small' checked={Boolean(value)} disabled={disabled} onChange={onChange} />
      );
    }
    if (type.includes('int') || type.includes('float') || type.includes('number')) {
      return (
        <InputNumber
          aria-label={title}
          size='small'
          value={typeof value === 'number' ? value : undefined}
          disabled={disabled}
          placeholder={example}
          suffix={unit}
          onChange={onChange}
        />
      );
    }
    if (type.includes('date')) {
      return (
        <input
          className={styles.nativeInput}
          type={type.includes('time') ? 'datetime-local' : 'date'}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-label={title}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
    return (
      <Input
        aria-label={title}
        size='small'
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        placeholder={example}
        suffix={unit}
        onChange={onChange}
      />
    );
  })();

  return (
    <span
      className={styles.inlineField}
      data-complete={isAimdValueComplete(value)}
      data-owner={ownership}
      data-updated={recentlyUpdated}
    >
      <span className={styles.inlineFieldLabel}>{title}</span>
      {control}
      {description ? (
        <Tooltip content={description} position='top'>
          <Info className={styles.inlineFieldInfo} size={13} aria-label={description} />
        </Tooltip>
      ) : null}
    </span>
  );
};

const ProtocolInlineContent: React.FC<{
  inlines: AimdInline[];
  run: AimdRunState;
  labels: Labels;
  recentlyUpdatedField?: string;
  saving?: boolean;
  onValue: (id: string, value: unknown) => void;
}> = ({ inlines, run, labels, recentlyUpdatedField, saving, onValue }) => {
  const fieldCount = inlines.filter((inline) => inline.kind === 'var').length;
  const fieldOnly =
    fieldCount > 1 &&
    inlines.every(
      (inline) =>
        inline.kind === 'var' ||
        inline.kind === 'break' ||
        (inline.kind === 'text' && /^[\s,.;:，。、；：|/]*$/u.test(inline.value))
    );

  return (
    <div
      className={`${styles.inlineParagraph} ${fieldOnly ? styles.fieldGrid : ''}`}
      role='paragraph'
      data-field-grid={fieldOnly || undefined}
    >
      {inlines.map((inline, index) => {
        const key = `${inline.kind}-${index}`;
        if (inline.kind === 'var') {
          return (
            <ProtocolField
              key={`${inline.field.id}-${index}`}
              field={inline.field}
              value={run.values[inline.field.id]}
              disabled={saving || run.status !== 'running'}
              readOnly={run.status === 'completed'}
              ownership={run.fieldOwnership[inline.field.id] || 'human'}
              labels={labels}
              recentlyUpdated={recentlyUpdatedField === inline.field.id}
              onChange={(value) => onValue(inline.field.id, value)}
            />
          );
        }
        if (fieldOnly && (inline.kind === 'text' || inline.kind === 'break')) return null;
        if (inline.kind === 'strong') return <strong key={key}>{inline.value}</strong>;
        if (inline.kind === 'emphasis') return <em key={key}>{inline.value}</em>;
        if (inline.kind === 'delete') return <del key={key}>{inline.value}</del>;
        if (inline.kind === 'code') return <code key={key}>{inline.value}</code>;
        if (inline.kind === 'link') {
          return (
            <a key={key} href={inline.url} target='_blank' rel='noreferrer'>
              {inline.label}
            </a>
          );
        }
        if (inline.kind === 'break') return <br key={key} />;
        if (inline.kind === 'reference') {
          return (
            <span key={key} className={styles.referenceChip}>
              {inline.target || inline.label}
            </span>
          );
        }
        return <React.Fragment key={key}>{inline.value}</React.Fragment>;
      })}
    </div>
  );
};

const ProtocolQuiz: React.FC<{
  quiz: AimdQuizNode;
  value: unknown;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}> = ({ quiz, value, disabled, readOnly, onChange }) => {
  const title = quiz.title || quiz.stem || quiz.id;
  if (quiz.quizType === 'choice' || quiz.quizType === 'true_false') {
    const options =
      quiz.options ||
      (quiz.quizType === 'true_false'
        ? [
            { key: 'true', text: 'True' },
            { key: 'false', text: 'False' },
          ]
        : []);
    if (readOnly) {
      const selectedKeys = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
      const selectedLabels = options
        .filter((option) => selectedKeys.includes(String(option.key)))
        .map((option) => option.text);
      return (
        <section className={styles.quizBlock} data-complete={isAimdValueComplete(value)} data-read-only='true'>
          <h4>{title}</h4>
          <div className={styles.recordedDecision}>
            <CheckSmall size={13} theme='outline' strokeWidth={2.2} aria-hidden='true' />
            <strong>{selectedLabels.join('，') || '—'}</strong>
          </div>
        </section>
      );
    }
    if (quiz.mode === 'multiple') {
      const current = Array.isArray(value) ? value.map(String) : [];
      return (
        <section className={styles.quizBlock} data-complete={isAimdValueComplete(value)}>
          <h4>{title}</h4>
          <Checkbox.Group
            aria-label={title}
            value={current}
            disabled={disabled}
            options={options.map((option) => ({ label: option.text, value: option.key }))}
            onChange={onChange}
          />
        </section>
      );
    }
    return (
      <section className={styles.quizBlock} data-complete={isAimdValueComplete(value)}>
        <h4>{title}</h4>
        <Radio.Group
          aria-label={title}
          value={value === true ? 'true' : value === false ? 'false' : value}
          disabled={disabled}
          onChange={(next) => onChange(quiz.quizType === 'true_false' ? next === 'true' : next)}
        >
          {options.map((option) => (
            <Radio key={option.key} value={option.key}>
              {option.text}
            </Radio>
          ))}
        </Radio.Group>
      </section>
    );
  }
  if (readOnly) {
    return (
      <section className={styles.quizBlock} data-complete={isAimdValueComplete(value)} data-read-only='true'>
        <h4>{title}</h4>
        <p className={styles.recordedTextDecision}>{typeof value === 'string' && value.trim() ? value : '—'}</p>
      </section>
    );
  }
  return (
    <section className={styles.quizBlock} data-complete={isAimdValueComplete(value)}>
      <h4>{title}</h4>
      <Input.TextArea
        aria-label={title}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        autoSize={{ minRows: 2, maxRows: 6 }}
        onChange={onChange}
      />
    </section>
  );
};

const tableFieldTitle = (field: AimdVarTableField): string => String(field.title || field.kwargs?.title || field.id);

const ProtocolTableCell: React.FC<{
  field: AimdSubvar;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}> = ({ field, value, disabled, onChange }) => {
  const type = String(field.type || 'str').toLowerCase();
  const label = String(field.title || field.id);
  const enumValues = field.enum || field.kwargs?.enum;
  const placeholder = Array.isArray(field.examples) && field.examples.length ? String(field.examples[0]) : undefined;

  if (type === 'file') return <AttachmentField value={value} label={label} disabled={disabled} onChange={onChange} />;

  if (Array.isArray(enumValues) && enumValues.length) {
    return (
      <Select
        aria-label={label}
        size='small'
        value={value as string | number | undefined}
        disabled={disabled}
        placeholder={placeholder}
        options={enumValues.map((item) => ({ label: String(item), value: item as string | number }))}
        onChange={onChange}
      />
    );
  }
  if (type.includes('bool')) {
    return <Switch aria-label={label} size='small' checked={Boolean(value)} disabled={disabled} onChange={onChange} />;
  }
  if (type.includes('int') || type.includes('float') || type.includes('number')) {
    return (
      <InputNumber
        aria-label={label}
        size='small'
        value={typeof value === 'number' ? value : undefined}
        disabled={disabled}
        placeholder={placeholder}
        suffix={typeof field.kwargs?.unit === 'string' ? field.kwargs.unit : undefined}
        onChange={onChange}
      />
    );
  }
  return (
    <Input
      aria-label={label}
      size='small'
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      placeholder={placeholder}
      onChange={onChange}
    />
  );
};

const ProtocolTable: React.FC<{
  field: AimdVarTableField;
  rows: Array<Record<string, unknown>>;
  disabled: boolean;
  ownership: Record<string,AimdFieldOwnership>;
  readOnly: boolean;
  labels: Labels;
  onChange: (rows: Array<Record<string, unknown>>) => void;
  calculatedColumns?:string[];
}> = ({ field, rows, disabled, readOnly, labels, ownership, onChange,calculatedColumns=[] }) => {
  const setCell = (rowIndex: number, columnId: string, value: unknown) => {
    const next = rows.map((row, index) => (index === rowIndex ? { ...row, [columnId]: value } : row));
    onChange(next);
  };
  const addRow = () =>
    onChange([...rows, Object.fromEntries(field.subvars.filter(column=>ownership[field.id+'.'+column.id]==='human').map((column) => [column.id, column.default]))]);
  const removeRow = (rowIndex: number) => onChange(rows.filter((_, index) => index !== rowIndex));

  return (
    <section className={styles.tableBlock} data-testid={`aimd-table-${field.id}`} aria-label={tableFieldTitle(field)}>
      <header>
        <div>
          <h4>{tableFieldTitle(field)}</h4>
          {field.description ? <p>{field.description}</p> : null}
        </div>
        {!readOnly ? (
          <Button size='mini' icon={<Plus />} disabled={disabled || ownership[field.id]!=='human'} onClick={addRow}>
            {labels.addRow}
          </Button>
        ) : null}
      </header>
      {rows.length ? (
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th className={styles.rowIndexCell} aria-label='#'>
                  #
                </th>
                {field.subvars.map((column) => (
                  <th key={column.id} title={column.description}>
                    {column.title || column.id}
                    {typeof column.kwargs?.unit === 'string' ? <small>{column.kwargs.unit}</small> : null}
                  </th>
                ))}
                {!readOnly ? <th className={styles.rowActionsCell} aria-label={labels.removeRow} /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${field.id}-${rowIndex}`}>
                  <td className={styles.rowIndexCell}>{String(rowIndex + 1).padStart(2, '0')}</td>
                  {field.subvars.map((column) => (
                    <td key={column.id} data-complete={isAimdValueComplete(row[column.id])}>
                      {readOnly ? (
                        <span className={styles.recordedTableValue}>
                          {isAimdValueComplete(row[column.id]) ? String(row[column.id]) : '—'}
                        </span>
                      ) : (
                        <ProtocolTableCell
                          field={column}
                          value={row[column.id]}
                          disabled={disabled || ownership[field.id+'.'+column.id]!=='human'}
                          onChange={(value) => setCell(rowIndex, column.id, value)}
                        />
                      )}
                    </td>
                  ))}
                  {!readOnly ? (
                    <td className={styles.rowActionsCell}>
                      <Tooltip content={labels.removeRow}>
                        <Button
                          size='mini'
                          type='text'
                          icon={<Delete />}
                          disabled={disabled || ownership[field.id]!=='human' || field.subvars.some(c=>ownership[field.id+'.'+c.id]!=='human' && !calculatedColumns.includes(field.id+'.'+c.id) && rows.slice(rowIndex).some(r=>r[c.id]!==undefined))}
                          aria-label={labels.removeRow}
                          onClick={() => removeRow(rowIndex)}
                        />
                      </Tooltip>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.tableEmpty}>{labels.noRows}</p>
      )}
    </section>
  );
};

const ProtocolCapabilities: React.FC<{ protocol: ParsedAimdProtocol; labels: Labels }> = ({ protocol, labels }) => {
  const workflowCount = protocol.fields.workflow?.length || 0;
  const connectors = (protocol.fields.connectors || []).flatMap((registry) => Object.values(registry.connectors));
  const collectors = (protocol.fields.collectors || []).flatMap((registry) => Object.values(registry.collectors));
  const assigners = protocol.fields.client_assigner || [];
  const references = protocol.fields.refs || [];
  if (!workflowCount && !connectors.length && !collectors.length && !assigners.length && !references.length)
    return null;

  return (
    <section className={styles.capabilitiesBlock}>
      <h2>{labels.automation}</h2>
      <div className={styles.capabilityRows}>
        {workflowCount ? (
          <div>
            <strong>{labels.workflow}</strong>
            <span>{workflowCount}</span>
            <small>{protocol.fields.workflow?.map((workflow) => workflow.title || workflow.id).join(' · ')}</small>
          </div>
        ) : null}
        {connectors.length ? (
          <div>
            <strong>{labels.sources}</strong>
            <span>{connectors.length}</span>
            <small>{connectors.map((connector) => connector.title || connector.id).join(' · ')}</small>
          </div>
        ) : null}
        {collectors.length ? (
          <div>
            <strong>{labels.collectors}</strong>
            <span>{collectors.length}</span>
            <small>{collectors.map((collector) => collector.title || collector.id).join(' · ')}</small>
          </div>
        ) : null}
        {assigners.length ? (
          <div>
            <strong>{labels.calculations}</strong>
            <span>{assigners.length}</span>
            <small>{assigners.map((assigner) => assigner.id).join(' · ')}</small>
          </div>
        ) : null}
        {references.length ? (
          <div>
            <strong>{labels.references}</strong>
            <span>{references.length}</span>
            <small>{references.map((reference) => reference.title || reference.id).join(' · ')}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
};

const statusLabel = (status: RunStatus, labels: Labels): string =>
  status === 'completed' ? labels.completed : status === 'running' ? labels.running : labels.ready;

const auditActionLabel = (action: AuditAction, labels: Labels): string => {
  const actionLabels: Record<AuditAction, string> = {
    run_created: labels.eventRunCreated,
    run_started: labels.eventRunStarted,
    field_updated: labels.eventFieldUpdated,
    table_updated: labels.eventTableUpdated,
    step_updated: labels.eventStepUpdated,
    check_updated: labels.eventCheckUpdated,
    decision_updated: labels.eventDecisionUpdated,
    run_completed: labels.eventRunCompleted,
    record_exported: labels.eventRecordExported,
  };
  return actionLabels[action];
};

const formatTimestamp = (value: string | undefined, locale: 'zh' | 'en'): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
};

const checkLabel = (check: { id: string; label?: string; checked_message?: string }): string =>
  check.checked_message || check.label || check.id;

const stepLabel = (step?: { id: string; title?: string;checked_message?:string }): string | undefined => step?.title || step?.checked_message || step?.id;

const quizAnswerLabel = (quiz: AimdQuizNode, value: unknown): string | undefined => {
  if (!isAimdValueComplete(value)) return undefined;
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  const labels = values.map((item) => quiz.options?.find((option) => option.key === item)?.text || item);
  return labels.filter(Boolean).join(', ') || undefined;
};

const fileName = (path?: string): string => path?.replace(/\\/gu, '/').split('/').at(-1) || 'protocol.aimd';

const stableSessionKey = (filePath: string | undefined, content: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `deepscientist:aimd-record:${filePath || 'inline'}:${(hash >>> 0).toString(16)}`;
};

const readPersistedRun = (key: string, protocol: ParsedAimdProtocol): AimdRunState | undefined => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as AimdRunState;
    if (!parsed?.id || !parsed?.status) return undefined;
    return {
      ...parsed,
      tables: parsed.tables || {},
      values: parsed.values || {},
      steps: parsed.steps || {},
      checks: parsed.checks || {},
      quizzes: parsed.quizzes || {},
      fieldOwnership: { ...buildAimdFieldOwnership(protocol), ...parsed.fieldOwnership },
      events:
        Array.isArray(parsed.events) && parsed.events.length
          ? parsed.events
          : [makeAuditEvent('system', 'run_created', fileName(undefined), undefined, parsed.createdAt)],
    };
  } catch {
    return undefined;
  }
};

const AimdProtocolWorkspace: React.FC<AimdProtocolWorkspaceProps> = ({
  content,
  filePath,
  workspace,
  revision,
  initialRun,
  adapter,
  onDirtyChange,
  onBusyChange,
}) => {
  const completionSurface = useRef<HTMLDivElement>(null);
  const [savingRequest, setSaving] = useState(false);
  const [uploads, setUploads] = useState(0);
  const reportUpload = useCallback((busy: boolean) => setUploads(count => count + (busy ? 1 : -1)), []);
  const saving = savingRequest || uploads > 0;
  const [saveStatus, setSaveStatus] = useState("表单修改后请保存草稿；提交时会先保存并校验。");
  const { i18n } = useTranslation();
  const locale: 'zh' | 'en' = (i18n.resolvedLanguage || i18n.language)?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const labels = LABELS[locale];
  const parsed = useMemo<{ protocol?: ParsedAimdProtocol; error?: string }>(() => {
    try {
      return { protocol: parseAimdProtocol(content, fileName(filePath).replace(/\.aimd$/iu, '')), error: undefined };
    } catch (error) {
      return { protocol: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }, [content, filePath]);
  const sessionKey = useMemo(() => stableSessionKey(filePath, content), [content, filePath]);
  const initialRunSignature = useMemo(() => (initialRun ? JSON.stringify(initialRun) : ''), [initialRun]);
  const runSourceKey = `${sessionKey}:${initialRunSignature}`;
  const protocol = parsed.protocol;
  const [run, setRun] = useState<AimdRunState>(() =>
    protocol
      ? initialRun
        ? initialRunState(protocol, filePath, initialRun)
        : readPersistedRun(sessionKey, protocol) || initialRunState(protocol, filePath)
      : ({} as AimdRunState)
  );
  const [view, setView] = useState<'protocol' | 'details'>('protocol');
  const signature = (value: AimdRunState) => JSON.stringify([value.status, value.values, value.tables, value.steps, value.checks, value.quizzes]);
  const savedSignature = useRef(signature(run));
  const dirty = signature(run) !== savedSignature.current;
  const automatic=adapter?.automatic;
  const inputKey=(value:AimdRunState)=>{const input=stripCalculated(value,automatic?.targets || []);return JSON.stringify([input.status,input.values,input.tables]);};
  const autoInputKey=inputKey(run);
  const latestRun=useRef(run);latestRun.current=run;
  const latestAdapter=useRef(adapter);latestAdapter.current=adapter;
  const autoRequest=useRef(false),autoAttempt=useRef(''),autoSaved=useRef(run.calculation?autoInputKey:'');
  const mounted=useRef(true);
  const [autoWorking,setAutoWorking]=useState(false),[autoTick,setAutoTick]=useState(0),[autoMessage,setAutoMessage]=useState(()=>run.calculation?.errors.length?'已保存的输入需要修正，请核对计算详情':run.calculation?.pending.length?'等待补齐相关数据':run.calculation?'已计算并保存':'修改输入后自动计算并保存');
  const needsAuto=Boolean(automatic && run.status==='running' && autoInputKey!==autoSaved.current && autoInputKey!==autoAttempt.current);
  const reviewDirty=Boolean(automatic && dirty && autoInputKey===autoSaved.current);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!needsAuto || saving)return;
    const timer=window.setTimeout(async()=>{
      if(autoRequest.current)return;
      autoRequest.current=true;
      const snapshot=latestRun.current,key=inputKey(snapshot);autoAttempt.current=key;
      setAutoWorking(true);setAutoMessage('正在校验与计算…');
      try{
        const result=await latestAdapter.current!.save(snapshot);
        autoSaved.current=key;
        if(!mounted.current)return;
        setRun(current=>{
          if(inputKey(current)!==key)return current; // A slow result never replaces newer cell edits.
          const merged={...current,...result,fieldOwnership:current.fieldOwnership,events:current.events};
          savedSignature.current=signature(merged);return merged;
        });
        const errors=result.calculation?.errors || [],pending=result.calculation?.pending || [];
        setAutoMessage(errors.length?errors.map(e=>(e.row===null||e.row===undefined?'':'第 '+(e.row+1)+' 行：')+e.message).join('；'):pending.length?'已保存输入，等待补齐相关数据':'已计算并自动保存');
      }catch(error){if(mounted.current)setAutoMessage('计算未完成：'+String((error as Error).message)+'。可修正输入或点击保存草稿重试。');}
      finally{autoRequest.current=false;if(mounted.current){setAutoWorking(false);setAutoTick(t=>t+1);}}
    },650);
    return()=>window.clearTimeout(timer);
  },[autoInputKey,autoTick,needsAuto,saving]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(saving || autoWorking || needsAuto); }, [saving,autoWorking,needsAuto,onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  const [now, setNow] = useState(Date.now());
  const [recentlyUpdatedField, setRecentlyUpdatedField] = useState<string>();
  const recentUpdateTimer = useRef<number | undefined>(undefined);
  const activeRunSourceRef = useRef(runSourceKey);
  const { documents, loading: documentsLoading } = useProtocolDocuments({ workspace, filePath, content });

  useEffect(() => {
    if (!protocol || activeRunSourceRef.current === runSourceKey) return;
    activeRunSourceRef.current = runSourceKey;
    setRun(
      initialRun
        ? initialRunState(protocol, filePath, initialRun)
        : readPersistedRun(sessionKey, protocol) || initialRunState(protocol, filePath)
    );
    setView('protocol');
  }, [filePath, initialRun, protocol, runSourceKey, sessionKey]);

  useEffect(() => {
    if (!run?.id || adapter) return;
    try {
      sessionStorage.setItem(sessionKey, JSON.stringify(run));
    } catch {
      // A private or constrained renderer may reject session storage; the active component still keeps the draft.
    }
  }, [run, sessionKey]);

  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  useEffect(
    () => () => {
      if (recentUpdateTimer.current) window.clearTimeout(recentUpdateTimer.current);
    },
    []
  );

  if (!protocol) {
    return (
      <div className={styles.errorState} role='alert'>
        <strong>{labels.protocolError}</strong>
        <code>{parsed.error}</code>
      </div>
    );
  }

  const variables = uniqueVariables(protocol);
  const requiredVariables = variables.filter((field) => field.definition?.kwargs?.required !== false);
  const requiredTables = (protocol.fields.var_table || []).filter((table) => table.kwargs?.required !== false);
  const requiredSteps = protocol.steps.filter((step) => step.check !== false);
  const requiredChecks = protocol.checks;
  const requiredQuizzes = protocol.quizzes;
  const incompleteLabels = [
    ...requiredVariables.filter(field => !isAimdValueComplete(run.values[field.id])).map(fieldLabel),
    ...requiredTables.filter(table => {
      const rows = run.tables[table.id] || [];
      return !rows.length || rows.some(row => table.subvars.some(column => !isAimdValueComplete(row[column.id])));
    }).map(tableFieldTitle),
    ...requiredSteps.filter(step => !run.steps[step.id]).map(step => step.title || step.id),
    ...requiredChecks.filter(check => !run.checks[check.id]).map(checkLabel),
    ...requiredQuizzes.filter(quiz => !isAimdValueComplete(run.quizzes[quiz.id])).map(quiz => quiz.title || quiz.stem || quiz.id),
  ];
  const totalCount =
    requiredVariables.length +
    requiredTables.length +
    requiredSteps.length +
    requiredChecks.length +
    requiredQuizzes.length;
  const completedCount = totalCount - incompleteLabels.length;
  const progress = totalCount === 0 ? 100 : Math.round((completedCount / totalCount) * 100);
  const canFinish = completedCount === totalCount && run.status === 'running';
  const runStartedAt = run.startedAt ? Date.parse(run.startedAt) : undefined;
  const elapsedSeconds = runStartedAt ? Math.max(0, Math.round((now - runStartedAt) / 1_000)) : 0;
  const activeStep =
    run.status === 'running' ? protocol.steps.find((step) => !run.steps[step.id]) || protocol.steps.at(-1) : undefined;
  const firstStep = protocol.steps.at(0);
  const resultStep = protocol.steps.findLast((step) => step.result) || protocol.steps.at(-1);
  const finalDecisionQuiz = protocol.quizzes.findLast((quiz) => isAimdValueComplete(run.quizzes[quiz.id]));
  const finalDecision = finalDecisionQuiz
    ? quizAnswerLabel(finalDecisionQuiz, run.quizzes[finalDecisionQuiz.id])
    : undefined;
  const remainingCount = Math.max(0, totalCount - completedCount);
  const ownershipCounts = Object.values(run.fieldOwnership).reduce<Record<AimdFieldOwnership, number>>(
    (counts, ownership) => {
      counts[ownership] += 1;
      return counts;
    },
    { human: 0, agent: 0, system: 0 }
  );

  const startRun = () => {
    if (adapter) setSaveStatus("运行状态尚未保存，请保存草稿");
    setNow(Date.now());
    setRun((current) => {
      const startedAt = current.startedAt || new Date().toISOString();
      return {
        ...current,
        status: 'running',
        startedAt,
        events: appendAuditEvent(
          current.events,
          makeAuditEvent('system', 'run_started', protocol.title, undefined, startedAt)
        ),
      };
    });
  };
  const newRun = () => {
    if (adapter) { void adapter.create().catch(error => Message.error(String(error))); return; }
    setNow(Date.now());
    setRun(initialRunState(protocol, filePath));
  };
  const saveDraft = async () => {
    if (!adapter || saving) return;
    setSaving(true);
    try { const saved = await adapter.save(run); savedSignature.current = signature(saved); setRun({ ...run, ...saved }); setSaveStatus("已保存至共享数据库"); }
    catch (error) { setSaveStatus(labels.saveFailed+' '+String(error)); Message.error(String(error)); }
    finally { setSaving(false); }
  };
  const completeRun = () => {
    if (saving || run.status !== 'running') return;
    if (!canFinish) {
      const message = (locale === 'zh' ? '请先完成：' : 'Please complete: ') + incompleteLabels.join(locale === 'zh' ? '、' : ', ');
      setSaveStatus(message);
      Message.warning(message);
      const target = Array.from(completionSurface.current?.querySelectorAll<HTMLElement>('[aria-label]') || [])
        .find(element => element.getAttribute('aria-label') === incompleteLabels[0]);
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
      return;
    }
    if (adapter) {
      setSaving(true);
      void adapter.submit(run).then(saved => { savedSignature.current = signature(saved); setRun({ ...run, ...saved }); setSaveStatus("已提交；历史版本已保留"); }).catch(error => { setSaveStatus(String(error)); Message.error(String(error)); }).finally(() => setSaving(false));
      return;
    }
    setRun((current) => {
      const completedAt = new Date().toISOString();
      return {
        ...current,
        status: 'completed',
        completedAt,
        events: appendAuditEvent(
          current.events,
          makeAuditEvent('system', 'run_completed', protocol.title, undefined, completedAt)
        ),
      };
    });
  };
  const exportRecord = () => {
    if (adapter) { void adapter.export().catch(error => Message.error(String(error))); return; }
    const exportedAt = new Date().toISOString();
    const exportedRun = {
      ...run,
      events: appendAuditEvent(
        run.events,
        makeAuditEvent('system', 'record_exported', `${run.id}.record.json`, undefined, exportedAt)
      ),
    };
    setRun(exportedRun);
    const record = {
      schema: 'deepscientist.protocol.record.v2',
      protocol: {
        title: protocol.title,
        filePath,
        workspace,
        revision,
      },
      record: exportedRun,
    };
    void downloadTextContent(
      `${JSON.stringify(record, null, 2)}\n`,
      `${run.id}.record.json`,
      'application/json;charset=utf-8'
    ).then(() => Message.success(labels.exported));
  };
  const markEdited = () => {
    // Close the parent's review event guard before a second click can use its previous rendered state.
    onDirtyChange?.(true);
    if (adapter) setSaveStatus(labels.unsavedDraft);
  };
  const setValue = (id: string, value: unknown) => {
    markEdited();
    setRun((previous) => {const current=automatic?stripCalculated(previous,automatic.targets):previous;return ({
      ...current, calculation:undefined,checks:automatic?{}:current.checks,
      values: { ...current.values, [id]: value },
      events: appendAuditEvent(current.events, makeAuditEvent('human', 'field_updated', id), true),
    });});
    setRecentlyUpdatedField(id);
    if (recentUpdateTimer.current) window.clearTimeout(recentUpdateTimer.current);
    recentUpdateTimer.current = window.setTimeout(() => setRecentlyUpdatedField(undefined), 760);
  };
  const setTable = (id: string, rows: Array<Record<string, unknown>>) => {
    markEdited();
    setRun((current) => {const next={...current,tables:{...current.tables,[id]:rows}};return ({
      ...(automatic?stripCalculated(next,automatic.targets):next),calculation:undefined,checks:automatic?{}:current.checks,
      events: appendAuditEvent(current.events, makeAuditEvent('human', 'table_updated', id), true),
    });});
  };
  const setStep = (id: string, value: boolean) => {
    markEdited();
    setRun((current) => ({
      ...current,
      steps: { ...current.steps, [id]: value },
      events: appendAuditEvent(current.events, makeAuditEvent('human', 'step_updated', id, String(value))),
    }));
  };
  const setCheck = (id: string, value: boolean) => {
    markEdited();
    setRun((current) => ({
      ...current,
      checks: { ...current.checks, [id]: value },
      events: appendAuditEvent(current.events, makeAuditEvent('human', 'check_updated', id, String(value))),
    }));
  };
  const setQuiz = (id: string, value: unknown) => {
    markEdited();
    setRun((current) => ({
      ...current,
      quizzes: { ...current.quizzes, [id]: value },
      events: appendAuditEvent(current.events, makeAuditEvent('human', 'decision_updated', id), true),
    }));
  };

  const renderBlock = (block: AimdProtocolBlock, index: number): React.ReactNode => {
    if (block.kind === 'heading') {
      if (block.depth === 1) return null;
      if (block.depth === 2 && protocol.blocks[index + 1]?.kind === 'step') return null;
      const Tag = block.depth <= 2 ? 'h2' : 'h3';
      return <Tag key={`heading-${index}`}>{block.text}</Tag>;
    }
    if (block.kind === 'paragraph') {
      return (
        <ProtocolInlineContent
          key={`paragraph-${index}`}
          inlines={block.inlines}
          run={run}
          labels={labels}
          recentlyUpdatedField={recentlyUpdatedField}
          saving={saving}
          onValue={setValue}
        />
      );
    }
    if (block.kind === 'table') {
      const table = protocol.fields.var_table.find((candidate) => candidate.id === block.table.id);
      const ownership = run.fieldOwnership[block.table.id] || 'human';
      return table ? (
        <ProtocolTable
          key={`table-${table.id}`}
          field={table}
          rows={run.tables[table.id] || []}
          disabled={saving || run.status !== 'running'}
          ownership={run.fieldOwnership}
          calculatedColumns={automatic?.targets}
          readOnly={run.status === 'completed'}
          labels={labels}
          onChange={(rows) => setTable(table.id, rows)}
        />
      ) : null;
    }
    if (block.kind === 'markdown') {
      return (
        <div key={`markdown-${index}`} className={styles.markdownBlock}>
          <MarkdownPreview content={block.source} file_path={filePath} workspace={workspace} />
        </div>
      );
    }
    if (block.kind === 'step') {
      const checked = Boolean(run.steps[block.step.id]);
      return (
        <section
          key={`step-${block.step.id}`}
          id={`aimd-step-${block.step.id}`}
          className={styles.stepBlock}
          data-level={block.step.level}
          data-complete={checked}
          data-active={activeStep?.id === block.step.id}
          title={block.step.subtitle || undefined}
        >
          <button
            type='button'
            className={styles.stepMarker}
            data-presentation='report-index'
            disabled={saving || autoWorking || needsAuto || run.status !== 'running'}
            aria-label={stepLabel(block.step)}
            aria-pressed={checked}
            onClick={() => setStep(block.step.id, !checked)}
          >
            <span className={styles.stepMarkerIndex}>{String(block.step.step).padStart(2, '0')}</span>
            {checked ? (
              <CheckSmall className={styles.stepMarkerCheck} size={11} theme='outline' strokeWidth={2.2} />
            ) : null}
          </button>
          <div className={styles.stepCopy}>
            <span>{stepLabel(block.step)}</span>
          </div>
        </section>
      );
    }
    if (block.kind === 'check') {
      if (run.status === 'completed' && run.checks[block.check.id]) return null;
      return (
        <div key={`check-${block.check.id}`} className={styles.checkBlock}>
          <Checkbox
            aria-label={checkLabel(block.check)}
            checked={Boolean(run.checks[block.check.id])}
            disabled={saving || autoWorking || needsAuto || run.status !== 'running'}
            onChange={(value) => setCheck(block.check.id, value)}
          />
          <span>{checkLabel(block.check)}</span>
        </div>
      );
    }
    if (block.kind === 'quiz') {
      return (
        <ProtocolQuiz
          key={`quiz-${block.quiz.id}`}
          quiz={block.quiz}
          value={run.quizzes[block.quiz.id]}
          disabled={saving || autoWorking || needsAuto || run.status !== 'running'}
          readOnly={run.status === 'completed'}
          onChange={(value) => setQuiz(block.quiz.id, value)}
        />
      );
    }
    if (block.kind === 'figure') {
      return (
        <figure key={`figure-${block.figure.id}`} className={styles.figureBlock}>
          <img src={block.figure.src} alt={block.figure.title || block.figure.id} />
          <figcaption>{block.figure.title || block.figure.legend || block.figure.id}</figcaption>
        </figure>
      );
    }
    return (
      <a
        key={`media-${block.media.id}`}
        className={styles.mediaBlock}
        href={block.media.src}
        target='_blank'
        rel='noreferrer'
      >
        <span>{block.media.title || block.media.id}</span>
        <small>{labels.openMedia}</small>
      </a>
    );
  };

  const outcomeTitle =
    run.status === 'completed'
      ? labels.outcomeCompleted
      : run.status === 'running'
        ? labels.outcomeRunning
        : labels.outcomeReady;
  const outcomeDetail =
    run.status === 'completed'
      ? labels.outcomeCompletedDetail
      : run.status === 'running'
        ? labels.outcomeRunningDetail
        : labels.outcomeReadyDetail;
  const outcomeDisplayTitle =
    run.status === 'completed' ? finalDecision || stepLabel(resultStep) || outcomeTitle : outcomeTitle;
  const runSummaryLabel = statusLabel(run.status, labels);
  const runSummaryText =
    automatic && locale==='zh'
      ? run.status==='completed'?'已完成复核，可导出结果或再次运行。':run.status==='ready'?'下一步：点击“开始运行”，填写下方数据。':run.calculation?.errors.length?'下一步：修正提示的数据，结果会自动更新。':!run.calculation || run.calculation.pending.length?'下一步：补齐下方输入，系统会自动计算。':canFinish?'下一步：点击“完成运行”，提交本次实验。':'下一步：核对结果，完成下方检查后提交。'
      : run.status === 'completed'
      ? labels.completedHint
      : `${run.status === 'running' ? labels.currentStep : labels.startWith}${locale === 'zh' ? '：' : ': '}${stepLabel(activeStep || firstStep) || labels.notStarted}`;

  if (view === 'details') {
    return (
      <div className={styles.workspace} data-testid='aimd-protocol-details'>
        <div className={styles.scrollSurface}>
          <header className={styles.detailsHeader}>
            <Button type='text' size='small' icon={<ArrowLeft />} onClick={() => setView('protocol')}>
              {labels.back}
            </Button>
            <div>
              <span>{labels.details}</span>
              <h1>{protocol.title}</h1>
              <p>{labels.savedHint}</p>
            </div>
          </header>

          <main className={styles.detailsContent}>
            <section className={styles.detailsOutcome} data-status={run.status}>
              <span>{labels.outcome}</span>
              <h2>{outcomeDisplayTitle}</h2>
              <p>{outcomeDetail}</p>
              <div className={styles.detailsProgress}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </section>

            <div className={styles.detailsGrid}>
              <section className={styles.detailsSection}>
                <h2>{labels.technicalDetails}</h2>
                <dl>
                  <div>
                    <dt>{labels.recordId}</dt>
                    <dd>{run.id}</dd>
                  </div>
                  <div>
                    <dt>{labels.version}</dt>
                    <dd>{revision?.slice(0, 12) || labels.workingTree}</dd>
                  </div>
                  <div>
                    <dt>{labels.source}</dt>
                    <dd>{fileName(filePath)}</dd>
                  </div>
                  <div>
                    <dt>{labels.workspace}</dt>
                    <dd>{workspace || '—'}</dd>
                  </div>
                  <div>
                    <dt>{labels.createdAt}</dt>
                    <dd>{formatTimestamp(run.createdAt, locale)}</dd>
                  </div>
                  <div>
                    <dt>{labels.startedAt}</dt>
                    <dd>{formatTimestamp(run.startedAt, locale)}</dd>
                  </div>
                  <div>
                    <dt>{labels.completedAt}</dt>
                    <dd>{formatTimestamp(run.completedAt, locale)}</dd>
                  </div>
                </dl>
              </section>

              <section className={styles.detailsSection}>
                <h2>{labels.operationalSummary}</h2>
                <div className={styles.ownershipSummary}>
                  {(['human', 'agent', 'system'] as const).map((ownership) => (
                    <div key={ownership} data-owner={ownership}>
                      <strong>{ownershipCounts[ownership]}</strong>
                      <span>{ownershipLabel(ownership, labels)}</span>
                    </div>
                  ))}
                </div>
                <dl>
                  <div>
                    <dt>{labels.progress}</dt>
                    <dd>{progress}%</dd>
                  </div>
                  <div>
                    <dt>{labels.remaining}</dt>
                    <dd>
                      {remainingCount} {labels.items}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.steps}</dt>
                    <dd>
                      {completeSteps}/{requiredSteps.length}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.checks}</dt>
                    <dd>
                      {completeChecks}/{requiredChecks.length}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            <ProtocolCapabilities protocol={protocol} labels={labels} />

            <section className={styles.auditSection}>
              <header>
                <div>
                  <h2>{labels.auditTrail}</h2>
                  <p>{labels.savedHint}</p>
                </div>
                <b>{run.events.length}</b>
              </header>
              {run.events.length ? (
                <ol>
                  {run.events.toReversed().map((event) => (
                    <li key={event.id}>
                      <i data-owner={event.actor} />
                      <div>
                        <strong>{auditActionLabel(event.action, labels)}</strong>
                        <span>{event.target || protocol.title}</span>
                      </div>
                      <time>{formatTimestamp(event.at, locale)}</time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{labels.noAudit}</p>
              )}
            </section>
          </main>
        </div>
      </div>
    );
  }

  return (
    <AttachmentBusyContext.Provider value={reportUpload}><div ref={completionSurface} aria-busy={saving} style={saving ? { pointerEvents: 'none', opacity: 0.8 } : undefined} className={styles.workspace} data-status={run.status} data-testid='aimd-protocol-workspace'>
      <div className={styles.scrollSurface}>
        <header className={styles.protocolHeader}>
          <div className={styles.eyebrowRow}>
            <div className={styles.eyebrow}>
              <span>{labels.protocol}</span>
            </div>
            <Tooltip content={labels.details}>
              <Button
                type='text'
                size='mini'
                className={styles.detailsTrigger}
                icon={<Info size={13} />}
                aria-label={labels.details}
                onClick={() => setView('details')}
              />
            </Tooltip>
          </div>
          <div className={styles.headerMain}>
            <div>
              <h1>{protocol.title}</h1>
              {protocol.summary ? automatic?<details className="experiment-description"><summary>方法说明</summary><p>{protocol.summary}</p></details>:<p>{protocol.summary}</p> : null}
            </div>
            <div className={styles.headerActions}>
              {run.status === 'ready' ? (
                <Button type='primary' icon={<PlayOne />} onClick={startRun}>
                  {labels.start}
                </Button>
              ) : run.status === 'completed' ? (
                <Button icon={<Refresh />} onClick={newRun}>
                  {labels.newRun}
                </Button>
              ) : (
                <Button type='primary' icon={<CheckOne />} disabled={saving || autoWorking || needsAuto} onClick={completeRun}>
                  {labels.finish}
                </Button>
              )}
              {adapter && run.status !== "completed" && (!automatic || dirty || autoMessage.startsWith('计算未完成')) && <Button loading={saving || autoWorking} disabled={autoWorking || needsAuto} onClick={() => void saveDraft()}>{labels.saveDraft}</Button>}
              {adapter && <span role="status" style={{ maxWidth: 360, fontSize: 12 }}>{automatic?(needsAuto?'输入已修改，准备计算…':reviewDirty?saveStatus:autoMessage):saveStatus}</span>}
              <Button icon={<Download />} onClick={exportRecord}>
                {labels.export}
              </Button>
            </div>
          </div>
          {automatic && <section className="interactive-result-summary" aria-label="本次计算结果"><header><strong>计算结果</strong><small>{run.status==='completed'?'已复核':autoWorking||needsAuto?'正在更新':run.calculation?.errors.length?'请修正数据':run.calculation?.pending.length||!run.calculation?'等待输入':'待人工核对'}</small></header><dl className="experiment-metrics">{protocol.variables.filter(f=>automatic.targets.includes(f.id)).slice(0,6).map(f=><div key={f.id}><dt>{fieldLabel(f)}</dt><dd>{typeof run.values[f.id]==='number'?run.values[f.id].toLocaleString(locale):typeof run.values[f.id]==='string'||typeof run.values[f.id]==='boolean'?String(run.values[f.id]):'—'}</dd></div>)}</dl>{!protocol.variables.some(f=>automatic.targets.includes(f.id))&&<p>自动计算结果显示在下方表格和图表中。</p>}</section>}
          <section className={styles.runSummary} data-status={run.status} aria-label={runSummaryLabel}>
            <span className={styles.runSummaryState}>{runSummaryLabel}</span>
            <strong>{runSummaryText}</strong>
            <div className={styles.runSummaryMeta}>
              <span>{progress}%</span>
              <span>
                {run.status === 'running'
                  ? `${labels.elapsed} ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`
                  : `${labels.duration} ${formatDuration(protocol.estimatedDurationMs, locale)}`}
              </span>
            </div>
            <div className={styles.runSummaryProgress} aria-label={`${labels.progress} ${progress}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>
          </section>
        </header>

        <div className={styles.protocolLayout}>
          <nav className={styles.progressRail} aria-label={labels.steps}>
            {protocol.steps.map((step) => (
              <a
                key={step.id}
                href={`#aimd-step-${step.id}`}
                title={step.title || step.id}
                data-complete={Boolean(run.steps[step.id])}
                data-active={activeStep?.id === step.id}
                aria-current={activeStep?.id === step.id ? 'step' : undefined}
              >
                <span />
              </a>
            ))}
          </nav>

          <main className={styles.protocolBody} aria-label={protocol.title}>
            {protocol.blocks.map(renderBlock)}
            {automatic?.charts.map(chart=>{const rows=(run.tables[chart.table] || []).filter(row=>typeof row[chart.value]==='number');const max=Math.max(1,...rows.map(row=>Number(row[chart.value])));return <section key={chart.id} className="interactive-chart" aria-label={chart.title}><h3>{chart.title}</h3>{rows.length?rows.map((row,i)=><div className="interactive-chart-row" key={i}><span>{String(row[chart.label] || '测点 '+(i+1))}</span><div><i style={{width:(Number(row[chart.value])/max*100)+'%'}}/></div><strong>{String(row[chart.value])}</strong></div>):<p>填写数据后自动更新图表</p>}</section>;})}
            {automatic && run.calculation && <details className="interactive-calculation"><summary>计算依据与校验详情</summary><p>本次输入、执行包指纹和计算记录随实验记录保存；计算结果仍需人工核对。</p><pre>{JSON.stringify(run.calculation,null,2)}</pre></details>}
            {run.status === 'completed' ? (
              <section className={styles.resultPanel} data-status={run.status} aria-label={labels.expectedOutput}>
                <header>
                  <span>{labels.outcome}</span>
                  <strong>
                    {completedCount}/{totalCount}
                  </strong>
                </header>
                <h2>{outcomeDisplayTitle}</h2>
                <p>{outcomeDetail}</p>
                <div className={styles.resultProgress} aria-hidden='true'>
                  <span style={{ width: `${progress}%` }} />
                </div>
              </section>
            ) : null}
            <ProtocolDocumentBrowser
              documents={documents}
              loading={documentsLoading}
              workspace={workspace}
              labels={{
                title: labels.relatedDocuments,
                description: labels.relatedDocumentsDescription,
                current: labels.currentDocument,
                aimd: labels.aimdDocument,
                markdown: labels.markdownDocument,
                record: labels.recordDocument,
                preview: labels.documentPreview,
                open: labels.openDocument,
                empty: labels.noDocuments,
              }}
            />
          </main>
        </div>
      </div>
    </div></AttachmentBusyContext.Provider>
  );
};

export default AimdProtocolWorkspace;
