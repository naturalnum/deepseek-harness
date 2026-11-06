import { z } from 'zod';
const text = z.string().trim().min(1).max(20000);
const id = z.string().regex(/^[\w.-]{1,120}$/);
const ids = z.array(id).max(100);
const version = {id, expectedRevision:z.number().int().min(0), requestId:text};
const kind = z.enum(['evidence','claim','report','roadmap','labskill']);
export const scienceContracts = {
  lab_skills:{description:'List explicitly human-published skills from this local installation. Drafts are never exposed to other conversations.',shape:{}},
  lab_skill_put:{description:'Save a versioned lab skill draft with Markdown procedure and pinned evidence references. Editing unpublishes the skill until renewed human approval.',shape:{...version,title:text,markdown:text,evidenceIds:ids}},
  lab_skill_publish:{description:'Human-only: publish or withdraw this skill from the local Harness skill library. Publishing requires accepted source evidence and an explicit review reason.',shape:{...version,published:z.boolean(),reason:text}},
  science_state: {description:'Read this conversation’s research routes, evidence, claims and reports. Inspect revisions before editing.',shape:{}},
  science_revision: {description:'Read an immutable saved revision including its source snapshots and audit identity.',shape:{kind,id,revision:z.number().int().positive()}},
  evidence_put: {description:'Register observed evidence with a real attachment, chart, pinned record revision or a cited excerpt. This creates a draft; only a human may review evidence. Preserve measured/synthetic/literature/estimated basis.',shape:{...version,title:text,observation:text,basis:z.enum(['measured','synthetic','literature','estimated']),source:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('attachment'),reference:z.string().regex(/^attachment:[a-f0-9]{64}$/)}).strict(),
    z.object({kind:z.literal('record'),id:text,revision:z.number().int().positive()}).strict(),
    z.object({kind:z.literal('chart'),id:text}).strict(),
    z.object({kind:z.literal('citation'),url:z.string().url().max(2000),excerpt:text}).strict(),
  ])}},
  evidence_review: {description:'Human-only: record a review result and reason for this exact evidence revision. This is a human assessment, not automatic proof of scientific correctness.',shape:{...version,result:z.enum(['accepted','rejected']),reason:text}},
  claim_put: {description:'Save a scientific claim and explicit limitations, linked to evidence in this conversation. Supported/refuted claims require human-accepted evidence. Source revisions are snapshotted.',shape:{...version,title:text,statement:text,limitations:text,status:z.enum(['proposed','supported','refuted','inconclusive']),evidenceIds:ids}},
  report_put: {description:'Save a research report in Markdown with pinned claim and evidence revisions. Include limitations; all referenced items must exist in this conversation.',shape:{...version,title:text,markdown:z.string().trim().min(1).max(500000),claimIds:ids,evidenceIds:ids}},
  roadmap_put: {description:'Create/update a DeepScientist research route using schema deepscientist.science.research_route.v1. Original route validator applies. No second Goal scheduler. Pending branch selection and verified stage changes require the human workbench.',shape:{...version,route:z.record(z.unknown())}},
  roadmap_select: {description:'Human-only: answer a pending route decision by selecting an explicitly offered node. Saves the decision; does not start a model task or Git operation.',shape:{...version,nodeId:id}},
  science_export: {description:'Export this conversation’s research routes, evidence snapshots, claims, reports and revision history as a self-contained JSON ledger.',shape:{}},
};
