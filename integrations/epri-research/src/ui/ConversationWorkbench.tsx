import React, { useEffect, useRef, useState } from 'react';
import { api, sessionId } from './adapters/api';
import { downloadTextContent } from './adapters/download';
import MarkdownPreview from './adapters/MarkdownPreview';
import { openAiraArchive } from '../reused/aira/index';
import { parseAimdProtocol } from '../reused/protocol/aimdProtocolModel';
import { applyWorkbenchTheme } from './workbench-theme.mjs';
import {embedded,platformIdentity,openWorkbench} from './embedded-workbench.mjs';
import { publicAddresses } from '../public-addresses.mjs';
const addresses = publicAddresses();
const fullUrl = (record?: string) => addresses.workbench.href + '?session=' + encodeURIComponent(sessionId || '') + (record ? '&record=' + encodeURIComponent(record) : '');
const openLink = (event: React.MouseEvent, target: any) => {if(openWorkbench(target))event.preventDefault();};
const detailView = new URLSearchParams(location.search).get('view') === 'detail';
const decode = (bytes: string) => Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
const imageMime = (name: string) => ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml'} as Record<string,string>)[name.split('.').pop()?.toLowerCase() || ''];
export const artifactCategory = (artifact: {kind: string; name?: string}) => artifact.kind === 'file' && imageMime(artifact.name || '') ? 'chart' : artifact.kind;
function AttachmentThumbnail({reference, name}: {reference: string; name: string}) {
  const [image, setImage] = useState('');
  const mime = imageMime(name);
  useEffect(() => {
    const controller = new AbortController();
    setImage('');
    void api('attachment_get', {reference}, undefined, controller.signal).then(file => {
      if (!controller.signal.aborted) setImage('data:' + mime + ';base64,' + file.contentBase64);
    }).catch(() => { /* Keep the preview action available if the thumbnail cannot load. */ });
    return () => controller.abort();
  }, [reference, mime]);
  return image ? <img alt={name} src={image} loading="lazy" decoding="async" onError={() => setImage('')} /> : <span className="image-placeholder" aria-hidden="true">▧</span>;
}
export function saveBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RecordPreview({record}: {record: any}) {
  return <div className="record-preview"><p><span className="badge">Airalogy Record JSON</span> {record.record_id} · 修订 {record.record_version}</p>
    {['var','step','check','quiz'].map(group => <section key={group}><h3>{{var:'变量与表格',step:'实验步骤',check:'人工检查',quiz:'决策与问答'}[group]}</h3>{Object.entries(record.data?.[group] || {}).map(([key,value]) => <div className="record-value" key={key}><strong>{key}</strong><pre>{typeof value === 'string' ? value : JSON.stringify(value,null,2)}</pre></div>)}</section>)}
  </div>;
}
function AimdPreview({content}: {content: string}) {
  const model = parseAimdProtocol(content);
  return <><h3>{model.title || 'AIMD 协议'}</h3><p>{model.variables.length} 个变量 · {model.steps.length} 个步骤 · {model.checks.length} 项复核</p><pre>{content}</pre></>;
}
export default function ConversationWorkbench() {
  const [state,setState] = useState<any>(null), [error,setError] = useState(''), [key,setKey] = useState('');
  const [filter,setFilter] = useState('all'), [busy,setBusy] = useState(false), [preview,setPreview] = useState<any>(null), [history,setHistory] = useState<any>(null);
  const [updated,setUpdated] = useState('');
  const [checking,setChecking] = useState(true);
  const detailOpened = useRef(false);
  const seenTasks=useRef<Set<string>|null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => applyWorkbenchTheme(event);
    window.addEventListener('message', receive);
    if (window.parent !== window) window.parent.postMessage({type:'research-theme-ready',sessionId}, addresses.harness.origin);
    return () => window.removeEventListener('message', receive);
  }, []);
  const refresh = async (signal?: AbortSignal) => {
    const s = await api('state', {}, undefined, signal); setState(s); setUpdated(new Date().toLocaleTimeString());
    const taskKeys=(s.tasks||[]).map((t:any)=>t.id+':'+(t.recordId||''));
    if(seenTasks.current&&embedded&&!detailView){const next=(s.tasks||[]).find((t:any)=>!seenTasks.current!.has(t.id+':'+(t.recordId||'')));if(next)openWorkbench({tab:'engine',task:next.id,...(next.recordId?{record:next.recordId}:{})});}
    seenTasks.current=new Set(taskKeys);
    if (window.parent !== window) window.parent.postMessage({type:'research-summary',sessionId,count:s.artifacts.length + s.records.length}, addresses.harness.origin);
  };
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const poll = async () => { if (pending || (document.hidden && state)) return; pending = true; try { await refresh(controller.signal); } catch (e: any) { if (!controller.signal.aborted) { if (e.status === 401) { setState(null); setError(''); } else setError(e.message); } } finally { pending = false; if (!controller.signal.aborted) setChecking(false); } };
    void poll(); const timer = state ? setInterval(poll,3000) : undefined;
    return () => { clearInterval(timer); controller.abort(); };
  }, [Boolean(state)]);
  useEffect(() => { if (!detailView && (preview || history) && !dialog.current?.open) dialog.current?.showModal(); }, [preview,history]);
  useEffect(()=>{
    if(!detailView||!state||detailOpened.current)return;
    detailOpened.current=true;
    const query=new URLSearchParams(location.search),kind=query.get('kind'),id=query.get('item');
    const item=kind==='record'?state.records.find((x:any)=>x.id===id):state.artifacts.find((x:any)=>x.id===id&&x.kind===kind);
    if(item)void task(()=>show({...item,kind:kind==='record'?'record':item.kind}));
    else setError('此成果不存在或无权访问，请返回当前对话重新选择。');
  },[state]);
  useEffect(() => {
    if (window.parent !== window) window.parent.postMessage({type:'research-preview',sessionId,open:Boolean(preview || history)}, addresses.harness.origin);
  }, [preview,history]);
  const task = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const upload = async (file: File) => {
    if (file.size > 2*1024*1024) throw new Error('单文件最大 2 MiB，请选择较小文件。');
    const contentBase64 = await new Promise<string>((resolve,reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(new Error('无法读取文件')); r.readAsDataURL(file); });
    await api('attachment_put',{name:file.name,contentBase64,requestId:crypto.randomUUID()}); await refresh();
  };
  const show = async (a: any) => {
    if(!detailView&&openWorkbench({view:'detail',kind:a.kind,item:a.id,title:a.title || a.protocolId || a.name}))return;
    if (a.kind === 'chart') { setPreview({name:a.title,image:'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(a.svg)))}); return; }
    if (a.kind === 'record') { setPreview({name:a.protocolId,record:await api('record_export',{id:a.id})}); return; }
    const file = await api('attachment_get',{reference:a.reference}), bytes = decode(file.contentBase64), text = new TextDecoder().decode(bytes);
    const name = a.name, ext = name.split('.').pop().toLowerCase();
    if (ext === 'aira') {
      const archive = await openAiraArchive(bytes);
      if (archive.entries.length > 1000 || archive.entries.reduce((n,e) => n+e.uncompressedSize,0) > 64*1024*1024) throw new Error('归档展开后超过预览上限（64 MiB / 1000 项）');
      const validation = await archive.validate();
      if (!validation.ok) throw new Error('Airalogy 归档校验未通过：' + validation.issues.join('; '));
      const protocols = await Promise.all((archive.manifest.protocols || (archive.manifest.protocol ? [archive.manifest.protocol] : [])).map(async p => ({name:p.protocol_name || p.protocol_id,content:await archive.readText((p.archive_root ? p.archive_root + '/' : '') + (p.entrypoint || 'protocol.aimd'))})));
      const records = await Promise.all((archive.manifest.records || []).map(r => archive.readJson(r.path)));
      setPreview({name,archive,summary:archive.summary(),protocols,records});
    } else if (imageMime(name)) setPreview({name,image:'data:' + imageMime(name) + ';base64,' + file.contentBase64});
    else if (ext === 'aimd') setPreview({name,aimd:text});
    else if (ext === 'json') { const value = JSON.parse(text); setPreview(value.format === 'airalogy.record' ? {name,record:value} : {name,text:JSON.stringify(value,null,2)}); }
    else if (['md','txt','csv','tsv','log','py','js','mjs','yaml','yml'].includes(ext)) setPreview({name,text,markdown:ext === 'md'});
    else setPreview({name,text:'此类型请下载后使用本地应用打开。文件原始内容已经保存。'});
  };
  if (!state) return <div className="compact-connect">
    <div className="compact-connect-heading"><span className="compact-connect-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></span><div><strong>{checking ? '正在载入科研成果…' : platformIdentity ? '请确认平台登录状态' : '连接你的科研成果'}</strong><p>{platformIdentity ? '使用当前平台身份，无需单独的科研账号或密钥。' : '连接后，当前对话的文件、图表与实验记录会自动呈现。'}</p></div></div>
    {!checking && platformIdentity && <button onClick={() => location.reload()}>重新载入</button>}
    {!checking && !platformIdentity && <form className="compact-connect-form" onSubmit={e => {e.preventDefault();if(key.trim()) void task(async () => { await api('state',{},key.trim()); setKey(''); await refresh(); });}}>
      <input type="password" aria-label="工作台访问密钥" aria-describedby="workbench-key-hint" placeholder="输入工作台访问密钥" autoComplete="off" spellCheck={false} disabled={busy} value={key} onChange={e => setKey(e.target.value)} />
      <button type="submit" disabled={busy || !key.trim()}>{busy ? '连接中…' : '连接工作台'}</button>
    </form>}
    <p className="compact-connect-hint" id="workbench-key-hint">{error ? <span role="alert">{error}</span> : platformIdentity ? '请在平台完成登录后重新载入。' : '使用本地工作台密钥，无需填写模型 API Key。'}</p>
  </div>;
  const items = [...state.artifacts,...state.records.map((r: any) => ({...r,kind:'record',title:r.protocolId}))].sort((a,b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const visibleItems = items.filter(a => filter === 'all' || artifactCategory(a) === filter);
  const previewBody = <>
    {preview?.image && <img className="preview-image" src={preview.image} alt={preview.name} />}
    {preview?.record && <RecordPreview record={preview.record} />}
    {preview?.aimd && <AimdPreview content={preview.aimd} />}
    {preview?.text && (preview.markdown ? <MarkdownPreview content={preview.text} /> : <pre>{preview.text}</pre>)}
    {preview?.archive && <><p className="archive-valid">✓ Airalogy 归档校验通过 · {preview.summary.recordCount} 条记录 · {preview.summary.fileCount} 个文件引用</p>{preview.protocols.map((p:any,i:number)=><details key={i}><summary>{p.name || '协议'} · AIMD</summary><AimdPreview content={p.content}/></details>)}{preview.records.map((r:any,i:number)=><details key={i} open><summary>记录 {r.record_id}</summary><RecordPreview record={r}/></details>)}{(preview.archive.manifest.files || []).map((f:any,i:number)=><button key={i} onClick={()=>void task(async()=>{const blob=preview.archive.manifest.blobs.find((b:any)=>b.blob_id===f.blob_id);saveBytes(await preview.archive.readBytes(blob.archive_path),f.filename || 'attachment');})}>下载包内附件：{f.filename}</button>)}</>}
  </>;
  if(detailView)return <section className="research-detail">
    <header className="research-detail-header"><div><h2>{preview?.name || '成果详情'}</h2><p>当前对话 · DeepScientist 研究成果</p></div>{preview && <span className="badge">{preview.image ? '图片与图表' : preview.record ? '实验记录' : '成果文件'}</span>}</header>
    <div className="research-detail-content">{error?<p role="alert" className="compact-error">{error}</p>:preview?previewBody:<p role="status">正在载入成果…</p>}</div>
  </section>;
  return <div className="conversation-workbench">
    <div className="workbench-actions"><div className="workbench-tabs">{[['all','全部','当前对话的全部成果'],['file','文件','文档、代码、数据表和其他附件'],['chart','图片与图表','图片文件和工作台生成的图表'],['record','实验记录','按 Airalogy 协议填写的实验数据、步骤和复核结果']].map(([id,label,hint]) => <button key={id} title={hint} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} <small>{items.filter(a => id === 'all' || artifactCategory(a) === id).length}</small></button>)}</div><label className="upload-button">＋ 添加文件<input type="file" disabled={busy} aria-label="添加成果文件" onChange={e => {const f=e.target.files?.[0];e.target.value='';if(f) void task(() => upload(f));}} /></label><a className="workbench-progress" href={fullUrl()+'&tab=science'} target={embedded?undefined:'_blank'} rel="noreferrer" onClick={e=>openLink(e,{tab:'science'})}>研究进展 →</a><span className="workbench-export"><button disabled={busy} onClick={() => void task(async () => {const a=await api('workspace_export');saveBytes(decode(a.contentBase64),a.name);})}>导出 .aira</button><small>Airalogy 格式</small></span><button disabled={busy} onClick={() => void task(async () => setHistory(await api('history_list')))}>历史成果</button></div>
    {error && <p className="compact-error" role="alert">{error}</p>}
    {state.tasks?.length>0&&<button className="workbench-task-link" onClick={()=>openWorkbench({tab:'engine',task:state.tasks[0].id})}>研究任务：{state.tasks[0].objective} <span>继续 →</span></button>}
    {!items.length && <div className="workbench-empty"><b>这次研究的成果，都在这里</b><p>文件、图表与 Airalogy 记录自动汇集，也可添加已有文件。</p><a target={embedded?undefined:'_blank'} rel="noreferrer" href={fullUrl()} onClick={e=>openLink(e,{tab:'protocols'})}>新建协议与记录 →</a></div>}
    {items.length > 0 && !visibleItems.length && <p className="workbench-empty">{{file:'本对话暂无文档、代码或数据文件。',chart:'本对话暂无图片或图表。',record:'本对话暂无实验记录，可在完整科研工作台中按协议创建。'}[filter]}</p>}
    <div className="workbench-grid">{visibleItems.map(a => <article className="result-card" key={a.kind+a.id}>
      <button className="result-preview" aria-label={'预览 ' + a.title} title="点击预览" onClick={() => void task(() => show(a))}>{a.kind === 'chart' ? <img alt={a.title} src={'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(a.svg)))} /> : a.kind === 'file' && imageMime(a.name) ? <AttachmentThumbnail reference={a.reference} name={a.name} /> : <span>{a.kind === 'record' ? 'AIMD' : a.name.split('.').pop().toUpperCase().slice(0,8)}</span>}</button>
      <div><strong title={a.title}>{a.kind === 'file' && imageMime(a.name) ? a.title.replace(/\.(png|jpe?g|gif|webp|svg)$/i, '') : a.title}</strong><small>{a.kind === 'record' ? (a.status === 'submitted' ? '已人工提交' : '待复核草稿') + ' · 修订 ' + a.revision : a.kind === 'chart' ? 'SVG · 科研图表' : (a.size/1024).toFixed(1) + ' KiB'} · {new Date(a.updatedAt || a.createdAt).toLocaleDateString()}</small>
      <div className="result-links"><button onClick={() => void task(() => show(a))}>查看详情</button>{a.kind === 'record' ? <a href={fullUrl(a.id)} target={embedded?undefined:'_blank'} rel="noreferrer" onClick={e=>openLink(e,{record:a.id})}>编辑记录 →</a> : <button onClick={() => void task(async () => {if(a.kind === 'chart') await downloadTextContent(a.svg,a.id+'.svg','image/svg+xml');else {const file=await api('attachment_get',{reference:a.reference});saveBytes(decode(file.contentBase64),a.name);}})}>下载</button>}{a.kind === 'record' && <button onClick={() => void task(async () => {const r=await api('record_export',{id:a.id});await downloadTextContent(JSON.stringify(r,null,2),a.id+'.record.json','application/json');})}>JSON</button>}</div></div>
    </article>)}</div>
    <div className="workbench-status">{busy ? '正在处理…' : '自动更新 · ' + updated}<span>{sessionId ? '仅显示本对话成果' : '未关联的历史研究空间'}</span></div>
    {(preview || history) && <dialog ref={dialog} className="workbench-dialog" onClose={() => {setPreview(null);setHistory(null);}}><header><strong>{preview?.name || '关联历史成果'}</strong><button autoFocus onClick={() => dialog.current?.close()}>关闭</button></header>
      {previewBody}
      {history && <><p>旧数据保留在历史空间。点击下方按钮，会将选中成果归入当前对话。</p>{[...history.records.map((r: any) => ({...r,kind:'record',title:r.protocolId})),...history.artifacts.map((r: any) => ({...r,kind:'artifact'}))].map((r: any) => <div className="history-row" key={r.id}><span>{r.title} <small>{r.id.slice(0,8)}</small></span><button disabled={busy || !sessionId} onClick={() => void task(async () => {await api('history_associate',{kind:r.kind,id:r.id,requestId:crypto.randomUUID()});setHistory(await api('history_list'));await refresh();})}>关联到本次对话</button></div>)}{!history.records.length && !history.artifacts.length && <p>没有尚未关联的历史成果。</p>}</>}
      {error && <p role="alert" className="compact-error">{error}</p>}
    </dialog>}
  </div>;
}
