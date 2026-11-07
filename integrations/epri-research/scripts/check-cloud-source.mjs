/** Check retained scientific sources and the recorded transport and optional-model adaptations. */
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),record=JSON.parse(readFileSync(join(root,'source-records/cloud-integration.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of record.files){
  const path=resolve(root,file.path);if(!path.startsWith(root+'/'))throw new Error('Source record escapes its package');
  if(hash(readFileSync(path))!==file.cloudSha256)throw new Error('Scientific source changed without a reviewed source record: '+file.path);
  if(file.change==='retained-original'&&file.importedSha256!==file.cloudSha256)throw new Error('Retained executor differs from its imported source');
}
if(hash(readFileSync(join(root,'source-records',record.transportPatch)))!==record.transportPatchSha256)throw new Error('Transport patch record changed');
console.log('Cloud source record: retained executors and documented adaptations match.');
