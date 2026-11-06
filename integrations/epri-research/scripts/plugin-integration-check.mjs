// Integration audit: use an isolated Harness home and synthetic data only.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Context} from '../harness-runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import {SystemPrompt} from '../harness-runtime/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import {ToolRuntime} from '../harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import {SkillRegistry} from '../harness-runtime/node_modules/@deepseek-ai/dsh-skill/lib/index.js';
import {loadProfile, composeEntries, evaluatePluginCompatibility, readProfileManifest, writeProfileBundles} from '../harness-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
import {contracts} from '../src/server/contracts.mjs';
import {pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option=name=>{const at=process.argv.indexOf(name);if(at<0)return undefined;if(!process.argv[at+1]||process.argv[at+1].startsWith('--'))throw new Error('Missing '+name);return process.argv[at+1];};
const packageRoot=resolve(option('--package') || root);
const installSource=resolve(option('--install') || packageRoot);
const output=resolve(option('--output') || join(root,'verification/plugin-integration-20261028'));
const generic=process.argv.includes('--generic');
const tools=await import(pathToFileURL(join(packageRoot,'plugins/airalogy/index.mjs')));
const skills=await import(pathToFileURL(join(packageRoot,'plugins/deepscientist/index.mjs')));
const workbench=await import(pathToFileURL(join(packageRoot,'plugins/workbench/index.mjs')));
const {startServer}=await import(pathToFileURL(join(packageRoot,'dist/server/main.mjs')));
mkdirSync(output,{recursive:true});
const temporary=mkdtempSync(join(tmpdir(),'research-plugin-integration-'));
const home=join(temporary,'harness-home'), directory=join(temporary,'research');
const profileName='integration-check', profileDir=join(home,'profiles',profileName);
const runtime=join(root,'harness-runtime/node_modules/@deepseek-ai/dsh');
const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
const runtimeVersion=JSON.parse(readFileSync(join(runtime,'package.json'),'utf8')).version;
const env={...process.env,DSH_HOME:home,DS_SUITE_HOME:home,DS_RESEARCH_DATA_DIR:directory,
  DSH_TELEMETRY_DISABLED:'1',npm_config_registry:'http://127.0.0.1:9/',npm_config_offline:'true'};
const exec=promisify(execFile), checks=[];
const cli=async(...args)=>{
  const result=await exec(process.execPath,[join(runtime,'lib/bin.js'),...args],{
    cwd:root,env,timeout:60000,maxBuffer:8*1024*1024,windowsHide:true,
  });
  return result.stdout;
};
const entries=()=>{
  const profile=loadProfile('dsh',profileName,join(runtime,'package.json'),home);
  assert.deepEqual(profile.skippedBundles,[]);
  return composeEntries([...profile.layers.map(layer=>layer.patches),profile.patches]);
};
const check=(name)=>{checks.push(name);console.log('PASS: '+name);};
const priorData=process.env.DS_RESEARCH_DATA_DIR;
process.env.DS_RESEARCH_DATA_DIR=directory;
let app,ctx;
try{
  assert.equal(evaluatePluginCompatibility(manifest,{},runtimeVersion),undefined);
  assert.ok(evaluatePluginCompatibility(manifest,{},'0.2.1'));
  check('Pinned runtime accepted; another runtime version rejected without exemption');
  await cli(profileName,'--from-default-profile','web','--dump-config');
  const collaboratorPatch='- insert:\n    - id: integration-colleague\n      name: cordis:group\n      group: true\n      config: []\n';
  writeFileSync(join(profileDir,'cordis.patch.yml'),collaboratorPatch);
  const baseline=entries(), baseById=new Map(baseline.map(entry=>[entry.id,entry]));
  const profilePatch=()=>readFileSync(join(profileDir,'cordis.patch.yml'),'utf8');
  await cli('plugin','--profile',profileName,'add','--offline',installSource);
  await cli('plugin','--profile',profileName,'add','--offline',installSource);
  let current=readProfileManifest('dsh',profileDir);
  assert.equal(current.dsh.profile.bundles.filter(name=>name===manifest.name).length,1);
  assert.equal(profilePatch(),collaboratorPatch);
  const enabled=entries();
  const changed=baseline.filter(entry=>JSON.stringify(entry)!==JSON.stringify(enabled.find(next=>next.id===entry.id))).map(entry=>entry.id);
  assert.deepEqual(changed.sort(),generic?[]:['preset-minimal','preset-ptc']);
  for(const id of ['preset-standard','preset-cordis','integration-colleague'])assert.deepEqual(enabled.find(entry=>entry.id===id),baseById.get(id));
  assert.equal(enabled.filter(entry=>entry.id==='ds-preset-research').length,1);
  assert.equal(enabled.filter(entry=>entry.id==='research-workbench').length,1);
  check('Real offline CLI install and repeated install preserve collaborator configuration');
  check(generic?'Generic bundle leaves every existing host row unchanged':'Only the two intentional preset disables modify existing host rows');
  const selected=current.dsh.profile.bundles;
  writeProfileBundles(profileDir,current,selected.filter(name=>name!==manifest.name));
  assert.deepEqual(entries(),baseline);
  check('Disabling the bundle restores the original host composition');
  current=readProfileManifest('dsh',profileDir);
  writeProfileBundles(profileDir,current,selected);
  assert.deepEqual(entries(),enabled);
  check('Re-enabling adds one research preset and one workbench');

  app=await startServer({directory,port:0});
  const sessionId='synthetic-plugin-lifecycle';
  const api=async(op,args={})=>{
    const response=await fetch(app.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.credentials.humanToken},body:JSON.stringify({op,args,sessionId})});
    const value=await response.json();assert.ok(response.ok,value.error||op);return value.result;
  };
  await api('protocol_put',{id:'synthetic-integration',version:'1.0.0',content:'# Synthetic engineering integration audit\n\n{{var|sample: str, title="Synthetic input", owner="human"}}\n',requestId:randomUUID()});
  const record=await api('record_create',{protocolId:'synthetic-integration',protocolVersion:'1.0.0',requestId:randomUUID()});
  const original=await api('record_get',{id:record.id});
  await cli('plugin','--profile',profileName,'remove',manifest.name);
  assert.deepEqual(entries(),baseline);
  assert.equal(profilePatch(),collaboratorPatch);
  assert.deepEqual(await api('record_get',{id:record.id}),original);
  await cli('plugin','--profile',profileName,'add','--offline',installSource);
  assert.deepEqual(entries(),enabled);
  await app.close();app=undefined;
  app=await startServer({directory,port:0});
  assert.deepEqual(await api('record_get',{id:record.id}),original);
  check('CLI uninstall and reinstall, plus service restart, preserve synthetic research data');

  ctx=new Context();
  await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime);await ctx.plugin(SkillRegistry);
  // The workbench hook only needs the projection service identity while idle.
  ctx.provide('sessionProjections',{stateOf:()=>undefined});
  for(let round=0;round<3;round++){
    const mounted=await Promise.all([ctx.plugin(tools),ctx.plugin(skills),ctx.plugin(workbench)]);
    const names=ctx.tools.schemas().map(tool=>tool.name);
    assert.equal(names.length,Object.keys(contracts).length);assert.equal(new Set(names).size,names.length);
    const catalog=await ctx.skills.list();
    assert.ok(catalog.length>300);assert.equal(new Set(catalog.map(skill=>skill.name)).size,catalog.length);
    await Promise.all(mounted.map(fiber=>fiber.dispose()));
    assert.equal(ctx.tools.schemas().length,0);assert.equal((await ctx.skills.list()).length,0);
  }
  check('Three real Cordis mount/unmount cycles remove all tools and skill providers without duplicates');
  const imports=['./','./airalogy','./research','./workbench','./client','./cordis.patch.yml'];
  for(const key of imports){const target=manifest.exports[key==='./'?'.':key];assert.ok(target&&existsSync(join(packageRoot,target)),key);}
  check('All declared plugin and browser exports exist');
  writeFileSync(join(output,'lifecycle-result.json'),JSON.stringify({status:'pass',date:new Date().toISOString().slice(0,10),runtimeVersion,pluginVersion:manifest.version,generic,installKind:installSource.endsWith('.tgz')?'tarball':'folder',checks,
    limitations:['Disable/re-enable verifies persisted bundle composition, not browser HMR.','Reinstall and restart use the same version; historical schema upgrades and downgrades are not covered.','The final engineer branch and platform SSO were not jointly tested.'],
    customerDataModified:false,offlineRegistry:'disabled localhost endpoint; CLI operations succeeded offline'},null,2));
}finally{
  await ctx?.fiber.dispose();await app?.close();
  if(priorData===undefined)delete process.env.DS_RESEARCH_DATA_DIR;else process.env.DS_RESEARCH_DATA_DIR=priorData;
  assert.equal(dirname(temporary),resolve(tmpdir()));
  rmSync(temporary,{recursive:true,force:true,maxRetries:5});
}
