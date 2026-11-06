import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scienceContracts } from './science-contracts.mjs';
import { validateResearchRouteMap } from '../reused/science/researchRoute.ts';
const hash = data => createHash('sha256').update(typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data)).digest('hex');
const fail = (code,message) => { throw Object.assign(new Error(message),{code}); };

// One append-only revision table; SQLite transactions also cover idempotency.
export function scienceStore(db, readWorkspace) {
  db.exec(`CREATE TABLE IF NOT EXISTS science_revisions (
    session TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(session,kind,id,revision));
    CREATE TABLE IF NOT EXISTS science_requests (session TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(session,id));`);
  const rows = (session,kind) => db.prepare(`SELECT a.body FROM science_revisions a WHERE a.session=? AND a.kind=?
    AND a.revision=(SELECT max(b.revision) FROM science_revisions b WHERE b.session=a.session AND b.kind=a.kind AND b.id=a.id) ORDER BY a.rowid DESC`).all(session,kind).map(r=>JSON.parse(r.body));
  const get = (session,kind,id,revision) => {
    const row = revision === undefined
      ? db.prepare('SELECT body FROM science_revisions WHERE session=? AND kind=? AND id=? ORDER BY revision DESC LIMIT 1').get(session,kind,id)
      : db.prepare('SELECT body FROM science_revisions WHERE session=? AND kind=? AND id=? AND revision=?').get(session,kind,id,revision);
    return row ? JSON.parse(row.body) : null;
  };
  const requireItem = (session,kind,id) => get(session,kind,id) || fail('NOT_FOUND',`${kind} ${id} 不属于当前对话或尚未保存。`);
  const state = session => Object.fromEntries(['evidence','claim','report','roadmap','labskill'].map(k=>[k,rows(session,k)]));
  const snapshot = item => ({kind:item.kind,id:item.id,revision:item.revision,sha256:item.sha256,data:item.data});
  function sourceSnapshot(session,source) {
    const workspace = readWorkspace();
    const belongs = item => (item.sessionId || '') === session;
    if (source.kind === 'citation') {
      if (!['https:','http:'].includes(new URL(source.url).protocol)) fail('INVALID','文献地址必须使用 HTTP 或 HTTPS。');
      return {...source,sha256:hash(source.excerpt),verification:'provided-excerpt-not-independently-verified'};
    }
    if (source.kind === 'attachment') {
      const scope = db.prepare('SELECT 1 FROM attachment_scopes WHERE reference=? AND session=?').get(source.reference,session);
      const artifact = workspace.artifacts.find(a=>belongs(a) && a.reference===source.reference);
      if (!scope || !artifact) fail('NOT_FOUND','请先把证据文件保存到本对话。');
      const bytes = db.prepare('SELECT body FROM attachments WHERE reference=?').get(source.reference)?.body;
      if (!bytes || 'attachment:'+hash(bytes) !== source.reference) fail('INVALID','证据文件校验失败。');
      return {...source,name:artifact.name,size:bytes.length,sha256:source.reference.slice(11)};
    }
    if (source.kind === 'chart') {
      const chart = workspace.artifacts.find(a=>belongs(a)&&a.kind==='chart'&&a.id===source.id);
      if (!chart) fail('NOT_FOUND','图表不属于本对话。');
      return {...source,title:chart.title,spec:chart.spec,svg:chart.svg,sha256:hash(chart.svg)};
    }
    const record = workspace.records.find(r=>belongs(r)&&r.id===source.id);
    if (!record || record.revision!==source.revision) fail('CONFLICT','实验记录版本已改变或不可访问，请重新载入。');
    return {...source,sha256:hash(record),snapshot:record};
  }
  function validateRoute(session,route,previous,actor) {
    const result = validateResearchRouteMap(route);
    if (!result.ok) fail('INVALID',result.error);
    const next = result.value;
    const previousDecision = previous?.data?.route?.decision;
    if (actor !== 'human') {
      if (next.decision?.status === 'answered' && JSON.stringify(next.decision)!==JSON.stringify(previousDecision)) fail('FORBIDDEN','研究路线的选择必须由用户在工作台确认。');
      if (previousDecision?.status==='pending' && JSON.stringify(next.decision)!==JSON.stringify(previousDecision)) fail('FORBIDDEN','待用户选择的路线不能由智能体覆盖。');
      const oldNodes = new Map((previous?.data?.route?.nodes || []).map(n=>[n.id,n]));
      for (const node of next.nodes) if (node.lifecycle==='verified' && oldNodes.get(node.id)?.lifecycle!=='verified') fail('FORBIDDEN','阶段复核必须由用户确认。');
    }
    const evidenceIds = new Set(), artifactIds = new Set();
    for (const node of next.nodes) {
      for (const values of [node.evidenceIds,node.execution?.requiredEvidenceIds,node.outcome?.supportingEvidenceIds,node.outcome?.refutingEvidenceIds,node.outcome?.exhaustionEvidenceIds]) for (const id of values || []) evidenceIds.add(id);
      for (const id of [...(node.artifactIds || []),...(node.outcome?.producedArtifactIds || [])]) artifactIds.add(id);
    }
    for (const c of next.completionContract?.criteria || []) {
      for (const id of c.evidenceIds) evidenceIds.add(id);
      if (c.status==='satisfied' && !c.evidenceIds.length) fail('INCOMPLETE','完成条件必须关联证据。');
    }
    const evidence = [...evidenceIds].map(id=>snapshot(requireItem(session,'evidence',id)));
    const accepted = ids => ids?.length && ids.every(id => evidence.find(e=>e.id===id)?.data.review.status==='accepted');
    for (const node of next.nodes) if (node.lifecycle==='verified' && !accepted(node.evidenceIds)) fail('INCOMPLETE','已复核阶段必须关联人工复核通过的证据。');
    for (const criterion of next.completionContract?.criteria || []) if (criterion.status==='satisfied' && !accepted(criterion.evidenceIds)) fail('INCOMPLETE','已满足的完成条件必须关联人工复核通过的证据。');
    const artifacts = readWorkspace().artifacts.filter(a=>(a.sessionId || '')===session);
    for (const id of artifactIds) if (!artifacts.some(a=>a.id===id)) fail('NOT_FOUND','路线引用了本对话不存在的成果：'+id);
    return {route:next,evidence,artifacts:artifacts.filter(a=>artifactIds.has(a.id))};
  }
  function execute(op,args,actor,sessionId) {
    if(op==='lab_skills')return db.prepare("SELECT a.body FROM science_revisions a WHERE a.kind='labskill' AND a.revision=(SELECT max(b.revision) FROM science_revisions b WHERE b.session=a.session AND b.kind=a.kind AND b.id=a.id)").all().map(r=>JSON.parse(r.body)).filter(r=>r.data.published===true).map(r=>({id:r.id,sessionId:r.sessionId,revision:r.revision,title:r.data.title,markdown:r.data.markdown,evidence:r.data.evidence,sha256:r.sha256}));
    if (!sessionId) fail('INVALID','请从科研对话进入工作台，再管理路线与证据。');
    const session = sessionId;
    const a = z.object(scienceContracts[op].shape).strict().parse(args);
    if (op==='science_state') return state(session);
    if (op==='science_revision') return get(session,a.kind,a.id,a.revision) || fail('NOT_FOUND','修订不存在。');
    if (op==='science_export') return {format:'deepscientist.research-ledger',version:1,sessionId,exportedAt:new Date().toISOString(),current:state(session),revisions:db.prepare('SELECT body FROM science_revisions WHERE session=? ORDER BY rowid').all(session).map(x=>JSON.parse(x.body))};
    if (['evidence_review','roadmap_select','lab_skill_publish'].includes(op) && actor!=='human') fail('FORBIDDEN','此操作需要人工确认。');
    const kind = op.startsWith('lab_skill_') ? 'labskill' : op.startsWith('evidence_') ? 'evidence' : op.startsWith('roadmap_') ? 'roadmap' : op.split('_')[0];
    const key = actor+':'+a.requestId, requestHash=hash({op,a,actor});
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior=db.prepare('SELECT hash,response FROM science_requests WHERE session=? AND id=?').get(session,key);
      if (prior) {
        if (prior.hash!==requestHash) fail('CONFLICT','重试标识已用于其他请求。');
        db.exec('COMMIT'); return JSON.parse(prior.response);
      }
      const previous=get(session,kind,a.id);
      if ((previous?.revision || 0)!==a.expectedRevision) fail('CONFLICT','内容已被更新，请重新载入后编辑。');
      let data;
      if (op==='evidence_put') data={title:a.title,observation:a.observation,basis:a.basis,source:sourceSnapshot(session,a.source),review:{status:'pending'}};
      if (op==='evidence_review') {
        if (!previous) fail('NOT_FOUND','证据不存在。');
        data={...previous.data,review:{status:a.result,reason:a.reason,at:new Date().toISOString(),actor}};
      }
      if (op==='claim_put') {
        const evidence=a.evidenceIds.map(id=>snapshot(requireItem(session,'evidence',id)));
        if (['supported','refuted'].includes(a.status) && (!evidence.length || evidence.some(e=>e.data.review.status!=='accepted'))) fail('INCOMPLETE','支持或否定的结论需要关联已人工复核通过的证据。');
        data={title:a.title,statement:a.statement,limitations:a.limitations,status:a.status,evidence};
      }
      if(op==='lab_skill_put')data={title:a.title,markdown:a.markdown,evidence:a.evidenceIds.map(id=>snapshot(requireItem(session,'evidence',id))),published:false};
      if(op==='lab_skill_publish'){
        if(!previous)fail('NOT_FOUND','技能草稿不存在。');
        const evidence=previous.data.evidence.map(e=>snapshot(requireItem(session,'evidence',e.id)));
        if(a.published && (!evidence.length || evidence.some(e=>e.data.review.status!=='accepted')))fail('INCOMPLETE','发布技能需要关联已人工复核的来源证据。');
        data={...previous.data,evidence,published:a.published,publication:{reason:a.reason,at:new Date().toISOString(),actor}};
      }
      if (op==='report_put') data={title:a.title,markdown:a.markdown,claims:a.claimIds.map(id=>snapshot(requireItem(session,'claim',id))),evidence:a.evidenceIds.map(id=>snapshot(requireItem(session,'evidence',id)))};
      if (op==='roadmap_put') {
        if (a.route.roadmapId!==a.id) fail('INVALID','路线 ID 必须与 roadmapId 一致。');
        data=validateRoute(session,a.route,previous,actor);
      }
      if (op==='roadmap_select') {
        if (!previous || previous.data.route.decision?.status!=='pending') fail('CONFLICT','当前没有待选择的研究路线。');
        const route=structuredClone(previous.data.route);
        if (!route.decision.selectableNodeIds.includes(a.nodeId)) fail('INVALID','请选择提供的候选路线。');
        route.decision={...route.decision,status:'answered',selectedNodeId:a.nodeId,updatedAt:Date.now()};
        route.selectedTargetId=a.nodeId; route.focusNodeId=a.nodeId; route.updatedAt=Date.now();
        route.nodes.find(n=>n.id===a.nodeId).lifecycle='selected';
        data=validateRoute(session,route,previous,actor);
      }
      const item={id:a.id,kind,sessionId,revision:a.expectedRevision+1,createdAt:previous?.createdAt || new Date().toISOString(),updatedAt:new Date().toISOString(),actor,operation:op,data,sha256:hash(data),previousSha256:previous?.sha256 || null};
      const body=JSON.stringify(item);
      db.prepare('INSERT INTO science_revisions VALUES(?,?,?,?,?)').run(session,kind,a.id,item.revision,body);
      db.prepare('INSERT INTO science_requests VALUES(?,?,?,?)').run(session,key,requestHash,body);
      db.exec('COMMIT'); return JSON.parse(body);
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  return {execute};
}
