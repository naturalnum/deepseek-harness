// Real browser/frame/SQLite acceptance with test-owned accounts, not production login evidence.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openCloudStore} from '../dist/server/cloud-store.mjs';
const require=createRequire(new URL('../../../apps/web/package.json',import.meta.url));
const {chromium}=require('playwright');
const evidence=resolve(process.argv[2]||'.browser-evidence');mkdirSync(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...process.env.EPRI_BROWSER_EXECUTABLE?{executablePath:process.env.EPRI_BROWSER_EXECUTABLE}:{}});
const homes=[],stores=[];
const config={cloud:true,platformIdentity:true,harnessUrl:'/',workbenchUrl:'/research/',requestTimeoutMs:10000,maxPendingRequests:8};
const files=new Map([['/research/',new URL('../dist/ui/index.html',import.meta.url)],['/research/app.js',new URL('../dist/ui/app.js',import.meta.url)],
  ['/research/app.css',new URL('../dist/ui/app.css',import.meta.url)],['/bridge.mjs',new URL('../src/cloud-bridge.mjs',import.meta.url)]]);
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  if(path==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><script type="module">import {bindResearchBridge} from "/bridge.mjs"; const frame=document.createElement("iframe");document.body.append(frame);bindResearchBridge(window,frame,"same-session",(id,op,args)=>window.fixtureResearch(id,op,args),8);frame.src="/research/?session=same-session&tab=protocols";</script><body></body>');return;
  }
  if(path==='/research/public-config.js'){res.setHeader('Content-Type','text/javascript');res.end('window.__DS_RESEARCH_PUBLIC__='+JSON.stringify(config));return;}
  const file=files.get(path);
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('/')?'text/html; charset=utf-8':'text/javascript');res.end(readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
async function account(id,title) {
  const home=mkdtempSync(join(tmpdir(),'epri-browser-'));homes.push(home);
  let current=true;
  const check=()=>{if(!current)throw new Error('账号会话已失效，请重新登录。');};
  const store=openCloudStore({directory:home,python:'/opt/epri-python/bin/python3',lifetime:new AbortController().signal,assertCurrent:check,
    authorizeSession:async sid=>{check();assert.equal(sid,'same-session');return {check,workspaceRoot:'/workspace/'+id,
      run:async()=>{throw new Error('Execution belongs to the separate Linux acceptance test.');}};}});stores.push(store);
  await store.execute('protocol_put',{id,version:'1',content:'# '+title+'\n\n{{var|value: str}}',requestId:'same-request'},'human','same-session');
  const context=await browser.newContext({viewport:{width:1440,height:960}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixtureResearch',(session,op,args)=>store.execute(op,args,'human',session));
  await page.goto(url);
  const frame=page.frameLocator('iframe');
  await frame.getByText(id,{exact:false}).first().waitFor();
  assert.equal(await frame.getByRole('button',{name:'账号与项目',exact:true}).count(),0);
  return {page,frame,errors,revoke(){current=false;}};
}
try {
  const a=await account('tenant-a-only','账号甲专用方法'),b=await account('tenant-b-only','账号乙专用方法');
  assert.doesNotMatch(await a.frame.locator('body').innerText(),/tenant-b-only/);
  assert.doesNotMatch(await b.frame.locator('body').innerText(),/tenant-a-only/);
  await a.page.screenshot({path:join(evidence,'account-a.png'),fullPage:true});
  await b.page.screenshot({path:join(evidence,'account-b.png'),fullPage:true});
  a.revoke();await a.page.reload();
  await a.page.frameLocator('iframe').getByText('账号会话已失效，请重新登录。',{exact:false}).waitFor();
  await b.page.reload();await b.page.frameLocator('iframe').getByText('tenant-b-only',{exact:false}).first().waitFor();
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
  console.log(JSON.stringify({passed:['rendered cloud workbench','two browser accounts with identical Session/request ids','no cross-account protocol display','platform identity hides separate login','revoked account rejected while other account remains usable'],scope:'test-owned account and transport fixture; not production SSO'},null,2));
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  for(const store of stores)await store.close();
  for(const home of homes)rmSync(home,{recursive:true,force:true});
}
