import {spawn} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {nativePython,runNativePython} from './native-runtime.mjs';

// Offline Docker imports retain the immutable image ID even when registry digest names are absent.
export const ENGINE_IMAGE=process.env.DS_ENGINE_IMAGE || 'ghcr.io/airalogy/airalogy-engine@sha256:5d26af0a28fc42f042cf079ac6e00b1a4435ff2d1fd02631c5d356bfdd0e08b7';
if(!/^(?:sha256:[a-f0-9]{64}|ghcr\.io\/airalogy\/airalogy-engine@sha256:[a-f0-9]{64})$/.test(ENGINE_IMAGE))throw new Error('Airalogy execution requires an immutable image ID or registry digest');
const resources=join(dirname(fileURLToPath(import.meta.url)),'engine');
const failure=(code,message)=>Object.assign(new Error(message),{code});
export function docker(args,input,{signal,timeout=120000,name}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(failure('CANCELLED','运行已取消。'));
    const child=spawn('docker',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',size=0,stopError;
    const stop=error=>{if(stopError)return;stopError=error;child.kill();if(name){const clean=spawn('docker',['rm','-f',name],{windowsHide:true,stdio:'ignore'});clean.on('error',()=>{});const timer=setTimeout(()=>clean.kill(),10000);clean.on('close',()=>clearTimeout(timer));}};
    const abort=()=>stop(failure('CANCELLED','运行已取消。'));
    const timer=setTimeout(()=>stop(failure('TIMEOUT','执行超过时限，已停止隔离环境。')),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)return stop(failure('LIMIT','执行输出超过 8 MiB。'));if(key==='out')out+=chunk;else err+=chunk;});
    child.on('error',error=>{stopError=error;});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(stopError)reject(stopError);else if(code!==0)reject(failure('ENGINE_UNAVAILABLE',(err || 'Docker 执行失败').slice(0,3000)));else resolve(out);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export async function engineStatus() {
  if(process.env.DS_ENGINE_URL)return workerCall('/status',undefined);
  if(nativePython()){
    try{const versions=JSON.parse(await runNativePython(['-c','import sys,json; from importlib.metadata import version; import airalogy; print(json.dumps({"python":sys.version.split()[0],"airalogy":version("airalogy")}))'],null,{timeout:15000}));return {ready:true,...versions,runtime:'Windows / Python '+versions.python,execution:'native',network:'host',isolation:'windows-job',limits:{seconds:120,concurrency:2}};}
    catch(error){return {ready:false,execution:'native',message:'本地计算环境未就绪，请确认 App 已完整解压。',detail:error.message};}
  }
  try {await docker(['image','inspect',ENGINE_IMAGE,'--format','{{.Id}}'],null,{timeout:10000});return {ready:true,image:ENGINE_IMAGE,network:'disabled',runtime:'Docker / Python 3.13',limits:{seconds:120,memoryMiB:512,cpus:1}};}
  catch(error){return {ready:false,image:ENGINE_IMAGE,message:'请启动 Docker Desktop 并导入 Airalogy 执行镜像。',detail:error.message};}
}
export async function runDockerExecutor(action,root,params,options={}) {
  options.signal?.throwIfAborted();
  const files={};
  function collect(dir,prefix='') {for(const entry of readdirSync(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())collect(join(dir,entry.name),name+'/');else if(entry.isFile())files[name]=readFileSync(join(dir,entry.name)).toString('base64');else throw failure('INVALID','协议包不允许符号链接。');}}
  collect(root);
  const payload={action,params,files,attachments:options.attachments || {}};
  if(options.executor)return options.executor(payload,options);
  if(process.env.DS_ENGINE_URL)return workerCall('/run',payload,options.signal);
  return runDockerPayload(payload,options);
}
export async function workerCall(route,payload,signal,timeout=125000){
  const token=readFileSync(process.env.DS_ENGINE_TOKEN_FILE,'utf8').trim();
  const deadline=AbortSignal.timeout(payload?timeout:15000);
  const response=await fetch(process.env.DS_ENGINE_URL+route,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined,signal:signal?AbortSignal.any([signal,deadline]):deadline});
  const result=await response.json();if(!response.ok)throw failure(result.code || 'ENGINE_UNAVAILABLE',result.error || '执行服务连接失败。');return result;
}
export async function runDockerPayload(input,options={}){
  const payload={...input,executors:Object.fromEntries(['protocol_executor.py','workflow_executor.py'].map(name=>[name,readFileSync(join(resources,name),'utf8')]))};
  if(nativePython()){
    const output=await runNativePython([join(resources,'runner.py')],JSON.stringify(payload),{signal:options.signal,timeout:Math.min(options.timeout || 120,120)*1000});
    try{const result=JSON.parse(output);if(typeof result.success!=='boolean')throw new Error();return result;}catch{throw failure('INVALID','执行引擎未返回有效 JSON 结果。');}
  }
  const name='epri-airalogy-'+randomUUID();
  const args=['run','--rm','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--user','1000:1000','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','-i','--entrypoint','python',ENGINE_IMAGE,'-c',readFileSync(join(resources,'runner.py'),'utf8')];
  const output=await docker(args,JSON.stringify(payload),{name,signal:options.signal,timeout:Math.min(options.timeout || 120,120)*1000});
  try {const result=JSON.parse(output);if(typeof result.success!=='boolean')throw new Error();return result;}catch{throw failure('INVALID','执行引擎未返回有效 JSON 结果。');}
}
