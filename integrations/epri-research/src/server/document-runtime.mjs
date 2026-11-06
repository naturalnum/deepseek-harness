import {randomUUID} from 'node:crypto';
import {docker,workerCall} from './engine-runtime.mjs';
import {nativePython,runNativePython} from './native-runtime.mjs';
import {fileURLToPath} from 'node:url';
export const documentImage=()=>process.env.DS_DOCUMENT_IMAGE || 'epri-document-tools:20261026';
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID'});};
export function validateDocumentInput(input){
 if(!input || !['.pdf','.png','.jpg','.jpeg','.tif','.tiff','.bmp'].includes(input.extension))fail('不支持的文档格式。');
 if(!['chi_sim+eng','eng','chi_sim'].includes(input.language))fail('不支持的 OCR 语言。');
 if(typeof input.contentBase64!=='string'||input.contentBase64.length>48*1024*1024||!input.contentBase64.length)fail('文件为空或超过 36 MiB。');
 return {extension:input.extension,language:input.language,contentBase64:input.contentBase64};
}
export async function documentStatus(){
 if(process.env.DS_ENGINE_URL)return workerCall('/documents/status');
 if(nativePython()){
  try{await runNativePython([fileURLToPath(new URL('./document-native.py',import.meta.url)),'--status'],null,{timeout:20000});return {available:true,execution:'native',engine:'pymupdf+rapidocr-onnx',maxPages:80};}
  catch(error){return {available:false,execution:'native',maxPages:80,message:'本地识别环境未就绪，请确认 App 已完整解压。',detail:error.message};}
 }
 try{await docker(['image','inspect',documentImage(),'--format','{{.Id}}'],null,{timeout:10000});return {available:true,image:documentImage(),maxPages:80};}
 catch{return {available:false,image:documentImage(),maxPages:80};}
}
export async function extractDocument(input,signal){
 const payload=validateDocumentInput(input);
 if(process.env.DS_ENGINE_URL)return workerCall('/documents/extract',payload,signal,185000);
 return extractDocumentLocally(payload,signal);
}
export async function extractDocumentLocally(input,signal){
 const payload=validateDocumentInput(input);
 if(nativePython()){
  const output=await runNativePython([fileURLToPath(new URL('./document-native.py',import.meta.url))],JSON.stringify(payload),{signal,timeout:180000});
  const data=JSON.parse(output);if(!Array.isArray(data.pages))fail('提取器未返回页面文字。');return data;
 }
 const name='epri-doc-'+randomUUID();
 const output=await docker(['run','--rm','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','768m','--pids-limit','96','--user','1000:1000','--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','-i',documentImage(),'--stdin'],JSON.stringify(payload),{name,signal,timeout:180000});
 const data=JSON.parse(output);if(!Array.isArray(data.pages))fail('提取器未返回页面文字。');return data;
}
