import {requestResearch} from '../../cloud-bridge.mjs';
declare global { interface Window { __DS_RESEARCH_PUBLIC__?: {cloud?: boolean} } }
export const sessionId = new URLSearchParams(location.search).get("session") || null;
export async function api(op: string, args: any = {}, token?: string, signal?: AbortSignal) {
  if(window.__DS_RESEARCH_PUBLIC__?.cloud)return requestResearch(window,sessionId,op,args,signal);
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
