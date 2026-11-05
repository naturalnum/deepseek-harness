// Restricted worker: fixed protocol and document actions; callers cannot select commands or images.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {engineStatus,runDockerPayload} from '../dist/server/engine-runtime.mjs';
import {documentStatus,extractDocumentLocally,validateDocumentInput} from '../dist/server/document-runtime.mjs';
const token=readFileSync(process.env.DS_ENGINE_TOKEN_FILE,'utf8').trim();
if(token.length<32)throw new Error('Engine token must contain at least 32 characters');
let running=0;
const server=http.createServer(async(req,res)=>{
 const send=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}};
 const supplied=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'') || '');
 const expected=Buffer.from(token);
 if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return send(401,{error:'Unauthorized'});
 const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
 try{
  if(req.method==='GET' && req.url==='/status')return send(200,await engineStatus());
  if(req.method==='GET' && req.url==='/documents/status')return send(200,await documentStatus());
  const documentRequest=req.url==='/documents/extract';
  if(req.method!=='POST' || (!documentRequest && req.url!=='/run'))return send(404,{error:'Not found'});
  if(running>=2)return send(429,{error:'Engine busy'});
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(documentRequest?49:7)*1024*1024)return send(413,{error:'Request too large'});chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString());
  if(documentRequest){
    const document=validateDocumentInput(input);if(running>=2)return send(429,{error:'Worker busy'});
    running++;try{send(200,await extractDocumentLocally(document,controller.signal));}finally{running--;}return;
  }
  if(!['parse_protocol','validate_variables','assign_variable','import_records','migrate_schema','workflow_assign'].includes(input.action))throw new Error('Unsupported action');
  if(!input.files || typeof input.files!=='object' || Array.isArray(input.files) || Object.keys(input.files).length>100)throw new Error('Invalid files');
  let fileSize=0;for(const [name,value] of Object.entries(input.files)){if(typeof value!=='string' || !/^[\w.\-/]+$/.test(name) || name.split('/').some(p=>!p || p==='..' || p==='.'))throw new Error('Invalid package path');fileSize+=Buffer.byteLength(value);}
  if(fileSize>3*1024*1024)throw new Error('Package too large');
  if(running>=2)return send(429,{error:'Engine busy'});
  running++;try{send(200,await runDockerPayload({action:input.action,files:input.files,params:input.params,attachments:input.attachments},{signal:controller.signal,timeout:120}));}finally{running--;}
 }catch(error){send(400,{error:error.message,code:error.code});}
});
server.listen(Number(process.env.DS_ENGINE_PORT || 43129),'127.0.0.1',()=>console.log('Restricted protocol and document worker is ready.'));
