import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizePublicAddress, publicConfiguration, publicAddresses} from '../src/public-addresses.mjs';
import {applyWorkbenchTheme} from '../src/ui/workbench-theme.mjs';
import {startServer} from '../dist/server/main.mjs';

test('public addresses retain local defaults and support HTTPS and a research subpath', () => {
  const browser = {location:{href:'http://127.0.0.1:43128/'}};
  assert.equal(publicAddresses(browser,'harness').workbench.href,'http://127.0.0.1:43128/research/');
  browser.location.href = 'https://portal.example.test/platform/';
  browser.__DS_RESEARCH_PUBLIC__ = publicConfiguration({DS_RESEARCH_PUBLIC_URL:'/research',DS_HARNESS_PUBLIC_URL:'/platform',SECRET:'never-public'});
  const host = publicAddresses(browser,'harness');
  assert.equal(host.workbench.href,'https://portal.example.test/research/');
  assert.equal(host.harness.href,'https://portal.example.test/platform/');
  browser.location.href = 'https://portal.example.test/research/?session=one';
  assert.equal(publicAddresses(browser).workbench.href,host.workbench.href);
  assert.equal(new URL('./api',browser.location.href).pathname,'/research/api');
  assert.equal(new URL('./auth',browser.location.href).pathname,'/research/auth');
  assert.equal(normalizePublicAddress('https://portal.example.test/research'),'https://portal.example.test/research/');
  for (const bad of ['//attacker.test/','javascript:alert(1)','file:///data','https://user:secret@portal.example.test/','https://portal.example.test/?token=secret','/research#fragment','/\\attacker.test/'])
    assert.throws(()=>normalizePublicAddress(bad));
  assert.deepEqual(Object.keys(browser.__DS_RESEARCH_PUBLIC__).sort(),['harnessUrl','workbenchUrl']);

  const parent={}, properties={};
  Object.assign(browser,{parent,CSS:{supports:()=>true},document:{documentElement:{style:{setProperty:(k,v)=>properties[k]=v}}}});
  const event={source:parent,origin:host.harness.origin,data:{type:'research-theme',tokens:{'--research-text':'#123456'}}};
  applyWorkbenchTheme({...event,source:{}},browser);
  applyWorkbenchTheme({...event,origin:'https://attacker.test'},browser);
  assert.deepEqual(properties,{});
  applyWorkbenchTheme(event,browser);
  assert.equal(properties['--research-text'],'#123456');
});

test('HTTP public config carries no access keys and an approved Origin still needs authentication', async () => {
  const directory=mkdtempSync(join(tmpdir(),'research-public-addresses-'));
  const publicUrls=publicConfiguration({DS_RESEARCH_PUBLIC_URL:'https://portal.example.test/research/',DS_HARNESS_PUBLIC_URL:'https://portal.example.test/platform/'});
  const app=await startServer({directory,port:0,publicUrls});
  try {
    const config=await fetch(app.url+'/public-config.js');
    assert.equal(config.status,200);
    const text=await config.text();
    assert.ok(text.includes(publicUrls.workbenchUrl));
    assert.ok(!text.includes(app.credentials.agentToken) && !text.includes(app.credentials.humanToken));
    const page=await fetch(app.url+'/');
    assert.match(await page.text(),/src="\.\/public-config\.js"/);
    assert.ok(page.headers.get('content-security-policy').includes('https://portal.example.test'));
    const invoke=origin=>fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({op:'state',args:{},sessionId:'synthetic'})});
    assert.equal((await invoke('https://portal.example.test')).status,401);
    assert.equal((await invoke('https://attacker.test')).status,403);
  } finally {await app.close();rmSync(directory,{recursive:true,force:true});}
});
