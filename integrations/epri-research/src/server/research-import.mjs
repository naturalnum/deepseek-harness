import {createHash,randomUUID} from 'node:crypto';
import {validateResearchRouteMap} from '../reused/science/researchRoute.ts';
const hash=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID'});};
const kinds=['evidence','claim','report','roadmap','labskill'];
const key=x=>JSON.stringify([x.kind,x.id,x.revision]);

// Runs inside the archive import transaction. Original bytes remain archived;
// local IDs and fingerprints are rebuilt, never presented as the original IDs.
export function restoreResearch(db,ledger,session,archiveSha,mapping,workspace){
  if(!ledger)return {entities:0,revisions:0,skills:0};
  if(ledger.format!=='deepscientist.research-ledger'||ledger.version!==1||!Array.isArray(ledger.revisions)||ledger.revisions.length>10000)fail('不支持的研究档案格式或版本数量。');
  const rows=new Map(),groups=new Map(),ids=new Map();
  for(const item of ledger.revisions){
    if(!kinds.includes(item.kind)||typeof item.id!=='string'||!Number.isInteger(item.revision)||item.revision<1||!item.data||hash(item.data)!==item.sha256||rows.has(key(item)))fail('研究档案版本或指纹不一致。');
    const entity=JSON.stringify([item.kind,item.id]);
    rows.set(key(item),item);if(!groups.has(entity)){groups.set(entity,[]);ids.set(entity,randomUUID());}groups.get(entity).push(item);
  }
  for(const revisions of groups.values()){
    revisions.sort((a,b)=>a.revision-b.revision);
    for(let i=0;i<revisions.length;i++)if(revisions[i].revision!==i+1||revisions[i].previousSha256!==(i?revisions[i-1].sha256:null))fail('研究历史不连续，无法完整恢复。');
  }
  const id=(kind,old)=>ids.get(JSON.stringify([kind,old]))||fail('档案缺少引用项：'+kind+' '+old);
  mapping.research=Object.fromEntries(ids);
  const transformed=new Map(),visiting=new Set();
  const snapshot=item=>({kind:item.kind,id:item.id,revision:item.revision,sha256:item.sha256,data:item.data,imported:item.imported});
  const convert=item=>{
    const k=key(item);if(transformed.has(k))return transformed.get(k);if(visiting.has(k))fail('研究引用存在循环。');visiting.add(k);
    const original=rows.get(k);if(!original||original.sha256!==item.sha256)fail('研究引用快照与历史指纹不一致。');
    const data=structuredClone(original.data);
    for(const field of ['evidence','claims'])if(data[field])data[field]=data[field].map(ref=>snapshot(convert(ref)));
    if(data.source){const source=data.source;
      if(source.kind==='attachment'&&!db.prepare('SELECT 1 FROM attachment_scopes WHERE session=? AND reference=?').get(session,source.reference))fail('研究证据引用的附件不在归档中。');
      if(source.kind==='record'||source.kind==='chart'){
        const mapped=(source.kind==='record'?mapping.records:mapping.artifacts)[source.id];if(!mapped)fail('研究证据引用的记录或图表不在归档中。');
        source.importedFrom={id:source.id,revision:source.revision,sha256:source.sha256};source.id=mapped;
        // Keep the source snapshot as historical evidence; it is not the new draft record.
      }
    }
    if(data.review)data.review={...data.review,imported:true};
    if(data.route){
      const route=data.route;route.roadmapId=id('roadmap',original.id);
      for(const node of route.nodes){
        for(const [owner,fields] of [[node,['evidenceIds']],[node.execution,['requiredEvidenceIds']],[node.outcome,['supportingEvidenceIds','refutingEvidenceIds','exhaustionEvidenceIds']]])if(owner)for(const field of fields)if(owner[field])owner[field]=owner[field].map(x=>id('evidence',x));
        for(const [owner,field] of [[node,'artifactIds'],[node.outcome,'producedArtifactIds']])if(owner?.[field])owner[field]=owner[field].map(x=>mapping.artifacts[x]||fail('路线成果未包含在归档中。'));
      }
      for(const criterion of route.completionContract?.criteria||[])criterion.evidenceIds=criterion.evidenceIds.map(x=>id('evidence',x));
      if(!validateResearchRouteMap(route).ok)fail('恢复后的研究路线校验失败。');
      if(data.artifacts)data.artifacts=data.artifacts.map(a=>workspace.artifacts.find(x=>x.id===mapping.artifacts[a.id])||fail('路线成果映射缺失。'));
    }
    const result={...original,id:id(original.kind,original.id),sessionId:session,data,sha256:hash(data),previousSha256:original.revision>1?convert(rows.get(JSON.stringify([original.kind,original.id,original.revision-1]))).sha256:null,
      imported:{archiveSha256:archiveSha,sourceSession:ledger.sessionId,sourceId:original.id,sourceRevision:original.revision,sourceSha256:original.sha256,sourceActor:original.actor},actor:'imported',operation:'archive_restore'};
    visiting.delete(k);transformed.set(k,result);return result;
  };
  const insert=item=>db.prepare('INSERT INTO science_revisions VALUES(?,?,?,?,?)').run(session,item.kind,item.id,item.revision,JSON.stringify(item));
  for(const revisions of groups.values())for(const original of revisions)insert(convert(original));
  const now=new Date().toISOString();let skills=0;
  for(const revisions of groups.values()){
    const old=convert(revisions.at(-1)),data=structuredClone(old.data);
    if(old.kind==='evidence')data.review={status:'pending',reason:'归档来源复核记录保留在历史版本，请在本机重新复核。'};
    if(old.kind==='claim'&&['supported','refuted'].includes(data.status))data.status='proposed';
    if(old.kind==='labskill'){data.published=false;delete data.publication;skills++;}
    if(data.route){
      for(const node of data.route.nodes)if(node.lifecycle==='verified')node.lifecycle='completed';
      for(const criterion of data.route.completionContract?.criteria||[])if(criterion.status==='satisfied')criterion.status='pending';
      data.route.updatedAt=Date.now();
    }
    insert({...old,data,revision:old.revision+1,actor:'human',operation:'archive_restore_for_review',updatedAt:now,sha256:hash(data),previousSha256:old.sha256});
  }
  return {entities:groups.size,revisions:rows.size+groups.size,skills,status:'restored-review-required'};
}
