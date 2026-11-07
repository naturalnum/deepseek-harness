import {publicAddresses} from '../../public-addresses.mjs';
export const cloudMode = Boolean((window as Window & {__DS_RESEARCH_PUBLIC__?:{cloud?:boolean}}).__DS_RESEARCH_PUBLIC__?.cloud);
export const sessionId = new URLSearchParams(location.search).get("session") || null;
export async function api(op: string, args: any = {}, token?: string, signal?: AbortSignal) {
  if (cloudMode) return bridge(op,args,false,signal);
  const response = await fetch("./api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ op, args, sessionId }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(response.status === 401
    ? (token ? '访问密钥不正确，请检查后重试。' : '登录已失效，请在平台登录后重新载入。')
    : data.code ? data.code + ": " + data.error : data.error), {status: response.status,code:data.code});
  return data.result;
}

/** Explicit button probe uses the current native conversation rather than a Web process launch. */
export function nativeApi(op:string,args:Record<string,unknown>={}) {
  return cloudMode ? bridge(op,args,true) : api(op,args);
}
function bridge(op:string,args:unknown,execute:boolean,signal?:AbortSignal):Promise<any> {
  if(window.parent===window)return Promise.reject(new Error('请从当前原生科研对话的右侧栏打开工作台。'));
  const budget=(window as Window & {__DS_RESEARCH_PUBLIC__?:{cloudRequestTimeoutMs?:number}}).__DS_RESEARCH_PUBLIC__?.cloudRequestTimeoutMs;
  if(!Number.isSafeInteger(budget)||!budget||budget<1000)return Promise.reject(new Error('科研页面等待时间尚未配置。'));
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(budget)]);
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const channel=new MessageChannel();
    const stop=()=>{channel.port1.postMessage({type:'cancel'});finish();reject(signal?.reason || new Error('请求已取消。'));};
    const finish=()=>{signal?.removeEventListener('abort',stop);channel.port1.close();};
    channel.port1.onmessage=event=>{finish();if(event.data?.ok)resolve(event.data.value);else reject(new Error(event.data?.error || '科研操作未确认，请检查当前对话。'));};
    signal?.addEventListener('abort',stop,{once:true});
    window.parent.postMessage({type:'research-api',sessionId,op,args,execute},publicAddresses().harness.origin,[channel.port2]);
  });
}
