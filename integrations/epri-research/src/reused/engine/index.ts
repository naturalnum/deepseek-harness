// Reused Airalogy engine 0.0.5; upstream license retained in LICENSE.airalogy.
// Workflow parser and transition logic are copied; runtime transport uses restricted Docker.
import {parseDocument} from 'yaml';
import {existsSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {runDockerExecutor} from '../../server/engine-runtime.mjs';
export interface ProtocolResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
  output?: string;
  files?: SandboxFileBridgeOutput[];
}

export interface SandboxFileBridgeInput {
  id: string;
  path: string;
  fileName?: string;
  contentType?: string;
}

export interface SandboxFileBridgeOutput {
  id: string;
  path: string;
  file_name?: string;
  name?: string;
  content_type?: string;
  size?: number;
}

export interface SandboxFileBridgeOptions {
  inputs?: SandboxFileBridgeInput[];
  outputDir?: string;
}

export interface SandboxOptions {
  signal?: AbortSignal;
  image?: string;
  rootfsPath?: string;
  timeout?: number;
  memoryMib?: number;
  cpus?: number;
  debug?: boolean;
  logFile?: string;
  fileBridge?: SandboxFileBridgeOptions;
}

export type WorkflowAssignerRuntime = "sandbox" | "local";

export interface WorkflowRunOptions extends SandboxOptions {
  workflowId?: string;
  transitionIds?: string[];
  transitionOutputs?: Record<string, unknown>;
  nodeIterations?: Record<string, number>;
  maxPasses?: number;
  assignerRuntime?: WorkflowAssignerRuntime;
}

export interface WorkflowTransitionOptions extends SandboxOptions {
  workflowId?: string;
  transitionOutputs?: Record<string, unknown>;
  nodeIterations?: Record<string, number>;
  assignerRuntime?: WorkflowAssignerRuntime;
}

export type AimdWorkflowAssignValue =
  | string
  | number
  | boolean
  | null
  | AimdWorkflowAssignValue[]
  | { [key: string]: AimdWorkflowAssignValue };

export interface AimdWorkflowPermissions {
  network?: string[];
  secrets?: string[];
}

export interface AimdWorkflowNodeField {
  id: string;
  protocol?: string;
  protocol_id?: string;
  protocol_version?: string;
  title?: string;
  description?: string;
}

export interface AimdWorkflowAssignerField {
  id: string;
  runtime: string;
  entrypoint?: string;
  description?: string;
  outputs?: Record<string, string>;
  permissions?: AimdWorkflowPermissions;
}

export interface AimdWorkflowTransitionField {
  id: string;
  from: string[];
  to: string[];
  when?: string;
  label?: string;
  run?: string;
  inputs?: Record<string, AimdWorkflowAssignValue>;
  assign?: Record<string, Record<string, AimdWorkflowAssignValue>>;
  max_iterations?: number;
}

export interface AimdWorkflowField {
  id: string;
  version: "airalogy.workflow.v1";
  nodes: AimdWorkflowNodeField[];
  assigners: AimdWorkflowAssignerField[];
  transitions: AimdWorkflowTransitionField[];
  title?: string;
  description?: string;
  logic?: string;
  default_initial_node?: string;
  default_research_purpose?: string;
  default_research_strategy?: string;
  raw: string;
}

export type WorkflowPathStepMode = "ai" | "user";

export interface WorkflowProtocolInfo {
  protocol_index: number;
  protocol_id: string;
  protocol_version: string | null;
  airalogy_protocol_id: string | null;
  protocol_data: Record<string, unknown>;
}

export interface WorkflowPathStep {
  step: string;
  path_index: number;
  mode: WorkflowPathStepMode;
  data: Record<string, unknown>;
}

export interface WorkflowPathData {
  path_status: string;
  steps: WorkflowPathStep[];
}

export interface WorkflowData {
  protocols_info: WorkflowProtocolInfo[];
  path_data: WorkflowPathData;
}

type EnvVars = Record<string, string>;
function isSandboxOptions(value: EnvVars | SandboxOptions | WorkflowRunOptions | WorkflowTransitionOptions | undefined): value is SandboxOptions {
  if (value === undefined) {
    return false;
  }

  return [
    "signal",
    "image",
    "rootfsPath",
    "timeout",
    "memoryMib",
    "cpus",
    "debug",
    "logFile",
    "fileBridge",
    "workflowId",
    "transitionIds",
    "transitionOutputs",
    "nodeIterations",
    "maxPasses",
    "assignerRuntime",
  ].some((key) => key in value);
}

function resolveEnvAndOptions(
  envVarsOrOptions: EnvVars | SandboxOptions | undefined,
  options: SandboxOptions | undefined,
): {
  envVars: EnvVars | undefined;
  options: SandboxOptions;
} {
  if (isSandboxOptions(envVarsOrOptions)) {
    return {
      envVars: undefined,
      options: envVarsOrOptions,
    };
  }

  return {
    envVars: envVarsOrOptions,
    options: options ?? {},
  };
}

function resolveEnvAndWorkflowRunOptions(
  envVarsOrOptions: EnvVars | WorkflowRunOptions | undefined,
  options: WorkflowRunOptions | undefined,
): {
  envVars: EnvVars | undefined;
  options: WorkflowRunOptions;
} {
  if (isSandboxOptions(envVarsOrOptions)) {
    return {
      envVars: undefined,
      options: envVarsOrOptions as WorkflowRunOptions,
    };
  }

  return {
    envVars: envVarsOrOptions,
    options: options ?? {},
  };
}

function resolveEnvAndWorkflowTransitionOptions(
  envVarsOrOptions: EnvVars | WorkflowTransitionOptions | undefined,
  options: WorkflowTransitionOptions | undefined,
): {
  envVars: EnvVars | undefined;
  options: WorkflowTransitionOptions;
} {
  if (isSandboxOptions(envVarsOrOptions)) {
    return {
      envVars: undefined,
      options: envVarsOrOptions as WorkflowTransitionOptions,
    };
  }

  return {
    envVars: envVarsOrOptions,
    options: options ?? {},
  };
}

const WORKFLOW_VERSION = "airalogy.workflow.v1";
const WORKFLOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const WORKFLOW_FIELD_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const WORKFLOW_REFERENCE_VALIDATION_PATTERN = /^\$\{[A-Za-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z][A-Za-z0-9_]*){2,}|\.(?:status|iteration))\}$/;
const WORKFLOW_REFERENCE_PATTERN = /^\$\{(?<root>[A-Za-z][A-Za-z0-9_]*)(?<path>(?:\.[A-Za-z][A-Za-z0-9_]*)+)\}$/;
const WORKFLOW_REFERENCE_FIND_PATTERN = /\$\{[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\}/g;
const WORKFLOW_WHEN_PATTERN = /^\s*(?<left>\$\{[^}]+\})(?:\s*(?<op>==|!=|>=|<=|>|<)\s*(?<right>.+?))?\s*$/;
const RECORD_DATA_SECTIONS = new Set(["var", "step", "check", "quiz", "workflow"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeWorkflowId(value: unknown, fieldName: string): string {
  const id = nonEmptyString(value, fieldName);
  if (!WORKFLOW_ID_PATTERN.test(id)) {
    throw new Error(`${fieldName} must start with a letter and contain only letters, digits, and underscores`);
  }
  return id;
}

function normalizeWorkflowIdList(value: unknown, fieldName: string): string[] {
  const values = Array.isArray(value)
    ? value.map((item, index) => normalizeWorkflowId(item, `${fieldName}[${index}]`))
    : [normalizeWorkflowId(value, fieldName)];
  if (values.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string or list`);
  }

  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item)) {
      throw new Error(`${fieldName} contains duplicate node id: ${item}`);
    }
    seen.add(item);
  }
  return values;
}

function normalizeWorkflowStringRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${fieldName} must be a mapping/object`);
  }

  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!WORKFLOW_ID_PATTERN.test(key)) {
      throw new Error(`${fieldName}.${key} must use an identifier key`);
    }
    result[key] = nonEmptyString(rawValue, `${fieldName}.${key}`);
  }
  return result;
}

function normalizeWorkflowValueRecord(
  value: unknown,
  fieldName: string,
): Record<string, AimdWorkflowAssignValue> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${fieldName} must be a mapping/object`);
  }

  const result: Record<string, AimdWorkflowAssignValue> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!WORKFLOW_ID_PATTERN.test(key)) {
      throw new Error(`${fieldName}.${key} must use an identifier key`);
    }
    result[key] = rawValue as AimdWorkflowAssignValue;
  }
  return result;
}

function normalizeWorkflowPermissions(value: unknown): AimdWorkflowPermissions | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error("assigner permissions must be a mapping/object");
  }

  const permissions: AimdWorkflowPermissions = {};
  for (const key of ["network", "secrets"] as const) {
    const rawList = value[key];
    if (rawList === undefined || rawList === null) {
      continue;
    }
    if (!Array.isArray(rawList) || !rawList.every((item) => typeof item === "string" && item.trim().length > 0)) {
      throw new Error(`permissions.${key} must be a list of non-empty strings`);
    }
    permissions[key] = rawList.map((item) => item.trim());
  }
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}

function normalizeWorkflowNode(rawNode: unknown, index: number): AimdWorkflowNodeField {
  if (!isPlainRecord(rawNode)) {
    throw new Error(`nodes[${index}] must be a mapping/object`);
  }

  const node: AimdWorkflowNodeField = {
    id: normalizeWorkflowId(rawNode.id, `nodes[${index}].id`),
  };

  const protocol = optionalString(rawNode.protocol, `nodes[${index}].protocol`);
  const protocolId = optionalString(rawNode.protocol_id, `nodes[${index}].protocol_id`);
  if (protocol === undefined && protocolId === undefined) {
    throw new Error(`nodes[${index}] must define protocol or protocol_id`);
  }
  if (protocol !== undefined) node.protocol = protocol;
  if (protocolId !== undefined) node.protocol_id = protocolId;

  const protocolVersion = optionalString(rawNode.protocol_version, `nodes[${index}].protocol_version`);
  const title = optionalString(rawNode.title, `nodes[${index}].title`);
  const description = optionalString(rawNode.description, `nodes[${index}].description`);
  if (protocolVersion !== undefined) node.protocol_version = protocolVersion;
  if (title !== undefined) node.title = title;
  if (description !== undefined) node.description = description;
  return node;
}

function normalizeWorkflowAssigner(rawAssigner: unknown, index: number): AimdWorkflowAssignerField {
  if (!isPlainRecord(rawAssigner)) {
    throw new Error(`assigners[${index}] must be a mapping/object`);
  }

  const assigner: AimdWorkflowAssignerField = {
    id: normalizeWorkflowId(rawAssigner.id, `assigners[${index}].id`),
    runtime: nonEmptyString(rawAssigner.runtime, `assigners[${index}].runtime`),
  };

  const entrypoint = optionalString(rawAssigner.entrypoint, `assigners[${index}].entrypoint`);
  if (assigner.runtime === "python" && entrypoint === undefined) {
    throw new Error(`assigners[${index}].entrypoint is required for python runtime`);
  }
  if (entrypoint !== undefined) assigner.entrypoint = entrypoint;

  const description = optionalString(rawAssigner.description, `assigners[${index}].description`);
  if (description !== undefined) assigner.description = description;

  const outputs = normalizeWorkflowStringRecord(rawAssigner.outputs, `assigners[${index}].outputs`);
  if (outputs !== undefined) assigner.outputs = outputs;

  const permissions = normalizeWorkflowPermissions(rawAssigner.permissions);
  if (permissions !== undefined) assigner.permissions = permissions;

  return assigner;
}

function normalizeWorkflowFieldAssignmentRecord(
  value: unknown,
  fieldName: string,
): Record<string, AimdWorkflowAssignValue> {
  if (!isPlainRecord(value)) {
    throw new Error(`${fieldName} must be a mapping/object`);
  }

  const result: Record<string, AimdWorkflowAssignValue> = {};
  for (const [fieldPath, rawValue] of Object.entries(value)) {
    if (!WORKFLOW_FIELD_PATH_PATTERN.test(fieldPath)) {
      throw new Error(`${fieldName}.${fieldPath} must be a workflow field path like var.sample_id`);
    }
    result[fieldPath] = rawValue as AimdWorkflowAssignValue;
  }
  return result;
}

function normalizeWorkflowTransitionAssign(
  value: unknown,
  targetIds: string[],
  fieldName: string,
): Record<string, Record<string, AimdWorkflowAssignValue>> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error(`${fieldName} must be a mapping/object`);
  }

  const targetSet = new Set(targetIds);
  const result: Record<string, Record<string, AimdWorkflowAssignValue>> = {};
  if (targetIds.length === 1) {
    const [onlyTarget] = targetIds;
    const groupedKeys = Object.keys(value).filter((key) => targetSet.has(key));
    if (groupedKeys.length > 0) {
      for (const [targetId, rawAssignments] of Object.entries(value)) {
        if (!targetSet.has(targetId)) {
          throw new Error(`${fieldName}.${targetId} must reference a transition target node`);
        }
        result[targetId] = normalizeWorkflowFieldAssignmentRecord(rawAssignments, `${fieldName}.${targetId}`);
      }
    } else if (onlyTarget !== undefined) {
      result[onlyTarget] = normalizeWorkflowFieldAssignmentRecord(value, `${fieldName}.${onlyTarget}`);
    }
    return result;
  }

  for (const [targetId, rawAssignments] of Object.entries(value)) {
    if (!targetSet.has(targetId)) {
      throw new Error(`${fieldName}.${targetId} must reference a transition target node`);
    }
    result[targetId] = normalizeWorkflowFieldAssignmentRecord(rawAssignments, `${fieldName}.${targetId}`);
  }
  return result;
}

function normalizeWorkflowTransition(
  rawTransition: unknown,
  index: number,
  nodeIds: Set<string>,
  assignerIds: Set<string>,
): AimdWorkflowTransitionField {
  if (!isPlainRecord(rawTransition)) {
    throw new Error(`transitions[${index}] must be a mapping/object`);
  }

  const id = normalizeWorkflowId(rawTransition.id, `transitions[${index}].id`);
  const from = normalizeWorkflowIdList(rawTransition.from, `transitions[${index}].from`);
  const to = normalizeWorkflowIdList(rawTransition.to, `transitions[${index}].to`);
  for (const sourceId of from) {
    if (!nodeIds.has(sourceId)) {
      throw new Error(`transitions[${index}].from references unknown node: ${sourceId}`);
    }
  }
  for (const targetId of to) {
    if (!nodeIds.has(targetId)) {
      throw new Error(`transitions[${index}].to references unknown node: ${targetId}`);
    }
  }

  const transition: AimdWorkflowTransitionField = { id, from, to };
  const when = optionalString(rawTransition.when, `transitions[${index}].when`);
  const run = optionalString(rawTransition.run, `transitions[${index}].run`);
  const label = optionalString(rawTransition.label, `transitions[${index}].label`);
  if (when !== undefined) transition.when = when;
  if (label !== undefined) transition.label = label;
  if (run !== undefined) {
    if (!assignerIds.has(run)) {
      throw new Error(`transitions[${index}].run references unknown assigner: ${run}`);
    }
    transition.run = run;
  }

  const inputs = normalizeWorkflowValueRecord(rawTransition.inputs, `transitions[${index}].inputs`);
  if (inputs !== undefined) transition.inputs = inputs;

  const maxIterations = rawTransition.max_iterations;
  if (maxIterations !== undefined && maxIterations !== null) {
    if (typeof maxIterations !== "number" || !Number.isInteger(maxIterations) || maxIterations <= 0) {
      throw new Error(`transitions[${index}].max_iterations must be a positive integer`);
    }
    transition.max_iterations = maxIterations;
  }

  const assign = normalizeWorkflowTransitionAssign(rawTransition.assign, to, `transitions[${index}].assign`);
  if (assign !== undefined) transition.assign = assign;

  return transition;
}

function collectDuplicateWorkflowIds(items: Array<{ id: string }>, fieldName: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`${fieldName} contains duplicate id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function parseWorkflowYamlMapping(content: string): Record<string, unknown> {
  const normalized = content.replace(/\r\n?/g, "\n");
  const document = parseDocument(normalized, {
    prettyErrors: true,
    uniqueKeys: true,
    merge: false,
    schema: "core",
    maxAliasCount: 32,
  } as any);

  if (document.errors.length > 0) {
    const [firstError] = document.errors;
    throw new Error(`Invalid workflow YAML: ${firstError.message}`);
  }

  const value = document.toJSON();
  if (!isPlainRecord(value)) {
    throw new Error("workflow block must be a YAML mapping/object");
  }
  return value;
}

export function isAimdWorkflowReference(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_REFERENCE_VALIDATION_PATTERN.test(value.trim());
}

export function parseWorkflowContent(content: string): AimdWorkflowField {
  const data = parseWorkflowYamlMapping(content);
  const version = nonEmptyString(data.version, "workflow.version");
  if (version !== WORKFLOW_VERSION) {
    throw new Error(`workflow.version must be ${WORKFLOW_VERSION}`);
  }

  const rawNodes = data.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error("workflow.nodes must be a non-empty list");
  }
  const nodes = rawNodes.map(normalizeWorkflowNode);
  collectDuplicateWorkflowIds(nodes, "workflow.nodes");
  const nodeIds = new Set(nodes.map((node) => node.id));

  const rawAssigners = data.assigners;
  const assigners = Array.isArray(rawAssigners)
    ? rawAssigners.map(normalizeWorkflowAssigner)
    : [];
  if (rawAssigners !== undefined && !Array.isArray(rawAssigners)) {
    throw new Error("workflow.assigners must be a list");
  }
  collectDuplicateWorkflowIds(assigners, "workflow.assigners");
  const assignerIds = new Set(assigners.map((assigner) => assigner.id));

  const rawTransitions = data.transitions;
  if (!Array.isArray(rawTransitions) || rawTransitions.length === 0) {
    throw new Error("workflow.transitions must be a non-empty list");
  }
  const transitions = rawTransitions.map((transition, index) =>
    normalizeWorkflowTransition(transition, index, nodeIds, assignerIds));
  collectDuplicateWorkflowIds(transitions, "workflow.transitions");

  const workflow: AimdWorkflowField = {
    id: normalizeWorkflowId(data.id, "workflow.id"),
    version: WORKFLOW_VERSION,
    nodes,
    assigners,
    transitions,
    raw: content,
  };

  const title = optionalString(data.title, "workflow.title");
  const description = optionalString(data.description, "workflow.description");
  const logic = optionalString(data.logic, "workflow.logic");
  const defaultInitialNode = optionalString(data.default_initial_node, "workflow.default_initial_node");
  const defaultResearchPurpose = optionalString(data.default_research_purpose, "workflow.default_research_purpose");
  const defaultResearchStrategy = optionalString(data.default_research_strategy, "workflow.default_research_strategy");
  if (title !== undefined) workflow.title = title;
  if (description !== undefined) workflow.description = description;
  if (logic !== undefined) workflow.logic = logic;
  if (defaultInitialNode !== undefined) {
    if (!nodeIds.has(defaultInitialNode)) {
      throw new Error(`workflow.default_initial_node references unknown node: ${defaultInitialNode}`);
    }
    workflow.default_initial_node = defaultInitialNode;
  }
  if (defaultResearchPurpose !== undefined) workflow.default_research_purpose = defaultResearchPurpose;
  if (defaultResearchStrategy !== undefined) workflow.default_research_strategy = defaultResearchStrategy;

  return workflow;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

function makeRecordDraft(): Record<string, unknown> {
  return {
    data: {
      check: {},
      quiz: {},
      step: {},
      var: {},
      workflow: {},
    },
  };
}

function nestedGet(value: unknown, pathParts: string[], context: string): unknown {
  let current = value;
  for (const part of pathParts) {
    if (isPlainRecord(current) && Object.hasOwn(current,part)) {
      current = current[part];
    } else {
      throw new Error(`Cannot resolve ${context}: missing ${part}`);
    }
  }
  return current;
}

function recordGet(record: Record<string, unknown>, pathParts: string[], context: string): unknown {
  if (pathParts.length === 0) {
    return record;
  }

  const [first] = pathParts;
  const data = record.data;
  if (
    first !== undefined &&
    RECORD_DATA_SECTIONS.has(first) &&
    isPlainRecord(data) &&
    first in data
  ) {
    return nestedGet(data, pathParts, context);
  }
  return nestedGet(record, pathParts, context);
}

function recordSet(record: Record<string, unknown>, pathParts: string[], value: unknown): void {
  if(pathParts.some(p=>['__proto__','constructor','prototype'].includes(p)))throw new Error('Reserved assignment path');
  if (pathParts.length === 0) {
    throw new Error("assignment field path must not be empty");
  }

  const [first] = pathParts;
  let current: Record<string, unknown>;
  if (first !== undefined && RECORD_DATA_SECTIONS.has(first)) {
    const existingData = record.data;
    if (existingData === undefined) {
      record.data = {};
    }
    if (!isPlainRecord(record.data)) {
      throw new Error("record.data must be a mapping/object");
    }
    current = record.data;
  } else {
    current = record;
  }

  for (const part of pathParts.slice(0, -1)) {
    const child = current[part];
    if (child === undefined) {
      current[part] = {};
    }
    if (!isPlainRecord(current[part])) {
      throw new Error(`Cannot assign ${pathParts.join(".")} through non-object field ${part}`);
    }
    current = current[part];
  }

  const finalPart = pathParts[pathParts.length - 1];
  current[finalPart] = cloneValue(value);
}

function parseLiteral(value: string): unknown {
  const normalized = value.trim();
  const lowered = normalized.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  if (lowered === "null") return null;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return normalized;
  }
}

function compareWorkflowValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return (left as number) > (right as number);
    case "<":
      return (left as number) < (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<=":
      return (left as number) <= (right as number);
    default:
      throw new Error(`Unsupported workflow condition operator: ${op}`);
  }
}

function readWorkflowDefinition(workflowPath: string, workflowId?: string): {
  workflow: AimdWorkflowField;
  workflowRoot: string;
} {
  let resolvedPath = path.resolve(workflowPath);
  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    resolvedPath = path.join(resolvedPath, "workflow.aimd");
  }
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`workflow_path must be a workflow file: ${workflowPath}`);
  }

  const source = readFileSync(resolvedPath, "utf8");
  const workflowBlocks = [...source.matchAll(/^[ \t]*```workflow\b[^\n]*\n([\s\S]*?)^[ \t]*```/gm)];
  const workflows = workflowBlocks.length > 0
    ? workflowBlocks.map((match) => parseWorkflowContent(match[1]?.trimEnd() ?? ""))
    : [parseWorkflowContent(source)];
  const filtered = workflowId === undefined
    ? workflows
    : workflows.filter((workflow) => workflow.id === workflowId);
  if (workflowId !== undefined && filtered.length === 0) {
    throw new Error(`workflow id not found: ${workflowId}`);
  }
  if (filtered.length !== 1) {
    throw new Error("workflow_path must contain exactly one workflow block");
  }

  return {
    workflow: filtered[0],
    workflowRoot: path.dirname(resolvedPath),
  };
}

function resolveWorkflowReference(
  reference: string,
  records: Record<string, unknown>,
  transitionOutputs: Record<string, unknown>,
  nodeIterations: Record<string, number>,
): unknown {
  const match = WORKFLOW_REFERENCE_PATTERN.exec(reference);
  const groups = match?.groups;
  if (groups === undefined) {
    throw new Error(`Invalid workflow reference: ${reference}`);
  }

  const root = groups.root;
  const pathParts = groups.path.slice(1).split(".");
  if (pathParts[0] === "outputs") {
    if (!(root in transitionOutputs)) {
      throw new Error(`Transition output not available: ${root}.outputs`);
    }
    return nestedGet(
      transitionOutputs[root],
      pathParts.slice(1),
      `${root}.${pathParts.join(".")}`,
    );
  }
  if (pathParts.length === 1 && pathParts[0] === "iteration") {
    return nodeIterations[root] ?? 0;
  }
  if (pathParts.length === 1 && pathParts[0] === "status") {
    if (!(root in records)) {
      throw new Error(`Record not available for node: ${root}`);
    }
    const record = records[root];
    if (isPlainRecord(record)) {
      if ("status" in record) return record.status;
      if (isPlainRecord(record.metadata) && "status" in record.metadata) {
        return record.metadata.status;
      }
    }
    return null;
  }

  if (!(root in records)) {
    throw new Error(`Record not available for node: ${root}`);
  }
  const record = records[root];
  if (!isPlainRecord(record)) {
    throw new Error(`Record for node ${root} must be a mapping/object`);
  }
  return recordGet(record, pathParts, `${root}.${pathParts.join(".")}`);
}

function resolveWorkflowValue(
  value: AimdWorkflowAssignValue,
  records: Record<string, unknown>,
  transitionOutputs: Record<string, unknown>,
  nodeIterations: Record<string, number>,
): unknown {
  if (typeof value !== "string") {
    return cloneValue(value);
  }

  const trimmed = value.trim();
  if (WORKFLOW_REFERENCE_PATTERN.test(trimmed)) {
    return cloneValue(resolveWorkflowReference(trimmed, records, transitionOutputs, nodeIterations));
  }

  if (WORKFLOW_REFERENCE_FIND_PATTERN.test(value)) {
    WORKFLOW_REFERENCE_FIND_PATTERN.lastIndex = 0;
    return value.replace(WORKFLOW_REFERENCE_FIND_PATTERN, (reference) =>
      String(resolveWorkflowReference(reference, records, transitionOutputs, nodeIterations)));
  }

  return value;
}

function evaluateWorkflowWhen(
  when: string | undefined,
  records: Record<string, unknown>,
  transitionOutputs: Record<string, unknown>,
  nodeIterations: Record<string, number>,
): boolean {
  if (when === undefined || when.trim().length === 0) {
    return true;
  }

  const match = WORKFLOW_WHEN_PATTERN.exec(when);
  const groups = match?.groups;
  if (groups === undefined) {
    throw new Error(`Unsupported workflow condition: ${when}`);
  }

  const left = resolveWorkflowValue(groups.left, records, transitionOutputs, nodeIterations);
  if (groups.op === undefined) {
    return Boolean(left);
  }
  const rawRight = groups.right;
  if (rawRight === undefined) {
    throw new Error(`Unsupported workflow condition: ${when}`);
  }
  const resolvedRight = resolveWorkflowValue(rawRight, records, transitionOutputs, nodeIterations);
  const right = typeof resolvedRight === "string" && !WORKFLOW_REFERENCE_PATTERN.test(resolvedRight.trim())
    ? parseLiteral(resolvedRight)
    : resolvedRight;
  return compareWorkflowValues(left, groups.op, right);
}

function resolveWorkflowInputs(
  transition: AimdWorkflowTransitionField,
  records: Record<string, unknown>,
  transitionOutputs: Record<string, unknown>,
  nodeIterations: Record<string, number>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transition.inputs ?? {})) {
    inputs[key] = resolveWorkflowValue(value, records, transitionOutputs, nodeIterations);
  }
  return inputs;
}

async function executeInSandbox(action:string, protocolPath:string, params:Record<string,unknown>, envVars?:EnvVars, options:SandboxOptions={}) { return runDockerExecutor(action,protocolPath,params,options); }
async function runWorkflowAssignerInSandbox(root:string,entrypoint:string,inputs:Record<string,unknown>,envVars?:EnvVars,options:SandboxOptions={}) {
  const result=await runDockerExecutor('workflow_assign',root,{entrypoint,inputs},options);
  if(!result.success)throw new Error(result.message || 'Workflow assigner failed');
  return result.data?.outputs || {};
}
async function runWorkflowAssignerLocally():Promise<Record<string,unknown>> {throw new Error('本地宿主 Python 执行已禁用，请使用隔离执行环境。');}
function normalizeWorkflowAssignerRuntime(value: WorkflowAssignerRuntime | undefined): WorkflowAssignerRuntime {
  return value === "local" ? "local" : "sandbox";
}

function workflowNodeProtocolIdentifier(node: AimdWorkflowNodeField): string {
  return node.protocol_id ?? node.protocol ?? node.id;
}

function workflowNodeProtocolIndexMap(workflow: AimdWorkflowField): Map<string, number> {
  return new Map(workflow.nodes.map((node, index) => [node.id, index]));
}

function buildWorkflowProtocolsInfo(workflow: AimdWorkflowField): WorkflowProtocolInfo[] {
  return workflow.nodes.map((node, index) => ({
    protocol_index: index,
    protocol_id: workflowNodeProtocolIdentifier(node),
    protocol_version: node.protocol_version ?? null,
    airalogy_protocol_id: node.protocol_id ?? null,
    protocol_data: {
      node_id: node.id,
      title: node.title ?? null,
      description: node.description ?? null,
      protocol_path: node.protocol ?? null,
      markdown: null,
      model: null,
      assigner: null,
      field_json_schema: null,
    },
  }));
}

function optionalRecordString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalRecordVersion(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : null;
}

function workflowRecordReference(record: unknown): {
  record_id: string | null;
  record_version: number | null;
  airalogy_record_id: string | null;
} {
  if (!isPlainRecord(record)) {
    return {
      record_id: null,
      record_version: null,
      airalogy_record_id: null,
    };
  }
  const metadata = isPlainRecord(record.metadata) ? record.metadata : {};
  return {
    record_id: optionalRecordString(record.record_id) ?? optionalRecordString(record.id),
    record_version: optionalRecordVersion(record.record_version)
      ?? optionalRecordVersion(record.version)
      ?? optionalRecordVersion(metadata.record_ver),
    airalogy_record_id: optionalRecordString(record.airalogy_record_id),
  };
}

function workflowRecordProtocolStep(
  workflow: AimdWorkflowField,
  nodeId: string,
  record: unknown,
  pathIndex: number,
  mode: WorkflowPathStepMode,
  source: string,
): WorkflowPathStep {
  const protocolIndex = workflowNodeProtocolIndexMap(workflow).get(nodeId) ?? -1;
  const ref = workflowRecordReference(record);
  return {
    step: "record_protocol",
    path_index: pathIndex,
    mode,
    data: {
      node_id: nodeId,
      protocol_index: protocolIndex,
      ...ref,
      record_ref_available: ref.record_id !== null || ref.airalogy_record_id !== null,
      source,
    },
  };
}

function initialWorkflowPathSteps(
  workflow: AimdWorkflowField,
  records: Record<string, unknown>,
): WorkflowPathStep[] {
  const steps: WorkflowPathStep[] = [];
  for (const node of workflow.nodes) {
    if (records[node.id] !== undefined) {
      steps.push(workflowRecordProtocolStep(
        workflow,
        node.id,
        records[node.id],
        steps.length + 1,
        "user",
        "input",
      ));
    }
  }
  return steps;
}

function transitionWorkflowPathSteps(
  workflow: AimdWorkflowField,
  transition: AimdWorkflowTransitionField,
  assignedValues: Record<string, Record<string, unknown>>,
  startPathIndex: number,
): WorkflowPathStep[] {
  const protocolIndexes = workflowNodeProtocolIndexMap(workflow);
  const steps: WorkflowPathStep[] = [];
  let targetOffset = 0;

  for (const targetNode of transition.to) {
    const protocolIndex = protocolIndexes.get(targetNode) ?? -1;
    const pathIndex = startPathIndex + targetOffset;
    targetOffset += 1;
    steps.push({
      step: "add_next_protocol",
      path_index: pathIndex,
      mode: "ai",
      data: {
        thought: null,
        transition_id: transition.id,
        from: cloneValue(transition.from),
        node_id: targetNode,
        protocol_index: protocolIndex,
        end_path: false,
      },
    });
    steps.push({
      step: "add_initial_values_for_fields_in_next_protocol",
      path_index: pathIndex,
      mode: "ai",
      data: {
        thought: null,
        transition_id: transition.id,
        node_id: targetNode,
        protocol_index: protocolIndex,
        values: cloneValue(assignedValues[targetNode] ?? {}),
      },
    });
  }

  return steps;
}

function reindexWorkflowPathSteps(
  steps: WorkflowPathStep[],
  startPathIndex: number,
): WorkflowPathStep[] {
  const indexMap = new Map<number, number>();
  let nextPathIndex = startPathIndex;
  return steps.map((step) => {
    if (!indexMap.has(step.path_index)) {
      indexMap.set(step.path_index, nextPathIndex);
      nextPathIndex += 1;
    }
    return {
      ...step,
      path_index: indexMap.get(step.path_index) ?? step.path_index,
      data: cloneValue(step.data),
    };
  });
}

function nextWorkflowPathIndex(steps: WorkflowPathStep[]): number {
  return steps.reduce((nextIndex, step) => (
    Number.isFinite(step.path_index) && step.path_index >= nextIndex
      ? step.path_index + 1
      : nextIndex
  ), 1);
}

function workflowPathStatus(success: boolean, steps: WorkflowPathStep[]): string {
  if (!success) {
    return "waiting_for_next_protocol";
  }
  if (steps.some((step) => step.step === "add_initial_values_for_fields_in_next_protocol")) {
    return "waiting_for_record";
  }
  return "completed";
}

function buildWorkflowData(
  workflow: AimdWorkflowField,
  steps: WorkflowPathStep[],
  success: boolean,
): WorkflowData {
  return {
    protocols_info: buildWorkflowProtocolsInfo(workflow),
    path_data: {
      path_status: workflowPathStatus(success, steps),
      steps: cloneValue(steps),
    },
  };
}

async function runWorkflowTransitionInternal(
  workflow: AimdWorkflowField,
  workflowRoot: string,
  transitionId: string,
  records: Record<string, unknown>,
  envVars: EnvVars | undefined,
  options: WorkflowTransitionOptions,
): Promise<ProtocolResult> {
  options.signal?.throwIfAborted();
  const transition = workflow.transitions.find((item) => item.id === transitionId);
  if (transition === undefined) {
    return { success: false, message: `workflow transition not found: ${transitionId}` };
  }

  const stateRecords = cloneValue(records);
  const transitionOutputs = cloneValue(options.transitionOutputs ?? {});
  const nodeIterations = { ...options.nodeIterations };
  const attempts: Array<Record<string, unknown>> = [];
  const executedTransitions: Array<Record<string, unknown>> = [];
  const skippedTransitions: Array<Record<string, unknown>> = [];
  const pathSteps: WorkflowPathStep[] = [];

  try {
    if (!evaluateWorkflowWhen(transition.when, stateRecords, transitionOutputs, nodeIterations)) {
      skippedTransitions.push({ id: transitionId, reason: "when_false" });
      const workflowSteps = initialWorkflowPathSteps(workflow, records);
      return {
        success: true,
        data: {
          workflow,
          records: stateRecords,
          transition_outputs: transitionOutputs,
          executed_transitions: executedTransitions,
          skipped_transitions: skippedTransitions,
          attempts,
          node_iterations: nodeIterations,
          path_steps: pathSteps,
          workflow_data: buildWorkflowData(workflow, workflowSteps, true),
        },
      };
    }

    let runId: string | undefined;
    if (transition.run !== undefined) {
      runId = transition.run;
      const assigner = workflow.assigners.find((item) => item.id === runId);
      if (assigner === undefined) {
        throw new Error(`workflow assigner not found: ${runId}`);
      }
      if (assigner.runtime !== "python") {
        throw new Error(`Unsupported workflow assigner runtime: ${assigner.runtime}`);
      }
      if (assigner.entrypoint === undefined) {
        throw new Error("python workflow assigner requires entrypoint");
      }

      const inputs = resolveWorkflowInputs(transition, stateRecords, transitionOutputs, nodeIterations);
      const assignerRuntime = normalizeWorkflowAssignerRuntime(options.assignerRuntime);
      const attempt: Record<string, unknown> = {
        transition: transitionId,
        assigner: runId,
        runtime: assignerRuntime,
        status: "running",
      };
      attempts.push(attempt);
      const outputs = assignerRuntime === "local"
        ? await runWorkflowAssignerLocally(
          workflowRoot,
          assigner.entrypoint,
          inputs,
          envVars,
          options,
        )
        : await runWorkflowAssignerInSandbox(
          workflowRoot,
          assigner.entrypoint,
          inputs,
          envVars,
          options,
        );
      attempt.status = "succeeded";
      attempt.outputs = cloneValue(outputs);
      transitionOutputs[transitionId] = cloneValue(outputs);
    }

    const assignedValuesByTarget: Record<string, Record<string, unknown>> = {};
    for (const [targetNode, assignments] of Object.entries(transition.assign ?? {})) {
      const existing = stateRecords[targetNode];
      if (existing !== undefined && !isPlainRecord(existing)) {
        throw new Error(`Record for target node ${targetNode} must be a mapping/object`);
      }
      const targetRecord = existing === undefined
        ? makeRecordDraft()
        : cloneValue(existing as Record<string, unknown>);
      for (const [fieldPath, rawValue] of Object.entries(assignments)) {
        const value = resolveWorkflowValue(rawValue, stateRecords, transitionOutputs, nodeIterations);
        recordSet(targetRecord, fieldPath.split("."), value);
        assignedValuesByTarget[targetNode] ??= {};
        assignedValuesByTarget[targetNode][fieldPath] = cloneValue(value);
      }
      stateRecords[targetNode] = targetRecord;
    }

    for (const targetNode of transition.to) {
      nodeIterations[targetNode] = (nodeIterations[targetNode] ?? 0) + 1;
    }

    executedTransitions.push({
      id: transitionId,
      from: transition.from,
      to: transition.to,
      run: runId,
    });
    pathSteps.push(...transitionWorkflowPathSteps(workflow, transition, assignedValuesByTarget, 1));

    const workflowSteps = [
      ...initialWorkflowPathSteps(workflow, records),
      ...reindexWorkflowPathSteps(pathSteps, initialWorkflowPathSteps(workflow, records).length + 1),
    ];
    return {
      success: true,
      data: {
        workflow,
        records: stateRecords,
        transition_outputs: transitionOutputs,
        executed_transitions: executedTransitions,
        skipped_transitions: skippedTransitions,
        attempts,
        node_iterations: nodeIterations,
        path_steps: pathSteps,
        workflow_data: buildWorkflowData(workflow, workflowSteps, true),
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    for (const attempt of attempts) {
      if (attempt.status === "running") {
        attempt.status = "failed";
        attempt.message = message;
      }
    }
    const workflowSteps = [
      ...initialWorkflowPathSteps(workflow, records),
      ...reindexWorkflowPathSteps(pathSteps, initialWorkflowPathSteps(workflow, records).length + 1),
    ];
    return {
      success: false,
      message,
      data: {
        workflow,
        records: stateRecords,
        transition_outputs: transitionOutputs,
        executed_transitions: executedTransitions,
        skipped_transitions: skippedTransitions,
        attempts,
        node_iterations: nodeIterations,
        path_steps: pathSteps,
        workflow_data: buildWorkflowData(workflow, workflowSteps, false),
      },
    };
  }
}

export function parseProtocol(
  protocolPath: string,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export function parseProtocol(
  protocolPath: string,
  envVars?: EnvVars,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export async function parseProtocol(
  protocolPath: string,
  envVarsOrOptions?: EnvVars | SandboxOptions,
  options?: SandboxOptions,
): Promise<ProtocolResult> {
  const resolved = resolveEnvAndOptions(envVarsOrOptions, options);
  return executeInSandbox("parse_protocol", protocolPath, {}, resolved.envVars, resolved.options);
}

export function assignVariable(
  protocolPath: string,
  varName: string,
  dependentData: Record<string, unknown>,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export function assignVariable(
  protocolPath: string,
  varName: string,
  dependentData: Record<string, unknown>,
  envVars?: EnvVars,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export async function assignVariable(
  protocolPath: string,
  varName: string,
  dependentData: Record<string, unknown>,
  envVarsOrOptions?: EnvVars | SandboxOptions,
  options?: SandboxOptions,
): Promise<ProtocolResult> {
  const resolved = resolveEnvAndOptions(envVarsOrOptions, options);
  const params = {
    var_name: varName,
    dependent_data: dependentData,
  };
  return executeInSandbox("assign_variable", protocolPath, params, resolved.envVars, resolved.options);
}

export function validateVariables(
  protocolPath: string,
  vars: Record<string, unknown>,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export function validateVariables(
  protocolPath: string,
  vars: Record<string, unknown>,
  envVars?: EnvVars,
  options?: SandboxOptions,
): Promise<ProtocolResult>;
export async function validateVariables(
  protocolPath: string,
  vars: Record<string, unknown>,
  envVarsOrOptions?: EnvVars | SandboxOptions,
  options?: SandboxOptions,
): Promise<ProtocolResult> {
  const resolved = resolveEnvAndOptions(envVarsOrOptions, options);
  return executeInSandbox("validate_variables", protocolPath, vars, resolved.envVars, resolved.options);
}

/**
 * Apply a Protocol schema migration in the sandbox. This API intentionally
 * accepts no environment map so transforms cannot receive host secrets.
 */
export async function migrateSchema(
  protocolPath: string,
  data: Record<string, unknown>,
  manifest: Record<string, unknown>,
  options: SandboxOptions = {},
): Promise<ProtocolResult> {
  return executeInSandbox(
    "migrate_schema",
    protocolPath,
    { data, manifest },
    undefined,
    options,
  );
}

export function runWorkflow(
  workflowPath: string,
  records: Record<string, unknown>,
  options?: WorkflowRunOptions,
): Promise<ProtocolResult>;
export function runWorkflow(
  workflowPath: string,
  records: Record<string, unknown>,
  envVars?: EnvVars,
  options?: WorkflowRunOptions,
): Promise<ProtocolResult>;
export async function runWorkflow(
  workflowPath: string,
  records: Record<string, unknown>,
  envVarsOrOptions?: EnvVars | WorkflowRunOptions,
  options?: WorkflowRunOptions,
): Promise<ProtocolResult> {
  const resolved = resolveEnvAndWorkflowRunOptions(envVarsOrOptions, options);
  const { workflow, workflowRoot } = readWorkflowDefinition(
    workflowPath,
    resolved.options.workflowId,
  );
  const selectedTransitionIds = resolved.options.transitionIds ?? workflow.transitions.map((transition) => transition.id);
  const maxPasses = resolved.options.maxPasses ?? 1;
  if (!Number.isInteger(maxPasses) || maxPasses < 1) {
    return { success: false, message: "maxPasses must be a positive integer" };
  }

  const knownTransitions = new Set(workflow.transitions.map((transition) => transition.id));
  for (const transitionId of selectedTransitionIds) {
    if (!knownTransitions.has(transitionId)) {
      return { success: false, message: `workflow transition not found: ${transitionId}` };
    }
  }

  let stateRecords = cloneValue(records);
  let transitionOutputs = cloneValue(resolved.options.transitionOutputs ?? {});
  let nodeIterations = { ...resolved.options.nodeIterations };
  const transitionCounts: Record<string, number> = {};
  const executedTransitions: Array<Record<string, unknown>> = [];
  const skippedTransitions: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const pathSteps: WorkflowPathStep[] = initialWorkflowPathSteps(workflow, records);

  for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
    for (const transitionId of selectedTransitionIds) {
      const transition = workflow.transitions.find((item) => item.id === transitionId);
      if (transition === undefined) {
        return { success: false, message: `workflow transition not found: ${transitionId}` };
      }

      const count = transitionCounts[transitionId] ?? 0;
      if (transition.max_iterations !== undefined && count >= transition.max_iterations) {
        skippedTransitions.push({ id: transitionId, reason: "max_iterations" });
        continue;
      }

      const result = await runWorkflowTransitionInternal(
        workflow,
        workflowRoot,
        transitionId,
        stateRecords,
        resolved.envVars,
        {
          ...resolved.options,
          transitionOutputs,
          nodeIterations,
        },
      );
      const data = result.data ?? {};
      if (Array.isArray(data.path_steps)) {
        pathSteps.push(...reindexWorkflowPathSteps(
          data.path_steps as WorkflowPathStep[],
          nextWorkflowPathIndex(pathSteps),
        ));
      }
      if (Array.isArray(data.attempts)) {
        attempts.push(...data.attempts as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.skipped_transitions)) {
        skippedTransitions.push(...data.skipped_transitions as Array<Record<string, unknown>>);
      }
      if (!result.success) {
        return {
          ...result,
          data: {
            ...data,
            attempts,
            skipped_transitions: skippedTransitions,
            executed_transitions: executedTransitions,
            path_steps: pathSteps,
            workflow_data: buildWorkflowData(workflow, pathSteps, false),
          },
        };
      }

      if (isPlainRecord(data.records)) {
        stateRecords = data.records;
      }
      if (isPlainRecord(data.transition_outputs)) {
        transitionOutputs = data.transition_outputs;
      }
      if (isPlainRecord(data.node_iterations)) {
        nodeIterations = data.node_iterations as Record<string, number>;
      }
      const executed = Array.isArray(data.executed_transitions)
        ? data.executed_transitions as Array<Record<string, unknown>>
        : [];
      if (executed.length > 0) {
        transitionCounts[transitionId] = count + 1;
        executedTransitions.push(...executed);
      }
    }
  }

  return {
    success: true,
    data: {
      workflow,
      records: stateRecords,
      transition_outputs: transitionOutputs,
      executed_transitions: executedTransitions,
      skipped_transitions: skippedTransitions,
      attempts,
      node_iterations: nodeIterations,
      path_steps: pathSteps,
      workflow_data: buildWorkflowData(workflow, pathSteps, true),
    },
  };
}

export function runWorkflowTransition(
  workflowPath: string,
  transitionId: string,
  records: Record<string, unknown>,
  options?: WorkflowTransitionOptions,
): Promise<ProtocolResult>;
export function runWorkflowTransition(
  workflowPath: string,
  transitionId: string,
  records: Record<string, unknown>,
  envVars?: EnvVars,
  options?: WorkflowTransitionOptions,
): Promise<ProtocolResult>;
export async function runWorkflowTransition(
  workflowPath: string,
  transitionId: string,
  records: Record<string, unknown>,
  envVarsOrOptions?: EnvVars | WorkflowTransitionOptions,
  options?: WorkflowTransitionOptions,
): Promise<ProtocolResult> {
  const resolved = resolveEnvAndWorkflowTransitionOptions(envVarsOrOptions, options);
  const { workflow, workflowRoot } = readWorkflowDefinition(
    workflowPath,
    resolved.options.workflowId,
  );
  return runWorkflowTransitionInternal(
    workflow,
    workflowRoot,
    transitionId,
    cloneValue(records),
    resolved.envVars,
    resolved.options,
  );
}
