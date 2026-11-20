import React,{useEffect,useState} from 'react';
import { publicAddresses } from '../public-addresses.mjs';
import { openWorkbench,platformIdentity } from './embedded-workbench.mjs';
const base=publicAddresses().workbench.href;
export default function RoundHistory({session,item,compact=false}:{session:string,item?:string,compact?:boolean}){
  const [page,setPage]=useState<any>(),[error,setError]=useState(''),[cursors,setCursors]=useState<string[]>([]);
  const before=cursors.at(-1);
  useEffect(()=>{
    if(!session||!platformIdentity)return;
    const abort=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      try{
        const res=await fetch(base+'discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rounds',sessionId:session,item,before}),signal:abort.signal});
        const data=await res.json();if(!res.ok)throw Error(data.error);
        if(!abort.signal.aborted){setPage(data);setError('');}
      }catch(e){if(!abort.signal.aborted)setError(String(e));}
      finally{if(!abort.signal.aborted)timer=setTimeout(refresh,5000);}
    }
    setPage(undefined);void refresh();return()=>{abort.abort();clearTimeout(timer);};
  },[session,item,before]);
  if(!platformIdentity||!session)return null;
  if(error)return <p role="alert">{error}</p>;
  if(!page||(item?page.id!==item:!Array.isArray(page.rows)))return <small>正在读取实验轮次…</small>;
  const title=(r:any)=>'第 '+r.round+' 轮 · '+r.status+' · '+r.count+' 项操作'+(r.failures?'（'+r.failures+' 项失败）':'');
  const link=(id?:string)=>{const target={view:'rounds',...(id?{item:id}:{})};return {href:base+'?'+new URLSearchParams({session,...target} as Record<string,string>),onClick:(e:React.MouseEvent)=>{if(!e.ctrlKey&&!e.metaKey&&openWorkbench(target))e.preventDefault();}};};
  if(item)return <section style={{padding:16,overflowWrap:'anywhere'}}><a {...link()}>全部实验轮次</a><h2>{title(page)}</h2><small>{new Date(page.time).toLocaleString()} · {page.goalId}</small><p style={{whiteSpace:'pre-wrap'}}>{page.summary}</p><ol>{page.operations.map((op:any,i:number)=><li key={i}><details><summary>{op.name} · {op.status}</summary><b>调用参数</b><pre style={{whiteSpace:'pre-wrap'}}>{typeof op.args==='string'?op.args:JSON.stringify(op.args,null,2)}</pre><b>返回结果</b><pre style={{whiteSpace:'pre-wrap'}}>{op.result||op.status}</pre>{op.files?.length>0&&<p>关联文件 · {op.files.join('、')}</p>}</details></li>)}</ol></section>;
  if(compact && !page.rows.length)return null;
  return <section aria-label="自动科研实验轮次"><strong>实验轮次</strong> {compact&&<a {...link()}>查看全部</a>}{!page.rows.length&&<p>本对话还没有自动科研轮次。</p>}{(compact?page.rows.slice(0,1):page.rows).map((r:any)=><p key={r.id}><a {...link(r.id)}>{title(r)} · 查看本轮操作</a> {r.summary.slice(0,100)}</p>)}{!compact&&<>{cursors.length>0&&<button onClick={()=>setCursors(c=>c.slice(0,-1))}>较新轮次</button>}{page.more&&<button onClick={()=>setCursors(c=>[...c,page.rows.at(-1).id])}>较早轮次</button>}</>}</section>;
}
