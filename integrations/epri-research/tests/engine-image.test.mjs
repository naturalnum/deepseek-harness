import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('offline engine accepts an immutable local image ID and rejects a mutable tag',()=>{
 const probe=value=>spawnSync(process.execPath,['--input-type=module','-e',"import {ENGINE_IMAGE} from './dist/server/engine-runtime.mjs'; console.log(ENGINE_IMAGE)"],{encoding:'utf8',env:{...process.env,DS_ENGINE_IMAGE:value}});
 const id='sha256:'+'a'.repeat(64),good=probe(id);assert.equal(good.status,0,good.stderr);assert.equal(good.stdout.trim(),id);
 const bad=probe('ghcr.io/airalogy/airalogy-engine:latest');assert.notEqual(bad.status,0);assert.match(bad.stderr,/immutable image/);
});
