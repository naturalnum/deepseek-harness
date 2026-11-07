// Windows native execution reuses Harness Job ownership; this is not a file/network sandbox.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../../harness-runtime/package.json',import.meta.url));
const failure=(code,message)=>Object.assign(new Error(message),{code});
export const nativePython=()=>process.env.DS_NATIVE_PYTHON;
export async function runNativePython(args,input,{signal,timeout=120000}={}){
 signal?.throwIfAborted();
 const python=nativePython();if(!python)throw failure('ENGINE_UNAVAILABLE','未配置随 App 提供的本地计算环境。');
 const [{Context},{default:LocalRuntime}]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-subprocess-local'].map(name=>import(pathToFileURL(require.resolve(name)))));
 const parent=process.env.DS_RESEARCH_DATA_DIR?join(process.env.DS_RESEARCH_DATA_DIR,'native-tmp'):tmpdir();await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(join(parent,'epri-native-')),ctx=new Context(),cancel=new AbortController();
 const abort=()=>cancel.abort(failure('CANCELLED','运行已取消。'));
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>cancel.abort(failure('TIMEOUT','执行超过时限，已停止计算进程。')),timeout);
 let handle;
 try{
  await ctx.plugin(LocalRuntime);
  if(process.platform==='win32'&&ctx.subprocess.selectContainmentMode('ordinary')!=='windows-job')throw failure('ENGINE_UNAVAILABLE','Windows 计算进程管理不可用，请完整解压 App。');
  cancel.signal.throwIfAborted();
  // Tombstones remove service/credential configuration; Harness also scrubs credential-shaped names.
  const env=Object.fromEntries(Object.keys(process.env).filter(k=>/^(DS_|DSH_|PYTHON|NODE_OPTIONS$|NODE_PATH$)/i.test(k)).map(k=>[k,undefined]));
  Object.assign(env,{TEMP:directory,TMP:directory,EPRI_EXECUTION_ROOT:join(directory,'airalogy'),OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'});
  handle=ctx.subprocess.spawn({argv:[python,'-I','-X','utf8',...args],cwd:directory,env,stdio:{stdin:{data:input??''},stdout:'pipe',stderr:'pipe'},graceMs:1000,signal:cancel.signal});
  let size=0;const out=[],err=[];
  for(const [stream,chunks] of [[handle.stdout,out],[handle.stderr,err]])stream.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)cancel.abort(failure('LIMIT','执行输出超过 8 MiB。'));else chunks.push(chunk);});
  const result=await handle.done;
  if(cancel.signal.aborted)throw cancel.signal.reason;
  if(result.exitCode!==0)throw failure('ENGINE_UNAVAILABLE',Buffer.concat(err).toString('utf8').slice(-3000)||'本地计算进程未完成。');
  return Buffer.concat(out).toString('utf8');
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',abort);
  handle?.terminate();await ctx.fiber.dispose();
  await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
}
