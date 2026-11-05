export function searchLocal(db,state,science,session,query,maxResults=10){
 if(!session || typeof query!=='string' || !query.trim() || query.length>200 || !Number.isInteger(maxResults) || maxResults<1 || maxResults>20)throw new Error('请在科研对话中输入 1–200 字关键词，结果数为 1–20。');
 const needle=query.trim().toLocaleLowerCase(),results=[],skipped=[];let scanned=0;
 const search=(text,source)=>{const offset=text.toLocaleLowerCase().indexOf(needle);if(offset>=0)results.push({...source,excerpt:text.slice(Math.max(0,offset-120),offset+needle.length+240),offset,verification:'candidate-needs-review'});};
 for(const file of state.artifacts.filter(a=>a.sessionId===session && a.kind==='file')){
  const indexed=db.prepare('SELECT body FROM document_text WHERE session=? AND reference=?').get(session,file.reference);
  if(indexed){const doc=JSON.parse(indexed.body);for(const p of doc.pages)search(p.text,{title:file.title,kind:'document',reference:file.reference,sha256:file.reference.slice(11),page:p.page,method:p.method});continue;}
  if(!/\.(txt|md|csv|tsv|json|aimd|log)$/i.test(file.name)){skipped.push(file.name);continue;}
  const row=db.prepare('SELECT body FROM attachments WHERE reference=?').get(file.reference);if(!row)continue;
  scanned+=row.body.length;if(scanned>16*1024*1024){skipped.push(file.name);continue;}
  search(Buffer.from(row.body).toString('utf8'),{title:file.title,kind:'attachment',reference:file.reference,sha256:file.reference.slice(11)});
 }
 for(const record of state.records.filter(r=>r.sessionId===session && !r.archived))search(JSON.stringify(record.run),{title:'实验记录 · '+record.protocolId,kind:'record',id:record.id,revision:record.revision});
 for(const [kind,items] of Object.entries(science))for(const item of items)search(JSON.stringify(item.data),{title:item.data.title || item.data.route?.objective || item.id,kind,id:item.id,revision:item.revision,sha256:item.sha256});
 return {query:query.trim(),results:results.slice(0,maxResults),totalMatches:results.length,scannedBytes:scanned,skipped,scope:'current-conversation',note:'按原文匹配。已建立索引的 PDF 和图片按页检索；OCR 文字及匹配结果仍需核对原文。'};
}
