import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Windows manual launcher survives its console and reuses running services', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-start-test-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src/server'), {recursive: true});
  copyFileSync(new URL('../scripts/start-local.ps1', import.meta.url), join(root, 'scripts/start-local.ps1'));
  writeFileSync(join(root, 'src/server/paths.mjs'), 'export const suitePaths=()=>({directory:process.cwd()});');
  writeFileSync(join(root, 'scripts/service-status.mjs'), `
    import {readFileSync} from 'node:fs';
    async function probe(){try {return (await fetch(readFileSync('endpoint','utf8'),{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}}
    export const researchRunning=probe, harnessRunning=probe;
  `);
  writeFileSync(join(root, 'scripts/start-all.mjs'), `
    import http from 'node:http';
    import {appendFileSync,writeFileSync} from 'node:fs';
    appendFileSync('starts','started\\n');
    const server=http.createServer((req,res)=>{res.end('ready');if(req.method==='POST')server.close();});
    server.listen(0,'127.0.0.1',()=>writeFileSync('endpoint','http://127.0.0.1:'+server.address().port));
  `);
  const run = () => {
    const output=join(root,'launcher.log'), fd=openSync(output,'w');
    try {
      const result=spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/start-local.ps1'), '-NoOpen'], {cwd: root, stdio: ['ignore',fd,fd], timeout: 20000, windowsHide: true});
      return {...result, stdout:readFileSync(output,'utf8')};
    } finally {closeSync(fd);}
  };
  try {
    const first = run();
    assert.equal(first.status, 0, first.stdout || first.error?.message);
    assert.match(first.stdout, /Ready:/);
    assert.ok((await fetch(readFileSync(join(root, 'endpoint'), 'utf8'))).ok, 'Service must survive launcher exit');
    const second = run();
    assert.equal(second.status, 0, second.stdout || second.error?.message);
    assert.equal(readFileSync(join(root, 'starts'), 'utf8'), 'started\n', 'Second launch must reuse the service');
  } finally {
    try { await fetch(readFileSync(join(root, 'endpoint'), 'utf8'), {method: 'POST'}); } catch {}
    // Let Windows release the background process's current-directory handle.
    for(let attempt=0;attempt<30;attempt++) {
      try {rmSync(root,{recursive:true,force:true});break;}
      catch(error) {if(attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
  }
});
