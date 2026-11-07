import { createHash } from 'node:crypto';
import { createStoredZip, openAiraArchive } from '../reused/aira/index.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = name => ({svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',pdf:'application/pdf',csv:'text/csv',json:'application/json',aimd:'text/plain',md:'text/markdown'})[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
export async function exportWorkspace(state, records, readAttachment, researchLedger,calculationPackages=[]) {
  const entries = new Map(), manifest = {format:'airalogy.archive',version:1,kind:'records',created_at:new Date().toISOString(),records:[],protocols:[],blobs:[],files:[]};
  let total = 0;
  const add = (name, data) => { const bytes = Buffer.from(data); if (!entries.has(name)) { total += bytes.length; if (total > 64 * 1024 * 1024) throw new Error('Archive exceeds 64 MiB; export fewer files'); entries.set(name, {name,bytes}); } return hash(bytes); };
  // Export reviewed source as data. Import never restores execution approval automatically.
  for(const pack of calculationPackages){const root='calculation-packages/'+pack.sha256;for(const [name,content] of Object.entries(pack.files))add(root+'/'+name,typeof content==='string'?content:Buffer.from(content.contentBase64,'base64'));add(root+'/package-provenance.json',JSON.stringify({id:pack.id,version:pack.version,sha256:pack.sha256},null,2));}
  const protocolRoots = new Map();
  for (const p of state.protocols) {
    if (!p.sessionId && !records.some(r => r.metadata.protocol_id === p.id && r.metadata.protocol_version === p.version)) continue;
    const key = JSON.stringify([p.id,p.version]);
    // Session-specific protocol versions take precedence over shared templates.
    if (protocolRoots.has(key) && !p.sessionId) continue;
    protocolRoots.set(key, p);
  }
  for (const [key,p] of protocolRoots) {
    const root = 'protocols/' + hash(key + p.sha256).slice(0,24);
    const sha = add(root + '/protocol.aimd', p.content);
    manifest.protocols.push({protocol_id:p.id,protocol_version:p.version,protocol_name:p.title,archive_root:root,entrypoint:'protocol.aimd',files:['protocol.aimd'],file_hashes:{'protocol.aimd':sha}});
    protocolRoots.set(key, root);
  }
  const attach = (bytes, name, source, recordPath, fieldPath) => {
    const sha = hash(bytes), blobId = 'sha256:' + sha, path = 'blobs/sha256/' + sha;
    add(path,bytes);
    if (!manifest.blobs.some(b => b.blob_id === blobId)) manifest.blobs.push({blob_id:blobId,archive_path:path,sha256:sha,size:bytes.length});
    const ref = {source_uri:source,blob_id:blobId,filename:name,mime_type:mime(name),size:bytes.length,record_path:recordPath,field_path:fieldPath};
    manifest.files.push(ref); return ref;
  };
  for (const record of records) {
    const path = 'records/' + record.record_id + '.json';
    record.files = [];
    const visit = (value, field) => {
      if (typeof value === 'string' && /^attachment:[a-f0-9]{64}$/.test(value)) { const a = readAttachment(value); record.files.push(attach(Buffer.from(a.body),a.name,value,path,field)); }
      else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) visit(v, field + '.' + k);
    };
    visit(record.data, 'data');
    manifest.records.push({path,record_id:record.record_id,record_version:record.record_version,protocol_id:record.metadata.protocol_id,protocol_version:record.metadata.protocol_version,embedded_protocol_root:protocolRoots.get(JSON.stringify([record.metadata.protocol_id,record.metadata.protocol_version])),sha256:add(path,JSON.stringify(record,null,2))});
  }
  if (state.artifacts.length) {
    const path = 'records/conversation-deliverables.json';
    const record = {format:'airalogy.record',schema_version:1,record_id:'conversation-deliverables',record_version:1,metadata:{status:'draft',description:'Conversation deliverable snapshots; not a human-reviewed scientific record'},data:{var:{deliverables:[]},step:{},check:{},quiz:{}},files:[]};
    for (const [i,a] of state.artifacts.entries()) {
      const bytes = a.kind === 'chart' ? Buffer.from(a.svg) : Buffer.from(readAttachment(a.reference).body);
      const name = a.kind === 'chart' ? a.id + '.svg' : a.name;
      record.data.var.deliverables.push({id:a.id,title:a.title,kind:a.kind,createdAt:a.createdAt,...(a.kind === 'chart' ? {spec:a.spec} : {reference:a.reference})});
      record.files.push(attach(bytes,name,a.reference || 'deepscientist:chart:' + a.id,path,'data.var.deliverables.' + i));
    }
    manifest.records.push({path,record_id:record.record_id,record_version:1,sha256:add(path,JSON.stringify(record,null,2))});
  }
  if(researchLedger && (researchLedger.revisions.length||researchLedger.tasks?.length)){
    const path='records/research-ledger.json';const record={format:'airalogy.record',schema_version:1,record_id:'research-ledger',record_version:1,metadata:{description:'DeepScientist revision ledger; original reviewer identities retained'},data:{var:{research_ledger:researchLedger},step:{},check:{},quiz:{}}};
    manifest.records.push({path,record_id:record.record_id,record_version:1,sha256:add(path,JSON.stringify(record,null,2))});
  }
  add('_airalogy_archive/manifest.json',JSON.stringify(manifest,null,2));
  const bytes = createStoredZip([...entries.values()]);
  const archive = await openAiraArchive(bytes), validation = await archive.validate();
  if (!validation.ok) throw new Error('Airalogy validation: ' + validation.issues.join('; '));
  return {name:'research-workbench.aira',contentBase64:Buffer.from(bytes).toString('base64'),size:bytes.length,summary:archive.summary(),validation};
}
