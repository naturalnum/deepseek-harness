import {extname} from 'node:path';
import {documentStatus,extractDocument} from './document-runtime.mjs';
import {z} from 'zod';
const reference=z.string().regex(/^attachment:[a-f0-9]{64}$/);
export const documentContracts={
 document_status:{description:'Check offline PDF/OCR runtime and list indexed document metadata in this conversation.',shape:{}},
 document_extract:{description:'Extract PDF text and OCR scanned PDF/image pages locally. Save page numbers and source hash for offline search. OCR output requires review.',shape:{reference,language:z.enum(['chi_sim+eng','eng','chi_sim']).default('chi_sim+eng')}},
 document_text:{description:'Read extracted document pages for a source attachment in this conversation.',shape:{reference}},
};
export function documentStore(db,directory,runtime={status:documentStatus,extract:extractDocument}){
 db.exec('CREATE TABLE IF NOT EXISTS document_text(session TEXT NOT NULL,reference TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,reference))');
 const active=new Set();
 const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
 return {async execute(op,a,actor,signal,session){
  if(!session)fail('INVALID','请从科研对话打开资料索引。');a=z.object(documentContracts[op].shape).strict().parse(a);
  if(op==='document_status'){
   const status=await runtime.status();
   const documents=db.prepare('SELECT reference,body FROM document_text WHERE session=?').all(session).map(r=>{const d=JSON.parse(r.body);return {reference:r.reference,indexedAt:d.indexedAt,pageCount:d.pages.length,ocrPages:d.pages.filter(p=>p.method==='ocr').length};});
   return {...status,documents};
  }
  const file=db.prepare('SELECT a.name,a.body FROM attachments a JOIN attachment_scopes s ON s.reference=a.reference WHERE s.session=? AND a.reference=?').get(session,a.reference);
  if(!file)fail('NOT_FOUND','附件不属于当前对话。');
  if(op==='document_text'){const row=db.prepare('SELECT body FROM document_text WHERE session=? AND reference=?').get(session,a.reference);return row?JSON.parse(row.body):fail('NOT_FOUND','请先提取该文件的文字。');}
  const extension=extname(file.name).toLowerCase();if(!['.pdf','.png','.jpg','.jpeg','.tif','.tiff','.bmp'].includes(extension))fail('INVALID','支持 PDF、PNG、JPEG、TIFF 和 BMP。');
  if(active.size>=2||active.has(session+':'+a.reference))fail('BUSY','文字提取正在进行，请稍后再试。');
  const key=session+':'+a.reference;active.add(key);
  try{
   const data=await runtime.extract({extension,language:a.language,contentBase64:Buffer.from(file.body).toString('base64')},signal);
   const result={...data,reference:a.reference,sourceSha256:a.reference.slice(11),name:file.name,indexedAt:new Date().toISOString()};
   db.prepare('INSERT INTO document_text VALUES(?,?,?) ON CONFLICT(session,reference) DO UPDATE SET body=excluded.body').run(session,a.reference,JSON.stringify(result));return result;
  }catch(e){if(e.name==='AbortError'||e.code==='CANCELLED')throw e;if(e.code==='INVALID')throw e;fail('UNAVAILABLE','文字提取失败：请检查识别环境是否就绪，文件是否加密或损坏；支持最多 80 页，处理时限 180 秒。');}
  finally{active.delete(key);}
 }};
}
