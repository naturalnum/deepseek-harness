import {embedded} from './embedded-workbench.mjs';
import {publicAddresses} from '../public-addresses.mjs';
import {sessionId} from './adapters/api';
export async function requestTaskConversation(id,action){
  if(!embedded||window.parent===window)throw new Error('请从 Harness 科研对话打开此任务，人工确认在当前对话中进行。');
  const origin=publicAddresses().harness.origin,requestId=crypto.randomUUID();
  return new Promise((resolve,reject)=>{const done=(error)=>{clearTimeout(timer);window.removeEventListener('message',receive);if(error)reject(error);else resolve(true);};const receive=event=>{if(event.source===window.parent&&event.origin===origin&&event.data?.type==='research-task-request-result'&&event.data.requestId===requestId)done(event.data.ok?null:new Error(event.data.error||'对话输入服务尚未就绪。'));};const timer=setTimeout(()=>done(new Error('未连接到当前对话，请从科研模式重新打开任务。')),5000);window.addEventListener('message',receive);window.parent.postMessage({type:'research-task-request',sessionId,taskId:id,action,requestId},origin);});
}
