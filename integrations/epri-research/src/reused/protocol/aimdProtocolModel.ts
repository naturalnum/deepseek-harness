/**
 * @license
 * Copyright 2026 DeepScientist (deepscientist.cc)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  protectAimdInlineTemplates,
  remarkAimd,
  type AimdCheckNode,
  type AimdFigNode,
  type AimdMediaNode,
  type AimdQuizNode,
  type AimdStepNode,
  type AimdVarTableField,
  type AimdVarTableNode,
  type AimdVarNode,
  type ExtractedAimdFields,
} from '@airalogy/aimd-core';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type SourcePosition = {
  start?: { line?: number };
  end?: { line?: number };
};

export type AimdAstNode = {
  type: string;
  value?: string;
  depth?: number;
  url?: string;
  alt?: string;
  lang?: string;
  children?: AimdAstNode[];
  position?: SourcePosition;
  fieldType?: string;
  id?: string;
  raw?: string;
  [key: string]: unknown;
};

export type AimdInline =
  | { kind: 'text'; value: string }
  | { kind: 'strong' | 'emphasis' | 'delete' | 'code'; value: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'break' }
  | { kind: 'var'; field: AimdVarNode }
  | { kind: 'reference'; label: string; target: string };

export type AimdProtocolBlock =
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'paragraph'; inlines: AimdInline[] }
  | { kind: 'table'; table: AimdVarTableNode }
  | { kind: 'markdown'; source: string }
  | { kind: 'step'; step: AimdStepNode }
  | { kind: 'check'; check: AimdCheckNode }
  | { kind: 'quiz'; quiz: AimdQuizNode }
  | { kind: 'figure'; figure: AimdFigNode }
  | { kind: 'media'; media: AimdMediaNode };

export type ParsedAimdProtocol = {
  title: string;
  summary?: string;
  blocks: AimdProtocolBlock[];
  fields: ExtractedAimdFields;
  steps: AimdStepNode[];
  checks: AimdCheckNode[];
  variables: AimdVarNode[];
  quizzes: AimdQuizNode[];
  estimatedDurationMs: number;
  warningCount: number;
};

export type AimdFieldOwnership = 'human' | 'agent' | 'system';

type AimdOwnableField = AimdVarNode | AimdVarTableField;

const normalizeOwnership = (value: unknown): AimdFieldOwnership | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
  if (['human', 'user', 'operator', 'manual', 'person'].includes(normalized)) return 'human';
  if (['agent', 'assistant', 'ai', 'model', 'automatic', 'auto'].includes(normalized)) return 'agent';
  if (['system', 'runtime', 'computed', 'generated', 'readonly'].includes(normalized)) return 'system';
  return undefined;
};

const fieldMetadata = (field: AimdOwnableField): Record<string, unknown> => {
  const variableDefinition = (field as AimdVarNode).definition;
  if (variableDefinition) return variableDefinition.kwargs || {};
  return (field as AimdVarTableField).kwargs || {};
};

export const getAimdFieldOwnership = (
  field: AimdOwnableField,
  protocol: Pick<ParsedAimdProtocol, 'fields'>
): AimdFieldOwnership => {
  const metadata = fieldMetadata(field);
  const explicit = [
    metadata.owner,
    metadata.source,
    metadata.filled_by,
    metadata.filledBy,
    metadata.input_owner,
    metadata.inputOwner,
    metadata.generated_by,
    metadata.generatedBy,
  ]
    .map(normalizeOwnership)
    .find(Boolean);
  if (explicit) return explicit;

  const assignedByClient = (protocol.fields.client_assigner || []).some((assigner) =>
    assigner.assigned_fields.includes(field.id)
  );
  if (assignedByClient) return 'agent';
  if (metadata.readonly === true || metadata.read_only === true || metadata.computed === true) return 'system';
  return 'human';
};

export const buildAimdFieldOwnership = (protocol: ParsedAimdProtocol): Record<string, AimdFieldOwnership> =>
  Object.fromEntries(
    [...protocol.variables, ...(protocol.fields.var_table || []), ...(protocol.fields.var_table || []).flatMap(table=>table.subvars.map(column=>({...column,id:table.id+'.'+column.id,kwargs:{owner:getAimdFieldOwnership(table,protocol),...column.kwargs}})))].map((field) => [
      field.id,
      getAimdFieldOwnership(field, protocol),
    ])
  );

const EMPTY_FIELDS: ExtractedAimdFields = {
  var: [],
  var_definitions: [],
  var_table: [],
  client_assigner: [],
  connectors: [],
  collectors: [],
  workflow: [],
  quiz: [],
  step: [],
  check: [],
  ref_step: [],
  ref_var: [],
  ref_fig: [],
  ref_media: [],
  cite: [],
  fig: [],
  media: [],
  refs: [],
  step_hierarchy: [],
};

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkAimd);

const nodeText = (node?: AimdAstNode): string => {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'aimd' && typeof node.id === 'string') return node.id;
  return (node.children || []).map(nodeText).join('');
};

const nodeSource = (node: AimdAstNode, sourceLines: string[]): string => {
  const start = node.position?.start?.line;
  const end = node.position?.end?.line;
  if (!start || !end) return nodeText(node);
  return sourceLines.slice(Math.max(0, start - 1), end).join('\n');
};

const asAimdNode = <T extends { fieldType: string }>(node: AimdAstNode, fieldType: T['fieldType']): T | undefined =>
  node.type === 'aimd' && node.fieldType === fieldType ? (node as T) : undefined;

const inlineFromNode = (node: AimdAstNode): AimdInline[] => {
  if (node.type === 'text') return [{ kind: 'text', value: node.value || '' }];
  if (node.type === 'inlineCode') return [{ kind: 'code', value: node.value || '' }];
  if (node.type === 'break') return [{ kind: 'break' }];
  if (node.children?.some(hasAimd)) return node.children.flatMap(inlineFromNode);
  if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
    return [{ kind: node.type, value: nodeText(node) }];
  }
  if (node.type === 'link') return [{ kind: 'link', label: nodeText(node), url: node.url || '' }];
  const variable = asAimdNode<AimdVarNode>(node, 'var');
  if (variable) return [{ kind: 'var', field: variable }];
  if (node.type === 'aimd') {
    return [{ kind: 'reference', label: node.fieldType || 'reference', target: node.id || '' }];
  }
  if (node.children?.length) return node.children.flatMap(inlineFromNode);
  return node.value ? [{ kind: 'text', value: node.value }] : [];
};

const onlyAimdChild = (node: AimdAstNode): AimdAstNode | undefined => {
  if (node.type !== 'paragraph' || node.children?.length !== 1) return undefined;
  return node.children[0]?.type === 'aimd' ? node.children[0] : undefined;
};

const hasAimd = (node: AimdAstNode): boolean => node.type === 'aimd' || Boolean(node.children?.some(hasAimd));

const toBlock = (node: AimdAstNode, sourceLines: string[]): AimdProtocolBlock => {
  if (node.type === 'heading') {
    return { kind: 'heading', depth: node.depth || 2, text: nodeText(node) };
  }

  const onlyAimd = onlyAimdChild(node) || (node.type === 'aimd' ? node : undefined);
  if (onlyAimd) {
    const step = asAimdNode<AimdStepNode>(onlyAimd, 'step');
    if (step) return { kind: 'step', step };
    const table = asAimdNode<AimdVarTableNode>(onlyAimd, 'var_table');
    if (table) return { kind: 'table', table };
    const check = asAimdNode<AimdCheckNode>(onlyAimd, 'check');
    if (check) return { kind: 'check', check };
    const quiz = asAimdNode<AimdQuizNode>(onlyAimd, 'quiz');
    if (quiz) return { kind: 'quiz', quiz };
    const figure = asAimdNode<AimdFigNode>(onlyAimd, 'fig');
    if (figure) return { kind: 'figure', figure };
    const media = asAimdNode<AimdMediaNode>(onlyAimd, 'media');
    if (media) return { kind: 'media', media };
  }

  if (node.type === 'paragraph' && node.children?.some(hasAimd)) {
    return { kind: 'paragraph', inlines: node.children.flatMap(inlineFromNode) };
  }

  return { kind: 'markdown', source: nodeSource(node, sourceLines) };
};

const getSummaryNode = (root: AimdAstNode): AimdAstNode | undefined =>
  root.children?.find((node) => node.type === 'paragraph' && !node.children?.some((child) => child.type === 'aimd'));

const getSummary = (paragraph?: AimdAstNode): string | undefined => {
  const text = nodeText(paragraph).replace(/\s+/gu, ' ').trim();
  if (!text) return undefined;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
};

export const parseAimdProtocol = (content: string, fallbackTitle = 'Research protocol'): ParsedAimdProtocol => {
  const protectedInline = protectAimdInlineTemplates(content);
  const file = { data: { aimdInlineTemplates: protectedInline.templates } } as {
    data: { aimdInlineTemplates: typeof protectedInline.templates; aimdFields?: ExtractedAimdFields };
  };
  const syntaxTree = processor.parse(protectedInline.content) as AimdAstNode;
  const root = processor.runSync(syntaxTree as never, file as never) as AimdAstNode;
  const fields = file.data.aimdFields || EMPTY_FIELDS;
  const sourceLines = content.split(/\r?\n/gu);
  const flatten = (node:AimdAstNode):AimdAstNode[] => {
    if(['list','listItem','blockquote','table','tableRow','tableCell'].includes(node.type) && hasAimd(node)) {
      if(node.type==='tableCell')return [{...node,type:'paragraph'}];
      return (node.children || []).flatMap(flatten);
    }
    return [node];
  };
  const nodes = (root.children || []).flatMap(flatten);
  const allNodes:AimdAstNode[]=[];
  const visit=(node:AimdAstNode)=>{allNodes.push(node);for(const child of node.children || [])visit(child);};visit(root);
  const fieldsOf=<T extends {fieldType:string}>(type:string):T[]=>[...new Map(allNodes.filter(n=>n.type==='aimd'&&n.fieldType===type).map(n=>[n.id,n])).values()] as T[];
  const summaryNode = getSummaryNode(root);
  const title =
    nodes
      .find((node) => node.type === 'heading' && node.depth === 1)
      ?.children?.map(nodeText)
      .join('')
      .trim() || fallbackTitle;
  const blocks = nodes.filter((node) => node !== summaryNode).map((node) => toBlock(node, sourceLines));
  const steps=fieldsOf<AimdStepNode>('step');
  const checks=fieldsOf<AimdCheckNode>('check');
  const variables=fieldsOf<AimdVarNode>('var');
  const quizzes=fieldsOf<AimdQuizNode>('quiz');

  return {
    title,
    summary: getSummary(summaryNode),
    blocks,
    fields,
    steps,
    checks,
    variables,
    quizzes,
    estimatedDurationMs: steps.reduce((total, step) => total + (step.estimated_duration_ms || 0), 0),
    warningCount: (fields.var_definitions || []).reduce((total, definition) => {
      const warnings = (definition as AimdVarNode & { warnings?: unknown[] }).warnings;
      return total + (Array.isArray(warnings) ? warnings.length : 0);
    }, 0),
  };
};

export const createAimdRecordId = (filePath?: string): string => {
  const stem = (filePath || 'protocol')
    .replace(/\\/gu, '/')
    .split('/')
    .at(-1)
    ?.replace(/\.aimd$/iu, '')
    .replace(/[^a-z0-9_-]+/giu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${stem || 'protocol'}-${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}`;
};

export const isAimdValueComplete = (value: unknown): boolean => {
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
};
