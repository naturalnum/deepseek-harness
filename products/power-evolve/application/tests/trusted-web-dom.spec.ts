/** Execute trusted browser source and assert requests/UI; response fixtures grant no Platform authority. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'

const web=process.env.PE_WEB_DOM_ROOT ?? resolve(import.meta.dirname,'../web')
type Reply=unknown
type FetchCall={ path:string;init:RequestInit|undefined;body:Record<string,unknown> }
type Handler=(call:FetchCall)=>Reply
const USER='7f257f12-6670-472c-a263-9ce5a9314090'
type HeldGate={ settled:boolean;release:()=>void }
const heldGates=new WeakMap<Promise<Reply>,HeldGate>()
type Fixture={ dom:JSDOM;pending:Set<Promise<unknown>>;quiesce:()=>Promise<void> }
const fixtures:Fixture[]=[]
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{ status,headers:{ 'content-type':'application/json' } })
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
/** A fetch takes ownership when it first consumes this gate; unused gates own no request. */
function deferred(){
  let fulfill!:(value:Reply)=>void,fail!:(error:Error)=>void
  const promise=new Promise<Reply>((yes,no)=>{fulfill=yes;fail=no})
  const gate:HeldGate={ settled:false,release:()=>{ resolve(reply({ error:'owned_fixture_disposed' },499)) } }
  const resolve=(value:Reply)=>{if(!gate.settled){gate.settled=true;fulfill(value)}}
  const reject=(error:Error)=>{if(!gate.settled){gate.settled=true;fail(error)}}
  heldGates.set(promise,gate)
  return { promise,resolve,reject }
}
async function page(name:'login'|'approval',options:{ token?:string;storedAttempts?:string|undefined;handler?:Handler }={}){
  vi.resetModules()
  const dom=new JSDOM(await readFile(resolve(web,name+'.html'),'utf8'),{ url:'https://platform.example/'+name })
  const pending=new Set<Promise<unknown>>(),ownedGates=new Set<HeldGate>()
  let closing=false,quiescent=false
  const quiesce=async()=>{
    if(quiescent)return
    closing=true
    for(const gate of ownedGates)gate.release()
    // With admission closed, only owned in-memory response continuations remain.
    // An event-loop checkpoint lets response.json(), catch and finally finish before globals change.
    await vi.waitFor(async()=>{
      await nextTurn()
      expect(pending.size,'owned fetches and response readers must complete before DOM/global disposal').toBe(0)
      expect([...ownedGates].every(gate=>gate.settled),'owned held responses must be released').toBe(true)
    })
    quiescent=true
  }
  fixtures.push({ dom,pending,quiesce })
  if(options.token)dom.window.sessionStorage.setItem('pe-approval-token',options.token)
  if(options.storedAttempts)dom.window.sessionStorage.setItem('pe-mcp-approval-attempts',options.storedAttempts)
  const calls:FetchCall[]=[]
  const track=<T>(promise:Promise<T>):Promise<T>=>{pending.add(promise);return promise.finally(()=>{pending.delete(promise)})}
  const fetcher=vi.fn((path:string,init?:RequestInit)=>track((async()=>{
    const body:unknown=typeof init?.body==='string'?JSON.parse(init.body):{}
    if(!isRecord(body))throw new Error('Expected an owned request object')
    const call:FetchCall={ path,init,body };calls.push(call)
    let value=closing?reply({ error:'owned_fixture_disposed' },499):options.handler?.(call)
    if(value===undefined){
      if(path==='/config')value={ hostUrl:'https://host.example' }
      else if(path==='/approvals/me')value={ userId:USER,username:'审批账号' }
      else if(path==='/approvals/executions/list')value={ available:true,items:[] }
      else if(path==='/approvals/stdio-v2/list')value={ items:[],nextOffset:null }
      else if(path.startsWith('/approvals/'))value={ items:[] }
      else throw new Error('Unexpected owned test request: '+path)
    }
    const promise=Promise.resolve(value),gate=heldGates.get(promise)
    if(gate)ownedGates.add(gate)
    const result=await promise,response=result instanceof Response?result:reply(result)
    const json=response.json.bind(response),text=response.text.bind(response)
    response.json=()=>track(json());response.text=()=>track(text())
    return response
  })()))
  const navigate=vi.fn()
  vi.stubGlobal('document',dom.window.document);vi.stubGlobal('sessionStorage',dom.window.sessionStorage)
  vi.stubGlobal('location',{ replace:navigate });vi.stubGlobal('fetch',fetcher)
  await import(resolve(web,name+'.js'))
  const get=(id:string)=>dom.window.document.getElementById(id)!
  const button=(id:string)=>get(id) as HTMLButtonElement
  const input=(id:string)=>get(id) as HTMLInputElement
  const submit=(id:string)=>get(id).dispatchEvent(new dom.window.Event('submit',{ bubbles:true,cancelable:true }))
  const click=(node:HTMLElement)=>node.dispatchEvent(new dom.window.Event('click',{ bubbles:true,cancelable:true }))
  return { dom,get,button,input,submit,click,calls,fetcher,navigate,pending,quiesce }
}
afterEach(async()=>{
  const owned=fixtures.splice(0),unsettled=owned.map(fixture=>fixture.pending.size)
  try{
    for(const fixture of owned)await fixture.quiesce()
    // Forgotten settlements remain test failures, after their cleanup has completed.
    expect(unsettled,'every held response must be settled by its owning case').toEqual(owned.map(()=>0))
  }finally{for(const fixture of owned)fixture.dom.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules()}
})

test('login sends entered credentials only to Platform, holds the button until cookie exchange, then clears the password and opens native UI',async()=>{
  const login=deferred(),exchange=deferred()
  const p=await page('login',{ handler:({ path })=>path==='/identity/login'?login.promise:path.endsWith('/auth/exchange')?exchange.promise:undefined })
  expect(p.get('note').textContent).toBe('登录由可信平台处理。')
  p.input('username').value='用户';p.input('password').value='synthetic-input';p.get('error').textContent='old'
  expect(p.submit('login')).toBe(false);expect(p.button('submit').disabled).toBe(true);expect(p.get('error').textContent).toBe('')
  expect(p.calls[0]).toMatchObject({ path:'/identity/login',body:{ username:'用户',password:'synthetic-input' },init:{ method:'POST',headers:{ 'content-type':'application/json' } } })
  login.resolve({ token:'synthetic-browser-token' })
  await vi.waitFor(()=>{ expect(p.calls.some(x=>x.path.endsWith('/auth/exchange'))).toBe(true) })
  expect(p.button('submit').disabled).toBe(true);expect(p.input('password').value).toBe('');expect(p.navigate).not.toHaveBeenCalled()
  expect(p.calls.at(-1)).toMatchObject({ path:'https://host.example/auth/exchange',body:{ token:'synthetic-browser-token' },init:{ method:'POST',credentials:'include' } })
  exchange.resolve(reply({ ok:true }));await vi.waitFor(()=>{ expect(p.navigate).toHaveBeenCalledExactlyOnceWith('https://host.example/native/') })
  expect(p.button('submit').disabled).toBe(false)
})
test.each([{ status:403,error:'password_change_required',change:true },{ status:403,error:'denied',change:false },{ status:401,error:'bad_password',change:false },{ status:403,error:null,change:false }])('login keeps Platform refusal distinct from required password change ($error)',async({ status,error,change })=>{
  const p=await page('login',{ handler:({ path })=>path==='/identity/login'?reply(error===null?null:{ error },status):undefined })
  p.input('password').value='synthetic-input';p.submit('login')
  await vi.waitFor(()=>{ expect(p.button('submit').disabled).toBe(false) })
  expect(p.calls.map(x=>x.path)).toEqual(['/identity/login'])
  if(change){expect(p.navigate).toHaveBeenCalledExactlyOnceWith('/account#password');expect(p.input('password').value).toBe('')}
  else{expect(p.navigate).not.toHaveBeenCalled();expect(p.get('error').textContent).toBe('登录失败，请检查账号与密码')}
})
test('login displays a failed Host exchange without navigating and restores submit',async()=>{
  const p=await page('login',{ handler:({ path })=>path==='/identity/login'?{ token:'synthetic-browser-token' }:path.endsWith('/auth/exchange')?reply({},403):undefined })
  p.submit('login');await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe('登录失败，请检查账号与密码') })
  expect(p.navigate).not.toHaveBeenCalled();expect(p.button('submit').disabled).toBe(false)
})
test('login surfaces transport errors and does not forward credentials to a Host',async()=>{
  const p=await page('login',{ handler:()=>Promise.reject(new Error('fixture transport unavailable')) })
  p.submit('login');await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe('fixture transport unavailable') })
  expect(p.calls).toHaveLength(1);expect(p.navigate).not.toHaveBeenCalled();expect(p.button('submit').disabled).toBe(false)
})
test('approval starts logged out, translates controls and configures only its return link',async()=>{
  const p=await page('approval');await vi.waitFor(()=>{ expect(p.get('back').getAttribute('href')).toBe('https://host.example') })
  expect(p.get('approval-login').hidden).toBe(false);expect(p.get('approval-console').hidden).toBe(true)
  expect(p.get('login-button').textContent).toBe('登录可信审批页');expect(p.calls.map(x=>x.path)).toEqual(['/config'])
  expect(p.dom.window.sessionStorage.getItem('pe-mcp-approval-attempts')).toBeNull()
})

type Page=Awaited<ReturnType<typeof page>>
type McpAction={
  actionId:string
  state:string
  createdAt:string
  expiresAt:string
  fingerprint:string
  permissionId:string|null
  errorCode:string|null
  tool:{
    raw:{ name:string;description?:string|null }
    model:{ name:string }
    connectionId:string|null
    connectionRevision:number
    configurationRevision:number
    credentialRevision:number
    catalogId:string
    toolId:string
    descriptorDigest:string
  }
  arguments:unknown
  configuration:{
    displayName:string
    serverUrl:string
    authentication:string
    headerNames:string[]
  }
}
function mcpAction(overrides:Partial<McpAction>={}):McpAction{return { actionId:'mcp-1',state:'pending',createdAt:'2026-01-01T00:00:00Z',expiresAt:'2050-01-01T00:00:00Z',fingerprint:'frozen-fingerprint',permissionId:null,errorCode:null,tool:{ raw:{ name:'remote_tool',description:'Remote explanation' },model:{ name:'task_alias' },connectionId:'connection-1',connectionRevision:1,configurationRevision:2,credentialRevision:3,catalogId:'catalog-1',toolId:'tool-1',descriptorDigest:'d'.repeat(64) },arguments:{ z:2,a:[false,null,{ x:'中文' }] },configuration:{ displayName:'Frozen server',serverUrl:'https://fixture.invalid/mcp',authentication:'none',headerNames:['X-Example'] },...overrides }}
const labels={ changed:'操作状态或冻结内容已变化。请重新核对；本次没有提交变更。',unavailable:'无法读取 MCP 操作，请刷新状态。',uncertain:'提交结果尚不确定；请刷新状态核对，不能据此认定远端动作未执行。',revokeUncertain:'撤销结果尚不确定；当前列表没有许可撤销状态，不能据此认定已撤销。',submitted:'本次变更已经提交；请刷新状态核对结果，不会重复提交。' }
const mutations=(p:Page)=>p.calls.filter(x=>/^\/approvals\/mcp\/(decide|cancel|revoke)$/.test(x.path))
const attempt=(p:Page,key:string,index=0)=>Array.from(p.get('mcp-actions').querySelectorAll<HTMLButtonElement>('button[data-mcp-attempt]')).filter(x=>x.dataset.mcpAttempt===key)[index]!
const byText=(p:Page,id:string,text:string)=>Array.from(p.get(id).querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent===text)!
async function ready(p:Page,pending=0){await vi.waitFor(()=>{expect(p.calls.some(x=>x.path==='/approvals/stdio-v2/list')).toBe(true);expect(p.pending.size).toBe(pending)})}
async function mcpPage(items:McpAction[],handler?:Handler,storedAttempts?:string){const p=await page('approval',{ token:'synthetic-approval-token',storedAttempts,handler:call=>handler?.(call)??(call.path==='/approvals/mcp/list'?{ items }:undefined) });await ready(p);return p}
const attempts=(p:Page):Record<string,unknown>|null=>{
  const value:unknown=JSON.parse(p.dom.window.sessionStorage.getItem('pe-mcp-approval-attempts')??'null')
  if(value===null)return null
  if(!isRecord(value))throw new Error('Expected an owned attempt object')
  return value
}

test('approval restores a credential only at Platform origin and renders empty feature lists',async()=>{
  const p=await page('approval',{ token:'synthetic-approval-token' });await ready(p)
  expect(p.get('approval-console').hidden).toBe(false);expect(p.get('approval-login').hidden).toBe(true)
  expect(p.get('identity').textContent).toBe('审批账号')
  for(const id of ['actions','ssh-actions','mcp-actions'])expect(p.get(id).textContent).toBe('没有待处理或历史操作')
  for(const c of p.calls.filter(x=>x.path.startsWith('/approvals/')))expect(c.init).toMatchObject({ method:'POST',headers:{ authorization:'Bearer synthetic-approval-token' } })
  expect(p.calls.every(x=>!x.path.startsWith('https://host.example'))).toBe(true)
})
test('approval login holds submit, sends entered credentials and then stores the returned Platform token',async()=>{
  const gate=deferred();const p=await page('approval',{ handler:c=>c.path==='/identity/approval-login'?gate.promise:undefined })
  p.input('username').value='用户';p.input('password').value='synthetic-input';p.get('error').textContent='old'
  expect(p.submit('approval-login')).toBe(false);expect(p.button('login-button').disabled).toBe(true);expect(p.get('error').textContent).toBe('')
  expect(p.calls.find(c=>c.path==='/identity/approval-login')).toMatchObject({ body:{ username:'用户',password:'synthetic-input' },init:{ method:'POST',headers:{ 'content-type':'application/json' } } })
  gate.resolve({ token:'synthetic-returned-token',user:{ username:'登录账号' } });await ready(p)
  await vi.waitFor(()=>{ expect(p.button('login-button').disabled).toBe(false) })
  expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBe('synthetic-returned-token');expect(p.input('password').value).toBe('')
  expect(p.get('approval-console').hidden).toBe(false);expect(p.navigate).not.toHaveBeenCalled()
})
test.each(['refusal','transport'] as const)('approval login reports %s and allows retry',async(kind)=>{
  const p=await page('approval',{ handler:c=>c.path==='/identity/approval-login'?(kind==='refusal'?reply({},403):Promise.reject(new Error('fixture transport unavailable'))):undefined })
  p.submit('approval-login');await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(kind==='refusal'?'登录失败，请检查账号与密码':'fixture transport unavailable') })
  expect(p.button('login-button').disabled).toBe(false);expect(p.get('approval-login').hidden).toBe(false);expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBeNull()
})
test('approval tolerates an unavailable return-link configuration while continuing logged-out UI',async()=>{
  const p=await page('approval',{ handler:c=>c.path==='/config'?Promise.reject(new Error('fixture config unavailable')):undefined });await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) })
  expect(p.get('approval-login').hidden).toBe(false);expect(p.get('error').textContent).toBe('');expect(p.get('back').getAttribute('href')).not.toBe('https://host.example')
})
test.each(['/approvals/me','/approvals/executions/list','/approvals/stdio-v2/list'])('current credential rejection at %s returns to login and clears local attempts',async(path)=>{
  const p=await page('approval',{ token:'synthetic-approval-token',storedAttempts:JSON.stringify({ owner:USER,items:[['decide:mcp-1','submitted']] }),handler:c=>c.path===path?reply({},401):undefined })
  await vi.waitFor(()=>{expect(p.get('approval-login').hidden).toBe(false);expect(p.pending.size).toBe(0)})
  expect(p.get('approval-console').hidden).toBe(true)
  for(const key of ['pe-approval-token','pe-mcp-approval-attempts','pe-execution-resolution-attempts'])expect(p.dom.window.sessionStorage.getItem(key)).toBeNull()
})
test('a failed MCP list leaves other approval features readable and provides no mutation controls',async()=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/mcp/list'?reply({ error:'fixture_unavailable' },503):undefined });await ready(p)
  expect(p.get('mcp-actions').textContent).toBe(labels.unavailable);expect(p.get('mcp-actions').querySelector('button')).toBeNull();expect(p.get('identity').textContent).toBe('审批账号')
})
test('refresh reports a non-authentication Platform error without losing the current credential',async()=>{
  let fail=false;const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>fail&&c.path==='/approvals/list'?reply({ error:'fixture_denied' },403):undefined });await ready(p)
  fail=true;p.click(p.button('refresh'));await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe('审批请求失败，请重试 (fixture_denied)') })
  expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBe('synthetic-approval-token');expect(p.get('approval-console').hidden).toBe(false)
})
const note={ actionId:'note-1',state:'pending',text:'Exact synthetic note',fingerprint:'note-fingerprint',createdAt:'2026-01-01T00:00:00Z' }
const ssh={ actionId:'ssh-1',state:'pending',displayName:'Synthetic SSH',username:'runner',host:'fixture.invalid',port:22,workingDirectory:'/workspace',hostKeySha256:'synthetic-host-key',connectionRevision:2,credentialRevision:3,command:'printf synthetic',fingerprint:'ssh-fingerprint',createdAt:'2026-01-01T00:00:00Z' }
test.each([{ feature:'note',label:'批准本次写入',approve:true },{ feature:'note',label:'拒绝',approve:false },{ feature:'ssh',label:'批准本次命令',approve:true },{ feature:'ssh',label:'拒绝',approve:false }])('$feature decision $approve submits the frozen identifiers and holds its actual control until receipt',async({ feature,label,approve })=>{
  const gate=deferred();let listed=true
  const path=feature==='note'?'/approvals/decide':'/approvals/ssh-execute/decide'
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path===path?gate.promise:c.path==='/approvals/list'?{ items:listed&&feature==='note'?[note]:[] }:c.path==='/approvals/ssh-execute/list'?{ items:listed&&feature==='ssh'?[ssh]:[] }:undefined });await ready(p)
  const b=byText(p,feature==='note'?'actions':'ssh-actions',label);p.click(b);expect(b.disabled).toBe(true)
  expect(p.calls.find(c=>c.path===path)?.body).toEqual({ actionId:feature==='note'?note.actionId:ssh.actionId,fingerprint:feature==='note'?note.fingerprint:ssh.fingerprint,approve })
  listed=false;gate.resolve({ ok:true });await vi.waitFor(()=>{ expect(b.disabled).toBe(false) })
  expect(p.get(feature==='note'?'actions':'ssh-actions').textContent).toBe('没有待处理或历史操作')
})
test.each(['approved','uncertain'])('SSH %s can be cancelled using only its action identifier',async(state)=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/ssh-execute/list'?{ items:[{ ...ssh,state,workingDirectory:null }] }:undefined });await ready(p)
  expect(p.get('ssh-actions').textContent).toContain('远端默认目录')
  const b=byText(p,'ssh-actions','取消执行');p.click(b);await vi.waitFor(()=>{ expect(b.disabled).toBe(false) })
  expect(p.calls.find(c=>c.path==='/approvals/ssh-execute/cancel')?.body).toEqual({ actionId:'ssh-1' })
})
test('historical SSH/note states render without decision buttons and preserve unknown state text',async()=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/ssh-execute/list'?{ items:[{ ...ssh,state:'custom-ssh' }] }:c.path==='/approvals/list'?{ items:[{ ...note,state:'custom-note' }] }:undefined });await ready(p)
  expect(p.get('ssh-actions').textContent).toContain('custom-ssh');expect(p.get('actions').textContent).toContain('custom-note')
  expect(p.get('ssh-actions').querySelector('button')).toBeNull();expect(p.get('actions').querySelector('button')).toBeNull()
})
test.each([{ capability:'trial_note_query',enabled:true,label:'停用' },{ capability:'trial_note_append',enabled:false,label:'启用' }])('permission $capability toggles only the selected capability',async(permission)=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/permissions'?{ items:[permission] }:undefined });await ready(p)
  const b=byText(p,'permissions',permission.label);p.click(b);await vi.waitFor(()=>{ expect(b.disabled).toBe(false) })
  expect(p.calls.find(c=>c.path==='/approvals/permission')?.body).toEqual({ capability:permission.capability,enabled:!permission.enabled })
})
test('a rejected note decision surfaces its response and restores the detached actual control',async()=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/list'?{ items:[note] }:c.path==='/approvals/decide'?reply({ error:'fixture_denied' },403):undefined });await ready(p)
  const b=byText(p,'actions','批准本次写入');p.click(b);await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe('审批请求失败，请重试 (fixture_denied)') });expect(b.disabled).toBe(false)
})
test.each(['once','session','persistent','reject'])('MCP %s decision revalidates frozen content and sends exactly one mutation',async(decision)=>{
  const action=mcpAction();const p=await mcpPage([action]);const controls=Array.from(p.get('mcp-actions').querySelectorAll<HTMLButtonElement>('button'))
  const index=['once','session','persistent','reject'].indexOf(decision);const b=controls[index]!
  expect(b.className).toBe(decision==='reject'?'quiet':'');p.click(b)
  await vi.waitFor(()=>{expect(mutations(p)).toHaveLength(1);expect(p.get('mcp-actions').textContent).toContain(labels.submitted)})
  expect(mutations(p)[0]).toMatchObject({ path:'/approvals/mcp/decide',body:{ actionId:action.actionId,fingerprint:action.fingerprint,decision },init:{ headers:{ authorization:'Bearer synthetic-approval-token' } } })
  expect(p.calls.filter(c=>c.path==='/approvals/mcp/list')).toHaveLength(3)
  expect(attempts(p)).toEqual({ owner:USER,items:[['decide:mcp-1','submitted']] })
  expect(attempt(p,'decide:mcp-1').disabled).toBe(true);p.click(b);p.click(attempt(p,'decide:mcp-1'));expect(mutations(p)).toHaveLength(1)
})
test.each(['approved','preparing','dispatch-intent'])('MCP %s cancellation submits only its action identifier and retains the submitted warning',async(state)=>{
  const p=await mcpPage([mcpAction({ state })]);const b=attempt(p,'cancel:mcp-1');expect(b.className).toBe('quiet');p.click(b)
  await vi.waitFor(()=>{ expect(p.get('mcp-actions').textContent).toContain(labels.submitted) })
  expect(mutations(p).map(c=>({ path:c.path,body:c.body }))).toEqual([{ path:'/approvals/mcp/cancel',body:{ actionId:'mcp-1' } }]);expect(attempt(p,'cancel:mcp-1').disabled).toBe(true)
})
test.each([true,false])('MCP revoke receipt ok=$ok never equates an uncertain response with revocation',async(ok)=>{
  const p=await mcpPage([mcpAction({ state:'succeeded',permissionId:'permission-1' })],c=>c.path==='/approvals/mcp/revoke'?{ ok }:undefined);p.click(attempt(p,'revoke:permission-1'))
  await vi.waitFor(()=>{ expect(attempt(p,'revoke:permission-1').disabled).toBe(true) });await vi.waitFor(()=>{ expect(p.calls.filter(c=>c.path==='/approvals/mcp/list')).toHaveLength(3) })
  expect(mutations(p)[0]?.body).toEqual({ permissionId:'permission-1' })
  expect(attempts(p)).toEqual({ owner:USER,items:[['revoke:permission-1',ok?'revoked':'submitted']] })
  expect(attempt(p,'revoke:permission-1').textContent).toBe(ok?'已撤销此许可':'撤销此许可');expect(p.get('error').textContent).toBe(ok?'':labels.revokeUncertain)
})
test('MCP rendering displays frozen arguments, descriptive versions, unknown states and expired pending actions',async()=>{
  const a=mcpAction({ state:'custom-state',createdAt:'invalid-time',errorCode:'synthetic_error' });a.tool.raw.description=null;a.tool.connectionId=null
  const expired=mcpAction({ actionId:'expired',expiresAt:'2000-01-01T00:00:00Z' });delete expired.tool.raw.description
  const p=await mcpPage([a,expired]);const text=p.get('mcp-actions').textContent
  for(const value of ['custom-state','invalid-time','synthetic_error','远端提供的说明: 无','连接编号: 无','已过期','Remote explanation','"中文"']){
    if(value==='Remote explanation')expect(text).not.toContain(value);else expect(text).toContain(value)
  }
  expect(p.get('mcp-actions').querySelector('button')).toBeNull()
})
test.each(['missing','content','state','permission','expired'] as const)('MCP revalidation refuses %s changes before any mutation',async(change)=>{
  const a=mcpAction();let reads=0
  const p=await mcpPage([a],(c)=>{if(c.path!=='/approvals/mcp/list')return undefined;reads++;if(reads===1)return { items:[a] };const latest=mcpAction(change==='content'?{ arguments:{ changed:true } }:change==='state'?{ state:'succeeded' }:change==='permission'?{ permissionId:'new-permission' }:change==='expired'?{ expiresAt:'2000-01-01T00:00:00Z' }:{});return { items:change==='missing'?[]:[latest] }})
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(labels.changed) })
  expect(mutations(p)).toHaveLength(0);expect(attempts(p)).toBeNull()
})
test('canonical object-key ordering permits an unchanged frozen MCP review',async()=>{
  const a=mcpAction();let reads=0;const p=await mcpPage([a],c=>c.path==='/approvals/mcp/list'?{ items:[++reads===1?a:mcpAction({ arguments:{ a:[false,null,{ x:'中文' }],z:2 } })] }:undefined)
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(mutations(p)).toHaveLength(1) });await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) });expect(p.get('error').textContent).toBe('')
})
test('a failed MCP pre-read prevents mutation and restores eligible controls',async()=>{
  let reads=0;const p=await mcpPage([mcpAction()],c=>c.path==='/approvals/mcp/list'&&++reads>1?Promise.reject(new Error('fixture read unavailable')):undefined)
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(labels.unavailable) })
  expect(mutations(p)).toHaveLength(0);expect(attempt(p,'decide:mcp-1').disabled).toBe(false);expect(attempts(p)).toBeNull()
})
test.each(['decide','cancel','revoke'] as const)('a failed MCP %s response is uncertain and is never resubmitted',async(kind)=>{
  const a=mcpAction(kind==='cancel'?{ state:'approved' }:kind==='revoke'?{ state:'succeeded',permissionId:'permission-1' }:{})
  const p=await mcpPage([a],c=>c.path==='/approvals/mcp/'+kind?Promise.reject(new Error('fixture response lost')):undefined);const key=kind+':'+(kind==='revoke'?'permission-1':'mcp-1');p.click(attempt(p,key))
  await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(kind==='revoke'?labels.revokeUncertain:labels.uncertain) });await vi.waitFor(()=>{ expect(p.calls.filter(c=>c.path==='/approvals/mcp/list')).toHaveLength(3) })
  p.click(attempt(p,key));expect(mutations(p)).toHaveLength(1);expect(attempt(p,key).disabled).toBe(true);expect(attempts(p)!.items).toEqual([[key,'submitted']])
})
test.each(['decide','revoke'] as const)('a failed status read after MCP %s retains the attempt and an uncertain result',async(kind)=>{
  let reads=0;const a=mcpAction(kind==='revoke'?{ state:'succeeded',permissionId:'permission-1' }:{})
  const p=await mcpPage([a],c=>c.path==='/approvals/mcp/list'&&++reads>2?Promise.reject(new Error('fixture read unavailable')):c.path==='/approvals/mcp/revoke'?{ ok:true }:undefined)
  const key=kind+':'+(kind==='revoke'?'permission-1':'mcp-1');p.click(attempt(p,key));await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(kind==='revoke'?labels.revokeUncertain:labels.uncertain) })
  expect(mutations(p)).toHaveLength(1);expect(attempt(p,key).disabled).toBe(true)
})
test('queued MCP clicks while pre-read is busy produce only one explicit mutation',async()=>{
  const gate=deferred();let reads=0;const a=mcpAction();const p=await mcpPage([a],c=>c.path==='/approvals/mcp/list'&&++reads===2?gate.promise:undefined)
  const b=attempt(p,'decide:mcp-1');p.click(b);expect(b.disabled).toBe(true);p.click(b);p.click(attempt(p,'decide:mcp-1',1))
  expect(mutations(p)).toHaveLength(0);expect(reads).toBe(2)
  gate.resolve({ items:[a] });await vi.waitFor(()=>{ expect(p.get('mcp-actions').textContent).toContain(labels.submitted) });expect(mutations(p)).toHaveLength(1)
})
test('a detached MCP control cannot submit after a fresh review replaces its entry',async()=>{
  const p=await mcpPage([mcpAction()]);const b=attempt(p,'decide:mcp-1');p.click(p.button('refresh'))
  await vi.waitFor(()=>{ expect(attempt(p,'decide:mcp-1')).not.toBe(b) });const count=p.calls.length;p.click(b)
  expect(p.calls).toHaveLength(count);expect(mutations(p)).toHaveLength(0)
})
test('a locally expired MCP decision cannot initiate even a pre-read',async()=>{
  const p=await mcpPage([mcpAction()]);vi.spyOn(Date,'now').mockReturnValue(Date.parse('2051-01-01T00:00:00Z'))
  const count=p.calls.length;p.click(attempt(p,'decide:mcp-1'));expect(p.calls).toHaveLength(count);expect(mutations(p)).toHaveLength(0)
})
test('logout clears local review even when the logout endpoint rejects, and detached clicks remain inert',async()=>{
  const p=await mcpPage([mcpAction()],c=>c.path==='/approvals/logout'?Promise.reject(new Error('fixture logout unavailable')):undefined)
  const b=attempt(p,'decide:mcp-1');p.click(p.button('logout'));await vi.waitFor(()=>{ expect(p.get('approval-login').hidden).toBe(false) })
  expect(b.disabled).toBe(true);expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBeNull();expect(attempts(p)).toBeNull()
  const count=p.calls.length;p.click(b);expect(p.calls).toHaveLength(count);expect(mutations(p)).toHaveLength(0)
})
test('a later refresh wins over an earlier held identity read',async()=>{
  const old=deferred();let reads=0
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/me'&&++reads===1?old.promise:c.path==='/approvals/me'?{ userId:USER,username:'新读取' }:undefined })
  p.click(p.button('refresh'));await ready(p,1);expect(p.get('identity').textContent).toBe('新读取')
  old.resolve({ userId:USER,username:'旧读取' });await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) });expect(p.get('identity').textContent).toBe('新读取')
})
test('refresh invalidates a held MCP pre-read and prevents a stale decision',async()=>{
  const old=deferred();let reads=0;const a=mcpAction();const p=await mcpPage([a],c=>c.path==='/approvals/mcp/list'&&++reads===2?old.promise:undefined)
  p.click(attempt(p,'decide:mcp-1'));p.click(p.button('refresh'));await vi.waitFor(()=>{ expect(reads).toBe(3) })
  old.resolve({ items:[a] });await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) });await vi.waitFor(()=>{ expect(attempt(p,'decide:mcp-1').disabled).toBe(false) })
  expect(mutations(p)).toHaveLength(0);expect(attempts(p)).toBeNull();expect(p.get('error').textContent).toBe('')
})
test.each(['pre-read','mutation','final-read'] as const)('logout during MCP %s leaves the late reply unable to restore approval state',async(phase)=>{
  const old=deferred();let reads=0,held=false;const a=mcpAction()
  const p=await mcpPage([a],(c)=>{
    if(c.path==='/approvals/mcp/list'){reads++;if(phase==='pre-read'&&reads===2||phase==='final-read'&&reads===3){held=true;return old.promise}}
    if(phase==='mutation'&&c.path==='/approvals/mcp/decide'){held=true;return old.promise}
    return undefined
  })
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(held).toBe(true) });p.click(p.button('logout'));await vi.waitFor(()=>{ expect(p.get('approval-login').hidden).toBe(false) })
  old.resolve(phase==='mutation'?{ ok:true }:{ items:[a] });await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) })
  expect(p.get('approval-console').hidden).toBe(true);expect(attempts(p)).toBeNull();expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBeNull()
  expect(mutations(p)).toHaveLength(phase==='pre-read'?0:1);expect(p.get('error').textContent).toBe('')
})
test('a held old-credential 401 cannot clear a newly authenticated approval token',async()=>{
  const old=deferred();let reads=0
  const p=await page('approval',{ token:'old-synthetic-token',handler:c=>c.path==='/approvals/me'&&++reads===1?old.promise:c.path==='/identity/approval-login'?{ token:'new-synthetic-token',user:{ username:'新账号' } }:undefined })
  p.click(p.button('logout'));await vi.waitFor(()=>{ expect(p.get('approval-login').hidden).toBe(false) });p.submit('approval-login')
  await vi.waitFor(()=>{ expect(p.calls.some(c=>c.path==='/approvals/stdio-v2/list')).toBe(true) })
  old.resolve(reply({},401));await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) });await vi.waitFor(()=>{ expect(p.button('login-button').disabled).toBe(false) })
  expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBe('new-synthetic-token');expect(p.get('approval-console').hidden).toBe(false);expect(p.get('identity').textContent).toBe('审批账号')
})
test.each(['broken-json','wrong-owner','wrong-items','mixed-items','revoked'] as const)('stored MCP attempts %s are read as local duplicate protection only',async(kind)=>{
  const saved=kind==='broken-json'?'{':JSON.stringify({ owner:kind==='wrong-owner'?'other-user':USER,items:kind==='wrong-items'?{}:kind==='mixed-items'?[null,{},[123,'submitted'],['x'.repeat(201),'submitted'],['decide:mcp-1','invalid'],['decide:mcp-1','submitted'],['revoke:permission-1','revoked']]:kind==='revoked'?[['revoke:permission-1','revoked']]:[['decide:mcp-1','submitted']] })
  const p=await mcpPage([mcpAction({ permissionId:'permission-1' })],undefined,saved)
  expect(attempt(p,'decide:mcp-1').disabled).toBe(kind==='mixed-items');expect(attempt(p,'revoke:permission-1').disabled).toBe(kind==='mixed-items'||kind==='revoked')
  expect(mutations(p)).toHaveLength(0)
  if(kind==='mixed-items'||kind==='revoked')expect(attempt(p,'revoke:permission-1').textContent).toBe('已撤销此许可')
})
test('same-owner refresh retains local attempts; a changed owner discards them and uses username fallback',async()=>{
  let owner: string|undefined=USER;const p=await mcpPage([mcpAction()],c=>c.path==='/approvals/me'?{ userId:owner,username:'fallback-owner' }:undefined)
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(p.get('mcp-actions').textContent).toContain(labels.submitted) })
  p.dom.window.sessionStorage.setItem('pe-mcp-approval-attempts',JSON.stringify({ owner:USER,items:[] }));p.click(p.button('refresh'))
  await vi.waitFor(()=>{ expect(p.calls.filter(c=>c.path==='/approvals/stdio-v2/list')).toHaveLength(2) });expect(attempt(p,'decide:mcp-1').disabled).toBe(true)
  owner=undefined;p.click(p.button('refresh'));await vi.waitFor(()=>{ expect(attempt(p,'decide:mcp-1').disabled).toBe(false) });expect(mutations(p)).toHaveLength(1)
})
test.each(['new-attempt','revoked-update'] as const)('storage failure at MCP %s rolls back local state and does not claim certainty',async(phase)=>{
  const p=await mcpPage([mcpAction(phase==='revoked-update'?{ permissionId:'permission-1',state:'succeeded' }:{})],c=>c.path==='/approvals/mcp/revoke'?{ ok:true }:undefined)
  const original=p.dom.window.Storage.prototype.setItem.bind(p.dom.window.sessionStorage);let writes=0
  vi.spyOn(p.dom.window.Storage.prototype,'setItem').mockImplementation(function(this:Storage,key:string,value:string){if(key==='pe-mcp-approval-attempts'&&++writes===(phase==='new-attempt'?1:2))throw new Error('fixture storage unavailable'); original.call(this,key,value)})
  const key=phase==='new-attempt'?'decide:mcp-1':'revoke:permission-1';p.click(attempt(p,key))
  await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(phase==='new-attempt'?labels.unavailable:labels.revokeUncertain) })
  expect(mutations(p)).toHaveLength(phase==='new-attempt'?0:1);await vi.waitFor(()=>{ expect(attempt(p,key).disabled).toBe(phase!=='new-attempt') })
  expect(attempts(p)).toEqual(phase==='new-attempt'?null:{ owner:USER,items:[[key,'submitted']] })
})
test('an unavailable execution list displays the actual child failure while MCP and STDIO remain readable',async()=>{
  const p=await page('approval',{ token:'synthetic-approval-token',handler:c=>c.path==='/approvals/executions/list'?reply({},503):undefined });await ready(p)
  expect(p.get('error').textContent).toBe('无法核对执行状态，不能据此认定已结案。');expect(p.get('approval-console').hidden).toBe(false)
  expect(p.dom.window.sessionStorage.getItem('pe-approval-token')).toBe('synthetic-approval-token')
})
test('a malformed MCP status response with no items cannot initiate a decision',async()=>{
  let reads=0;const p=await mcpPage([mcpAction()],c=>c.path==='/approvals/mcp/list'&&++reads===2?{}:undefined)
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(p.get('error').textContent).toBe(labels.changed) })
  expect(mutations(p)).toHaveLength(0);expect(attempts(p)).toBeNull();expect(attempt(p,'decide:mcp-1').disabled).toBe(false)
})
test('missing remote argument data is rendered as absent rather than interpreted as an approval',async()=>{
  const p=await mcpPage([mcpAction({ state:'failed',arguments:undefined })]);expect(p.get('mcp-actions').querySelector('pre')?.textContent).toBe('无');expect(p.get('mcp-actions').querySelector('button')).toBeNull();expect(mutations(p)).toHaveLength(0)
})
test.each(['pre-read','mutation','final-read'] as const)('logout suppresses a late MCP %s failure from the previous credential',async(phase)=>{
  const old=deferred();let reads=0,held=false;const a=mcpAction()
  const p=await mcpPage([a],(c)=>{
    if(c.path==='/approvals/mcp/list'){reads++;if(phase==='pre-read'&&reads===2||phase==='final-read'&&reads===3){held=true;return old.promise}}
    if(phase==='mutation'&&c.path==='/approvals/mcp/decide'){held=true;return old.promise}
    return undefined
  })
  p.click(attempt(p,'decide:mcp-1'));await vi.waitFor(()=>{ expect(held).toBe(true) });p.click(p.button('logout'));await vi.waitFor(()=>{ expect(p.get('approval-login').hidden).toBe(false) })
  old.reject(new Error('fixture late response lost'));await vi.waitFor(()=>{ expect(p.pending.size).toBe(0) })
  expect(p.get('error').textContent).toBe('');expect(p.get('approval-console').hidden).toBe(true);expect(attempts(p)).toBeNull();expect(mutations(p)).toHaveLength(phase==='pre-read'?0:1)
})
