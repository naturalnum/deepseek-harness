import GitActions from './GitActions';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import ResearchGraph,{GraphNode} from './ResearchGraph';
import {api} from './adapters/api';
import {downloadTextContent} from './adapters/download';
import {collapseLinearResearchCommits,getResearchProgressParentIds} from '../reused/science/researchProgressGraph';
import {classifyResearchCommitSignal,getResearchCommitDisplayTitle} from '../reused/science/researchStage';
const labels:any={proposed:'待开展',selected:'已选择',running:'进行中',completed:'已完成',verified:'已复核',blocked:'受阻',pruned:'已停止',supported:'证据支持',refuted:'证据反驳',exhausted:'路径耗尽',inconclusive:'尚无定论',runtime_failed:'运行失败',runtimeFailed:'运行失败',setup:'初始化',experiment:'实验',analysis:'分析',decision:'决策',result:'结果',writing:'写作',review:'评审',final:'定稿',prompt:'构思',other:'提交',evidence:'证据',claim:'结论',report:'报告',roadmap:'路线',labskill:'技能',pending:'待复核',accepted:'复核通过',rejected:'未通过',measured:'实际测量',synthetic:'模拟数据',literature:'文献资料',estimated:'估算',advance:'继续',hold:'暂缓',reject:'放弃',repair:'修复',stop:'停止'};
function Snapshot({item}:any){return <details className="graph-reference"><summary>{labels[item.kind]} · {item.data?.title || item.id} · v{item.revision}</summary><p>{item.data?.observation || item.data?.statement}</p>{item.data?.basis && <p>{labels[item.data.basis]} · {labels[item.data.review?.status]}</p>}<small>内容指纹：{item.sha256}</small>{item.data?.source && <details><summary>原始来源快照</summary><pre>{JSON.stringify(item.data.source,null,2)}</pre></details>}</details>;}
const evidenceIds=(node:any)=>[...new Set<string>([...(node.evidenceIds || []),...(node.execution?.requiredEvidenceIds || []),...(node.outcome?.supportingEvidenceIds || []),...(node.outcome?.refutingEvidenceIds || []),...(node.outcome?.exhaustionEvidenceIds || [])])];
export function RouteProgress({item,busy,onChoose}:any) {
  const target=new URLSearchParams(location.search);
  const [version,setVersion]=useState('current'),[saved,setSaved]=useState<any>(null),[error,setError]=useState(''),[selected,setSelected]=useState(target.get('item')===item.id?target.get('node')||'':''),[view,setView]=useState('graph');
  useEffect(()=>{let active=true;setSaved(null);setError('');if(version!=='current')void api('science_revision',{kind:'roadmap',id:item.id,revision:Number(version)}).then(data=>{if(active)setSaved(data);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[item.id,version]);
  const shown=version==='current'?item:saved;
  const nodes:GraphNode[]=useMemo(()=>shown?.data.route.nodes.map((n:any)=>({id:n.id,parentIds:getResearchProgressParentIds(n),order:n.order,title:n.title,summary:n.summary,label:labels[n.outcome?.disposition] || labels[n.lifecycle],status:n.lifecycle,tone:n.outcome?'decision':n.order===0?'setup':'experiment',basisCount:evidenceIds(n).length,meta:n.git?.branchRef || labels[n.lifecycle],raw:n})) || [],[shown]);
  const node=nodes.find(n=>n.id===selected) || nodes.find(n=>n.id===shown?.data.route.focusNodeId) || nodes[0];
  return <div className="progress-panel">
    <div className="progress-options"><div className="graph-view-switch"><button aria-pressed={view==='graph'} onClick={()=>setView('graph')}>进展图</button><button aria-pressed={view==='list'} onClick={()=>setView('list')}>阶段列表</button></div><label>版本<select aria-label={'研究路线版本：'+item.data.route.objective} value={version} onChange={e=>setVersion(e.target.value)}><option value="current">当前版本 · v{item.revision}</option>{Array.from({length:item.revision},(_,i)=><option key={i+1} value={i+1}>历史快照 · v{i+1}</option>)}</select></label></div>
    {error && <p role="alert" className="compact-error">{error}</p>}
    {!shown && !error && <p>正在读取版本快照…</p>}
    {shown && <>{version!=='current' && <p className="graph-notice">正在查看 v{shown.revision} 的只读历史快照。节点和依据保留当时的内容。</p>}{view==='graph'?<ResearchGraph nodes={nodes} selectedId={node?.id} onSelect={n=>setSelected(n.id)} graphKey={item.id+':'+version}/>:<ol className="graph-stage-list">{nodes.map(n=><li key={n.id}><button aria-pressed={node?.id===n.id} onClick={()=>setSelected(n.id)}>{n.title} · {n.label}</button></li>)}</ol>}
      {node && <section className="graph-detail" aria-label="研究阶段详情"><header><div><small>阶段详情 · v{shown.revision}</small><h3>{node.title}</h3></div><span className="science-badge">{node.label}</span></header><p>{node.summary}</p>
        {node.raw.execution && <><h4>本阶段目标</h4><p>{node.raw.execution.objective}</p><h4>验收标准</h4><ul>{node.raw.execution.acceptanceCriteria.map((x:string,i:number)=><li key={i}>{x}</li>)}</ul></>}
        {node.raw.outcome && <><h4>阶段结果</h4><p>{node.raw.outcome.reflection}</p><p>{node.raw.outcome.beliefDelta}</p></>}
        {node.raw.blockedReason && <p>受阻原因：{node.raw.blockedReason}</p>}{node.raw.prunedReason && <p>停止原因：{node.raw.prunedReason}</p>}
        {node.raw.git && <p className="graph-mono">Git：{node.raw.git.branchRef} · {node.raw.git.checkpointCommit || node.raw.git.baseCommit}</p>}
        {evidenceIds(node.raw).map(id=>{const e=shown.data.evidence?.find((x:any)=>x.id===id);return e?<Snapshot key={id} item={e}/>:<p key={id}>依据 {id} 的快照未包含在此版本中。</p>;})}
        {(shown.data.artifacts || []).filter((a:any)=>[...(node.raw.artifactIds || []),...(node.raw.outcome?.producedArtifactIds || [])].includes(a.id)).map((a:any)=><p key={a.id}>关联成果：{a.title || a.name}</p>)}
        {version==='current' && item.data.route.decision?.status==='pending' && item.data.route.decision.selectableNodeIds.includes(node.id) && <button className="primary" disabled={busy} onClick={()=>onChoose(node.id)}>选择这条研究路线</button>}
      </section>}
      {shown.data.route.completionContract && <details className="graph-reference"><summary>研究完成条件</summary>{shown.data.route.completionContract.criteria.map((c:any)=><p key={c.id}>{c.requirement} · {c.status==='satisfied'?'已满足':'待完成'}{c.note?' · '+c.note:''}</p>)}</details>}
    </>}
  </div>;
}

export function buildEvidenceGraph(state:any):GraphNode[] {
  const nodes=new Map<string,GraphNode>();
  const visit=(item:any):string=>{
    const id=item.kind+':'+item.id+':'+item.revision;if(nodes.has(id))return id;
    const refs=[...(item.data.evidence || []),...(item.data.claims || [])];
    nodes.set(id,{id,title:item.data.title || item.id,summary:item.data.observation || item.data.statement || item.data.markdown?.slice(0,160),label:labels[item.kind],tone:item.kind,meta:'v'+item.revision,status:item.data.review?.status || item.data.status,basisCount:refs.length,raw:item});
    nodes.get(id)!.parentIds=refs.map(visit);return id;
  };
  for(const kind of ['evidence','claim','report','labskill'])for(const item of state[kind] || [])visit(item);
  return [...nodes.values()];
}
export function EvidenceGraph({state}:any) {
  const nodes=useMemo(()=>buildEvidenceGraph(state),[state]);const [selected,setSelected]=useState('');const node=nodes.find(n=>n.id===selected) || nodes.at(-1);
  return <><p className="science-muted">连线表示已保存的引用关系；同一条证据的不同版本分别显示，保留报告当时引用的内容。</p><ResearchGraph nodes={nodes} selectedId={node?.id} onSelect={n=>setSelected(n.id)} graphKey="evidence"/>{node && <section className="graph-detail" aria-label="依据关系详情"><h3>{node.title} · {node.meta}</h3><p>{node.summary}</p><Snapshot item={node.raw}/></section>}</>;
}

export function GitProgress({canManage=true}:any={}) {
  const [state,setState]=useState<any>(null),[path,setPath]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState(''),[detail,setDetail]=useState<any>(null),[all,setAll]=useState(false);
  const refresh=async()=>{const data=await api('project_git_state');setState(data);setPath(data.path || '');};
  const task=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  useEffect(()=>{void task(refresh);},[]);
  const groups=useMemo(()=>all?(state?.commits || []).toReversed().map((c:any)=>({boundary:c,commits:[c],collapsedCount:0})):collapseLinearResearchCommits(state?.commits || [],{maxBoundaries:12}).groups,[state,all]);
  const nodes:GraphNode[]=useMemo(()=>{const owner=new Map<string,string>();groups.forEach(g=>g.commits.forEach(c=>owner.set(c.sha,g.boundary.sha)));return groups.map((g,i)=>{const c=g.boundary,signal=classifyResearchCommitSignal(c),decision=c.checkpoint?.directionDecision;return {id:c.sha,parentIds:[...new Set(g.commits.flatMap(x=>x.parents.map(p=>owner.get(p))).filter((p):p is string=>Boolean(p)&&p!==c.sha))],order:i,title:getResearchCommitDisplayTitle(c.subject),summary:decision?.reason || c.bodyPreview.split('\n').filter(l=>!l.startsWith('DeepScientist-')).join(' ').trim() || c.shortSha,label:labels[signal.labelKey.split('.').at(-1)!],tone:signal.tone,basisCount:decision?.basisRefs.length,meta:(c.refs.join(' · ') || c.authoredAt.slice(0,10))+(g.collapsedCount?' · '+g.commits.length+' 次提交':''),raw:g};});},[groups]);
  const node=nodes.find(n=>n.id===selected) || nodes.at(-1);
  const selection=useRef('');selection.current=(state?.path || '')+':'+(node?.id || '');
  useEffect(()=>setDetail(null),[node?.id,state?.path]);
  const inspect=(sha:string)=>{const key=selection.current;void task(async()=>{const data=await api('project_git_commit',{sha});if(selection.current===key)setDetail(data);});};
  return <div className="git-progress"><div className="science-heading"><div><h2>Git 研究进展</h2><p className="science-muted">读取已有项目的分支、提交及 DeepScientist 检查点，查看每一步的依据与文件变化。</p></div>{state?.bound && <button disabled={busy} onClick={()=>void task(refresh)}>刷新 Git 历史</button>}</div>
    <details className="graph-reference" open={!state?.bound}><summary>{state?.bound?'已关联：'+state.path:'关联项目仓库'}</summary><form className="git-binding" onSubmit={e=>{e.preventDefault();void task(async()=>{await api('project_git_bind',{path});setSelected('');setDetail(null);await refresh();});}}><label>本机 Git 仓库根目录<input required value={path} placeholder="例如 D:\\Projects\\power-analysis" onChange={e=>setPath(e.target.value)}/></label><p>这里展示该仓库全部分支最近 200 次提交，可能包含其他对话的工作。关联操作仅保存查看位置。</p><button disabled={busy||!canManage} type="submit">确认关联并读取</button></form></details>
    {error && <p role="alert" className="compact-error">{error}</p>}{busy && <p role="status">正在读取项目历史…</p>}
    {state?.bound && <>{canManage&&<GitActions key={state.path} onChanged={refresh}/>}<div className="progress-options"><span>当前分支：{state.branch || '分离 HEAD'}{state.dirty?' · 有未提交修改':''}</span><button aria-pressed={all} onClick={()=>setAll(!all)}>{all?'收起普通提交':'展开全部提交'}</button></div>{state.truncated && <p className="graph-notice">当前显示最近 200 次提交，更早历史仍保存在 Git 仓库。</p>}<ResearchGraph nodes={nodes} selectedId={node?.id} onSelect={n=>setSelected(n.id)} graphKey={'git:'+state.path+':'+all}/>
      {node && <section className="graph-detail" aria-label="Git 节点详情"><header><div><small>{node.raw.boundary.shortSha} · {node.raw.boundary.authorName} · {new Date(node.raw.boundary.authoredAt).toLocaleString()}</small><h3>{node.title}</h3></div><button disabled={busy} onClick={()=>inspect(node.id)}>查看文件变化</button></header><p>{node.summary}</p>
        {node.raw.boundary.checkpoint?.directionDecision && <><h4>方向判断：{labels[node.raw.boundary.checkpoint.directionDecision.choice]}</h4><ul>{node.raw.boundary.checkpoint.directionDecision.basisRefs.map((b:any,i:number)=><li key={i}>{b.label || b.ref} · {b.kind}</li>)}</ul><p>{node.raw.boundary.checkpoint.directionDecision.nextTest}</p></>}
        {node.raw.boundary.checkpoint?.verification?.length>0 && <><h4>提交中记录的验证信息</h4><ul>{node.raw.boundary.checkpoint.verification.map((v:string,i:number)=><li key={i}>{v}</li>)}</ul></>}
        {node.raw.commits.length>1 && <details><summary>此节点包含 {node.raw.commits.length} 次提交</summary>{node.raw.commits.map((c:any)=><p key={c.sha}><button disabled={busy} onClick={()=>inspect(c.sha)}>{c.shortSha} · {c.subject}</button></p>)}</details>}
        {detail && <div className="git-patch"><h4>提交详情 · {detail.sha.slice(0,8)}</h4><pre>{detail.message}</pre><button onClick={()=>void downloadTextContent(detail.patch,detail.sha+'.patch','text/plain')}>下载 Patch</button><pre>{detail.patch || '此提交没有文本差异。'}</pre></div>}
      </section>}
    </>}
  </div>;
}
