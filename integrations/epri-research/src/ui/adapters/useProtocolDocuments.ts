// Transport adapter replacing Electron IPC; original document browser is retained.
import { useEffect,useMemo,useState } from "react";
import {api,sessionId} from './api';
export type ProtocolDocument = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  kind: "aimd" | "markdown" | "record";
  title: string;
  summary?: string;
  content: string;
  current: boolean;
};
export function useProtocolDocuments({
  filePath,
  content,
}: {
  workspace?: string;
  filePath?: string;
  content: string;
}) {
  const [related,setRelated]=useState<ProtocolDocument[]>([]),[loading,setLoading]=useState(false);
  useEffect(()=>{
    let cancelled=false;setLoading(true);
    void (async()=>{
      const state=await api('state',{includeArchived:true});
      const documents:ProtocolDocument[]=state.protocols.filter((p:any)=>p.sessionId===sessionId||state.records.some((r:any)=>r.protocolId===p.id&&r.protocolVersion===p.version)).map((p:any)=>({id:'protocol:'+p.id+'@'+p.version,name:p.id+'@'+p.version+'.aimd',path:'protocol:'+p.id+'@'+p.version,relativePath:p.id+' / '+p.version,kind:'aimd',title:p.title+' · v'+p.version,content:p.content,current:false}));
      for(const r of state.records)documents.push({id:'record:'+r.id,name:r.id+'.record.json',path:'record:'+r.id,relativePath:r.protocolId+' / '+r.id,kind:'record',title:r.protocolId+' · 记录 v'+r.revision,summary:r.archived?'已归档的记录快照':'当前保存的记录快照',content:JSON.stringify(r,null,2),current:false});
      for(const f of state.artifacts.filter((f:any)=>f.kind==='file'&&/\.(md|aimd|txt)$/i.test(f.name)).slice(0,20)){
        const a=await api('attachment_get',{reference:f.reference});
        if(a.contentBase64.length>700000)continue;
        const content=new TextDecoder().decode(Uint8Array.from(atob(a.contentBase64),(c)=>c.charCodeAt(0)));
        documents.push({id:f.reference,name:f.name,path:f.reference,relativePath:f.name,kind:/\.aimd$/i.test(f.name)?'aimd':'markdown',title:f.title||f.name,summary:'固定附件 · '+f.reference.slice(11,23),content,current:false});
      }
      if(!cancelled)setRelated(documents);
    })().catch(()=>{if(!cancelled)setRelated([]);}).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[filePath,content]);
  const documents = useMemo<ProtocolDocument[]>(
    () => [
      {
        id: filePath || "protocol",
        name: filePath || "protocol.aimd",
        path: filePath || "protocol.aimd",
        relativePath: filePath || "protocol.aimd",
        kind: "aimd",
        title: content.match(/^# (.+)/m)?.[1] || "Protocol",
        content,
        current: true,
      },
      ...related.filter(d=>d.path!==filePath),
    ],
    [filePath, content,related],
  );
  return { documents, loading };
}
