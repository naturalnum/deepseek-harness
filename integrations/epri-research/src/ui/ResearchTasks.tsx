import React,{useEffect,useState} from 'react';
import {api} from './adapters/api';
import {requestTaskConversation} from './task-conversation.mjs';
import {openWorkbench} from './embedded-workbench.mjs';
import {parseAimdProtocol,buildAimdFieldOwnership} from '../reused/protocol/aimdProtocolModel';
import {downloadTextContent} from './adapters/download';
import MarkdownPreview from './adapters/MarkdownPreview';

const labels:any={measured:'实际测量',synthetic:'合成测试',literature:'文献数据',estimated:'估计数据'};
const statusLabels:any={method:'待补方法',open:'待启用方法',input:'待填写数据',calculation:'计算需处理',review:'待人工确认',evidence:'待保存证据',evidence_review:'待证据复核',report:'待汇入报告',complete:'已汇入报告',archived:'记录已归档'};
const uid=()=>crypto.randomUUID();
export default function ResearchTasks({onResumeRecord}:any){
  const [tasks,setTasks]=useState<any[]>([]),[methods,setMethods]=useState<any[]>([]),[selected,setSelected]=useState(new URLSearchParams(location.search).get('task')||''),[objective,setObjective]=useState(''),[requirements,setRequirements]=useState(''),[basis,setBasis]=useState(''),[methodKey,setMethodKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[source,setSource]=useState<any>(null),[fullCatalog,setFullCatalog]=useState<any[]>([]),[showCreate,setShowCreate]=useState(false);
  const refresh=async()=>{const [t,m]=await Promise.all([api('tasks'),api('method_catalog')]);setTasks(t);setFullCatalog(m.methods);setMethods(m.methods);if(m.warnings?.length)setNotice('部分方法包需要修正：'+m.warnings.map((w:any)=>w.id+' / '+w.message).join('；'));};
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!busy)void api('tasks').then(setTasks).catch(e=>setError(e.message));},3000);return()=>clearInterval(timer);},[busy]);
  const task=tasks.find(x=>x.id===selected)||tasks[0],record=task?.record;
  const execute=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  const request=async(action:string)=>{try{await requestTaskConversation(task.id,action);setNotice('已将请求放入当前对话输入框。请发送，再按对话提示核对确认。');setError('');}catch(e:any){setError(e.message);}};
  const create=async()=>{const method=fullCatalog.find(x=>x.id+'@'+x.version===methodKey);const t=await api('task_create',{objective,requirements,basis,...(method?{methodId:method.id,methodVersion:method.version}:{}),requestId:uid()});setSelected(t.id);setShowCreate(false);await refresh();};
  const openReport=()=>{if(!openWorkbench({tab:'science',section:'report',item:task.reportId}))setNotice('请在“研究路线与证据 → 报告”查看这份报告。');};
  const chosen=fullCatalog.find(x=>x.id+'@'+x.version===methodKey);
  return <section className="power-research" aria-label="电力研究流程">
    <div className="power-heading"><div><small>AIRALOGY × DEEPSCIENTIST</small><h2>从研究任务到可复核结果</h2><p>确定任务，选用方法；数据、计算、人工确认和报告保存在同一条研究流程中。</p></div>{tasks.length>0&&<button disabled={busy} onClick={()=>setShowCreate(!showCreate)}>＋ 新建研究任务</button>}</div>
    {error&&<p role="alert" className="compact-error">{error}</p>}{notice&&<p role="status" className="power-notice">{notice}</p>}
    {(!tasks.length||showCreate)&&<form className="power-task-form" onSubmit={e=>{e.preventDefault();void execute(create);}}>
      <label>研究任务<textarea required rows={2} maxLength={2000} placeholder="例如：评估这批测点数据的完整性，或对测量通道做线性标定" value={objective} onChange={e=>setObjective(e.target.value)}/></label>
      <div className="power-form-actions"><button type="button" disabled={busy||!objective.trim()} onClick={()=>void execute(async()=>{const result=await api('method_catalog',{query:objective});setMethods(result.methods);setMethodKey('');setNotice(result.unmatched?'暂未匹配现成方法。可先保存任务，再导入所需方法包。':'请选择适合本次试验的方法，并核对适用范围。');})}>匹配适用方法</button><button type="button" onClick={()=>{setMethods(fullCatalog);setMethodKey('');}}>查看全部方法</button></div>
      <div className="science-form-row"><label>研究方法<select aria-label="任务研究方法" value={methodKey} onChange={e=>setMethodKey(e.target.value)}><option value="">暂不选择，记录待补方法</option>{methods.map(m=><option key={m.id+'@'+m.version} value={m.id+'@'+m.version}>{m.title} · {m.version}</option>)}</select></label><label>数据性质<select required aria-label="任务数据性质" value={basis} onChange={e=>setBasis(e.target.value)}><option value="">请明确选择</option>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{String(v)}</option>)}</select></label></div>
      {chosen&&<p className="power-method-note">{chosen.metadata.description}<br/>适用边界：{chosen.metadata.limitations}</p>}
      <label>试验要求与待补条件<textarea rows={2} maxLength={4000} value={requirements} onChange={e=>setRequirements(e.target.value)} placeholder="注明单位、量程、质控限值、数据来源，或所需仿真工具。表内默认限值需按本次试验要求核对。"/></label>
      <button className="experiment-primary" disabled={busy||!objective.trim()||!basis} type="submit">{methodKey?'保存任务并准备下一步':'保存待补方法的任务'}</button>
    </form>}
    {task&&<>
      {tasks.length>1&&<label>当前研究任务<select value={task.id} onChange={e=>{setSelected(e.target.value);setSource(null);}}>{tasks.map(t=><option key={t.id} value={t.id}>{t.objective} · {statusLabels[t.stage]}</option>)}</select></label>}
      <article className="power-task" aria-label="当前研究任务"><header><div><span className="power-kicker">{labels[task.basis]} · {task.selectedMethod?.title||'方法待补齐'}</span><h3>{task.objective}</h3></div><span className="science-badge">{statusLabels[task.stage]}</span></header>
        <ol className="power-steps">{task.steps.map((s:any,i:number)=><li key={s.title} data-status={s.status}><span>{s.status==='done'?'✓':i+1}</span>{s.title}</li>)}</ol>
        <div className="power-next"><small>下一步</small><p>{task.next}</p><div className="power-form-actions">
          {task.stage==='open'&&<button className="experiment-primary" onClick={()=>request('open')}>在对话中启用方法</button>}
          {record&&!record.archived&&<button className="experiment-primary" disabled={busy} onClick={()=>void execute(()=>onResumeRecord(record))}>{record.status==='submitted'?'查看实验结果':'打开实验表'}</button>}
          {task.stage==='review'&&<button onClick={()=>request('review')}>在对话中确认结果</button>}
          {task.stage==='evidence'&&<button disabled={busy} onClick={()=>void execute(async()=>{await api('task_evidence',{id:task.id,requestId:uid()});await refresh();})}>保存为研究证据</button>}
          {task.stage==='evidence_review'&&task.evidence?.data.review.status!=='rejected'&&<button onClick={()=>request('evidence')}>在对话中复核证据</button>}
          {task.stage==='report'&&<button className="experiment-primary" disabled={busy} onClick={()=>void execute(async()=>{await api('task_report',{id:task.id,requestId:uid()});await refresh();})}>汇入研究报告</button>}
          {task.report&&<button onClick={openReport}>{task.reportCurrent?'打开报告':'查看此前报告快照'}</button>}
        </div></div>
        {task.stage==='method'&&!record&&<form onSubmit={e=>{e.preventDefault();void execute(async()=>{const m=fullCatalog.find(x=>x.id+'@'+x.version===methodKey);await api('task_select_method',{id:task.id,expectedRevision:task.revision,methodId:m.id,methodVersion:m.version,requestId:uid()});await refresh();});}}><label>为任务选择已导入的方法<select required value={methodKey} onChange={e=>setMethodKey(e.target.value)}><option value="">请选择</option>{fullCatalog.map(m=><option key={m.id+'@'+m.version} value={m.id+'@'+m.version}>{m.title}</option>)}</select></label><button disabled={busy||!methodKey}>采用该方法</button><p>新增场景可在下方“方法包维护与独立实验”导入 Airalogy 协议包。</p></form>}
        {record?.calculation&&<div className="power-results"><strong>已保存的计算结果</strong><dl className="experiment-metrics">{task.metrics.map(({id,title,value}:any)=><div key={id}><dt>{title}</dt><dd>{typeof value==='boolean'?(value?'是':'否'):String(Number(Number(value).toPrecision(8)))}</dd></div>)}</dl><p>自动质控：{{passed:'满足本次判据',failed:'未满足本次判据', 'not-defined':'本方法未定义自动通过判据'}[task.quality as string]}。人工确认与证据复核仍需单独完成。</p>{task.charts.map((c:any)=><figure key={c.id} className="power-result-chart"><img alt={c.title} src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(c.svg)}/><figcaption>{c.title} <button onClick={()=>openWorkbench({view:'detail',kind:'chart',item:c.id,title:c.title})}>打开图表详情</button></figcaption></figure>)}</div>}
        {record&&record.status==='draft'&&<details className="power-import"><summary>导入 CSV 数据或下载表头模板</summary><p>UTF-8 编码，每次最多 500 行；只导入输入列，自动计算列由方法生成。导入会替换所选表格现有行。</p><TaskCsv task={task} busy={busy} execute={execute} refresh={refresh}/></details>}
        <details className="power-provenance"><summary>方法、来源与适用范围</summary><p>{task.requirements||'未另外记录试验要求；请核对表内默认参数。'}</p><p>{task.selectedMethod?.metadata.limitations}</p><p>任务：{task.id}</p>{record&&<p>记录：{record.id} / 修订 {record.revision}</p>}{task.evidence&&<p>证据：{task.evidence.id} / 修订 {task.evidence.revision} · {task.evidence.data.review.status}</p>}{task.selectedMethod&&<button disabled={busy} onClick={()=>void execute(async()=>setSource(await api('method_get',{id:task.methodId,version:task.methodVersion})))}>查看方法源码</button>}{source&&Object.entries(source.files).map(([name,content])=><details key={name}><summary>{name}</summary><pre>{String(content)}</pre></details>)}</details>
        {task.reportCurrent&&<details className="power-report"><summary>报告内容</summary><MarkdownPreview content={task.report.data.markdown}/><button onClick={()=>void downloadTextContent(task.report.data.markdown,task.reportId+'.md','text/markdown')}>下载 Markdown 报告</button></details>}
      </article>
    </>}
  </section>;
}

function TaskCsv({task,busy,execute,refresh}:any){
  const [source,setSource]=useState<any>(null),[selected,setSelected]=useState('');
  useEffect(()=>{void api('method_get',{id:task.methodId,version:task.methodVersion}).then(setSource).catch(()=>setSource(null));},[task.methodId,task.methodVersion]);
  if(!source)return null;
  const model=parseAimdProtocol(source.files['protocol.aimd']),owners=buildAimdFieldOwnership(model),tables=model.fields.var_table.filter(t=>owners[t.id]==='human'),table=tables.find(t=>t.id===selected)||tables[0];if(!table)return null;
  const columns=table.subvars.filter(c=>(owners[table.id+'.'+c.id]||owners[table.id])==='human');
  return <div className="power-form-actions"><select aria-label="CSV 目标表格" value={table.id} onChange={e=>setSelected(e.target.value)}>{tables.map(t=><option key={t.id} value={t.id}>{t.id}</option>)}</select><button disabled={busy} onClick={()=>void downloadTextContent(columns.map(c=>c.id).join(',')+'\r\n',task.methodId+'.csv','text/csv')}>下载 CSV 表头</button><label className="upload-button">导入 CSV<input type="file" accept=".csv,text/csv" aria-label="导入任务 CSV" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;void execute(async()=>{if(file.size>2*1024*1024)throw new Error('CSV 文件不能超过 2 MiB。');const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);const uploaded=await api('attachment_put',{name:file.name,contentBase64:btoa(text),requestId:uid()});await api('task_import_csv',{id:task.id,reference:uploaded.reference,table:table.id,expectedRecordRevision:task.record.revision,requestId:uid()});await refresh();});}}/></label></div>;
}

export function TaskRecordLink({record,onBack}:any){
  const [task,setTask]=useState<any>(null),[message,setMessage]=useState('');
  useEffect(()=>{let alive=true;void api('tasks').then(tasks=>{if(alive)setTask(tasks.find((t:any)=>t.recordId===record.id));}).catch(()=>{});return()=>{alive=false;};},[record.id,record.revision]);
  if(!task)return null;
  return <div className="record-review-hint power-record-link"><strong>{task.objective}</strong><p>{task.next}</p><button onClick={onBack}>返回研究任务</button>{task.stage==='review'&&<button onClick={async()=>{try{await requestTaskConversation(task.id,'review');setMessage('请求已放入当前对话输入框，请发送后确认。');}catch(e:any){setMessage(e.message);}}}>在对话中确认结果</button>}{message&&<p role="status">{message}</p>}</div>;
}
