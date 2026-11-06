import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

test('graphical entry handles spaces and Unicode, ignores a second launch, and exits after readiness', {skip: process.platform !== 'win32', timeout: 30000}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'research gui 启动-'));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['open-local.ps1', 'open-local.vbs'])
    copyFileSync(new URL('../scripts/' + name, import.meta.url), join(root, 'scripts', name));
  writeFileSync(join(root, 'scripts/start-local.ps1'), `
    $ErrorActionPreference = 'Stop'
    $directory = Split-Path $PSScriptRoot -Parent
    Add-Content -LiteralPath (Join-Path $directory 'starts') -Value 'started'
    Start-Sleep -Seconds 4
    Set-Content -LiteralPath (Join-Path $directory 'ready') -Value 'ready'
    exit 0
  `);
  const children = [];
  function launch() {
    const process = spawn('wscript.exe', ['//nologo', join(root, 'scripts/open-local.vbs')], {cwd:root, windowsHide:true, stdio:'ignore'});
    children.push(process);
    return new Promise((resolve,reject) => {
      const timer = setTimeout(()=>{process.kill();reject(new Error('Graphical launcher did not close after startup'));},18000);
      process.once('error',error=>{clearTimeout(timer);reject(error);});
      process.once('exit',code=>{clearTimeout(timer);resolve(code);});
    });
  }
  let failed = false;
  try {
    const first = launch();
    first.catch(()=>{});
    for(let attempt=0;attempt<120 && !existsSync(join(root,'starts'));attempt++) await delay(100);
    assert.ok(existsSync(join(root,'starts')), 'The graphical entry must start the existing worker');
    assert.equal(await launch(), 0, 'A repeated click must close quietly');
    assert.equal(await first, 0, 'Successful startup must close the progress window');
    assert.equal(readFileSync(join(root,'starts'),'utf8').trim(), 'started', 'Only one worker may start');
    assert.ok(existsSync(join(root,'ready')));
  } catch(error) {failed=true;throw error;} finally {
    for(const process of children) if(process.exitCode===null) process.kill();
    for(let attempt=0;attempt<30;attempt++) {
      try {rmSync(root,{recursive:true,force:true});break;}
      catch(error) {if(attempt===29){if(failed)console.error('Test fixture retained for diagnosis:',root);else throw error;}await delay(100);}
    }
  }
});
