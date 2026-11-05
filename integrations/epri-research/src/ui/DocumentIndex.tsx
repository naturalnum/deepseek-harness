import React,{useEffect,useState} from 'react';
import {api} from './adapters/api';
export default function DocumentIndex({workspace}:any){
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[detail,setDetail]=useState<any>(null),[language,setLanguage]=useState('chi_sim+eng');
 const refresh=async()=>setState(await api('document_status'));
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
 const files=workspace.artifacts.filter((a:any)=>a.kind==='file'&&/\.(pdf|png|jpg|jpeg|tiff?|bmp)$/i.test(a.name));
 const run=async(op:string,reference:string)=>{setBusy(reference);setError('');try{setDetail(await api(op,{reference,...(op==='document_extract'?{language}:{})}));await refresh();}catch(e:any){setError(e.message);}finally{setBusy('');}};
 return <details className="science-card document-index"><summary>PDF 与图片全文索引</summary><p>提取 PDF 的原文，对扫描页与图片进行离线 OCR。检索结果保留页码和原文件指纹；识别文字需要核对。</p>{error&&<p role="alert" className="compact-error">{error}</p>}
 <p>{state?.available?'离线识别引擎已就绪':state?.message||'识别引擎尚未就绪，请检查本地识别环境。'} <button disabled={!!busy} onClick={()=>void refresh().catch(e=>setError(e.message))}>检查引擎</button></p>
 <label>识别语言<select value={language} onChange={e=>setLanguage(e.target.value)}><option value="chi_sim+eng">简体中文与英文</option><option value="eng">英文</option><option value="chi_sim">简体中文</option></select></label>
 {!files.length&&<p>先在对话成果中添加 PDF 或图片。</p>}{files.map((f:any)=>{const indexed=state?.documents.find((d:any)=>d.reference===f.reference);return <div className="document-row" key={f.id}><span>{f.name}{indexed?' · '+indexed.pageCount+' 页，'+indexed.ocrPages+' 页 OCR':''}</span><button disabled={!!busy||!state?.available||workspace.access?.role==='viewer'} onClick={()=>void run('document_extract',f.reference)}>{busy===f.reference?'正在提取…':indexed?'重新提取':'建立索引'}</button>{indexed&&<button disabled={!!busy} onClick={()=>void run('document_text',f.reference)}>查看文字</button>}</div>;})}
 {detail&&<div>{detail.pages.map((p:any)=><details key={p.page}><summary>第 {p.page} 页 · {p.method==='ocr'?'OCR 识别':'PDF 原文'}</summary><pre>{p.text||'未识别到文字。'}</pre></details>)}</div>}</details>;
}
