import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/server/main.mjs';
import {registerWorkbenchRoute} from '../plugins/workbench/web-route.mjs';

test('workbench uses only the authenticated Host browser, never exposes research credentials, and rejects cloud fallback',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'workbench-gateway-')),prior=process.env.DS_RESEARCH_DATA_DIR;
  process.env.DS_RESEARCH_DATA_DIR=directory;const app=await startServer({directory,port:0});let route;
  const gateway=http.createServer((req,res)=>route.handler(req,res));
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+gateway.address().port;
  const browserPeer={principal:{kind:'owner'}},agentPeer={principal:{kind:'owner'}};
  let cloud=false;
  registerWorkbenchRoute({on:()=>{},get:()=>cloud,connection:{browserPeer,admit:req=>req.headers.host!==new URL(origin).host?{rejection:403}:req.headers.cookie==='platform=valid'?{peer:browserPeer}:req.headers.authorization==='Bearer agent'?{peer:agentPeer}:{rejection:401}},webServer:{getOrigin:()=>origin,register:value=>{route=value;return()=>{};}}});
  const browserHeaders={Cookie:'platform=valid'};
  const get=path=>fetch(origin+path,{headers:browserHeaders,redirect:'manual'});
  try{
    assert.equal((await fetch(origin+'/research/')).status,401);
    const page=await get('/research/');assert.equal(page.status,200);assert.match(await page.text(),/\.\/public-config\.js/);
    const config=await (await get('/research/public-config.js')).text();assert.match(config,/\/research\//);assert.match(config,/"platformIdentity":true/);assert.ok(!config.includes(app.credentials.humanToken));
    const post=(headers={})=>fetch(origin+'/research/api',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({op:'state',args:{},sessionId:'synthetic'})});
    assert.equal((await post()).status,401);
    assert.equal((await post({Authorization:'Bearer '+app.credentials.humanToken})).status,401,'Research credentials cannot bypass the platform');
    assert.equal((await post({Cookie:'ds_research='+app.credentials.humanToken})).status,401);
    assert.equal((await post({Authorization:'Bearer agent'})).status,403,'An owner API peer cannot impersonate the browser');
    const rejectedHost=await new Promise((resolve,reject)=>{http.get(origin+'/research/',{headers:{...browserHeaders,Host:'foreign.invalid'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
    assert.equal(rejectedHost,403);
    assert.equal((await post({...browserHeaders,Origin:'https://foreign.invalid'})).status,403);
    const authenticated=await post({...browserHeaders,Origin:origin,Authorization:'Bearer ignored'});assert.equal(authenticated.status,200);assert.deepEqual(authenticated.headers.getSetCookie(),[]);
    const payload=await authenticated.text();assert.ok(!payload.includes(app.credentials.humanToken));assert.ok(!payload.includes(app.credentials.agentToken));
    assert.equal((await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'state'})})).status,401,'Private backend still requires authentication');
    assert.equal((await get('/research/connection.json')).status,404);
    assert.equal((await get('/research')).status,308);
    assert.equal((await fetch(origin+'/research/auth',{method:'POST',headers:browserHeaders,body:'{}'})).status,403,'No second login or account mutation via the embedded page');
    cloud=true;assert.equal((await post(browserHeaders)).status,503,'Cloud accounts must not fall back to a shared local administrator');
  }finally{gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));await app.close();if(prior===undefined)delete process.env.DS_RESEARCH_DATA_DIR;else process.env.DS_RESEARCH_DATA_DIR=prior;rmSync(directory,{recursive:true,force:true});}
});
