import {documentContracts} from './documents.mjs';
import {engineContracts} from './engine-contracts.mjs';
import { z } from "zod";
import { scienceContracts } from './science-contracts.mjs';
import {gitContracts} from './project-git.mjs';
import {taskContracts} from './task-contracts.mjs';
const id = z.string().min(1),
  revision = z.number().int().positive();
const write = {
  requestId: id.describe(
    "Stable unique ID for this write; reuse only when retrying the identical request.",
  ),
};
const record = { id, expectedRevision: revision, ...write };
export const contracts = {
  ...taskContracts,
  ...documentContracts,
  ...scienceContracts,
  ...gitContracts,
  ...engineContracts,
  state: {
    description:
      "List protocols, visible records and chart artifacts in this explicitly configured research workspace.",
    shape: { includeArchived: z.boolean().default(false) },
  },
  protocol_put: {
    description:
      "Create an immutable AIMD protocol version. Existing versions cannot be overwritten.",
    shape: { id, version: id, content: id, ...write },
  },
  protocol_get: {
    description: "Read one exact protocol version.",
    shape: { id, version: id },
  },
  record_create: {
    description: "Create a draft pinned to an exact protocol version.",
    shape: { protocolId: id, protocolVersion: id, ...write },
  },
  record_get: {
    description:
      "Read a record, current revision and audit history before editing.",
    shape: { id },
  },
  record_bind_engine: {
    description: 'Human-only: bind a draft record to an approved Airalogy protocol package with identical AIMD. Automatic calculations then run on record_update and record the input and calculation-package hashes.',
    shape: {...record,packageId:id,version:id},
  },
  record_update: {
    description:
      "Save a draft with compare-and-swap revision. A bound approved Airalogy package recalculates automatic fields and charts from the actual inputs before saving, retaining the run ID, input hash and package hash. Agent may change only agent-owned inputs. run has status ready/running and object values,tables,steps,checks,quizzes. Read current run first; preserve fields owned by others.",
    shape: {
      ...record,
      run: z
        .object({
          status: z.enum(["ready", "running"]),
          values: z.record(z.unknown()),
          tables: z.record(z.array(z.record(z.unknown()))),
          steps: z.record(z.boolean()),
          checks: z.record(z.boolean()),
          quizzes: z.record(z.unknown()),
        })
        .passthrough(),
    },
  },
  record_submit: {
    description:
      "Human-only API: submit a running draft after review and structural completeness checks. The native Harness tool requests authenticated human confirmation in the conversation, including every check; direct agent API requests remain forbidden. This does not run Python validators or prove scientific correctness.",
    shape: record,
  },
  record_reopen: {
    description:
      "Human-only: amend a submitted record with an explicit reason; preserves the previous submitted snapshot.",
    shape: { ...record, reason: id },
  },
  record_archive: {
    description:
      "Human-only: archive a record while preserving its audit trail. Can be restored with record_restore.",
    shape: { ...record, reason: id },
  },
  record_restore: {
    description: "Human-only: restore an archived record with a reason and revision check.",
    shape: { ...record, reason: id },
  },
  attachment_put: {
    description: "Store a real attachment (maximum 2 MiB), returning an immutable attachment:SHA256 reference for a file field. Base64 must encode the actual file bytes.",
    shape: { name: z.string().min(1).max(255), contentBase64: z.string().max(2796204), ...write },
  },
  attachment_get: {
    description: "Read attachment metadata and verified bytes by its attachment:SHA256 reference.",
    shape: { reference: z.string().regex(/^attachment:[a-f0-9]{64}$/) },
  },
  record_export: {
    description:
      "Export an Airalogy record JSON envelope with var,step,check,quiz and DeepScientist audit extensions. No fabricated timer values.",
    shape: { id },
  },
  engine_outputs_save:{description:'Save generated files from a successful engine run into this conversation, preserving exact bytes and the run identity.',shape:{id,...write}},
  local_search:{description:'Offline exact-text search across current conversation text attachments, records, routes, evidence, claims and reports. Returns source hashes, offsets and excerpts; candidates require review. No network request.',shape:{query:z.string().trim().min(1).max(200),max_results:z.number().int().min(1).max(20).default(10)}},
  archive_inspect: {description:'Validate an Airalogy .aira archive and preview its protocol/record/file counts before import.',shape:{contentBase64:z.string().max(90*1024*1024)}},
  workspace_import: {description:'Human-only: atomically import a validated .aira archive into this conversation. Existing versions cannot change; records become new drafts with original payload retained and review checks reset.',shape:{contentBase64:z.string().max(90*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),restoreResearch:z.boolean().default(true),...write}},
  workspace_export: {
    description: "Export this conversation as a validated Airalogy .aira archive, including protocols, records, charts and actual attachment bytes.",
    shape: {},
  },
  history_list: {
    description: "Human-only: list historical items without a conversation association.",
    shape: {},
  },
  history_associate: {
    description: "Human-only: explicitly associate an unassigned historical record or artifact with this conversation.",
    shape: { kind: z.enum(["record", "artifact"]), id, ...write },
  },
  chart_render: {
    description:
      'Validate a DeepScientist report_chart spec and save a chart in this conversation. Minimal example: {"schema":"deepscientist.report_chart.v1","kind":"bar","title":"Comparison","data":[{"id":"a","label":"A","value":12}]}. Use schema and kind, not version or type.',
    shape: { spec: z.record(z.unknown()), ...write },
  },
  literature_search: {
    description:
      "Search bibliographic metadata using copied V2 providers. Results are candidates, not verified full-text evidence.",
    shape: {
      query: id,
      source: z
        .enum([
          "openalex",
          "semantic_scholar",
          "arxiv",
          "openreview",
          "crossref",
          "dblp",
        ])
        .default("openalex"),
      max_results: z.number().int().min(1).max(20).default(5),
    },
  },
};
export function validateArgs(op, args) {
  const c = contracts[op];
  if (!c) throw new Error("Unknown operation");
  return z.object(c.shape).strict().parse(args);
}
