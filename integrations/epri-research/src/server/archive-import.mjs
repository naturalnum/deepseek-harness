import {createHash,randomUUID} from 'node:crypto';
import {openAiraArchive} from '../reused/aira/index.ts';
import {parseAimdProtocol} from '../reused/protocol/aimdProtocolModel.ts';
import {reportChartSpecSchema} from '../reused/common/reportChart.ts';
import {renderReportChartSvg} from '../reused/services/reportChartSvg.ts';
import {z} from 'zod';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const plainName=name=>String(name || 'attachment').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g,'').slice(0,200) || 'attachment';
export async function prepareArchive(contentBase64){
  if(typeof contentBase64!=='string' || contentBase64.length>90*1024*1024)fail('LIMIT','归档最大 64 MiB。');
  const bytes=Buffer.from(contentBase64,'base64');if(bytes.length>64*1024*1024 || bytes.toString('base64')!==contentBase64)fail('INVALID','归档编码或大小不正确。');
  const archive=await openAiraArchive(bytes),validation=await archive.validate();
  if(!validation.ok)fail('INVALID','归档校验失败：'+validation.issues.join('; '));
  const m=archive.manifest,protocols=[],records=[],attachments=[];let researchLedger=null,deliverables=[];
  for(const p of m.protocols || (m.protocol?[m.protocol]:[])){
    const content=await archive.readText((p.archive_root?p.archive_root+'/':'')+(p.entrypoint || 'protocol.aimd'));
    const model=parseAimdProtocol(content);const id=p.protocol_id || 'import-'+hash(content).slice(0,16),version=String(p.protocol_version || '1.0.0');
    if(!String(id).trim() || id.length>200 || version.length>100)fail('INVALID','协议标识不正确。');
    protocols.push({id,version,content,title:p.protocol_name || model.title,sha256:hash(content),archiveRoot:p.archive_root || ''});
  }
  const blobs=new Map();for(const blob of m.blobs || [])blobs.set(blob.blob_id,Buffer.from(await archive.readBytes(blob.archive_path)));
  const references=new Map();
  for(const f of m.files || []){const body=blobs.get(f.blob_id);if(!body)fail('INVALID','文件引用缺少嵌入数据。');const reference='attachment:'+hash(body);attachments.push({name:plainName(f.filename),body,reference});for(const key of [f.source_uri,f.file_id,f.blob_id])if(key)references.set(key,reference);}
  const replaceRefs=value=>{if(typeof value==='string'){if(references.has(value))return references.get(value);if(value.startsWith('attachment:'))fail('INVALID','归档缺少引用附件：'+value);return value;}if(Array.isArray(value))return value.map(replaceRefs);if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceRefs(v)]));return value;};
  for(const entry of m.records || []){
    const original=await archive.readJson(entry.path);
    if(original.record_id==='research-ledger')researchLedger=original.data?.var?.research_ledger;
    if(original.record_id==='conversation-deliverables')deliverables=original.data?.var?.deliverables || [];
    const p=protocols.find(p=>p.id===(original.metadata?.protocol_id || entry.protocol_id) && p.version===String(original.metadata?.protocol_version || entry.protocol_version)) || protocols.find(p=>p.archiveRoot && p.archiveRoot===entry.embedded_protocol_root);
    if(!p || original.record_id==='conversation-deliverables'){
      const body=Buffer.from(JSON.stringify(original,null,2));attachments.push({name:plainName(original.record_id)+'.json',body,reference:'attachment:'+hash(body)});continue;
    }
    const model=parseAimdProtocol(p.content),vars=replaceRefs(original.data?.var || {}),tables=new Set((model.fields.var_table || []).map(f=>f.id));
    const run={id:randomUUID(),status:'ready',createdAt:new Date().toISOString(),values:Object.fromEntries(Object.entries(vars).filter(([k])=>!tables.has(k))),tables:Object.fromEntries(Object.entries(vars).filter(([k])=>tables.has(k))),steps:Object.fromEntries(Object.entries(original.data?.step || {}).map(([k,v])=>[k,v===true || v?.checked===true])),checks:Object.fromEntries(Object.keys(original.data?.check || {}).map(k=>[k,false])),quizzes:original.data?.quiz || {}};
    records.push({protocolId:p.id,protocolVersion:p.version,run,original});
  }
  // Preserve every additional source file (models, assigners, documents) as data, never execute an import.
  const payloadPaths=new Set([...(m.records || []).map(r=>r.path),...(m.blobs || []).map(b=>b.archive_path),'_airalogy_archive/manifest.json']);
  for(const entry of archive.entries)if(!payloadPaths.has(entry.name) && !entry.name.endsWith('/protocol.aimd') && entry.name!=='protocol.aimd'){const body=Buffer.from(await archive.readBytes(entry.name));attachments.push({name:plainName(entry.name),body,reference:'attachment:'+hash(body)});}
  return {sha256:hash(bytes),summary:archive.summary(),protocols,records,attachments,researchLedger,deliverables};
}
export function importPrepared(db,state,prepared,session){
  if(!session)fail('INVALID','请在目标科研对话中导入。');const createdAt=new Date().toISOString();
  for(const p of prepared.protocols){const existing=state.protocols.find(x=>x.id===p.id && x.version===p.version && (x.sessionId===session || !x.sessionId));if(existing && existing.sha256!==p.sha256)fail('CONFLICT','协议 '+p.id+'@'+p.version+' 与现有内容冲突，请在新的科研对话中导入或先调整源版本号。');if(!existing)state.protocols.push({...p,sessionId:session,createdAt});}
  for(const a of prepared.attachments){db.prepare('INSERT OR IGNORE INTO attachments VALUES(?,?,?,?)').run(a.reference,a.name,a.body,createdAt);db.prepare('INSERT OR IGNORE INTO attachment_scopes VALUES(?,?)').run(a.reference,session);if(!state.artifacts.some(x=>x.sessionId===session && x.reference===a.reference && x.name===a.name))state.artifacts.push({id:randomUUID(),kind:'file',sessionId:session,name:a.name,title:a.name,reference:a.reference,size:a.body.length,createdAt});}
  const mapping={records:{},artifacts:{}};
  for(const a of prepared.deliverables){
    if(a.kind==='chart'){
      const spec=reportChartSpecSchema.parse(a.spec),id=randomUUID();
      state.artifacts.push({id,sessionId:session,kind:'chart',title:a.title,spec,svg:renderReportChartSvg(spec),createdAt,imported:{archiveSha256:prepared.sha256,sourceId:a.id}});mapping.artifacts[a.id]=id;
    }else{const local=state.artifacts.find(x=>x.sessionId===session&&x.reference===a.reference);if(local)mapping.artifacts[a.id]=local.id;}
  }
  const ids=[];for(const r of prepared.records){const id=r.run.id;ids.push(id);mapping.records[r.original.record_id]=id;state.records.push({id,sessionId:session,protocolId:r.protocolId,protocolVersion:r.protocolVersion,revision:1,status:'draft',createdAt,updatedAt:createdAt,run:r.run,history:[],imported:{archiveSha256:prepared.sha256,original:r.original},audit:[{at:createdAt,actor:'human',action:'workspace_import',revision:1,detail:'Imported as draft; original record retained; checks require fresh human review'}]});}
  return {sha256:prepared.sha256,protocols:prepared.protocols.length,records:ids,attachments:prepared.attachments.length,mapping,status:'imported-as-draft'};
}

export function restoreTasks(state,prepared,session,mapping){
  const id=z.string().regex(/^[\w.-]{1,120}$/),schema=z.array(z.object({id,objective:z.string().min(1).max(2000),requirements:z.string().max(4000).default(''),basis:z.enum(['measured','synthetic','literature','estimated']),methodId:id.optional(),methodVersion:id.optional(),recordId:z.string().optional(),evidenceId:id,reportId:id,sourceFiles:z.array(z.object({reference:z.string().regex(/^attachment:[a-f0-9]{64}$/),name:z.string().max(255),recordRevision:z.number().int().positive()})).max(500).optional()}).strip()).max(500);
  for(const task of schema.parse(prepared.researchLedger?.tasks||[])){
    const taskId='task-'+randomUUID(),evidenceId=mapping.research?.[JSON.stringify(['evidence',task.evidenceId])],reportId=mapping.research?.[JSON.stringify(['report',task.reportId])];
    if(task.sourceFiles?.some(f=>!state.artifacts.some(a=>a.sessionId===session&&a.reference===f.reference)))fail('INVALID','任务原始文件未包含在归档中。');
    (state.tasks??=[]).push({...task,id:taskId,revision:1,sessionId:session,createdAt:new Date().toISOString(),recordId:mapping.records[task.recordId],evidenceId:evidenceId||'evidence-'+taskId,reportId:reportId||'report-'+taskId,imported:{archiveSha256:prepared.sha256,sourceId:task.id}});
  }
}
