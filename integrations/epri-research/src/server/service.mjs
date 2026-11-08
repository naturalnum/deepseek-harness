import {accessStore} from './access.mjs';
import {researchTaskStore} from './research-tasks.mjs';
import {taskContracts} from './task-contracts.mjs';
import {documentStore,documentContracts} from './documents.mjs';
import {searchLocal} from './local-search.mjs';
import {prepareArchive,importPrepared,restoreTasks} from './archive-import.mjs';
import {restoreResearch} from './research-import.mjs';
import {engineStore} from './engine.mjs';
import {engineContracts} from './engine-contracts.mjs';
import {bindCalculation,executeCalculation,stripCalculated,calculationHash} from './record-calculation.mjs';
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  parseAimdProtocol,
  buildAimdFieldOwnership,
  isAimdValueComplete,
} from "../reused/protocol/aimdProtocolModel.ts";
import { reportChartSpecSchema } from "../reused/common/reportChart.ts";
import { renderReportChartSvg } from "../reused/services/reportChartSvg.ts";
import { searchLiterature } from "../reused/literature/literatureSearch.ts";
import { buildCompactLiteratureSearchPayload } from "../reused/literature/researchEvidencePayload.ts";
import { contracts } from "./contracts.mjs";
import { exportWorkspace } from "./archive.mjs";
import { scienceStore } from './science.mjs';
import {projectGitStore,gitContracts} from './project-git.mjs';
import { scienceContracts } from './science-contracts.mjs';
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new DomainError(code, msg);
};
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const digest = (x) => createHash("sha256").update(x).digest("hex");
const now = () => new Date().toISOString();
const text = (x, name) => {
  if (typeof x !== "string" || !x.trim() || x.length > 2000000)
    fail("INVALID", name + " must be nonempty text");
  return x;
};
function scalar(field, value, attachmentExists) {
  if (value === null || value === undefined || value === "") return;
  const d = field.definition || field,
    t = String(d.type || "str").toLowerCase(),
    choices = d.enum || d.kwargs?.enum;
  if (
    Array.isArray(choices) &&
    !choices.some((x) => JSON.stringify(x) === JSON.stringify(value))
  )
    fail("INVALID", field.id + " must be an allowed enum value");
  if (t === "int" && !Number.isInteger(value))
    fail("INVALID", field.id + " must be an integer");
  if (
    ["float", "number"].includes(t) &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    fail("INVALID", field.id + " must be a finite number");
  if (t === "bool" && typeof value !== "boolean")
    fail("INVALID", field.id + " must be boolean");
  if (
    ["str", "string", "date", "datetime", "file"].includes(t) &&
    typeof value !== "string"
  )
    fail("INVALID", field.id + " must be a string");
  if (t === "date" || t === "datetime") {
    const date = typeof value === "string" && /^(\d{4}-\d{2}-\d{2})(.*)$/.exec(value);
    const parsed = date && new Date(date[1] + "T00:00:00Z");
    if (!date || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date[1] || date[1].startsWith("0000"))
      fail("INVALID", field.id + " must contain a valid calendar date");
    if (t === "date" && date[2] !== "") fail("INVALID", field.id + " must use YYYY-MM-DD");
    if (t === "datetime") {
      const time = /^[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(date[2]);
      if (!time) fail("INVALID", field.id + " must contain a valid ISO date and time");
    }
  }
  if (t === "file" && (typeof value !== "string" || !/^attachment:[a-f0-9]{64}$/.test(value) || !attachmentExists(value)))
    fail("INVALID", field.id + " must reference an uploaded attachment; a filename is not an upload");
  if (t.startsWith("list") && !Array.isArray(value))
    fail("INVALID", field.id + " must be an array");
  const kw = d.kwargs || {};
  if (typeof value === "number")
    for (const [key, ok] of [
      ["ge", value >= kw.ge],
      ["gt", value > kw.gt],
      ["le", value <= kw.le],
      ["lt", value < kw.lt],
    ])
      if (kw[key] !== undefined && !ok)
        fail("INVALID", field.id + " violates " + key);
}
export const operations = Object.keys(contracts);
export {parseAimdProtocol};
const humanOnly = new Set(["record_bind_engine", "record_submit", "record_reopen", "record_archive", "record_restore", "history_list", "history_associate", "workspace_import"]);
export function openStore(directory, options = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = options.openDatabase
    ? options.openDatabase(join(directory, "research.sqlite"))
    : new DatabaseSync(join(directory, "research.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL);",
  );
  db.exec("CREATE TABLE IF NOT EXISTS attachments (reference TEXT PRIMARY KEY, name TEXT NOT NULL, body BLOB NOT NULL, createdAt TEXT NOT NULL)");
  const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_scopes'").get();
  db.exec("CREATE TABLE IF NOT EXISTS attachment_scopes(reference TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(reference, session))");
  if (!migrated) db.exec("INSERT OR IGNORE INTO attachment_scopes SELECT reference, '' FROM attachments");
  const hasAttachment = (reference, sessionId) => Boolean(db.prepare("SELECT 1 FROM attachment_scopes WHERE reference=? AND session=?").get(reference, sessionId || ""));
  const attachmentExists = (reference) => Boolean(db.prepare("SELECT 1 FROM attachments WHERE reference=?").get(reference));
  db.prepare("INSERT OR IGNORE INTO state VALUES(1,?)").run(
    JSON.stringify({ protocols: [], records: [], artifacts: [] }),
  );
  const read = () =>
    JSON.parse(db.prepare("SELECT body FROM state WHERE id=1").get().body);
  const access=accessStore(db);
  const documents=documentStore(db,directory,options.documents);
  const science = scienceStore(db, read);
  const projectGit = projectGitStore(db,directory,options.git);
  const engine = engineStore(db, directory,options.engine);
  const tasks = researchTaskStore({db,read,mutate,execute,science,engine});
  // Add pre-conversation attachments once; retain all historical bytes and references.
  const initial = read();
  if (!initial.conversationMigration) {
    for (const a of db.prepare("SELECT a.reference,a.name,length(a.body) AS size,a.createdAt FROM attachments a JOIN attachment_scopes s ON a.reference=s.reference WHERE s.session=''").all()) {
      if (!initial.artifacts.some(x => x.reference === a.reference)) initial.artifacts.push({id:randomUUID(),kind:'file',title:a.name,...a,sessionId:null});
    }
    initial.conversationMigration = 1;
    db.prepare("UPDATE state SET body=? WHERE id=1").run(JSON.stringify(initial));
  }
  const protocol = (s, id, version, sessionId = null) =>
    s.protocols.find((p) => p.id === id && p.version === version && (p.sessionId || null) === sessionId) ||
    s.protocols.find((p) => p.id === id && p.version === version && !p.sessionId) ||
    fail("NOT_FOUND", "Protocol version missing");
  const record = (s, id) =>
    s.records.find((r) => r.id === id) || fail("NOT_FOUND", "Record missing");
  function checkRevision(r, a) {
    if (
      !Number.isInteger(a.expectedRevision) ||
      a.expectedRevision !== r.revision
    )
      fail(
        "CONFLICT",
        "Revision changed; reload and merge. Current revision " + r.revision,
      );
  }
  function mutate(op, a, actor, fn, sessionId) {
    text(a.requestId, "requestId");
    const key = (sessionId ? JSON.stringify([sessionId, actor]) : actor) + ":" + a.requestId,
      hash = digest(JSON.stringify({ op, a, actor }));
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = db.prepare("SELECT * FROM requests WHERE id=?").get(key);
      if (prior) {
        if (prior.hash !== hash)
          fail("CONFLICT", "Idempotency key reused with different request");
        db.exec("COMMIT");
        return JSON.parse(prior.response);
      }
      const s = read(),
        result = fn(s);
      const response = JSON.stringify(result);
      db.prepare("UPDATE state SET body=? WHERE id=1").run(JSON.stringify(s));
      db.prepare("INSERT INTO requests VALUES(?,?,?)").run(key, hash, response);
      db.exec("COMMIT");
      return JSON.parse(response);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const event = (r, action, actor, detail) => {
    r.revision++;
    r.updatedAt = now();
    r.audit.push({
      at: r.updatedAt,
      action,
      actor,
      revision: r.revision,
      detail,
    });
  };
  function validateRun(p, run, actor, previous, sessionId) {
    if (!object(run)) fail("INVALID", "run must be an object");
    const model = parseAimdProtocol(p.content),
      ownership = buildAimdFieldOwnership(model);
    const groups = {
      values: model.variables,
      tables: model.fields.var_table || [],
      steps: model.steps,
      checks: model.checks,
      quizzes: model.quizzes,
    };
    for (const [group, fields] of Object.entries(groups)) {
      if (!object(run[group])) fail("INVALID", group + " must be an object");
      const allowed = new Map(fields.map((f) => [f.id, f]));
      for (const [id, value] of Object.entries(run[group])) {
        if (!allowed.has(id))
          fail("INVALID", "Unknown field " + group + "." + id);
        const changed =
          JSON.stringify(previous?.[group]?.[id]) !== JSON.stringify(value);
        if (changed && group === "checks" && actor !== "human")
          fail("FORBIDDEN", "Review checks may only be changed by a human");
        if (changed && group === 'tables' && Array.isArray(value)) {
          const prior=previous?.tables?.[id] || [], table=allowed.get(id);
          if(value.length!==prior.length && ownership[id]!==actor) fail('FORBIDDEN','只有表格所有者可以增删行。');
          for(let i=0;i<Math.max(value.length,prior.length);i++) for(const column of table.subvars) {
            const owner=ownership[id+'.'+column.id] || ownership[id] || 'human';
            if(JSON.stringify(value[i]?.[column.id])!==JSON.stringify(prior[i]?.[column.id]) && owner!==actor) fail('FORBIDDEN',id+'.'+column.id+' is owned by '+owner);
          }
        }
        if (changed && group === 'values') {
          const owner = ownership[id] || "human";
          if (owner === "system" || owner !== actor)
            fail("FORBIDDEN", id + " is owned by " + owner);
        }
        if (["steps", "checks"].includes(group) && typeof value !== "boolean")
          fail("INVALID", group + " values must be boolean");
        if (group === "values") scalar(allowed.get(id), value, ref => hasAttachment(ref, sessionId));
        if (
          group === "tables" &&
          (!Array.isArray(value) || value.some((row) => !object(row)))
        )
          fail("INVALID", "Table must contain object rows");
        if (group === "tables")
          for (const row of value)
            for (const key of Object.keys(row))
              if (!allowed.get(id).subvars.some((c) => c.id === key))
                fail("INVALID", "Unknown table column " + key);
        if (group === "tables")
          for (const row of value)
            for (const column of allowed.get(id).subvars)
              scalar(column, row[column.id], ref => hasAttachment(ref, sessionId));
        if (
          group === "quizzes" &&
          value !== null &&
          value !== undefined &&
          value !== ""
        ) {
          const q = allowed.get(id);
          if (q.type === "choice") {
            const vals = q.mode === "multiple" ? value : [value];
            if (
              !Array.isArray(vals) ||
              vals.some((v) => !q.options?.some((o) => o.key === v))
            )
              fail("INVALID", "Invalid choice for " + id);
          }
          if (q.type === "true_false" && typeof value !== "boolean")
            fail("INVALID", "Boolean quiz answer required for " + id);
        }
      }
      for (const id of Object.keys(previous?.[group] || {}))
        if(group==='tables' && !Object.hasOwn(run.tables,id)) {
          const table=allowed.get(id);
          if(table?.subvars.some(c=>(ownership[id+'.'+c.id] || ownership[id])!==actor && previous.tables[id].some(row=>row[c.id]!==undefined))) fail('FORBIDDEN','不能删除包含他人数据的表格。');
        }
      for (const id of Object.keys(previous?.[group] || {}))
        if (!(id in run[group]) && group === "checks" && actor !== "human")
          fail("FORBIDDEN", "Review checks may only be changed by a human");
      for (const id of Object.keys(previous?.[group] || {}))
        if (
          !(id in run[group]) &&
          ["values", "tables"].includes(group) &&
          (ownership[id] === "system" || ownership[id] !== actor)
        )
          fail("FORBIDDEN", "Cannot remove " + id);
    }
    return model;
  }
  function missing(p, run) {
    const m = parseAimdProtocol(p.content),
      out = [];
    for (const f of m.variables)
      if (!isAimdValueComplete(run.values[f.id])) out.push(f.id);
    for (const f of m.fields.var_table || [])
      if (
        !run.tables[f.id]?.length ||
        !run.tables[f.id].every((row) =>
          f.subvars.every((c) => isAimdValueComplete(row[c.id])),
        )
      )
        out.push(f.id);
    for (const f of m.steps.filter((x) => x.check !== false))
      if (!run.steps[f.id]) out.push(f.id);
    for (const f of m.checks) if (!run.checks[f.id]) out.push(f.id);
    for (const f of m.quizzes)
      if (!isAimdValueComplete(run.quizzes[f.id])) out.push(f.id);
    return out;
  }
  async function execute(op, a = {}, actor = "agent", signal, sessionId = null) {
    if (sessionId !== null && (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200)) fail("INVALID", "Invalid conversation identity");
    if (!operations.includes(op)) fail("INVALID", "Unknown operation");
    if (!["human", "agent"].includes(actor)) fail("FORBIDDEN", "Unknown actor");
    if (!object(a)) fail("INVALID", "args must be object");
    if (humanOnly.has(op) && actor !== "human") fail("FORBIDDEN", op + " requires human review in the workbench");
    signal?.throwIfAborted();
    if (Object.hasOwn(taskContracts,op)) return tasks.execute(op,a,actor,signal,sessionId);
    if (Object.hasOwn(documentContracts,op)) return documents.execute(op,a,actor,signal,sessionId);
    if (Object.hasOwn(engineContracts,op)) return engine.execute(op,a,actor,sessionId);
    if (Object.hasOwn(scienceContracts,op)) {
      const previous=op==='roadmap_put'?science.execute('science_state',{},actor,sessionId).roadmap.find(x=>x.id===a.id):null;
      const result=science.execute(op,a,actor,sessionId);
      if(op==='roadmap_put')return {...result,automaticCheckpoint:await projectGit.autoCheckpoint(result,previous,signal,sessionId)};
      return result;
    }
    if (Object.hasOwn(gitContracts,op)) return projectGit.execute(op,a,actor,signal,sessionId);
    const belongs = item => (item.sessionId || null) === sessionId;
    const scoped = s => ({ ...s, tasks:(s.tasks||[]).filter(belongs), protocols: s.protocols.filter(p => belongs(p) || !p.sessionId), records: s.records.filter(belongs), artifacts: s.artifacts.filter(belongs) });
    if (op.startsWith("record_") && op !== "record_create") record(scoped(read()), a.id);
    if (op === "history_list") {
      const s = read();
      return { records: s.records.filter(r => !r.sessionId), artifacts: s.artifacts.filter(r => !r.sessionId) };
    }
    if (op === "state") {
      const s = scoped(read());
      return {
        ...s,
        records: s.records.filter((r) => a.includeArchived || !r.archived),
        validationLevel:
          "AIMD structural + required-field completeness; explicitly bound records additionally use approved Airalogy assigners",
      };
    }
    if (op === "protocol_get") return protocol(read(), a.id, a.version, sessionId);
    if (op === "record_get") return record(read(), a.id);
    if (op === "attachment_get") {
      if (!hasAttachment(a.reference, sessionId)) fail("NOT_FOUND", "Attachment missing in this conversation");
      const item = db.prepare("SELECT * FROM attachments WHERE reference=?").get(a.reference);
      if (!item) fail("NOT_FOUND", "Attachment missing");
      const bytes = Buffer.from(item.body);
      if ("attachment:" + digest(bytes) !== item.reference) fail("INVALID", "Attachment integrity check failed");
      const own = read().artifacts.find(x => belongs(x) && x.reference === item.reference);
      return { reference: item.reference, name: own?.name || item.name, size: bytes.length, createdAt: item.createdAt, contentBase64: bytes.toString("base64") };
    }
    if (op === "record_export") {
      const s = read(),
        r = record(s, a.id),
        p = protocol(s, r.protocolId, r.protocolVersion, sessionId);
      return {
        format: "airalogy.record",
        schema_version: 1,
        record_id: r.id,
        record_version: r.revision,
        metadata: {
          protocol_id: p.id,
          protocol_version: p.version,
          protocol_sha256: p.sha256,
          status: r.status,
          validation_level: r.calculationBinding?"structural-and-completeness-with-approved-assigners":"structural-and-completeness",
        },
        data: {
          var: { ...r.run.values, ...r.run.tables },
          step: Object.fromEntries(
            Object.entries(r.run.steps).map(([k, v]) => [
              k,
              { checked: v, annotation: "" },
            ]),
          ),
          check: Object.fromEntries(
            Object.entries(r.run.checks).map(([k, v]) => [
              k,
              { checked: v, annotation: "" },
            ]),
          ),
          quiz: r.run.quizzes,
        },
        extensions: {
          deepscientist: { audit: r.audit, run: r.run, history: r.history, imported:r.imported, calculationBinding:r.calculationBinding,calculation:r.calculation },
        },
      };
    }
    if (op === "workspace_export") {
      const s = scoped(read());
      const records = await Promise.all(s.records.map(r => execute("record_export", { id: r.id }, actor, signal, sessionId)));
      const calculationPackages=[];
      for(const r of s.records)if(r.calculationBinding && !calculationPackages.some(p=>p.sha256===r.calculationBinding.sha256))calculationPackages.push(await engine.execute('engine_package_get',{id:r.calculationBinding.packageId,version:r.calculationBinding.version},actor,sessionId));
      for(const t of s.tasks)if(t.methodId){try{const source=await tasks.execute('method_get',{id:t.methodId,version:t.methodVersion},actor,signal,sessionId);if(!calculationPackages.some(p=>p.sha256===source.sha256))calculationPackages.push(source);}catch(error){if(!['NOT_FOUND','CONFLICT'].includes(error.code))throw error;}}
      return exportWorkspace(s, records, reference => {
        if (!hasAttachment(reference, sessionId)) fail("NOT_FOUND", "Archive attachment missing in this conversation");
        const item = db.prepare("SELECT * FROM attachments WHERE reference=?").get(reference);
        if (!item || "attachment:" + digest(item.body) !== reference) fail("INVALID", "Archive attachment integrity check failed");
        return {...item, name:s.artifacts.find(x => x.reference === reference)?.name || item.name};
      }, sessionId ? {...science.execute("science_export",{},actor,sessionId),tasks:s.tasks} : undefined,calculationPackages);
    }
    if(op==='local_search')return searchLocal(db,read(),science.execute('science_state',{},actor,sessionId),sessionId,a.query,a.max_results ?? 10);
    if (op === "literature_search") {
      text(a.query, "query");
      const n = a.max_results ?? 5;
      if (!Number.isInteger(n) || n < 1 || n > 20)
        fail("INVALID", "max_results must be 1..20");
      const result = await (options.literatureSearch || searchLiterature)({
        query: a.query,
        maxResults: n,
        sources: [a.source || "openalex"],
        timeoutMs: 15000,
        signal,
      });
      signal?.throwIfAborted();
      if (result.sources.every((x) => x.error))
        fail("PROVIDER", result.warnings.join("; "));
      return buildCompactLiteratureSearchPayload(result, n);
    }
    let prepared,calculationBinding,calculated;
    if(['record_bind_engine','record_update'].includes(op)){
      // Return retries before starting another container; the transaction checks again at commit.
      const key=(sessionId?JSON.stringify([sessionId,actor]):actor)+':'+a.requestId;
      const cached=db.prepare('SELECT * FROM requests WHERE id=?').get(key);
      if(cached){if(cached.hash!==digest(JSON.stringify({op,a,actor})))fail('CONFLICT','Idempotency key reused with different request');return JSON.parse(cached.response);}
      const r=record(scoped(read()),a.id),p=protocol(read(),r.protocolId,r.protocolVersion,sessionId);
      checkRevision(r,a);
      if((op==='record_bind_engine' || r.calculationBinding) && (r.status!=='draft' || r.archived))fail('CONFLICT','Reopen：只有未归档的草稿可以修改。');
      if(op==='record_bind_engine')calculationBinding=await bindCalculation(engine,r,p,a,actor,sessionId,signal);
      if(op==='record_update' && r.calculationBinding){
        const binding=r.calculationBinding;
        const input=stripCalculated(a.run,binding.targets),previous=stripCalculated(r.run,binding.targets);
        validateRun(p,input,actor,previous,sessionId);
        calculated=await executeCalculation(engine,binding,'recalculate',{values:input.values,tables:input.tables},actor,sessionId,a.requestId,signal);
        const output=calculated.result.data;
        if(JSON.stringify(output.targets.slice().sort())!==JSON.stringify(binding.targets.slice().sort()))fail('INVALID','计算规则与绑定版本不一致。');
        const run={...input,values:output.values,tables:output.tables};
        // Validate types and references; computed writes originate only from this approved executor.
        validateRun(p,run,actor,{...previous,values:run.values,tables:run.tables},sessionId);
        calculated={run,execution:{runId:calculated.id,packageSha256:binding.sha256,inputSha256:calculationHash({values:input.values,tables:input.tables}),computedAt:calculated.finishedAt,pending:output.pending,errors:output.errors}};
      }
    }
    const engineOutput = op==='engine_outputs_save' ? await engine.execute('engine_run_get',{id:a.id},actor,sessionId) : null;
    if (['archive_inspect','workspace_import'].includes(op)) {
      prepared=await prepareArchive(a.contentBase64);
      if(op==='archive_inspect')return {sha256:prepared.sha256,summary:prepared.summary,protocols:prepared.protocols.map(p=>({id:p.id,version:p.version,title:p.title})),records:prepared.records.length,attachments:prepared.attachments.length,researchRevisions:prepared.researchLedger?.revisions?.length || 0};
      if(prepared.sha256!==a.sha256)fail('CONFLICT','归档与已预览内容不一致，请重新预览。');
    }
    return mutate(op, a, actor, (s) => {
      if(op==='engine_outputs_save') {
        if(engineOutput.status!=='succeeded')fail('CONFLICT','仅可保存成功执行的输出文件。');
        const files=[];
        for(const f of engineOutput.result?.files || []){
          const bytes=Buffer.from(f.contentBase64,'base64'),name=String(f.name).split(/[\\/]/).pop().replace(/[\x00-\x1f]/g,'').slice(0,200) || 'output';
          const reference='attachment:'+digest(bytes);db.prepare('INSERT OR IGNORE INTO attachments VALUES(?,?,?,?)').run(reference,name,bytes,now());db.prepare('INSERT OR IGNORE INTO attachment_scopes VALUES(?,?)').run(reference,sessionId);
          const item={id:randomUUID(),sessionId,kind:'file',reference,name,title:name,size:bytes.length,createdAt:now(),engineRunId:engineOutput.id};if(!s.artifacts.some(x=>belongs(x)&&x.reference===reference&&x.name===name))s.artifacts.push(item);files.push(item);
        }
        return {files};
      }
      if(op==='workspace_import') {
        const result=importPrepared(db,s,prepared,sessionId);
        if(a.restoreResearch!==false)result.research=restoreResearch(db,prepared.researchLedger,sessionId,prepared.sha256,result.mapping,s);
        if(a.restoreResearch!==false)restoreTasks(s,prepared,sessionId,result.mapping);
        for(const id of result.records){const r=record(s,id);validateRun(protocol(s,r.protocolId,r.protocolVersion,sessionId),r.run,'human',r.run,sessionId);}
        return result;
      }
      if (op === "history_associate") {
        if (!sessionId) fail("INVALID", "Open a conversation before associating history");
        const item = (a.kind === "record" ? s.records : s.artifacts).find(x => x.id === a.id);
        if (!item || item.sessionId) fail("CONFLICT", "Historical item already associated or missing");
        const refs = new Set(JSON.stringify(item).match(/attachment:[a-f0-9]{64}/g) || []);
        for (const ref of refs) {
          if (!attachmentExists(ref)) fail("NOT_FOUND", "Historical attachment missing");
          db.prepare("INSERT OR IGNORE INTO attachment_scopes VALUES(?,?)").run(ref, sessionId);
          if (a.kind === "record" && !s.artifacts.some(x => x.sessionId === sessionId && x.reference === ref)) {
            const file = db.prepare("SELECT name,length(body) AS size,createdAt FROM attachments WHERE reference=?").get(ref);
            s.artifacts.push({ id: randomUUID(), kind: "file", reference: ref, title: file.name, ...file, sessionId });
          }
        }
        item.sessionId = sessionId;
        if (a.kind === "record") event(item, op, actor, "explicitly associated with conversation " + sessionId);
        return item;
      }
      if (op === "attachment_put") {
        text(a.name, "name");
        if (a.name.length > 255 || /[\x00-\x1f/\\]/.test(a.name)) fail("INVALID", "Use a plain attachment filename");
        if (typeof a.contentBase64 !== "string" || a.contentBase64.length > 2796204) fail("INVALID", "Attachment exceeds 2 MiB");
        const bytes = Buffer.from(a.contentBase64, "base64");
        if (bytes.toString("base64") !== a.contentBase64 || bytes.length > 2 * 1024 * 1024) fail("INVALID", "Invalid Base64 or attachment exceeds 2 MiB");
        const reference = "attachment:" + digest(bytes);
        db.prepare("INSERT OR IGNORE INTO attachments VALUES(?,?,?,?)").run(reference, a.name, bytes, now());
        const stored = db.prepare("SELECT name,createdAt FROM attachments WHERE reference=?").get(reference);
        db.prepare("INSERT OR IGNORE INTO attachment_scopes VALUES(?,?)").run(reference, sessionId || "");
        const item = { id: randomUUID(), kind: "file", reference, name: a.name, title: a.name, size: bytes.length, createdAt: now(), sessionId };
        if (!s.artifacts.some(x => belongs(x) && x.reference === reference && x.name === a.name)) s.artifacts.push(item);
        return { reference, ...stored, size: bytes.length, name: a.name };
      }
      if (op === "protocol_put") {
        const id = text(a.id, "id"),
          version = text(a.version, "version"),
          content = text(a.content, "content");
        if (s.protocols.some((p) => p.id === id && p.version === version && (belongs(p) || !p.sessionId || !sessionId)))
          fail("CONFLICT", "Protocol versions are immutable");
        const parsed = parseAimdProtocol(content);
        if (
          !parsed.variables.length &&
          !parsed.steps.length &&
          !parsed.quizzes.length &&
          !(parsed.fields.var_table || []).length
        )
          fail("INVALID", "Protocol must contain AIMD fields");
        for (const f of parsed.fields.var || [])
          if (!parsed.variables.some((v) => v.id === f))
            fail(
              "UNSUPPORTED",
              "Nested AIMD variable " +
                f +
                " is not editable by the copied V2 workbench. Put the field in a top-level paragraph.",
            );
        for (const f of parsed.fields.step || [])
          if (!parsed.steps.some((v) => v.id === f))
            fail(
              "UNSUPPORTED",
              "Nested AIMD step " + f + " is unsupported by this workbench",
            );
        const p = {
          sessionId,
          id,
          version,
          content,
          title: parsed.title,
          sha256: digest(content),
          createdAt: now(),
        };
        s.protocols.push(p);
        return p;
      }
      if (op === "record_create") {
        const p = protocol(s, a.protocolId, a.protocolVersion, sessionId);
        const id = randomUUID();
        const model = parseAimdProtocol(p.content);
        const defaults = {
          values: Object.fromEntries(
            model.variables
              .filter((f) => f.definition?.default !== undefined)
              .map((f) => [f.id, f.definition.default]),
          ),
          tables: Object.fromEntries(
            (model.fields.var_table || []).map((f) => [
              f.id,
              Array.isArray(f.default) ? f.default : [],
            ]),
          ),
          quizzes: Object.fromEntries(
            model.quizzes
              .filter((f) => f.default !== undefined)
              .map((f) => [f.id, f.default]),
          ),
        };
        const r = {
          sessionId,
          id,
          protocolId: p.id,
          protocolVersion: p.version,
          revision: 1,
          status: "draft",
          createdAt: now(),
          updatedAt: now(),
          run: {
            id,
            status: "ready",
            createdAt: now(),
            values: defaults.values,
            tables: defaults.tables,
            steps: {},
            checks: {},
            quizzes: defaults.quizzes,
          },
          audit: [
            {
              at: now(),
              action: "record_create",
              actor,
              revision: 1,
              detail: "pinned protocol " + p.id + "@" + p.version,
            },
          ],
          history: [],
        };
        s.records.push(r);
        return r;
      }
      if (op === "chart_render") {
        const spec = reportChartSpecSchema.parse(a.spec);
        const item = {
          sessionId,
          id: randomUUID(),
          kind: "chart",
          title: spec.title,
          createdAt: now(),
          spec,
          svg: renderReportChartSvg(spec),
        };
        s.artifacts.push(item);
        return item;
      }
      const r = record(s, a.id);
      checkRevision(r, a);
      if (op === "record_restore") {
        if (!r.archived) fail("CONFLICT", "Record is not archived");
        text(a.reason, "reason");
        r.archived = false;
        event(r, op, actor, a.reason);
        return r;
      }
      if (r.archived) fail("CONFLICT", "Record archived");
      const p = protocol(s, r.protocolId, r.protocolVersion, sessionId);
      if(op==='record_bind_engine'){
        r.calculationBinding=calculationBinding;
        delete r.calculation;
        r.run=stripCalculated(r.run,calculationBinding.targets);
        r.run.checks=Object.fromEntries(Object.keys(r.run.checks).map(id=>[id,false]));
        event(r,op,actor,'bound approved Airalogy package '+calculationBinding.sha256);
        return r;
      }
      if (op === "record_update") {
        if (r.status !== "draft")
          fail(
            "CONFLICT",
            "Reopen a submitted record with a reason before editing",
          );
        if(!calculated)validateRun(p, a.run, actor, r.run, sessionId);
        if (!["ready", "running"].includes(a.run.status))
          fail("INVALID", "Use record_submit to complete");
        const next=calculated?.run || a.run;
        const changedData=["values","tables","quizzes"].some(group=>JSON.stringify(r.run[group])!==JSON.stringify(next[group]));
        const agentChangedData = (actor === "agent" || Boolean(calculated)) && changedData;
        r.run = {
          ...r.run,
          status: a.run.status,
          values: next.values,
          tables: next.tables,
          steps: a.run.steps,
          checks: agentChangedData ? Object.fromEntries(Object.keys(a.run.checks).map((id) => [id, false])) : a.run.checks,
          quizzes: a.run.quizzes,
          ...(a.run.status === "running"
            ? { startedAt: r.run.startedAt || now() }
            : {}),
        };
        if(calculated){
          r.calculation=calculated.execution;
          for(const chart of r.calculationBinding.charts){
            const rows=r.run.tables[chart.table] || [];
            const data=rows.filter(row=>Number.isFinite(row[chart.value])&&row[chart.label]).map((row,i)=>({id:String(i),label:String(row[chart.label]),value:row[chart.value]}));
            const pagePrefix=chart.id+':page:';
            const existing=s.artifacts.filter(x=>belongs(x)&&x.kind==='chart'&&x.sourceRecordId===r.id&&(x.interactionChartId===chart.id||x.interactionChartId?.startsWith(pagePrefix)));
            s.artifacts=s.artifacts.filter(x=>!existing.includes(x));
            if(!data.length || r.calculation.errors.length || r.calculation.pending.length)continue;
            // The retained bar-chart schema permits at most 200 points per artifact.
            const pageSize=200,pages=Math.ceil(data.length/pageSize);
            for(let page=0;page<pages;page++){
              const interactionChartId=page===0?chart.id:pagePrefix+(page+1),previous=existing.find(x=>x.interactionChartId===interactionChartId);
              const title=pages===1?chart.title:chart.title+'（第 '+(page+1)+'/'+pages+' 页，共 '+data.length+' 项）';
              const spec=reportChartSpecSchema.parse({schema:'deepscientist.report_chart.v1',kind:'bar',title,data:data.slice(page*pageSize,(page+1)*pageSize),
                ...(pages===1?{}:{caption:'按原始顺序完整分页；本页展示第 '+(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,data.length)+' 项，共 '+data.length+' 项，未抽样或省略。'})});
              s.artifacts.push({id:previous?.id || randomUUID(),sessionId,kind:'chart',sourceRecordId:r.id,interactionChartId,title,spec,svg:renderReportChartSvg(spec),createdAt:previous?.createdAt || now(),updatedAt:now(),calculation:calculated.execution});
            }
          }
        }
        event(r, op, actor, calculated?'Airalogy run '+calculated.execution.runId+'; input '+calculated.execution.inputSha256+(agentChangedData?'; review checks reset':''):agentChangedData ? "draft saved; review checks reset after agent changes" : "draft saved");
        return r;
      }
      if (op === "record_submit") {
        if (r.status !== "draft" || r.run.status !== "running")
          fail("CONFLICT", "Only a running draft can be submitted");
        if (a.confirmChecks === true) {
          const checks = parseAimdProtocol(p.content).checks;
          r.run.checks = Object.fromEntries(checks.map(({id}) => [id, true]));
        }
        validateRun(p, r.run, actor, r.run, sessionId);
        if(r.calculationBinding && (!r.calculation || r.calculation.pending.length || r.calculation.errors.length || r.calculation.inputSha256!==calculationHash((({values,tables})=>({values,tables}))(stripCalculated(r.run,r.calculationBinding.targets)))))fail('INCOMPLETE','自动计算尚未完成或校验未通过，请先修正输入并保存。');
        const absent = missing(p, r.run);
        if (absent.length)
          fail("INCOMPLETE", "Required fields missing: " + absent.join(", "));
        r.status = "submitted";
        r.run.status = "completed";
        r.run.completedAt = now();
        event(r, op, actor, "structural completeness passed");
        r.history.push({ revision: r.revision, run: structuredClone(r.run) });
        return r;
      }
      if (op === "record_reopen") {
        if (r.status !== "submitted")
          fail("CONFLICT", "Only submitted records can be amended");
        text(a.reason, "reason");
        r.status = "draft";
        r.run.status = "running";
        delete r.run.completedAt;
        r.run.checks = Object.fromEntries(Object.keys(r.run.checks).map((id) => [id, false]));
        event(r, op, actor, a.reason);
        return r;
      }
      if (op === "record_archive") {
        text(a.reason, "reason");
        r.archived = true;
        event(r, op, actor, a.reason);
        return r;
      }
      fail("INVALID", "Unsupported operation");
    }, sessionId);
  }
  return { execute, access, waitForRun: (id,session) => engine.waitForRun(id,session), close: () => {
    const stopped=engine.close();
    if(stopped)return stopped.finally(()=>db.close());
    db.close();
  } };
}
